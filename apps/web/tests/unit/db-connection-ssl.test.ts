import { describe, it, expect } from "vitest"
import { pinSslVerification } from "@/lib/db/connection"

describe("pinSslVerification", () => {
  it("pins the modes pg aliases to verify-full", () => {
    for (const mode of ["require", "prefer", "verify-ca"]) {
      const out = pinSslVerification(`postgresql://u:p@h.neon.tech:5432/db?sslmode=${mode}`)
      expect(new URL(out).searchParams.get("sslmode")).toBe("verify-full")
    }
  })

  it("leaves an already-explicit mode alone", () => {
    const url = "postgresql://u:p@h/db?sslmode=verify-full"
    expect(pinSslVerification(url)).toBe(url)
    const off = "postgresql://u:p@h/db?sslmode=disable"
    expect(pinSslVerification(off)).toBe(off)
  })

  it("leaves a URL with no sslmode alone — plain local Postgres", () => {
    const url = "postgresql://u:p@localhost:5432/db"
    expect(pinSslVerification(url)).toBe(url)
  })

  it("respects an explicit libpq-compat opt-in", () => {
    const url = "postgresql://u:p@h/db?uselibpqcompat=true&sslmode=require"
    expect(pinSslVerification(url)).toBe(url)
  })

  it("preserves other query params and credentials", () => {
    const out = pinSslVerification(
      "postgresql://user:pa%23ss@h.neon.tech/db?sslmode=require&connect_timeout=10&channel_binding=require",
    )
    const u = new URL(out)
    expect(u.searchParams.get("connect_timeout")).toBe("10")
    expect(u.searchParams.get("channel_binding")).toBe("require")
    expect(u.password).toBe("pa%23ss")
    expect(u.username).toBe("user")
  })

  it("hands back anything unparseable untouched", () => {
    expect(pinSslVerification("not a url")).toBe("not a url")
    expect(pinSslVerification("")).toBe("")
  })
})
