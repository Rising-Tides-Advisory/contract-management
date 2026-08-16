/**
 * POST /api/contracts/extract-preview — pass 1 of the upload wizard.
 *
 * Parses the document and returns deterministic guesses. **No model call.**
 *
 * This route used to run the LLM inline, which made wizard latency scale with
 * document length: a 2-page NDA and a 60-page MSA went down the same code path,
 * with the text front-truncated at 8,000 characters. It also swallowed the
 * common failure — `pdf-parse` returns an empty string rather than throwing on
 * a scanned PDF, so an empty prompt went to the model and the all-null result
 * came back as a blank form with no error.
 *
 * Pass 2 (`./ai`) does the model call in the background, and the
 * `contract.ai_extract` worker does the authoritative extraction into the
 * review queue once the contract exists.
 *
 * Body: multipart FormData with field "file".
 */

import { resolveAuth } from "@/lib/auth/middleware"
import { logger } from "@/lib/logger"
import {
  detectFileType,
  isThinText,
  parseDocument,
  type ParsedDocument,
} from "@/lib/ai/document"
import { heuristicPrefill, titleFromFilename } from "@/lib/ai/heuristics"
import type { ExtractPreviewResponse } from "@/lib/ai/preview-types"

const MAX_SIZE = 50 * 1024 * 1024 // 50 MB, matching the upload limit

/**
 * Document text returned for the preview dialog. Generous because the dialog's
 * "find dates in document" scan runs over it — the old 8,000-character cap meant
 * dates in anything past the first few pages were invisible to it.
 */
const PREVIEW_TEXT_CHARS = 100_000

export async function POST(req: Request): Promise<Response> {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })

  let formData: globalThis.FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 })
  }

  const fileField = formData.get("file")
  if (!fileField || !(fileField instanceof File)) {
    return Response.json({ error: "Missing file field" }, { status: 400 })
  }
  if (fileField.size > MAX_SIZE) {
    return Response.json({ error: "File exceeds 50 MB limit" }, { status: 413 })
  }

  const buffer = Buffer.from(await fileField.arrayBuffer())
  const fileType = detectFileType(buffer)
  if (!fileType) {
    return Response.json({ error: "unsupported_file_type" }, { status: 400 })
  }

  const titleFromName = titleFromFilename(fileField.name)

  let doc: ParsedDocument
  try {
    doc = await parseDocument(buffer, fileType)
  } catch (err) {
    // Malformed or password-protected. The worker will still attempt OCR after
    // upload, so this is a degraded start rather than a dead end.
    logger.warn({ err, fileType }, "[extract-preview] document parse failed")
    const body: ExtractPreviewResponse = {
      status: "text_extraction_failed",
      prefill: { title: titleFromName },
      confidence: {},
      documentText: null,
      documentTextTruncated: false,
      pageCount: 0,
      fileType,
    }
    return Response.json(body)
  }

  // The guard the old route was missing: pdf-parse returns "" for a scanned
  // page rather than throwing, so this is the only place the condition shows up.
  if (isThinText(doc.text)) {
    logger.info(
      { fileType, pageCount: doc.pageCount, chars: doc.text.length },
      "[extract-preview] no text layer — likely a scanned document",
    )
    const body: ExtractPreviewResponse = {
      status: "no_text_layer",
      prefill: { title: titleFromName },
      confidence: {},
      documentText: null,
      documentTextTruncated: false,
      pageCount: doc.pageCount,
      fileType,
    }
    return Response.json(body)
  }

  const { prefill, confidence } = heuristicPrefill(doc.text)

  const body: ExtractPreviewResponse = {
    status: "ok",
    prefill: { ...prefill, title: titleFromName },
    confidence,
    documentText: doc.text.slice(0, PREVIEW_TEXT_CHARS),
    documentTextTruncated: doc.text.length > PREVIEW_TEXT_CHARS,
    pageCount: doc.pageCount,
    fileType,
  }
  return Response.json(body)
}
