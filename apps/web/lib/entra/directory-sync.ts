/**
 * Directory sync — pulls the tenant's member list into EntraDirectoryUser.
 *
 * The synced snapshot is what powers the responsible-party picker and the
 * notification escalation path, so it has to answer two questions offline:
 * "who works here?" and "who do they report to?". Doing that live against
 * Graph on every notification would put a third-party API in the critical
 * path of an email that must go out.
 *
 * Runs from the daily cron and from the manual "Sync now" button.
 */
import type { PrismaClient } from "@prisma/client"
import { GraphError, fetchDirectoryUsers, type GraphDirectoryUser } from "@/lib/entra/graph"
import { logger } from "@/lib/logger"

export type SyncResult = {
  synced: number
  linked: number
  deactivated: number
  truncated: boolean
}

type SyncableIntegration = {
  id: string
  organizationId: string
  clientId: string
  encryptedSecret: string
  tenantId: string | null
}

/**
 * Sync one organization's directory. Writes the outcome back onto the
 * integration row so the settings page can show it, then rethrows so the
 * caller (cron job or API route) can decide how loud to be about a failure.
 */
export async function syncDirectory(
  db: PrismaClient,
  integration: SyncableIntegration,
): Promise<SyncResult> {
  try {
    const { users, truncated } = await fetchDirectoryUsers(integration)
    const result = await persistDirectory(db, integration, users, truncated)

    await db.entraIntegration.update({
      where: { id: integration.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: "success",
        lastSyncError: null,
        lastSyncUserCount: result.synced,
      },
    })

    logger.info(
      { organizationId: integration.organizationId, ...result },
      "[entra.sync] directory synced",
    )
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.entraIntegration
      .update({
        where: { id: integration.id },
        data: {
          lastSyncedAt: new Date(),
          lastSyncStatus: "error",
          lastSyncError: message.slice(0, 500),
          // A 401/403 means consent was revoked or the secret rotated. Clearing
          // the consent timestamp is what flips the UI back to "Reconnect" and
          // stops SSO from sending people to a tenant that will reject them.
          ...(err instanceof GraphError && err.needsReconsent
            ? { consentGrantedAt: null, consentError: message.slice(0, 500) }
            : {}),
        },
      })
      .catch(() => {})
    throw err
  }
}

async function persistDirectory(
  db: PrismaClient,
  integration: SyncableIntegration,
  users: GraphDirectoryUser[],
  truncated: boolean,
): Promise<SyncResult> {
  // Members of this org, keyed by lowercased email, so a directory user can be
  // linked to the ClauseFlow account that already exists for the same person.
  const members = await db.member.findMany({
    where: { organizationId: integration.organizationId },
    select: { user: { select: { id: true, email: true } } },
  })
  const userIdByEmail = new Map(
    members.map((m) => [m.user.email.toLowerCase(), m.user.id] as const),
  )

  // Stamped on every row this run touches, then used to find the rows it did
  // not — cheaper and far more robust than a `notIn` list of every object id in
  // a large tenant.
  const syncStartedAt = new Date()

  let linked = 0
  let seen = 0
  const pending: ReturnType<typeof db.entraDirectoryUser.upsert>[] = []

  // Prisma has no bulk upsert, and a 5,000-person tenant issued one row at a
  // time is 5,000 sequential round trips. Batching through $transaction sends
  // each chunk in one round trip instead, which is the difference between a
  // sync that finishes inside a request and one that times out.
  const CHUNK = 100
  async function flush() {
    if (pending.length === 0) return
    await db.$transaction(pending.splice(0, pending.length))
  }

  for (const u of users) {
    seen++

    // Graph exposes two addresses and they can differ: `mail` is the mailbox,
    // `userPrincipalName` is the sign-in name. Match on either, mailbox first,
    // because that is what a ClauseFlow account is normally created with.
    const candidates = [u.mail, u.userPrincipalName]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase())
    const userId = candidates.map((c) => userIdByEmail.get(c)).find(Boolean) ?? null
    if (userId) linked++

    const fields = {
      organizationId: integration.organizationId,
      userPrincipalName: u.userPrincipalName,
      displayName: u.displayName ?? u.userPrincipalName,
      mail: u.mail,
      jobTitle: u.jobTitle,
      department: u.department,
      officeLocation: u.officeLocation,
      accountEnabled: u.accountEnabled ?? true,
      managerObjectId: u.managerObjectId,
      lastSyncedAt: syncStartedAt,
    }

    pending.push(
      db.entraDirectoryUser.upsert({
        where: { integrationId_objectId: { integrationId: integration.id, objectId: u.id } },
        create: { integrationId: integration.id, objectId: u.id, userId, ...fields },
        // Only overwrite the link when we found one: an SSO sign-in also sets
        // userId (by object id, which is more reliable than an email match), and
        // a sync must not undo that just because the mailbox address differs.
        update: { ...fields, ...(userId ? { userId } : {}) },
      }),
    )
    if (pending.length >= CHUNK) await flush()
  }
  await flush()

  // People who vanished from the directory are marked disabled rather than
  // deleted. Deleting them would null out Contract.responsiblePartyId and
  // silently erase who was accountable for a contract — exactly the history
  // this feature exists to keep. Disabled rows still resolve, and the
  // notification path escalates past them to their manager.
  //
  // Skipped when the fetch was truncated: a partial page would look exactly
  // like "everyone else left" and disable most of the directory.
  let deactivated = 0
  if (!truncated && seen > 0) {
    const res = await db.entraDirectoryUser.updateMany({
      where: {
        integrationId: integration.id,
        lastSyncedAt: { lt: syncStartedAt },
        accountEnabled: true,
      },
      data: { accountEnabled: false },
    })
    deactivated = res.count
  }

  return { synced: users.length, linked, deactivated, truncated }
}
