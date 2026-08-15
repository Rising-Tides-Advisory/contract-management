import { describe, it, expect } from "vitest"
import { defaultModelFor, isKnownModel, MODEL_OPTIONS } from "@/lib/ai/models"

describe("model catalog", () => {
  it("defaults to the cheapest model per provider", () => {
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-4-5")
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini")
    expect(defaultModelFor("ollama")).toBe("llama3")
  })
  it("no longer offers or defaults to the retired claude-3-5-haiku", () => {
    const ids = MODEL_OPTIONS.anthropic.map((m) => m.value)
    expect(ids).not.toContain("claude-3-5-haiku-latest")
    expect(ids).toContain("claude-haiku-4-5")
    expect(isKnownModel("anthropic", "claude-3-5-haiku-latest")).toBe(false)
    expect(isKnownModel("anthropic", "claude-opus-5")).toBe(true)
  })
})
