/**
 * Server-side OAuth state for the Entra flows.
 *
 * State lives in the `Verification` table rather than a cookie because both
 * Entra redirects can land in a different browser context than the one that
 * started them — the admin-consent flow in particular is routinely completed
 * by a Global Admin in a fresh window. Storing it server-side also makes the
 * state single-use, which is what actually stops a replayed callback.
 *
 * Only a SHA-256 of the state token is persisted, so a database read cannot
 * be turned into a forged callback.
 */
import crypto from "node:crypto"
import { prisma } from "@/lib/db/client"
import { OAUTH_STATE_TTL_MS } from "@/lib/entra/config"

export type StatePurpose = "consent" | "signin"

export type ConsentStatePayload = {
  purpose: "consent"
  integrationId: string
  organizationId: string
  userId: string
}

export type SignInStatePayload = {
  purpose: "signin"
  integrationId: string
  organizationId: string
  tenantId: string
  nonce: string
  codeVerifier: string
  callbackURL: string
}

export type StatePayload = ConsentStatePayload | SignInStatePayload

function identifierFor(purpose: StatePurpose, state: string): string {
  return `entra-${purpose}:${crypto.createHash("sha256").update(state).digest("hex")}`
}

/** Persist a payload and return the opaque state token to put in the URL. */
export async function createState(payload: StatePayload): Promise<string> {
  const state = crypto.randomBytes(32).toString("base64url")
  const now = new Date()
  await prisma.verification.create({
    data: {
      id: crypto.randomUUID(),
      identifier: identifierFor(payload.purpose, state),
      value: JSON.stringify(payload),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
      createdAt: now,
      updatedAt: now,
    },
  })
  return state
}

/**
 * Consume a state token: delete it first (so a concurrent replay loses the
 * race) and only then decide whether it was valid. Returns null for unknown,
 * already-used, expired, or wrong-purpose tokens — the caller reports one
 * generic error for all of them.
 */
export async function consumeState<T extends StatePayload>(
  purpose: T["purpose"],
  state: string,
): Promise<T | null> {
  const identifier = identifierFor(purpose, state)

  const row = await prisma.verification.findFirst({ where: { identifier } })
  if (!row) return null

  const deleted = await prisma.verification.deleteMany({ where: { id: row.id } })
  // Zero rows means another request consumed it between our read and delete.
  if (deleted.count === 0) return null

  if (row.expiresAt < new Date()) return null

  try {
    const payload = JSON.parse(row.value) as StatePayload
    return payload.purpose === purpose ? (payload as T) : null
  } catch {
    return null
  }
}

/** Housekeeping for expired rows; safe to call from any cron-ish context. */
export async function purgeExpiredEntraState(): Promise<number> {
  const { count } = await prisma.verification.deleteMany({
    where: { identifier: { startsWith: "entra-" }, expiresAt: { lt: new Date() } },
  })
  return count
}
