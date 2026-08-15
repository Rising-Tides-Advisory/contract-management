/**
 * "Who is responsible for this contract?" — answered from the Entra directory.
 *
 * Resolution order:
 *   1. Contract.responsibleParty  — an explicit directory pick, when set.
 *   2. The directory user linked to Contract.owner — the common case, and the
 *      reason linking exists: the owner is a ClauseFlow account, but the
 *      mailbox and the reporting line only exist in Entra.
 *
 * Escalation to the manager happens when the responsible person cannot be
 * reached — their account is disabled, or they have dropped out of the
 * directory entirely — and optionally on the two events that mean nobody
 * acted in time (`contract.expired`, `obligation.overdue`).
 *
 * Returns an empty list for orgs with no Entra integration; callers keep their
 * existing owner-based behaviour in that case, so nothing regresses for orgs
 * that never connect a tenant.
 */
import type { PrismaClient } from "@prisma/client"

export type ResponsibleRecipient = {
  /** EntraDirectoryUser id — the unsubscribe key for people with no account. */
  directoryUserId: string
  /** Mailbox to notify — the directory `mail`, falling back to the UPN. */
  email: string
  displayName: string | null
  /** Linked ClauseFlow user, when this person has an account. */
  userId: string | null
  /** Why this person is on the list — surfaced in logs and the webhook payload. */
  reason: "responsible_party" | "owner_directory" | "manager_escalation"
}

type DirectoryRow = {
  id: string
  objectId: string
  displayName: string
  mail: string | null
  userPrincipalName: string
  accountEnabled: boolean
  notifyEnabled: boolean
  managerObjectId: string | null
  userId: string | null
}

const DIRECTORY_SELECT = {
  id: true,
  objectId: true,
  displayName: true,
  mail: true,
  userPrincipalName: true,
  accountEnabled: true,
  notifyEnabled: true,
  managerObjectId: true,
  userId: true,
} as const

/** Directory `mail` is the mailbox; the UPN is a usable address for work accounts. */
function addressOf(row: DirectoryRow): string | null {
  const candidate = row.mail?.trim() || row.userPrincipalName?.trim()
  return candidate && candidate.includes("@") ? candidate.toLowerCase() : null
}

/**
 * Events where the responsible party has demonstrably not acted, so the person
 * they report to should hear about it even though the responsible party is
 * perfectly reachable.
 */
const ESCALATING_EVENTS = new Set(["contract.expired", "obligation.overdue"])

export function shouldEscalateToManager(eventName: string): boolean {
  return ESCALATING_EVENTS.has(eventName)
}

export async function resolveResponsibleRecipients(
  db: PrismaClient,
  contractId: string,
  opts: { includeManager?: boolean } = {},
): Promise<ResponsibleRecipient[]> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: {
      organizationId: true,
      ownerId: true,
      responsiblePartyId: true,
      responsibleParty: { select: DIRECTORY_SELECT },
    },
  })
  if (!contract) return []

  let primary: DirectoryRow | null = contract.responsibleParty ?? null
  let reason: ResponsibleRecipient["reason"] = "responsible_party"

  if (!primary) {
    primary = await db.entraDirectoryUser.findFirst({
      where: { organizationId: contract.organizationId, userId: contract.ownerId },
      select: DIRECTORY_SELECT,
    })
    reason = "owner_directory"
  }

  // No directory row for either — org has no Entra integration, or this person
  // simply is not in the synced tenant. Caller falls back to owner-by-account.
  if (!primary) return []

  const recipients: ResponsibleRecipient[] = []
  const primaryAddress = addressOf(primary)
  const primaryReachable = primary.accountEnabled && !!primaryAddress

  // notifyEnabled is an opt-out, not an escalation trigger: someone who
  // unsubscribed is still the responsible party, so we drop them from the
  // recipient list without promoting their manager in their place.
  if (primaryReachable && primaryAddress && primary.notifyEnabled) {
    recipients.push({
      directoryUserId: primary.id,
      email: primaryAddress,
      displayName: primary.displayName,
      userId: primary.userId,
      reason,
    })
  }

  const needsEscalation = !primaryReachable || opts.includeManager === true
  if (needsEscalation && primary.managerObjectId) {
    const manager = await db.entraDirectoryUser.findFirst({
      where: {
        organizationId: contract.organizationId,
        objectId: primary.managerObjectId,
      },
      select: DIRECTORY_SELECT,
    })
    const managerAddress = manager ? addressOf(manager) : null
    // A disabled manager is a dead end rather than a chain to walk: reporting
    // lines in a tenant mid-reorg loop back on themselves often enough that
    // following them recursively is a worse failure than stopping here.
    if (manager?.accountEnabled && manager.notifyEnabled && managerAddress) {
      recipients.push({
        directoryUserId: manager.id,
        email: managerAddress,
        displayName: manager.displayName,
        userId: manager.userId,
        reason: "manager_escalation",
      })
    }
  }

  return dedupeByEmail(recipients)
}

function dedupeByEmail(list: ResponsibleRecipient[]): ResponsibleRecipient[] {
  const seen = new Set<string>()
  const out: ResponsibleRecipient[] = []
  for (const r of list) {
    if (seen.has(r.email)) continue
    seen.add(r.email)
    out.push(r)
  }
  return out
}
