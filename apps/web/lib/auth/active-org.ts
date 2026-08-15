/**
 * Which organization should a freshly created session start in?
 *
 * Better Auth's organization plugin only writes `Session.activeOrganizationId`
 * when something calls `setActive()` — which happens at org creation, when an
 * invitation is accepted, and in org settings. A plain email sign-in never
 * does, so every session created by logging in started with a null active org.
 *
 * Server-side that was invisible: resolveAuth() falls back to the user's first
 * membership. The client has no such fallback — `useActiveOrganization()`
 * returns null and the app layout shows its "No organization yet" holding
 * screen. The result was that an existing member who logged out and back in
 * was told to create an organization they already belonged to.
 *
 * This mirrors resolveAuth()'s fallback (oldest membership first) so the two
 * can never disagree about which org a session belongs to.
 */
import type { PrismaClient } from "@prisma/client"

export async function resolveDefaultOrganizationId(
  db: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string | null> {
  const member = await db.member.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  })
  return member?.organizationId ?? null
}
