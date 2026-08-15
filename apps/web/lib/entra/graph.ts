/**
 * Microsoft Graph client — app-only (client credentials) calls against a
 * customer tenant.
 *
 * The org grants admin consent once; from then on ClauseFlow authenticates
 * straight to that tenant's token endpoint with the org's own client id and
 * secret, and asks for the `.default` scope so it receives exactly the
 * application permissions the admin consented to.
 */
import {
  ENTRA_LOGIN_HOST,
  GRAPH_BASE,
  GRAPH_DEFAULT_SCOPE,
} from "@/lib/entra/config"
import { decryptSecret } from "@/lib/entra/crypto"
import { logger } from "@/lib/logger"

/** The integration fields the Graph layer needs. Keeps callers free to `select`. */
export type GraphCredentials = {
  id: string
  clientId: string
  encryptedSecret: string
  tenantId: string | null
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = "GraphError"
  }

  /** Consent was revoked or the secret rotated — the org must reconnect. */
  get needsReconsent(): boolean {
    return this.status === 401 || this.status === 403
  }
}

// ─── Token cache ──────────────────────────────────────────────────────────────
// Keyed by integration id so rotating a secret (which changes the row) does not
// leave a stale token behind. Expiry carries a 5-minute safety margin, matching
// what MSAL does internally.

type CachedToken = { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()
const TOKEN_SKEW_MS = 5 * 60 * 1000

export function clearTokenCache(integrationId?: string): void {
  if (integrationId) tokenCache.delete(integrationId)
  else tokenCache.clear()
}

/**
 * Acquire (or reuse) an app-only access token for the org's tenant.
 * Throws GraphError — `needsReconsent` distinguishes "admin revoked us" from
 * a transient failure.
 */
export async function getAppToken(cred: GraphCredentials): Promise<string> {
  if (!cred.tenantId) {
    throw new GraphError("Entra integration has no tenant — admin consent not completed", 400)
  }

  const cached = tokenCache.get(cred.id)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const body = new URLSearchParams({
    client_id: cred.clientId,
    client_secret: decryptSecret(cred.encryptedSecret),
    scope: GRAPH_DEFAULT_SCOPE,
    grant_type: "client_credentials",
  })

  const res = await fetch(`${ENTRA_LOGIN_HOST}/${cred.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !json.access_token) {
    // error_description embeds the client id and correlation ids but never the
    // secret, so it is safe to surface to the admin who is debugging setup.
    throw new GraphError(
      json.error_description ?? json.error ?? `token request failed (${res.status})`,
      res.status,
      json.error,
    )
  }

  const ttlMs = (json.expires_in ?? 3600) * 1000
  tokenCache.set(cred.id, {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(ttlMs - TOKEN_SKEW_MS, 30_000),
  })
  return json.access_token
}

// ─── Request helpers ──────────────────────────────────────────────────────────

async function graphFetch(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

async function throwGraphError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string }
  }
  throw new GraphError(
    body.error?.message ?? `Graph request failed (${res.status})`,
    res.status,
    body.error?.code,
  )
}

/**
 * Follow `@odata.nextLink` until the collection is exhausted.
 * `maxItems` is a hard stop so one enormous tenant cannot exhaust memory or
 * run the sync job forever; the caller reports truncation.
 */
export async function graphGetAll<T>(
  token: string,
  firstUrl: string,
  maxItems = 20_000,
  extraHeaders: Record<string, string> = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let url: string | undefined = firstUrl

  while (url) {
    const res: Response = await graphFetch(token, url, { headers: extraHeaders })
    if (!res.ok) await throwGraphError(res)
    const page = (await res.json()) as { value?: T[]; "@odata.nextLink"?: string }
    items.push(...(page.value ?? []))
    if (items.length >= maxItems) {
      return { items: items.slice(0, maxItems), truncated: true }
    }
    url = page["@odata.nextLink"]
  }

  return { items, truncated: false }
}

// ─── Directory users ──────────────────────────────────────────────────────────

export type GraphDirectoryUser = {
  id: string
  userPrincipalName: string
  displayName: string | null
  mail: string | null
  jobTitle: string | null
  department: string | null
  officeLocation: string | null
  accountEnabled: boolean | null
  managerObjectId: string | null
}

const USER_SELECT =
  "id,userPrincipalName,displayName,mail,jobTitle,department,officeLocation,accountEnabled"

type RawUser = Omit<GraphDirectoryUser, "managerObjectId"> & {
  manager?: { id?: string } | null
}

/**
 * Fetch every member of the tenant directory, with each user's manager.
 *
 * `$expand=manager` needs Graph's advanced query capabilities, which some
 * tenants reject outright. When that happens we refetch without the expand and
 * resolve managers through `$batch` (20 requests per round-trip) instead, so
 * manager escalation keeps working either way.
 */
export async function fetchDirectoryUsers(
  cred: GraphCredentials,
): Promise<{ users: GraphDirectoryUser[]; truncated: boolean }> {
  const token = await getAppToken(cred)

  // userType filtering keeps guests out: a B2B guest is not a person this org
  // can hold accountable for a contract, and their mail routes to another tenant.
  const filter = "&$filter=" + encodeURIComponent("userType eq 'Member'")

  try {
    const expanded = await graphGetAll<RawUser>(
      token,
      `${GRAPH_BASE}/users?$select=${USER_SELECT}&$expand=manager($select=id)&$top=999&$count=true${filter}`,
      20_000,
      { ConsistencyLevel: "eventual" },
    )
    return {
      users: expanded.items.map((u) => normalizeUser(u, u.manager?.id ?? null)),
      truncated: expanded.truncated,
    }
  } catch (err) {
    if (err instanceof GraphError && err.needsReconsent) throw err
    logger.warn(
      { err, integrationId: cred.id },
      "[entra.graph] $expand=manager rejected — falling back to $batch",
    )
  }

  const plain = await graphGetAll<RawUser>(
    token,
    `${GRAPH_BASE}/users?$select=${USER_SELECT}&$top=999&$count=true${filter}`,
    20_000,
    { ConsistencyLevel: "eventual" },
  )
  const managers = await fetchManagersBatched(
    token,
    plain.items.map((u) => u.id),
  )
  return {
    users: plain.items.map((u) => normalizeUser(u, managers.get(u.id) ?? null)),
    truncated: plain.truncated,
  }
}

function normalizeUser(u: RawUser, managerObjectId: string | null): GraphDirectoryUser {
  return {
    id: u.id,
    userPrincipalName: u.userPrincipalName,
    // displayName is technically nullable in Graph; the UPN is always present
    // and is a far better label than an empty string in a person picker.
    displayName: u.displayName?.trim() || u.userPrincipalName,
    mail: u.mail?.trim() || null,
    jobTitle: u.jobTitle?.trim() || null,
    department: u.department?.trim() || null,
    officeLocation: u.officeLocation?.trim() || null,
    accountEnabled: u.accountEnabled ?? true,
    managerObjectId,
  }
}

/**
 * Resolve managers via /$batch. Graph caps a batch at 20 requests, and a 404
 * inside a batch just means "no manager assigned" — not an error.
 */
async function fetchManagersBatched(
  token: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const CHUNK = 20

  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK)
    const requests = chunk.map((id, idx) => ({
      id: String(idx),
      method: "GET",
      url: `/users/${id}/manager?$select=id`,
    }))

    const res = await graphFetch(token, `${GRAPH_BASE}/$batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    })
    if (!res.ok) {
      // A failed batch loses manager data for this chunk only. Escalation
      // degrades to "notify the responsible party alone", which is still correct.
      logger.warn({ status: res.status }, "[entra.graph] manager $batch failed — skipping chunk")
      continue
    }

    const body = (await res.json()) as {
      responses?: { id: string; status: number; body?: { id?: string } }[]
    }
    for (const r of body.responses ?? []) {
      if (r.status !== 200 || !r.body?.id) continue
      const userId = chunk[Number(r.id)]
      if (userId) out.set(userId, r.body.id)
    }
  }

  return out
}

/** Read the tenant's own display name, used to label the connection in the UI. */
export async function fetchTenantName(cred: GraphCredentials): Promise<string | null> {
  try {
    const token = await getAppToken(cred)
    const res = await graphFetch(token, `${GRAPH_BASE}/organization?$select=displayName`)
    if (!res.ok) return null
    const body = (await res.json()) as { value?: { displayName?: string }[] }
    return body.value?.[0]?.displayName ?? null
  } catch {
    // Purely cosmetic — never block consent on it.
    return null
  }
}
