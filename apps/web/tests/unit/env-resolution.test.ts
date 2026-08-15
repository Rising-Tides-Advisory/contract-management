/**
 * Unit tests for provider env-var alias resolution.
 *
 * Covers lib/env.ts, lib/db/connection.ts, and the Postmark/SMTP selection in
 * lib/email/transport.ts. The point of these aliases is that a deployment can use
 * the variable names its provider already injects (Vercel↔Supabase, Cloudflare R2)
 * without re-keying them — so the tests assert both the aliases and the precedence
 * of the canonical names over them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { env, isServerless } from "@/lib/env"
import { getDatabaseUrl, getDirectDatabaseUrl, getPoolSize } from "@/lib/db/connection"
import { isEmailConfigured, getFromAddress } from "@/lib/email/transport"

const MANAGED_KEYS = [
  "VERCEL",
  "DATABASE_URL",
  "DIRECT_URL",
  "DATABASE_POOL_SIZE",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTMARK_SERVER_TOKEN",
  "POSTMARK_API_TOKEN",
  "POSTMARK_TOKEN",
  "POSTMARK_API_KEY",
  "SMTP_HOST",
  "SMTP_FROM",
  "EMAIL_FROM",
  "POSTMARK_FROM",
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_KEYS.map((k) => [k, process.env[k]]))
  for (const k of MANAGED_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("env()", () => {
  it("returns the first name that is set", () => {
    process.env.POSTGRES_URL = "second"
    expect(env("DATABASE_URL", "POSTGRES_URL")).toBe("second")
  })

  it("prefers the canonical name over its aliases", () => {
    process.env.DATABASE_URL = "canonical"
    process.env.POSTGRES_PRISMA_URL = "alias"
    expect(env("DATABASE_URL", "POSTGRES_PRISMA_URL")).toBe("canonical")
  })

  it("treats empty and whitespace-only values as unset", () => {
    process.env.DATABASE_URL = ""
    process.env.POSTGRES_PRISMA_URL = "   "
    process.env.POSTGRES_URL = "real"
    expect(env("DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL")).toBe("real")
  })

  it("returns undefined when nothing is set", () => {
    expect(env("DATABASE_URL", "POSTGRES_URL")).toBeUndefined()
  })
})

describe("database connection resolution", () => {
  it("falls back to the Vercel↔Supabase injected names", () => {
    process.env.POSTGRES_PRISMA_URL = "pooled"
    process.env.POSTGRES_URL_NON_POOLING = "direct"
    expect(getDatabaseUrl()).toBe("pooled")
    expect(getDirectDatabaseUrl()).toBe("direct")
  })

  it("falls back to the pooled URL when no direct URL is configured", () => {
    process.env.DATABASE_URL = "only-one"
    expect(getDirectDatabaseUrl()).toBe("only-one")
  })

  it("keeps the direct URL separate from the pooled one when both are set", () => {
    process.env.DATABASE_URL = "pooler:6543"
    process.env.DIRECT_URL = "direct:5432"
    expect(getDatabaseUrl()).toBe("pooler:6543")
    expect(getDirectDatabaseUrl()).toBe("direct:5432")
  })

  it("returns an empty string rather than undefined when unconfigured", () => {
    expect(getDatabaseUrl()).toBe("")
  })
})

describe("pool sizing", () => {
  it("defaults to 1 on Vercel so concurrent lambdas do not exhaust the pooler", () => {
    process.env.VERCEL = "1"
    expect(isServerless()).toBe(true)
    expect(getPoolSize()).toBe(1)
  })

  it("defaults to 20 for long-lived processes", () => {
    expect(isServerless()).toBe(false)
    expect(getPoolSize()).toBe(20)
  })

  it("honours an explicit override on Vercel", () => {
    process.env.VERCEL = "1"
    process.env.DATABASE_POOL_SIZE = "5"
    expect(getPoolSize()).toBe(5)
  })

  it("ignores non-numeric and non-positive overrides", () => {
    process.env.DATABASE_POOL_SIZE = "not-a-number"
    expect(getPoolSize()).toBe(20)
    process.env.DATABASE_POOL_SIZE = "0"
    expect(getPoolSize()).toBe(20)
  })
})

describe("email configuration", () => {
  it("is disabled when neither Postmark nor SMTP is configured", () => {
    expect(isEmailConfigured()).toBe(false)
  })

  it("is enabled by a Postmark server token alone", () => {
    process.env.POSTMARK_SERVER_TOKEN = "pm-token"
    expect(isEmailConfigured()).toBe(true)
  })

  it.each([
    "POSTMARK_SERVER_TOKEN",
    "POSTMARK_API_TOKEN",
    "POSTMARK_TOKEN",
    "POSTMARK_API_KEY",
  ])("accepts %s as the Postmark credential", (name) => {
    process.env[name] = "pm-token"
    expect(isEmailConfigured()).toBe(true)
  })

  it("is enabled by SMTP_HOST alone", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    expect(isEmailConfigured()).toBe(true)
  })

  it("still honours SMTP_FROM as an alias for EMAIL_FROM", () => {
    process.env.SMTP_FROM = "legacy@example.com"
    expect(getFromAddress()).toBe("legacy@example.com")
  })

  it("prefers EMAIL_FROM over SMTP_FROM", () => {
    process.env.EMAIL_FROM = "new@example.com"
    process.env.SMTP_FROM = "legacy@example.com"
    expect(getFromAddress()).toBe("new@example.com")
  })
})
