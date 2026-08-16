/**
 * What the search paths actually match.
 *
 * The regression these cover: every non-FTS path filtered on `title` alone, so
 * searching for a counterparty ("TELUS") returned nothing — on the contracts
 * list always, and on /api/search whenever the FTS query did not answer it
 * (including when the search_tsv column is missing, which throws).
 *
 * No live DB — Prisma is mocked, so the assertions are on the WHERE clauses
 * handed to Prisma rather than on rows returned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { prisma } from "@/lib/db/client"
import { _clearStore } from "@/lib/rate-limit"

vi.mock("@/lib/auth/middleware", () => ({
  resolveAuth: vi.fn().mockResolvedValue({
    userId: "user-1",
    organizationId: "org-1",
    role: "admin",
    source: "session" as const,
    requestId: "test-request-id",
  }),
  requireWriteScope: vi.fn(() => null),
}))

vi.mock("@/lib/context", () => ({
  requestContext: { run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()) },
}))

vi.mock("@/lib/posthog-server", () => ({
  captureServerEvent: vi.fn(),
}))

const telusContract = {
  id: "c1",
  title: "Business Services Agreement",
  contractType: "VENDOR",
  status: "ACTIVE",
  counterpartyName: "TELUS",
  value: null,
  currency: null,
  endDate: null,
  createdAt: new Date("2026-01-01"),
}

/** Pull the OR clause out of the WHERE that findMany was called with. */
function orFieldsOfLastFindMany(): string[] {
  const calls = vi.mocked(prisma.contract.findMany).mock.calls
  const where = (calls[calls.length - 1]?.[0] as { where?: { OR?: Record<string, unknown>[] } })?.where
  return (where?.OR ?? []).flatMap((clause) => Object.keys(clause))
}

describe("search matches the counterparty, not just the title", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearStore()
  })

  it("GET /api/contracts?search= matches title, counterparty and notes", async () => {
    vi.mocked(prisma.contract.findMany).mockResolvedValue([telusContract] as any)
    vi.mocked(prisma.contract.count).mockResolvedValue(1 as any)

    const { GET } = await import("@/app/api/contracts/route")
    const res = await GET(new Request("http://localhost/api/contracts?search=TELUS"))

    expect(res.status).toBe(200)
    expect(orFieldsOfLastFindMany()).toEqual(
      expect.arrayContaining(["title", "counterpartyName", "notes"]),
    )
  })

  it("GET /api/search falls back to a counterparty match when FTS throws", async () => {
    // Simulates a database without the search_tsv column / GIN index.
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('column "search_tsv" does not exist'))
    vi.mocked(prisma.contract.findMany).mockResolvedValue([telusContract] as any)
    vi.mocked(prisma.contract.count).mockResolvedValue(1 as any)

    const { GET } = await import("@/app/api/search/route")
    const res = await GET(new Request("http://localhost/api/search?q=TELUS"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].counterpartyName).toBe("TELUS")
    // The widened pass also reaches the unindexed document body.
    expect(orFieldsOfLastFindMany()).toEqual(
      expect.arrayContaining(["title", "counterpartyName", "notes", "extractedText"]),
    )
  })

  it("GET /api/search widens to a substring match when FTS returns nothing", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any)
    vi.mocked(prisma.contract.findMany).mockResolvedValue([telusContract] as any)
    vi.mocked(prisma.contract.count).mockResolvedValue(1 as any)

    const { GET } = await import("@/app/api/search/route")
    const res = await GET(new Request("http://localhost/api/search?q=TELU"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].id).toBe("c1")
  })

  it("short queries skip FTS and still match the counterparty", async () => {
    vi.mocked(prisma.contract.findMany).mockResolvedValue([telusContract] as any)
    vi.mocked(prisma.contract.count).mockResolvedValue(1 as any)

    const { GET } = await import("@/app/api/search/route")
    const res = await GET(new Request("http://localhost/api/search?q=TE"))

    expect(res.status).toBe(200)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(orFieldsOfLastFindMany()).toEqual(
      expect.arrayContaining(["title", "counterpartyName", "notes"]),
    )
  })

  it("archived contracts stay out of the fallback results", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("no search_tsv"))
    vi.mocked(prisma.contract.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.contract.count).mockResolvedValue(0 as any)

    const { GET } = await import("@/app/api/search/route")
    await GET(new Request("http://localhost/api/search?q=TELUS"))

    const calls = vi.mocked(prisma.contract.findMany).mock.calls
    const where = calls[calls.length - 1]?.[0] as {
      where?: { organizationId?: string; status?: { not?: string } }
    }
    expect(where?.where?.status).toEqual({ not: "ARCHIVED" })
    expect(where?.where?.organizationId).toBe("org-1")
  })
})
