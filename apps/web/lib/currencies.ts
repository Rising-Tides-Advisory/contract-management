/**
 * Currency codes, and the org-configurable subset of them.
 *
 * Before this file the picker was a hardcoded `["USD", "EUR", "GBP", "JPY",
 * "OTHER"]` copy-pasted into two pages, and "OTHER" was not a currency at all —
 * it was five characters long, so choosing it and then editing the contract sent
 * `currency: "OTHER"` to `PATCH /api/contracts/[id]`, whose schema requires
 * exactly three characters, and the save failed with a 422. The create route
 * accepted it (its schema allowed up to ten characters), which is why the bug
 * only appeared on the second save.
 *
 * Now: orgs pick which currencies they use and which is the default, the picker
 * renders only those, and every route validates the same way.
 */

import { z } from "zod"

export interface Currency {
  code: string
  name: string
  /** Symbol for display; falls back to the code where there is no common one. */
  symbol: string
}

/**
 * ISO 4217 codes offered in the settings picker.
 *
 * Not the complete ~180-code register — that is unusable as a list and the tail
 * of it is currencies no contract in this system will be denominated in. These
 * are the actively traded ones. A code outside this list can still be stored
 * through the API; the list governs what the UI offers.
 */
export const CURRENCIES: Currency[] = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
  { code: "CNY", name: "Chinese Yuan", symbol: "CN¥" },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr" },
  { code: "DKK", name: "Danish Krone", symbol: "kr" },
  { code: "PLN", name: "Polish Złoty", symbol: "zł" },
  { code: "CZK", name: "Czech Koruna", symbol: "Kč" },
  { code: "HUF", name: "Hungarian Forint", symbol: "Ft" },
  { code: "RON", name: "Romanian Leu", symbol: "lei" },
  { code: "TRY", name: "Turkish Lira", symbol: "₺" },
  { code: "ILS", name: "Israeli Shekel", symbol: "₪" },
  { code: "AED", name: "UAE Dirham", symbol: "AED" },
  { code: "SAR", name: "Saudi Riyal", symbol: "SAR" },
  { code: "QAR", name: "Qatari Riyal", symbol: "QAR" },
  { code: "ZAR", name: "South African Rand", symbol: "R" },
  { code: "NGN", name: "Nigerian Naira", symbol: "₦" },
  { code: "KES", name: "Kenyan Shilling", symbol: "KSh" },
  { code: "EGP", name: "Egyptian Pound", symbol: "E£" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$" },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$" },
  { code: "ARS", name: "Argentine Peso", symbol: "AR$" },
  { code: "CLP", name: "Chilean Peso", symbol: "CLP" },
  { code: "COP", name: "Colombian Peso", symbol: "COP" },
  { code: "KRW", name: "South Korean Won", symbol: "₩" },
  { code: "TWD", name: "Taiwan Dollar", symbol: "NT$" },
  { code: "THB", name: "Thai Baht", symbol: "฿" },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM" },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp" },
  { code: "PHP", name: "Philippine Peso", symbol: "₱" },
  { code: "VND", name: "Vietnamese Dong", symbol: "₫" },
  { code: "PKR", name: "Pakistani Rupee", symbol: "₨" },
  { code: "BDT", name: "Bangladeshi Taka", symbol: "৳" },
  { code: "UAH", name: "Ukrainian Hryvnia", symbol: "₴" },
  { code: "ISK", name: "Icelandic Króna", symbol: "kr" },
]

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]))

/**
 * What an org gets before anyone opens the settings screen.
 *
 * Deliberately identical to the old hardcoded picker (minus the bogus "OTHER"),
 * so existing orgs see no change until they choose to configure it.
 */
export const DEFAULT_ENABLED_CURRENCIES = ["USD", "EUR", "GBP", "JPY"]
export const FALLBACK_CURRENCY = "USD"

/**
 * Any three uppercase letters — not membership of `CURRENCIES`.
 *
 * The API has always accepted arbitrary codes and contracts may already be
 * stored with one that is not on the list above; tightening validation to the
 * curated list would make those rows un-editable. Shape is what gets enforced.
 */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 currency code")

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value.trim().toUpperCase())
}

export function currencyName(code: string): string {
  return BY_CODE.get(code)?.name ?? code
}

/** "USD — US Dollar", or just the code for anything off the curated list. */
export function currencyLabel(code: string): string {
  const c = BY_CODE.get(code)
  return c ? `${c.code} — ${c.name}` : code
}

// ─── Org settings ─────────────────────────────────────────────────────────────

export interface OrgCurrencySettings {
  enabled: string[]
  default: string
}

/**
 * Reads the currency settings out of an org's metadata blob.
 *
 * Tolerant by design — metadata is free-form JSON that predates this feature,
 * so anything unparseable, empty, or the wrong type falls back to the defaults
 * rather than throwing inside a request handler.
 */
export function readCurrencySettings(
  meta: Record<string, unknown> | null | undefined,
): OrgCurrencySettings {
  const rawEnabled = meta?.enabledCurrencies
  const enabled =
    Array.isArray(rawEnabled) && rawEnabled.length > 0
      ? rawEnabled.filter(isCurrencyCode).map((c) => c.toUpperCase())
      : []

  const list = enabled.length > 0 ? enabled : [...DEFAULT_ENABLED_CURRENCIES]

  const rawDefault = meta?.defaultCurrency
  const preferred =
    isCurrencyCode(rawDefault) ? (rawDefault as string).toUpperCase() : null

  // The default must be one the org actually uses, or the create form would
  // preselect a currency its own picker does not offer.
  const fallback = list.includes(FALLBACK_CURRENCY) ? FALLBACK_CURRENCY : list[0]

  return {
    enabled: list,
    default: preferred && list.includes(preferred) ? preferred : fallback,
  }
}
