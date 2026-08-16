/**
 * Contract metadata extraction: prompt, response parsing, and citation
 * verification.
 *
 * Shared by the `contract.ai_extract` worker and the upload wizard's background
 * enrichment route so the two cannot disagree about the schema they ask for or
 * how they validate what comes back.
 */

import {
  DEFAULT_MAX_PAGES,
  buildPageTaggedText,
  isThinText,
  locateQuote,
  selectPagesForExtraction,
  selectTextWindow,
  type ParsedDocument,
} from "@/lib/ai/document"
import {
  NATIVE_PDF_MAX_BYTES,
  supportsNativePdf,
  type ExtractionContent,
  type ExtractionProviderId,
} from "@/lib/ai/extract-call"

/**
 * Fields we extract. Must stay in sync with `FIELD_MAP` in
 * `app/api/contracts/[id]/extractions/route.ts`, which maps them onto Contract
 * columns when a reviewer accepts them.
 */
export const EXTRACTABLE_FIELDS = [
  "contractType",
  "startDate",
  "endDate",
  "renewalDate",
  "value",
  "currency",
  "counterpartyName",
  "governingLaw",
  "noticePeriodDays",
  "autoRenewal",
] as const

/**
 * Fields the upload wizard pre-fills but that have no `AIExtraction` row —
 * they map to Contract columns the review queue doesn't govern.
 */
export const WIZARD_EXTRA_FIELDS = ["title", "paymentTerms", "description"] as const

export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number]
export type WizardExtraField = (typeof WIZARD_EXTRA_FIELDS)[number]
export type PromptField = ExtractableField | WizardExtraField

export interface FieldExtraction {
  value: unknown
  confidence: number
  sourceText: string | null
  sourcePage: number | null
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const FIELD_SPEC: Record<PromptField, string> = {
  contractType: `one of "NDA" | "MSA" | "SOW" | "EMPLOYMENT" | "VENDOR" | "CUSTOMER" | "OTHER" or null`,
  startDate: "ISO 8601 date string (YYYY-MM-DD) or null",
  endDate: "ISO 8601 date string (YYYY-MM-DD) or null",
  renewalDate: "ISO 8601 date string (YYYY-MM-DD) or null",
  value: "numeric contract value (number) or null",
  currency: `3-letter ISO currency code (e.g. "USD", "EUR") or null`,
  counterpartyName: "name of the counterparty organization or individual (string) or null",
  governingLaw: "governing law / jurisdiction (string) or null",
  noticePeriodDays: "notice period in days (integer) or null",
  autoRenewal: "whether the contract auto-renews (boolean) or null",
  title: "the contract's title as written in the document (string) or null",
  paymentTerms: `payment terms as written, e.g. "Net 30" (string) or null`,
  description: "1-2 sentence plain-language summary of the contract (string) or null",
}

/**
 * Build the extraction system prompt.
 *
 * `canCitePages` must be false whenever the model is given text with no page
 * markers — a DOCX, or a plain-text fallback. Asking for a page number the
 * model has no way to know is what produced the fabricated `sourcePage` values
 * this pipeline used to persist.
 */
export function buildExtractionSystemPrompt(opts: {
  canCitePages: boolean
  fields?: readonly PromptField[]
}): string {
  const fields = opts.fields ?? EXTRACTABLE_FIELDS
  const fieldSpec = fields.map((f) => `- ${f}: ${FIELD_SPEC[f]}`).join("\n")
  const pageRule = opts.canCitePages
    ? `"sourcePage" must be the 1-indexed page number the quote appears on. Page boundaries are marked in the document as "[page N]" headers — use those numbers exactly. If a section you were shown is preceded by an omission marker, do not guess at what the omitted pages contained.`
    : `This document has no page numbering available, so "sourcePage" must always be null. Do not guess a page number.`

  return `You are a contract analysis assistant. Extract the following fields from the contract provided. Return ONLY a valid JSON object where each key maps to an object with this exact shape:

{ "value": <field value or null>, "confidence": <number between 0 and 1>, "sourceText": <exact quote from the contract supporting the value, or null>, "sourcePage": <1-indexed page number where the quote appears, or null> }

Use null for the "value" of any field you cannot determine. When "value" is null, set "confidence" to 0 and "sourceText"/"sourcePage" to null.

"sourceText" must be a verbatim substring of the contract — copy it exactly, do not paraphrase, reformat, or correct it. It is checked against the source document, and a quote that cannot be found there is discarded along with the value it supports.

${pageRule}

"confidence" must reflect how certain you are that the extracted value is correct: 1 = explicit and unambiguous, 0.5 = inferred, 0 = unknown.

Fields to extract (each with the shape above):
${fieldSpec}

Example output:
{
  "contractType": { "value": "NDA", "confidence": 0.95, "sourceText": "This Mutual Non-Disclosure Agreement", "sourcePage": 1 },
  "startDate": { "value": "2025-01-15", "confidence": 0.9, "sourceText": "Effective Date: January 15, 2025", "sourcePage": 1 },
  "value": { "value": null, "confidence": 0, "sourceText": null, "sourcePage": null }
}

Return ONLY the JSON object, no explanation, no markdown fences.`
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/** Strip markdown fences a model may add despite being told not to. */
export function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

function normalizeField(raw: unknown): FieldExtraction | null {
  if (raw === null || raw === undefined) return null
  // Lenient shape: a bare scalar instead of the documented object.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: raw, confidence: 0, sourceText: null, sourcePage: null }
  }
  const obj = raw as Record<string, unknown>
  if (obj.value === null || obj.value === undefined) return null

  const conf = typeof obj.confidence === "number" ? obj.confidence : 0
  const sourceText =
    typeof obj.sourceText === "string" && obj.sourceText.length > 0 ? obj.sourceText : null
  const sourcePage =
    typeof obj.sourcePage === "number" && Number.isFinite(obj.sourcePage)
      ? Math.trunc(obj.sourcePage)
      : null

  return {
    value: obj.value,
    confidence: Math.max(0, Math.min(1, conf)),
    sourceText,
    sourcePage,
  }
}

export interface ParsedExtraction {
  field: PromptField
  data: FieldExtraction
}

/**
 * Parse a raw model response into per-field extractions.
 * Returns null when the response is not valid JSON.
 */
export function parseExtractionResponse(
  raw: string,
  fields: readonly PromptField[] = EXTRACTABLE_FIELDS,
): ParsedExtraction[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFences(raw))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  return fields
    .map((field) => ({ field, data: normalizeField(record[field]) }))
    .filter((e): e is ParsedExtraction => e.data !== null)
}

/** True for fields that have a corresponding `AIExtraction` row. */
export function isExtractableField(field: string): field is ExtractableField {
  return (EXTRACTABLE_FIELDS as readonly string[]).includes(field)
}

// ─── Citation verification ────────────────────────────────────────────────────

export interface VerificationStats {
  /** Quote found; `sourcePage` now reflects where it actually appears. */
  verified: number
  /** Quote found on a different page than the model claimed. */
  corrected: number
  /** Quote appears nowhere in the document — citation discarded. */
  unfounded: number
  /** No text layer to check against; the model's claim was left as-is. */
  unchecked: number
}

/**
 * Confidence multiplier applied when a model's supporting quote cannot be found
 * in the source document. The value it claims to support may still be right, so
 * we keep it for review rather than dropping it — but a fabricated quote is
 * strong evidence the value was not read off the page either.
 */
const UNFOUNDED_CONFIDENCE_PENALTY = 0.5

/**
 * Ground each citation against our own per-page text.
 *
 * This is what makes `sourcePage` trustworthy without a second model call: we
 * search for the quote the model gave us and use the page we actually find it
 * on. A model asked for a page number will always produce a plausible one, and
 * before this the pipeline persisted those guesses straight to
 * `AIExtraction.sourcePage`.
 *
 * When `pages` carries no usable text (a scanned PDF read by the model through
 * vision) there is nothing to check against, so citations pass through
 * untouched rather than being wrongly discarded.
 */
export function verifyCitations(
  extractions: ParsedExtraction[],
  pages: string[],
  opts: {
    /** False when there is no text layer to check the quote against. */
    canVerify: boolean
    /**
     * False for formats with no real pagination (DOCX). The quote is still
     * checked for existence, but `sourcePage` stays null — the single synthetic
     * page these documents parse into is not a page number worth persisting.
     */
    assignPages: boolean
  },
): { extractions: ParsedExtraction[]; stats: VerificationStats } {
  const stats: VerificationStats = { verified: 0, corrected: 0, unfounded: 0, unchecked: 0 }

  if (!opts.canVerify) {
    stats.unchecked = extractions.filter((e) => e.data.sourceText !== null).length
    return { extractions, stats }
  }

  const checked = extractions.map(({ field, data }) => {
    if (!data.sourceText) return { field, data }

    const found = locateQuote(data.sourceText, pages)

    if (found === null) {
      stats.unfounded++
      return {
        field,
        data: {
          ...data,
          sourceText: null,
          sourcePage: null,
          confidence: data.confidence * UNFOUNDED_CONFIDENCE_PENALTY,
        },
      }
    }

    if (!opts.assignPages) {
      stats.verified++
      return { field, data: { ...data, sourcePage: null } }
    }

    if (data.sourcePage !== found) stats.corrected++
    else stats.verified++

    return { field, data: { ...data, sourcePage: found } }
  })

  return { extractions: checked, stats }
}

// ─── Model routing ────────────────────────────────────────────────────────────

/**
 * Models with a 1M-token context window. Anthropic's native PDF input allows
 * 600 pages on these and 100 on 200K-context models such as the default
 * `claude-haiku-4-5`.
 */
const LARGE_CONTEXT_MODEL_RE =
  /^claude-(?:opus-5|sonnet-5|fable-5|opus-4-[678]|sonnet-4-6)/

/** Hard page ceiling for sending a PDF as a native document block. */
export function nativePdfPageLimit(model: string): number {
  return LARGE_CONTEXT_MODEL_RE.test(model) ? 600 : 100
}

/**
 * Character budget for text-mode extraction, derived from the model's context
 * window rather than the provider.
 *
 * The previous limit was keyed on provider alone (600,000 chars for "anthropic"
 * ≈ 150K tokens), which overran the default Haiku model's 200K context while
 * wasting most of Sonnet's 1M.
 */
export function textCharBudget(provider: string, model: string): number {
  if (provider === "ollama") return 32_000
  if (provider === "openai") return 400_000
  if (provider === "anthropic") return LARGE_CONTEXT_MODEL_RE.test(model) ? 1_500_000 : 250_000
  return 100_000
}

/**
 * Cost guard on the native-PDF path. Each page is billed as text *and* image,
 * so a 600-page scan would be enormous even though the model would accept it.
 * Beyond this we fall back to the worker's OCR pipeline.
 */
const NATIVE_PDF_MAX_PAGES = 100

// ─── Planning ─────────────────────────────────────────────────────────────────

export interface ExtractionPlan {
  content: ExtractionContent
  /** Whether the model can be asked for page numbers at all. */
  canCitePages: boolean
  /** Whether we hold text to check the model's quotes against. */
  canVerify: boolean
  /** Whether a located quote yields a real page number. */
  assignPages: boolean
  pagesAnalyzed: number
  pagesDropped: number
  mode: "text" | "pdf"
}

export type ExtractionPlanResult =
  | { ok: true; plan: ExtractionPlan }
  | { ok: false; reason: "no_text_layer" }

/**
 * Decide what to send the model for one document.
 *
 * Text mode is preferred whenever the document has a usable text layer: it is
 * far cheaper than native PDF (which bills every page as an image as well as
 * text) and page-tagged text still gives the model real page numbers to cite.
 *
 * The native-PDF path exists for scanned documents, where the text layer is
 * empty and the only way to read the contract is to look at it. That case is
 * exactly the one the previous pipeline failed silently on — it sent an empty
 * string to the model and persisted the all-null result.
 */
export function planExtraction(args: {
  doc: ParsedDocument
  buffer: Buffer
  provider: ExtractionProviderId
  model: string
  maxPages?: number
}): ExtractionPlanResult {
  const { doc, buffer, provider, model } = args
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES
  const hasTextLayer = !isThinText(doc.text)

  if (hasTextLayer) {
    if (doc.fileType === "docx" || doc.pageCount === 0) {
      // No pagination to cite; a head+tail window beats front-only truncation,
      // which reliably cut the term and governing-law clauses at the end.
      const window = selectTextWindow(doc.text, textCharBudget(provider, model))
      return {
        ok: true,
        plan: {
          content: { kind: "text", text: window.text },
          canCitePages: false,
          canVerify: true,
          assignPages: false,
          pagesAnalyzed: 0,
          pagesDropped: 0,
          mode: "text",
        },
      }
    }

    const selection = selectPagesForExtraction(doc.pages, { maxPages })
    const tagged = buildPageTaggedText(doc.pages, selection)
    // Backstop: page selection bounds page count, not characters.
    const window = selectTextWindow(tagged, textCharBudget(provider, model))
    return {
      ok: true,
      plan: {
        content: { kind: "text", text: window.text },
        canCitePages: true,
        canVerify: true,
        assignPages: true,
        pagesAnalyzed: selection.pages.length,
        pagesDropped: selection.droppedPages,
        mode: "text",
      },
    }
  }

  // No usable text layer — the document has to be looked at, not read.
  const nativePageCap = Math.min(nativePdfPageLimit(model), NATIVE_PDF_MAX_PAGES)
  const canGoNative =
    doc.fileType === "pdf" &&
    supportsNativePdf(provider) &&
    doc.pageCount > 0 &&
    doc.pageCount <= nativePageCap &&
    buffer.byteLength <= NATIVE_PDF_MAX_BYTES

  if (!canGoNative) return { ok: false, reason: "no_text_layer" }

  return {
    ok: true,
    plan: {
      content: { kind: "pdf", base64: buffer.toString("base64") },
      canCitePages: true,
      // Nothing to check quotes against — our own extraction came back empty.
      canVerify: false,
      assignPages: true,
      pagesAnalyzed: doc.pageCount,
      pagesDropped: 0,
      mode: "pdf",
    },
  }
}

/**
 * Optional escape hatch for long documents: set `AI_EXTRACTION_LONG_DOC_MODEL`
 * to route documents that exceed the configured model's page limit to a
 * larger-context model instead of selecting pages.
 *
 * Off by default — silently upgrading the model would change what a BYOK org
 * pays per contract without them asking for it. Page selection is the default
 * because it keeps cost bounded and predictable.
 */
export function longDocumentModelOverride(): string | null {
  const override = process.env.AI_EXTRACTION_LONG_DOC_MODEL?.trim()
  return override && override.length > 0 ? override : null
}
