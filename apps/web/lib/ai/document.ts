/**
 * Document parsing and length-tiering for the extraction pipeline.
 *
 * Everything that needs to know "how big is this document and which parts of it
 * do we send to the model" lives here, so the upload wizard and the
 * `contract.ai_extract` worker cannot drift apart.
 *
 * The important idea: extraction is tiered on **page count**, not file size. A
 * 67 KB scanned PDF and a 67 KB text PDF need completely different handling,
 * and a 50-page MSA is usually a 6-page contract plus 44 pages of exhibits —
 * so for long documents we select pages rather than truncating from the front.
 *
 * Page numbers in this module are always **1-indexed** to match
 * `AIExtraction.sourcePage`.
 */

import pdfParse from "pdf-parse"
import mammoth from "mammoth"

export type DocumentFileType = "pdf" | "docx"

export interface ParsedDocument {
  fileType: DocumentFileType
  /**
   * Per-page text; page N is `pages[N - 1]`.
   *
   * DOCX has no page concept — mammoth reflows the document and any page number
   * we invented here would be a lie that lands in `AIExtraction.sourcePage`. So
   * DOCX always parses to a single entry with `pageCount: 0`, and callers treat
   * `pageCount === 0` as "this document cannot cite pages".
   */
  pages: string[]
  /** Real page count for PDFs; 0 for DOCX, which has no pages. */
  pageCount: number
  /** Whole-document text. */
  text: string
}

/** Below this many characters a document is treated as having no text layer. */
export const THIN_TEXT_CHARS = 100

/**
 * Page budget for a single extraction call. Above this we select pages instead
 * of sending the whole document. Chosen to sit under Anthropic's 100-page PDF
 * limit for 200K-context models (the default `claude-haiku-4-5`) with headroom.
 */
export const DEFAULT_MAX_PAGES = 30

/** Pages taken from the front — title, parties, recitals, effective date. */
export const DEFAULT_HEAD_PAGES = 8

/** Pages taken from the back — term, renewal, governing law, signatures. */
export const DEFAULT_TAIL_PAGES = 8

/** Character budget for documents that cannot be paginated (DOCX). */
export const DEFAULT_MAX_CHARS = 120_000

// ─── File type detection ──────────────────────────────────────────────────────

/**
 * Identify a document by magic bytes. Per CLAUDE.md we never trust the
 * client-supplied MIME header.
 */
export function detectFileType(buffer: Buffer): DocumentFileType | null {
  // %PDF
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return "pdf"
  }
  // PK ZIP header — DOCX is a zip containing a "word/" entry
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    if (buffer.includes(Buffer.from("word/"))) return "docx"
  }
  return null
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** Shape of the pdf.js page proxy that pdf-parse hands to `pagerender`. */
interface PdfPageProxy {
  pageNumber?: number
  getTextContent: (opts?: unknown) => Promise<{
    items: Array<{ str: string; transform: number[] }>
  }>
}

/**
 * Reproduces pdf-parse's default page renderer, but keeps each page separately
 * instead of concatenating everything into one string. Without per-page text we
 * cannot verify a model-reported `sourcePage`, and we cannot select pages.
 */
async function renderPdfPage(pageData: PdfPageProxy): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  })

  let lastY: number | undefined
  let text = ""
  for (const item of content.items) {
    // pdf.js emits one item per text run; a change in the y translation
    // (transform[5]) means a new line.
    if (lastY === undefined || lastY === item.transform[5]) text += item.str
    else text += "\n" + item.str
    lastY = item.transform[5]
  }
  return text
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  // pdf-parse catches per-page render errors and continues, so a page can be
  // skipped entirely. Key by the page number pdf.js reports rather than by push
  // order — otherwise one unrenderable page shifts every subsequent page number
  // by one and silently corrupts every citation after it.
  const byPage = new Map<number, string>()
  let fallbackIndex = 0

  const result = await pdfParse(buffer, {
    pagerender: async (pageData: PdfPageProxy) => {
      const text = await renderPdfPage(pageData)
      const n =
        typeof pageData.pageNumber === "number" && Number.isFinite(pageData.pageNumber)
          ? pageData.pageNumber
          : ++fallbackIndex
      byPage.set(n, text)
      return text
    },
  })

  // Defensive: if no page ever reached our renderer but pdf-parse still
  // produced text, fall back to its own output as a single unpaginated page.
  // Losing the text entirely here would look exactly like a scanned document
  // and send a perfectly readable contract down the OCR path.
  if (byPage.size === 0) {
    const text = result.text ?? ""
    return {
      fileType: "pdf",
      pages: text ? [text] : [],
      pageCount: text ? 0 : (result.numpages ?? 0),
      text,
    }
  }

  const pageCount = Math.max(result.numpages ?? 0, ...byPage.keys())
  const pages: string[] = []
  for (let n = 1; n <= pageCount; n++) pages.push(byPage.get(n) ?? "")

  return {
    fileType: "pdf",
    pages,
    pageCount,
    // Match pdf-parse's own joining so downstream text consumers (embeddings,
    // full-text search) see what they saw before.
    text: pages.join("\n\n"),
  }
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value ?? ""
  // Deliberately not paginated — see the `pages` doc comment.
  return { fileType: "docx", pages: [text], pageCount: 0, text }
}

/**
 * Parse a document into per-page text.
 *
 * Throws whatever the underlying parser throws (pdf-parse rejects on malformed
 * PDFs, e.g. "bad XRef entry"); callers decide whether that is fatal or whether
 * to fall back to OCR.
 */
export async function parseDocument(
  buffer: Buffer,
  fileType: DocumentFileType,
): Promise<ParsedDocument> {
  return fileType === "pdf" ? parsePdf(buffer) : parseDocx(buffer)
}

/**
 * True when a document yielded so little text that it almost certainly has no
 * text layer — a scanned image, or a generator that embedded fonts without a
 * ToUnicode map. `pdf-parse` returns an empty string rather than throwing in
 * that case, so this is the only way to notice.
 */
export function isThinText(text: string): boolean {
  return text.trim().length < THIN_TEXT_CHARS
}

// ─── Length tiering ───────────────────────────────────────────────────────────

export type LengthTier = "short" | "standard" | "long"

/**
 * Short documents are cheap enough to handle inline; standard ones still fit in
 * a single call but deserve to be async; long ones need page selection.
 *
 * `pageCount === 0` (DOCX) falls back to a character estimate at roughly one
 * page per 1,800 characters.
 */
export function classifyLength(
  pageCount: number,
  charCount: number,
  maxPages: number = DEFAULT_MAX_PAGES,
): LengthTier {
  const effective = pageCount > 0 ? pageCount : Math.ceil(charCount / 1_800)
  if (effective <= 10) return "short"
  if (effective <= maxPages) return "standard"
  return "long"
}

// ─── Page selection ───────────────────────────────────────────────────────────

/**
 * Sections that carry the fields we extract. Used to pull relevant pages out of
 * the middle of a long document — the part head/tail selection would miss.
 */
const RELEVANT_SECTION_RE =
  /governing\s+law|jurisdiction|venue|auto-?renew|automatically\s+renew|renewal\s+term|initial\s+term|term\s+of\s+this\s+agreement|payment\s+terms|net\s+\d+|notice\s+period|effective\s+date|total\s+(?:contract\s+)?(?:value|fees)|termination/i

export interface PageSelection {
  /** 1-indexed page numbers, ascending. */
  pages: number[]
  /** How many pages were left out — log this, never drop pages silently. */
  droppedPages: number
  strategy: "all" | "selected"
}

/**
 * Choose which pages of a long document to send to the model.
 *
 * Head and tail are taken unconditionally because contract metadata clusters
 * there: parties, title and effective date at the front; term, renewal,
 * governing law and signatures at the back. The remaining budget goes to middle
 * pages that mention a relevant section, which is what separates a real clause
 * from a page of exhibit line-items.
 */
export function selectPagesForExtraction(
  pages: string[],
  opts: {
    maxPages?: number
    headPages?: number
    tailPages?: number
  } = {},
): PageSelection {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const headPages = opts.headPages ?? DEFAULT_HEAD_PAGES
  const tailPages = opts.tailPages ?? DEFAULT_TAIL_PAGES
  const total = pages.length

  if (total === 0) return { pages: [], droppedPages: 0, strategy: "all" }
  if (total <= maxPages) {
    return {
      pages: Array.from({ length: total }, (_, i) => i + 1),
      droppedPages: 0,
      strategy: "all",
    }
  }

  const selected = new Set<number>()
  for (let n = 1; n <= Math.min(headPages, total); n++) selected.add(n)
  for (let n = Math.max(1, total - tailPages + 1); n <= total; n++) selected.add(n)

  // Spend whatever budget is left on middle pages that look substantive.
  if (selected.size < maxPages) {
    for (let n = headPages + 1; n <= total - tailPages; n++) {
      if (selected.size >= maxPages) break
      if (RELEVANT_SECTION_RE.test(pages[n - 1] ?? "")) selected.add(n)
    }
  }

  const ordered = [...selected].sort((a, b) => a - b)
  return {
    pages: ordered,
    droppedPages: total - ordered.length,
    strategy: "selected",
  }
}

/**
 * Render selected pages with explicit page markers.
 *
 * This is what makes a text-mode `sourcePage` meaningful at all: the previous
 * pipeline asked the model for a page number while feeding it one flat
 * concatenated string, so every page number it returned was a guess.
 * Discontinuities are marked so the model does not assume pages are adjacent.
 */
export function buildPageTaggedText(
  pages: string[],
  selection: PageSelection,
): string {
  const parts: string[] = []
  let previous: number | null = null

  for (const n of selection.pages) {
    if (previous !== null && n !== previous + 1) {
      parts.push(`[... pages ${previous + 1}–${n - 1} omitted ...]`)
    }
    parts.push(`[page ${n}]\n${pages[n - 1] ?? ""}`)
    previous = n
  }

  return parts.join("\n\n")
}

/**
 * Head+tail window for documents that cannot be paginated (DOCX).
 *
 * Front-only truncation is what the old pipeline did, and it reliably cut the
 * term, renewal and governing-law clauses that live at the end of a contract.
 */
export function selectTextWindow(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { text: string; truncated: boolean; droppedChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, droppedChars: 0 }
  }
  const half = Math.floor(maxChars / 2)
  const head = text.slice(0, half)
  const tail = text.slice(text.length - half)
  const dropped = text.length - head.length - tail.length
  return {
    text: `${head}\n\n[... ${dropped.toLocaleString("en-US")} characters omitted ...]\n\n${tail}`,
    truncated: true,
    droppedChars: dropped,
  }
}

// ─── Quote location (deterministic page verification) ─────────────────────────

/** Collapse whitespace and case so PDF spacing artefacts don't defeat a match. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/** Last resort: compare only alphanumerics, ignoring punctuation and spacing. */
function looseForMatch(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase()
}

/**
 * Find which page a quote came from, by searching our own per-page text.
 *
 * This is the check that makes `sourcePage` trustworthy. A model asked for a
 * page number will happily supply a plausible one; searching for the quote we
 * were given turns that claim into something verifiable, at no token cost.
 *
 * Returns `null` when the quote appears nowhere in the document — which means
 * the quote itself was fabricated, and the caller should discard the citation
 * rather than just the page number.
 */
export function locateQuote(quote: string, pages: string[]): number | null {
  if (!quote || pages.length === 0) return null

  const needle = normalizeForMatch(quote)
  if (needle.length === 0) return null

  const normalizedPages = pages.map(normalizeForMatch)

  // Exact (whitespace-normalised) match.
  for (let i = 0; i < normalizedPages.length; i++) {
    if (normalizedPages[i].includes(needle)) return i + 1
  }

  // Models often reproduce a long quote with small edits. A distinctive prefix
  // is enough to place it, and 40 chars is long enough not to match by chance.
  if (needle.length > 40) {
    const prefix = needle.slice(0, 40)
    for (let i = 0; i < normalizedPages.length; i++) {
      if (normalizedPages[i].includes(prefix)) return i + 1
    }
  }

  // Punctuation-insensitive fallback — PDF extraction mangles quotes, dashes
  // and ligatures often enough that this recovers real matches.
  const loose = looseForMatch(quote)
  if (loose.length >= 20) {
    const probe = loose.slice(0, 60)
    for (let i = 0; i < pages.length; i++) {
      if (looseForMatch(pages[i]).includes(probe)) return i + 1
    }
  }

  return null
}
