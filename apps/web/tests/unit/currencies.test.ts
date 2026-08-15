import { describe, it, expect } from "vitest"
import {
  CurrencyCodeSchema,
  readCurrencySettings,
  isCurrencyCode,
} from "@/lib/currencies"
import { z } from "zod"

describe("CurrencyCodeSchema", () => {
  it("uppercases and trims", () => {
    expect(CurrencyCodeSchema.parse(" cad ")).toBe("CAD")
  })
  it("rejects OTHER — the bug that made contracts un-editable", () => {
    expect(CurrencyCodeSchema.safeParse("OTHER").success).toBe(false)
  })
  it("rejects empty / 2-letter / digits", () => {
    for (const bad of ["", "US", "USDD", "12", "U$D"])
      expect(CurrencyCodeSchema.safeParse(bad).success).toBe(false)
  })
  it("works with .default() and .nullable() and inside arrays", () => {
    expect(CurrencyCodeSchema.default("USD").parse(undefined)).toBe("USD")
    expect(CurrencyCodeSchema.nullable().parse(null)).toBe(null)
    expect(z.array(CurrencyCodeSchema).parse(["usd", "eur"])).toEqual(["USD", "EUR"])
  })
})

describe("readCurrencySettings", () => {
  it("falls back for empty metadata", () => {
    expect(readCurrencySettings({})).toEqual({
      enabled: ["USD", "EUR", "GBP", "JPY"],
      default: "USD",
    })
    expect(readCurrencySettings(null).default).toBe("USD")
  })
  it("reads a configured list", () => {
    expect(
      readCurrencySettings({ enabledCurrencies: ["CAD", "USD"], defaultCurrency: "CAD" }),
    ).toEqual({ enabled: ["CAD", "USD"], default: "CAD" })
  })
  it("ignores a default outside the enabled list", () => {
    expect(
      readCurrencySettings({ enabledCurrencies: ["CAD", "EUR"], defaultCurrency: "JPY" }),
    ).toEqual({ enabled: ["CAD", "EUR"], default: "CAD" })
  })
  it("survives junk", () => {
    expect(readCurrencySettings({ enabledCurrencies: "nope", defaultCurrency: 7 }).enabled)
      .toEqual(["USD", "EUR", "GBP", "JPY"])
    expect(readCurrencySettings({ enabledCurrencies: ["OTHER", 5, "cad"] }))
      .toEqual({ enabled: ["CAD"], default: "CAD" })
  })
})
