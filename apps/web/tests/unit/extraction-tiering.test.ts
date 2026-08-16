/**
 * Unit tests for the length-tiering and citation-grounding logic that the
 * extraction pipeline is built on.
 *
 * These are the pieces that decide what a long contract sends to the model and
 * whether a returned `sourcePage` is trustworthy, so they are tested directly
 * rather than only through the routes.
 */

import { describe, it, expect, vi } from "vitest"

// pdf-parse reads a test fixture at module load and crashes when it is absent.
// document.ts imports it eagerly, so it has to be stubbed before that import.
vi.mock("pdf-parse", () => ({ default: vi.fn() }))
vi.mock("mammoth", () => ({ extractRawText: vi.fn() }))

import {
  buildPageTaggedText,
  classifyLength,
  detectFileType,
  isThinText,
  locateQuote,
  selectPagesForExtraction,
  selectTextWindow,
} from "@/lib/ai/document"
import { parseExtractionResponse, planExtraction, verifyCitations } from "@/lib/ai/extraction"
import type { ParsedDocument } from "@/lib/ai/document"

/** Build an n-page document; `overrides` injects text on specific 1-indexed pages. */
function makePages(n: number, overrides: Record<number, string> = {}): string[] {
  return Array.from(
    { length: n },
    (_, i) => overrides[i + 1] ?? `Page ${i + 1} of routine exhibit line items.`,
  )
}

describe("detectFileType", () => {
  it("identifies a PDF by magic bytes", () => {
    expect(detectFileType(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf")
  })

  it("requires a word/ entry before calling a zip a DOCX", () => {
    const notDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("xl/")])
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/")])
    expect(detectFileType(notDocx)).toBeNull()
    expect(detectFileType(docx)).toBe("docx")
  })

  it("rejects anything else", () => {
    expect(detectFileType(Buffer.from("plain text"))).toBeNull()
  })
})

describe("isThinText", () => {
  // pdf-parse returns "" for a scanned page rather than throwing; this guard is
  // the only thing that distinguishes that from a readable document.
  it("treats an empty extraction as having no text layer", () => {
    expect(isThinText("")).toBe(true)
    expect(isThinText("   \n  ")).toBe(true)
  })

  it("accepts a document with real content", () => {
    const page =
      "This Agreement is entered into as of January 1, 2026 between Acme Corporation " +
      "and Globex Inc, and sets out the terms under which services will be provided."
    expect(isThinText(page)).toBe(false)
  })

  it("treats a stray header on an otherwise blank scan as thin", () => {
    // A scanned page often yields a few characters of junk rather than nothing.
    expect(isThinText("Page 1 of 24")).toBe(true)
  })
})

describe("classifyLength", () => {
  it("tiers on page count", () => {
    expect(classifyLength(3, 5_000)).toBe("short")
    expect(classifyLength(25, 60_000)).toBe("standard")
    expect(classifyLength(120, 400_000)).toBe("long")
  })

  it("falls back to a character estimate when there are no pages (DOCX)", () => {
    expect(classifyLength(0, 2_000)).toBe("short")
    expect(classifyLength(0, 500_000)).toBe("long")
  })
})

describe("selectPagesForExtraction", () => {
  it("sends everything when the document fits", () => {
    const result = selectPagesForExtraction(makePages(12), { maxPages: 30 })
    expect(result.strategy).toBe("all")
    expect(result.pages).toHaveLength(12)
    expect(result.droppedPages).toBe(0)
  })

  it("always keeps the head and the tail of a long document", () => {
    // Term, renewal and governing-law clauses live at the back — front-only
    // truncation is exactly what used to lose them.
    const result = selectPagesForExtraction(makePages(100), {
      maxPages: 30,
      headPages: 8,
      tailPages: 8,
    })
    expect(result.strategy).toBe("selected")
    expect(result.pages.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.pages.slice(-8)).toEqual([93, 94, 95, 96, 97, 98, 99, 100])
  })

  it("pulls relevant middle pages out of an exhibit-heavy contract", () => {
    const pages = makePages(100, {
      50: "12. GOVERNING LAW. This Agreement shall be governed by the laws of New York.",
      60: "13. Payment Terms. Net 30 from receipt of invoice.",
    })
    const result = selectPagesForExtraction(pages, { maxPages: 30 })
    expect(result.pages).toContain(50)
    expect(result.pages).toContain(60)
  })

  it("never exceeds the page budget and reports what it dropped", () => {
    const result = selectPagesForExtraction(makePages(200), { maxPages: 30 })
    expect(result.pages.length).toBeLessThanOrEqual(30)
    expect(result.pages.length + result.droppedPages).toBe(200)
  })

  it("handles an empty document", () => {
    expect(selectPagesForExtraction([]).pages).toEqual([])
  })
})

describe("buildPageTaggedText", () => {
  it("labels pages so the model has real numbers to cite", () => {
    const pages = ["first", "second", "third"]
    const tagged = buildPageTaggedText(pages, {
      pages: [1, 2, 3],
      droppedPages: 0,
      strategy: "all",
    })
    expect(tagged).toContain("[page 1]\nfirst")
    expect(tagged).toContain("[page 3]\nthird")
  })

  it("marks gaps so the model does not read a selection as contiguous", () => {
    const tagged = buildPageTaggedText(makePages(10), {
      pages: [1, 9, 10],
      droppedPages: 7,
      strategy: "selected",
    })
    expect(tagged).toContain("[... pages 2–8 omitted ...]")
  })
})

describe("selectTextWindow", () => {
  it("leaves a short document alone", () => {
    const result = selectTextWindow("short contract", 1_000)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe("short contract")
  })

  it("keeps both ends rather than truncating from the front", () => {
    const text = `${"A".repeat(5_000)}${"B".repeat(5_000)}`
    const result = selectTextWindow(text, 1_000)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith("A")).toBe(true)
    expect(result.text.endsWith("B")).toBe(true)
    expect(result.droppedChars).toBeGreaterThan(0)
  })
})

describe("locateQuote", () => {
  const pages = [
    "This Mutual Non-Disclosure Agreement is made as of January 15, 2025.",
    "2. Term. The initial term is twelve (12) months.",
    "9. Governing Law.  This  Agreement  is governed by the laws of Delaware.",
  ]

  it("finds a quote and returns its 1-indexed page", () => {
    expect(locateQuote("the initial term is twelve", pages)).toBe(2)
  })

  it("is insensitive to the whitespace PDF extraction mangles", () => {
    expect(locateQuote("This Agreement is governed by the laws of Delaware", pages)).toBe(3)
  })

  it("returns null for a quote that is not in the document", () => {
    // A fabricated quote must be detectable — this is what stops an invented
    // citation from being persisted next to a real-looking value.
    expect(locateQuote("The Buyer shall indemnify the Seller in perpetuity", pages)).toBeNull()
  })

  it("returns null for an empty quote or an empty document", () => {
    expect(locateQuote("", pages)).toBeNull()
    expect(locateQuote("anything", [])).toBeNull()
  })
})

describe("verifyCitations", () => {
  const pages = [
    "Cover page. Master Services Agreement.",
    "1. Parties. Acme Corporation and Globex Inc.",
    "7. Governing Law. Governed by the laws of the State of Delaware.",
  ]

  const parse = (obj: unknown) => parseExtractionResponse(JSON.stringify(obj))!

  it("overrides a wrong page number with the page the quote is actually on", () => {
    const parsed = parse({
      governingLaw: {
        value: "State of Delaware",
        confidence: 0.9,
        sourceText: "Governed by the laws of the State of Delaware",
        sourcePage: 1, // model guessed
      },
    })
    const { extractions, stats } = verifyCitations(parsed, pages, {
      canVerify: true,
      assignPages: true,
    })
    expect(extractions[0].data.sourcePage).toBe(3)
    expect(stats.corrected).toBe(1)
  })

  it("discards a citation whose quote is nowhere in the document", () => {
    const parsed = parse({
      counterpartyName: {
        value: "Initech LLC",
        confidence: 0.95,
        sourceText: "between the Company and Initech LLC",
        sourcePage: 2,
      },
    })
    const { extractions, stats } = verifyCitations(parsed, pages, {
      canVerify: true,
      assignPages: true,
    })
    expect(stats.unfounded).toBe(1)
    expect(extractions[0].data.sourceText).toBeNull()
    expect(extractions[0].data.sourcePage).toBeNull()
    // The value survives for review, but stops looking confident.
    expect(extractions[0].data.value).toBe("Initech LLC")
    expect(extractions[0].data.confidence).toBeLessThan(0.95)
  })

  it("verifies the quote but withholds a page number for unpaginated formats", () => {
    // DOCX parses to one synthetic page; reporting "page 1" would be a lie.
    const parsed = parse({
      counterpartyName: {
        value: "Acme Corporation",
        confidence: 0.9,
        sourceText: "Acme Corporation and Globex Inc",
        sourcePage: 1,
      },
    })
    const { extractions, stats } = verifyCitations(parsed, [pages.join("\n")], {
      canVerify: true,
      assignPages: false,
    })
    expect(stats.verified).toBe(1)
    expect(extractions[0].data.sourcePage).toBeNull()
    expect(extractions[0].data.sourceText).not.toBeNull()
  })

  it("leaves citations untouched when there is no text to check against", () => {
    // A scanned PDF read through vision: our own extraction is empty, so an
    // unverifiable quote must not be mistaken for a fabricated one.
    const parsed = parse({
      startDate: {
        value: "2025-01-15",
        confidence: 0.8,
        sourceText: "Effective Date: January 15, 2025",
        sourcePage: 4,
      },
    })
    const { extractions, stats } = verifyCitations(parsed, [], {
      canVerify: false,
      assignPages: true,
    })
    expect(stats.unchecked).toBe(1)
    expect(extractions[0].data.sourcePage).toBe(4)
    expect(extractions[0].data.confidence).toBe(0.8)
  })
})

describe("planExtraction", () => {
  const realPage =
    "This Agreement is entered into between Acme Corporation and Globex Inc, " +
    "and sets out the terms under which the services described herein are provided."

  const pdfDoc = (pageCount: number, text = realPage): ParsedDocument => ({
    fileType: "pdf",
    pages: Array.from({ length: pageCount }, () => text),
    pageCount,
    text: Array.from({ length: pageCount }, () => text).join("\n\n"),
  })

  const scannedPdf = (pageCount: number): ParsedDocument => ({
    fileType: "pdf",
    pages: Array.from({ length: pageCount }, () => ""),
    pageCount,
    text: "",
  })

  it("uses page-tagged text when the document has a text layer", () => {
    const result = planExtraction({
      doc: pdfDoc(5),
      buffer: Buffer.alloc(10),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.mode).toBe("text")
    expect(result.plan.canCitePages).toBe(true)
    expect(result.plan.assignPages).toBe(true)
    if (result.plan.content.kind !== "text") throw new Error("expected text content")
    expect(result.plan.content.text).toContain("[page 1]")
  })

  it("selects pages for a long document and reports the drop", () => {
    const result = planExtraction({
      doc: pdfDoc(150),
      buffer: Buffer.alloc(10),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.pagesDropped).toBeGreaterThan(0)
    expect(result.plan.pagesAnalyzed).toBeLessThanOrEqual(30)
  })

  // The failure that started this: a scanned contract has no text to send, so
  // it has to be looked at rather than read.
  it("sends a scanned PDF natively so the model can read the pages", () => {
    const result = planExtraction({
      doc: scannedPdf(8),
      buffer: Buffer.from("%PDF-1.4 fake bytes"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.mode).toBe("pdf")
    expect(result.plan.content.kind).toBe("pdf")
    // Nothing of our own to check the model's quotes against.
    expect(result.plan.canVerify).toBe(false)
  })

  it("declines a scan too long to send natively", () => {
    const result = planExtraction({
      doc: scannedPdf(400),
      buffer: Buffer.from("%PDF-1.4"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    // The worker falls back to OCR text from the job payload in this case.
    expect(result.ok).toBe(false)
  })

  it("declines a scan when the provider has no native PDF path", () => {
    const result = planExtraction({
      doc: scannedPdf(4),
      buffer: Buffer.from("%PDF-1.4"),
      provider: "openai",
      model: "gpt-4o-mini",
    })
    expect(result.ok).toBe(false)
  })

  it("suppresses page citations for unpaginated formats", () => {
    const docx: ParsedDocument = {
      fileType: "docx",
      pages: [realPage],
      pageCount: 0,
      text: realPage,
    }
    const result = planExtraction({
      doc: docx,
      buffer: Buffer.alloc(0),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.canCitePages).toBe(false)
    expect(result.plan.assignPages).toBe(false)
  })
})

describe("parseExtractionResponse", () => {
  it("strips markdown fences the model was told not to emit", () => {
    const raw = '```json\n{"currency": {"value": "USD", "confidence": 1}}\n```'
    const parsed = parseExtractionResponse(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed![0].data.value).toBe("USD")
  })

  it("drops fields whose value is null", () => {
    const raw = JSON.stringify({
      currency: { value: null, confidence: 0 },
      governingLaw: { value: "Delaware", confidence: 0.7 },
    })
    const parsed = parseExtractionResponse(raw)
    expect(parsed!.map((e) => e.field)).toEqual(["governingLaw"])
  })

  it("clamps confidence into range", () => {
    const raw = JSON.stringify({ currency: { value: "USD", confidence: 42 } })
    expect(parseExtractionResponse(raw)![0].data.confidence).toBe(1)
  })

  it("returns null for a non-JSON response", () => {
    expect(parseExtractionResponse("I could not read the contract.")).toBeNull()
  })

  it("ignores fields outside the requested set", () => {
    const raw = JSON.stringify({ title: { value: "MSA", confidence: 1 } })
    // `title` is a wizard-only field, absent from the default extraction set.
    expect(parseExtractionResponse(raw)).toEqual([])
  })
})
