/**
 * Editing org settings must not destroy the credential you cannot re-read.
 *
 * Neither GET returns the stored API key or Postmark token, so if a write path
 * requires it, the only way to change an adjacent field — the AI model, the
 * From address — is to fetch the secret out of the provider's dashboard again.
 * Both routes previously did exactly that.
 *
 * These tests pin the contract: omit the credential and the stored one survives
 * untouched; supply one and it is re-encrypted; omit it when there is nothing
 * stored (or when the provider changed) and the request is rejected rather than
 * writing an empty secret.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { prisma } from "@/lib/db/client"
import { encrypt } from "@/lib/notifications/crypto"

const adminCtx = {
  userId: "user-admin",
  organizationId: "org-1",
  role: "admin",
  source: "session" as const,
  requestId: "test-request-id",
}

vi.mock("@/lib/auth/middleware", () => ({
  resolveAuth: vi.fn(() => Promise.resolve(adminCtx)),
  requireWriteScope: vi.fn(() => null),
}))

vi.mock("@/lib/notifications/crypto", () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace("enc:", "")),
}))

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

// ─── AI config ────────────────────────────────────────────────────────────────

describe("POST /api/org/ai-config — changing the model only", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the stored key when apiKey is omitted", async () => {
    vi.mocked(prisma.orgAiConfig.findUnique).mockResolvedValue({
      provider: "anthropic",
    } as never)
    vi.mocked(prisma.orgAiConfig.update).mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
    } as never)

    const { POST } = await import("@/app/api/org/ai-config/route")
    const res = await POST(
      post("http://localhost/api/org/ai-config", {
        provider: "anthropic",
        model: "claude-opus-5",
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ model: "claude-opus-5", hasKey: true })

    // The upsert path would have written encryptedKey; update must not.
    expect(prisma.orgAiConfig.upsert).not.toHaveBeenCalled()
    expect(encrypt).not.toHaveBeenCalled()

    const args = vi.mocked(prisma.orgAiConfig.update).mock.calls[0][0]
    expect(args.data).not.toHaveProperty("encryptedKey")
    expect(args.data).toMatchObject({ provider: "anthropic", model: "claude-opus-5" })
  })

  it("still re-encrypts when a new key is supplied", async () => {
    vi.mocked(prisma.orgAiConfig.findUnique).mockResolvedValue({
      provider: "anthropic",
    } as never)
    vi.mocked(prisma.orgAiConfig.upsert).mockResolvedValue({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    } as never)

    const { POST } = await import("@/app/api/org/ai-config/route")
    const res = await POST(
      post("http://localhost/api/org/ai-config", {
        provider: "anthropic",
        apiKey: "sk-ant-new",
        model: "claude-haiku-4-5",
      }),
    )

    expect(res.status).toBe(200)
    expect(encrypt).toHaveBeenCalledWith("sk-ant-new")
    const args = vi.mocked(prisma.orgAiConfig.upsert).mock.calls[0][0]
    expect(args.update).toMatchObject({ encryptedKey: "enc:sk-ant-new" })
    expect(prisma.orgAiConfig.update).not.toHaveBeenCalled()
  })

  it("rejects an omitted key when nothing is stored yet", async () => {
    vi.mocked(prisma.orgAiConfig.findUnique).mockResolvedValue(null)

    const { POST } = await import("@/app/api/org/ai-config/route")
    const res = await POST(
      post("http://localhost/api/org/ai-config", {
        provider: "anthropic",
        model: "claude-opus-5",
      }),
    )

    expect(res.status).toBe(400)
    expect(prisma.orgAiConfig.update).not.toHaveBeenCalled()
    expect(prisma.orgAiConfig.upsert).not.toHaveBeenCalled()
  })

  it("rejects an omitted key when switching provider — an Anthropic key is not an OpenAI key", async () => {
    vi.mocked(prisma.orgAiConfig.findUnique).mockResolvedValue({
      provider: "anthropic",
    } as never)

    const { POST } = await import("@/app/api/org/ai-config/route")
    const res = await POST(
      post("http://localhost/api/org/ai-config", {
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    )

    expect(res.status).toBe(400)
    expect(prisma.orgAiConfig.update).not.toHaveBeenCalled()
    expect(prisma.orgAiConfig.upsert).not.toHaveBeenCalled()
  })
})

// ─── Email config ─────────────────────────────────────────────────────────────

describe("POST /api/org/email-config — changing the From address only", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the stored token when serverToken is omitted", async () => {
    vi.mocked(prisma.orgEmailConfig.findUnique).mockResolvedValue({
      organizationId: "org-1",
    } as never)
    vi.mocked(prisma.orgEmailConfig.update).mockResolvedValue({
      fromAddress: "billing@rtadvisory.ca",
      messageStream: "outbound",
    } as never)

    const { POST } = await import("@/app/api/org/email-config/route")
    const res = await POST(
      post("http://localhost/api/org/email-config", {
        fromAddress: "billing@rtadvisory.ca",
      }),
    )

    expect(res.status).toBe(200)
    expect(prisma.orgEmailConfig.upsert).not.toHaveBeenCalled()
    expect(encrypt).not.toHaveBeenCalled()

    const args = vi.mocked(prisma.orgEmailConfig.update).mock.calls[0][0]
    expect(args.data).not.toHaveProperty("encryptedToken")
    expect(args.data).toMatchObject({ fromAddress: "billing@rtadvisory.ca" })
  })

  it("still re-encrypts when a new token is supplied", async () => {
    vi.mocked(prisma.orgEmailConfig.findUnique).mockResolvedValue({
      organizationId: "org-1",
    } as never)
    vi.mocked(prisma.orgEmailConfig.upsert).mockResolvedValue({
      fromAddress: "a@b.co",
      messageStream: null,
    } as never)

    const { POST } = await import("@/app/api/org/email-config/route")
    const res = await POST(
      post("http://localhost/api/org/email-config", {
        serverToken: "pm-token-2",
        fromAddress: "a@b.co",
      }),
    )

    expect(res.status).toBe(200)
    expect(encrypt).toHaveBeenCalledWith("pm-token-2")
    expect(prisma.orgEmailConfig.update).not.toHaveBeenCalled()
  })

  it("rejects an omitted token when nothing is stored yet", async () => {
    vi.mocked(prisma.orgEmailConfig.findUnique).mockResolvedValue(null)

    const { POST } = await import("@/app/api/org/email-config/route")
    const res = await POST(
      post("http://localhost/api/org/email-config", { fromAddress: "a@b.co" }),
    )

    expect(res.status).toBe(400)
    expect(prisma.orgEmailConfig.update).not.toHaveBeenCalled()
    expect(prisma.orgEmailConfig.upsert).not.toHaveBeenCalled()
  })
})
