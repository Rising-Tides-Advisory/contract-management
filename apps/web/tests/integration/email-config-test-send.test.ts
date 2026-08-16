/**
 * POST /api/org/email-config/test — the "is my email actually working" button.
 *
 * The whole point of this route is that it must not report success unless mail
 * really left the building. `sendEmail` is a deliberate no-op when nothing is
 * configured, so an unguarded route would cheerfully return 200 for the exact
 * broken setup an admin pressed the button to find. These tests pin that, plus
 * the role gate and the fact that the recipient is always the caller's own
 * account address rather than anything supplied in the request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { prisma } from "@/lib/db/client"
import { sendEmail } from "@/lib/email/transport"

const adminCtx = {
  userId: "user-admin",
  organizationId: "org-1",
  role: "admin",
  source: "session" as const,
  requestId: "test-request-id",
}

const { resolveAuth } = vi.hoisted(() => ({ resolveAuth: vi.fn() }))

vi.mock("@/lib/auth/middleware", () => ({
  resolveAuth,
  requireWriteScope: vi.fn(() => null),
}))

vi.mock("@/lib/email/transport", () => ({
  sendEmail: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: 0 })),
  rateLimitResponse: vi.fn(() => new Response("Too Many Requests", { status: 429 })),
}))

function post(body?: unknown): Request {
  return new Request("http://localhost/api/org/email-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe("POST /api/org/email-config/test", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuth.mockResolvedValue(adminCtx)
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      name: "Rising Tides",
    } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      name: "Ada Admin",
      email: "ada@rtadvisory.ca",
    } as never)
  })

  it("sends to the caller's own account address and reports the source", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ sent: true, source: "org" })

    const { POST } = await import("@/app/api/org/email-config/test/route")
    // A recipient in the body must be ignored — this route is not a relay.
    const res = await POST(post({ to: "someone-else@example.com" }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sentTo: "ada@rtadvisory.ca",
      source: "org",
    })

    const message = vi.mocked(sendEmail).mock.calls[0][0]
    expect(message.to).toBe("ada@rtadvisory.ca")
    expect(message.organizationId).toBe("org-1")
  })

  it("reports a 400 rather than success when nothing is configured", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ sent: false, source: null })

    const { POST } = await import("@/app/api/org/email-config/test/route")
    const res = await POST(post())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not configured/i)
  })

  it("surfaces the mail server's own rejection reason", async () => {
    const smtpError = Object.assign(new Error("Invalid login"), {
      response: "535 5.7.8 Error: authentication failed",
    })
    vi.mocked(sendEmail).mockRejectedValue(smtpError)

    const { POST } = await import("@/app/api/org/email-config/test/route")
    const res = await POST(post())

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.detail).toBe("535 5.7.8 Error: authentication failed")
  })

  it("rejects non-admin members", async () => {
    resolveAuth.mockResolvedValue({ ...adminCtx, role: "legal" })

    const { POST } = await import("@/app/api/org/email-config/test/route")
    const res = await POST(post())

    expect(res.status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated requests", async () => {
    resolveAuth.mockResolvedValue(null)

    const { POST } = await import("@/app/api/org/email-config/test/route")
    const res = await POST(post())

    expect(res.status).toBe(401)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("fails cleanly when the account has no email address", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)

    const { POST } = await import("@/app/api/org/email-config/test/route")
    const res = await POST(post())

    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
