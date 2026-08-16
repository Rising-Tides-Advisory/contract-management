/**
 * Deterministic field guesses from contract text.
 *
 * These run in pass 1 of the upload wizard, before any model call, so the
 * review form renders with something useful in well under a second regardless
 * of how long the document is. They are intentionally conservative: each match
 * is an unambiguous surface pattern, and every score is low enough that the
 * background AI pass overwrites it.
 *
 * Nothing here is authoritative — canonical fields are only ever written by a
 * human accepting a value in the review queue.
 */

import type { PreviewPrefill } from "@/lib/ai/preview-types"

/** Confidence assigned to a heuristic hit — low, and below any real AI score. */
const HEURISTIC_CONFIDENCE = 0.35

/**
 * Only look at the ends of the document. Governing-law and payment clauses sit
 * near the back, headline value near the front, and scanning the middle of a
 * 200-page exhibit set costs time for no accuracy.
 */
const SCAN_WINDOW_CHARS = 40_000

function scanWindow(text: string): string {
  if (text.length <= SCAN_WINDOW_CHARS * 2) return text
  return `${text.slice(0, SCAN_WINDOW_CHARS)}\n${text.slice(-SCAN_WINDOW_CHARS)}`
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
}

/** Title-case a filename stem: "master_services-agreement" → "Master Services Agreement". */
export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Extract what can be read off the text without a model.
 *
 * Returns the guesses plus a per-field confidence map, in the same shape the AI
 * pass returns so the wizard can merge them identically.
 */
export function heuristicPrefill(text: string): {
  prefill: PreviewPrefill
  confidence: Record<string, number>
} {
  const prefill: PreviewPrefill = {}
  const confidence: Record<string, number> = {}
  const window = scanWindow(text)

  const set = <K extends keyof PreviewPrefill>(key: K, value: PreviewPrefill[K]) => {
    prefill[key] = value
    confidence[key] = HEURISTIC_CONFIDENCE
  }

  // "Net 30", "net 45 days"
  const paymentTerms = window.match(/\bnet\s+(\d{1,3})\b/i)
  if (paymentTerms) set("paymentTerms", `Net ${paymentTerms[1]}`)

  // "governed by the laws of the State of Delaware"
  const governingLaw = window.match(
    /governed\s+by\s+(?:and\s+construed\s+in\s+accordance\s+with\s+)?the\s+laws\s+of\s+(?:the\s+)?([A-Z][^.,;\n]{2,60})/i,
  )
  if (governingLaw) set("governingLaw", governingLaw[1].trim())

  // An explicit auto-renewal clause. Checked against a negation first, because
  // "shall not automatically renew" is at least as common as the affirmative.
  if (/\b(?:shall|will|does)\s+not\s+(?:automatically\s+renew|auto-?renew)/i.test(window)) {
    set("autoRenewal", false)
  } else if (/\bautomatically\s+renew|\bauto-?renew(?:al|s|ed)?\b/i.test(window)) {
    set("autoRenewal", true)
  }

  // A currency-marked amount: "$1,250,000.00" or "USD 50,000".
  const symbolAmount = window.match(
    /([$£€¥])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/,
  )
  const codeAmount = window.match(
    /\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK|NZD|SGD|INR)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
  )

  if (codeAmount) {
    const amount = Number(codeAmount[2].replace(/,/g, ""))
    if (Number.isFinite(amount) && amount > 0) {
      set("value", amount)
      set("currency", codeAmount[1].toUpperCase())
    }
  } else if (symbolAmount) {
    const amount = Number(symbolAmount[2].replace(/,/g, ""))
    if (Number.isFinite(amount) && amount > 0) {
      set("value", amount)
      const code = CURRENCY_SYMBOLS[symbolAmount[1]]
      if (code) set("currency", code)
    }
  }

  return { prefill, confidence }
}
