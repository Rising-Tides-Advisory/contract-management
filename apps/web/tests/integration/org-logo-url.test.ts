/**
 * PATCH /api/org must accept the logo URL that POST /api/org/logo hands back.
 *
 * The upload route returns `/api/org/logo?key=...` — a root-relative path,
 * because the object lives in private storage and is streamed back through an
 * authenticated route rather than exposed publicly. The org schema validated
 * with `z.string().url()`, which rejects relative paths, so uploading a logo and
 * pressing Save Changes returned 422 and the UI showed "Failed to update
 * organization". The logo still appeared on screen, because the client had set
 * it locally from the upload response — so nothing looked wrong until reload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { prisma } from "@/lib/db/client"

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

vi.mock("@/lib/context", () => ({
  requestContext: { run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()) },
}))

function patch(body: unknown): Request {
  return new Request("http://localhost/api/org", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /api/org — logo", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      metadata: null,
    } as never)
    vi.mocked(prisma.organization.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        id: "org-1",
        name: "Rising Tides Advisory",
        logo: args.data.logo ?? null,
        metadata: args.data.metadata ?? null,
      })) as never,
    )
  })

  it("accepts the root-relative path the upload route returns", async () => {
    const { PATCH } = await import("@/app/api/org/route")
    const logo = "/api/org/logo?key=orgs%2Forg-1%2Flogo%2F1755283200000_wave.png"

    const res = await PATCH(patch({ name: "Rising Tides Advisory Inc", logo }))

    expect(res.status).toBe(200)
    const args = vi.mocked(prisma.organization.update).mock.calls[0][0]
    expect(args.data.logo).toBe(logo)
  })

  it("still accepts an absolute https URL — an external CDN", async () => {
    const { PATCH } = await import("@/app/api/org/route")
    const logo = "https://cdn.example.com/logo.png"

    const res = await PATCH(patch({ logo }))
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.organization.update).mock.calls[0][0].data.logo).toBe(logo)
  })

  it("accepts null to clear the logo", async () => {
    const { PATCH } = await import("@/app/api/org/route")
    const res = await PATCH(patch({ logo: null }))
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.organization.update).mock.calls[0][0].data.logo).toBeNull()
  })

  it.each([
    ["protocol-relative", "//evil.example.com/logo.png"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["bare text", "not-a-url"],
  ])("rejects %s — this renders into an <img src>", async (_label, logo) => {
    const { PATCH } = await import("@/app/api/org/route")
    const res = await PATCH(patch({ logo }))

    expect(res.status).toBe(422)
    expect(prisma.organization.update).not.toHaveBeenCalled()
  })
})
