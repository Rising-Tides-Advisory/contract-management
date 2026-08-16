/**
 * POST /api/contracts/extract-preview/ai — pass 2 of the upload wizard.
 *
 * Runs the model over the document and returns field guesses. The wizard fires
 * this in the background after pass 1 has already rendered the review form, and
 * merges what comes back into fields the user has not touched — so wizard
 * latency no longer scales with document length.
 *
 * This is a *convenience* pass. The authoritative extraction, with verified
 * citations, is the `contract.ai_extract` worker job that runs once the
 * contract exists and writes into the human review queue. Nothing here is
 * persisted.
 *
 * Body: multipart FormData with field "file".
 */

import { resolveAuth } from "@/lib/auth/middleware"
import { resolveAiConfig } from "@/lib/ai/resolve"
import { defaultModelFor } from "@/lib/ai/models"
import { logger } from "@/lib/logger"
import { captureServerEvent } from "@/lib/posthog-server"
import { detectFileType, parseDocument, type ParsedDocument } from "@/lib/ai/document"
import { callExtractionModel } from "@/lib/ai/extract-call"
import {
  EXTRACTABLE_FIELDS,
  WIZARD_EXTRA_FIELDS,
  buildExtractionSystemPrompt,
  parseExtractionResponse,
  planExtraction,
  verifyCitations,
  type PromptField,
} from "@/lib/ai/extraction"
import type { AiExtractPreviewResponse, PreviewPrefill } from "@/lib/ai/preview-types"

const MAX_SIZE = 50 * 1024 * 1024

/** The wizard fills three fields that have no AIExtraction row of their own. */
const WIZARD_FIELDS: readonly PromptField[] = [...EXTRACTABLE_FIELDS, ...WIZARD_EXTRA_FIELDS]

function fail(status: AiExtractPreviewResponse["status"]): Response {
  const body: AiExtractPreviewResponse = {
    status,
    prefill: {},
    confidence: {},
    pagesAnalyzed: 0,
    pagesDropped: 0,
  }
  return Response.json(body)
}

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
  if (!fileType) return Response.json({ error: "unsupported_file_type" }, { status: 400 })

  const aiConfig = await resolveAiConfig(ctx.organizationId)
  if (!aiConfig.provider) return fail("ai_unavailable")
  if (aiConfig.provider !== "ollama" && !aiConfig.apiKey) return fail("ai_unavailable")
  // Ollama has no reliable structured-output mode; the old route skipped it too.
  if (aiConfig.provider === "ollama") return fail("provider_unsupported")

  const model = aiConfig.model ?? defaultModelFor(aiConfig.provider)

  let doc: ParsedDocument
  try {
    doc = await parseDocument(buffer, fileType)
  } catch (err) {
    logger.warn({ err, fileType }, "[extract-preview/ai] document parse failed")
    return fail("text_extraction_failed")
  }

  const planned = planExtraction({
    doc,
    buffer,
    provider: aiConfig.provider,
    model,
  })
  if (!planned.ok) {
    // Scanned, and too large to send natively — the worker's OCR path is the
    // fallback, and it runs after the contract is created.
    logger.info(
      { pageCount: doc.pageCount, bytes: buffer.byteLength },
      "[extract-preview/ai] no text layer and native PDF not viable",
    )
    return fail("no_text_layer")
  }
  const plan = planned.plan

  if (plan.pagesDropped > 0) {
    logger.info(
      {
        pageCount: doc.pageCount,
        pagesAnalyzed: plan.pagesAnalyzed,
        pagesDropped: plan.pagesDropped,
      },
      "[extract-preview/ai] long document — analyzed a page selection",
    )
  }

  let raw: string
  try {
    raw = await callExtractionModel({
      provider: aiConfig.provider,
      apiKey: aiConfig.apiKey,
      model,
      systemPrompt: buildExtractionSystemPrompt({
        canCitePages: plan.canCitePages,
        fields: WIZARD_FIELDS,
      }),
      content: plan.content,
    })
  } catch (err) {
    logger.error({ err, model, mode: plan.mode }, "[extract-preview/ai] provider call failed")
    return fail("ai_error")
  }

  const parsed = parseExtractionResponse(raw, WIZARD_FIELDS)
  if (parsed === null) {
    logger.error(
      { model, sample: raw.slice(0, 200) },
      "[extract-preview/ai] model response was not valid JSON",
    )
    return fail("ai_error")
  }

  // Quote grounding still matters here even though nothing is persisted: a
  // value whose supporting quote is nowhere in the document is downgraded, so
  // the wizard does not present a fabrication with a confident-looking score.
  const { extractions, stats } = verifyCitations(parsed, doc.pages, {
    canVerify: plan.canVerify,
    assignPages: plan.assignPages,
  })

  if (stats.unfounded > 0) {
    logger.warn(
      { model, ...stats },
      "[extract-preview/ai] discarded citations that are not in the document",
    )
  }

  const prefill: PreviewPrefill = {}
  const confidence: Record<string, number> = {}
  for (const { field, data } of extractions) {
    ;(prefill as Record<string, unknown>)[field] = data.value
    confidence[field] = data.confidence
  }

  captureServerEvent(ctx.userId, "ai_extraction_run", {
    organizationId: ctx.organizationId,
    mode: plan.mode,
    pageCount: doc.pageCount,
    pagesAnalyzed: plan.pagesAnalyzed,
    pagesDropped: plan.pagesDropped,
  })

  const body: AiExtractPreviewResponse = {
    status: "ok",
    prefill,
    confidence,
    pagesAnalyzed: plan.pagesAnalyzed,
    pagesDropped: plan.pagesDropped,
  }
  return Response.json(body)
}
