/**
 * Wire types shared between the upload wizard (client) and the two
 * extract-preview routes.
 *
 * Deliberately dependency-free — this module is imported into a client bundle,
 * so it must not pull in pdf-parse, mammoth, or any provider SDK.
 */

/** Outcome of pass 1: parse the document. No model involved. */
export type PreviewStatus =
  | "ok"
  /** Parsed, but produced almost no text — a scanned image or a broken font map. */
  | "no_text_layer"
  /** The parser threw; we have nothing to work with. */
  | "text_extraction_failed"

/** Outcome of pass 2: the background AI enrichment call. */
export type AiPreviewStatus =
  | "ok"
  /** No AI provider or API key is configured for this org. */
  | "ai_unavailable"
  /** The provider call or its response failed. */
  | "ai_error"
  /** Nothing readable to send. */
  | "no_text_layer"
  | "text_extraction_failed"
  /** The configured provider has no structured-extraction path (Ollama). */
  | "provider_unsupported"

export interface PreviewPrefill {
  title?: string | null
  contractType?: string | null
  counterpartyName?: string | null
  startDate?: string | null
  endDate?: string | null
  value?: number | null
  currency?: string | null
  paymentTerms?: string | null
  governingLaw?: string | null
  autoRenewal?: boolean
  description?: string | null
}

/** `POST /api/contracts/extract-preview` — fast, deterministic, no model call. */
export interface ExtractPreviewResponse {
  status: PreviewStatus
  prefill: PreviewPrefill
  /** Per-field 0–1 scores for what pass 1 filled. Heuristics score low by design. */
  confidence: Record<string, number>
  /** Document text for the preview dialog; DOCX has no other renderer. */
  documentText: string | null
  documentTextTruncated: boolean
  /** Real page count for PDFs; 0 when the format has no pages (DOCX). */
  pageCount: number
  fileType: "pdf" | "docx" | null
}

/** `POST /api/contracts/extract-preview/ai` — background enrichment. */
export interface AiExtractPreviewResponse {
  status: AiPreviewStatus
  prefill: PreviewPrefill
  confidence: Record<string, number>
  /** Pages actually sent to the model. */
  pagesAnalyzed: number
  /** Pages left out by selection — surfaced so truncation is never silent. */
  pagesDropped: number
}

/**
 * User-facing explanation for a non-ok outcome, or null when there is nothing
 * to explain. Centralised so the sidebar and the toast never disagree.
 */
export function previewStatusMessage(
  status: PreviewStatus | AiPreviewStatus,
): string | null {
  switch (status) {
    case "ok":
      return null
    case "no_text_layer":
      return "No readable text in this document — it looks like a scanned image. Text will be recovered by OCR after you create the contract."
    case "text_extraction_failed":
      return "This file could not be read. It may be corrupt or password-protected."
    case "ai_unavailable":
      return "AI extraction is not configured for your organization. Fill in the fields manually."
    case "provider_unsupported":
      return "Your configured AI provider does not support structured extraction. Fill in the fields manually."
    case "ai_error":
      return "AI extraction failed. Fill in the fields manually — it will retry after the contract is created."
    default:
      return null
  }
}
