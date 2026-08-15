import { describe, expect, it, vi } from "vitest"
import { resolveDefaultOrganizationId } from "@/lib/auth/active-org"

type Db = Parameters<typeof resolveDefaultOrganizationId>[0]

function fakeDb(rows: { organizationId: string }[]): { db: Db; findFirst: ReturnType<typeof vi.fn> } {
  const findFirst = vi.fn(async () => rows[0] ?? null)
  return { db: { member: { findFirst } } as unknown as Db, findFirst }
}

describe("resolveDefaultOrganizationId", () => {
  it("returns the user's organization so a fresh session starts inside it", async () => {
    const { db } = fakeDb([{ organizationId: "org-1" }])
    expect(await resolveDefaultOrganizationId(db, "user-1")).toBe("org-1")
  })

  it("returns null for a user with no memberships", async () => {
    const { db } = fakeDb([])
    expect(await resolveDefaultOrganizationId(db, "user-1")).toBeNull()
  })

  it("picks the oldest membership, matching resolveAuth's server-side fallback", async () => {
    // If these two disagreed, the org the UI shows and the org the API writes
    // to could differ for a multi-org user — the worst possible outcome.
    const { db, findFirst } = fakeDb([{ organizationId: "org-oldest" }])
    await resolveDefaultOrganizationId(db, "user-1")
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        orderBy: { createdAt: "asc" },
      }),
    )
  })
})
