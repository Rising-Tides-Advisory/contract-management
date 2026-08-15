/**
 * OpenID Connect authorization-code flow (with PKCE) against a single Entra
 * tenant, using that organization's own app registration.
 *
 * ClauseFlow cannot use Better Auth's static `socialProviders.microsoft`
 * config here: the client id, client secret and authority are all per-org
 * rows in the database, resolved at request time from the signing-in user's
 * email domain. So the flow is driven directly and only the resulting session
 * is handed back to Better Auth.
 */
import crypto from "node:crypto"
import {
  ENTRA_LOGIN_HOST,
  ENTRA_SIGNIN_SCOPES,
  GRAPH_DEFAULT_SCOPE,
  consentRedirectUri,
  signInRedirectUri,
} from "@/lib/entra/config"
import { decryptSecret } from "@/lib/entra/crypto"

export type PkcePair = { verifier: string; challenge: string }

/** RFC 7636 §4.1–4.2 — 32 random bytes, base64url, SHA-256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url")
}

export function buildAuthorizeUrl(opts: {
  tenantId: string
  clientId: string
  state: string
  nonce: string
  codeChallenge: string
  /** Pre-fills the account picker; Entra treats it as a hint, never a filter. */
  loginHint?: string | null
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: signInRedirectUri(),
    response_mode: "query",
    scope: ENTRA_SIGNIN_SCOPES.join(" "),
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  })
  if (opts.loginHint) params.set("login_hint", opts.loginHint)
  return `${ENTRA_LOGIN_HOST}/${opts.tenantId}/oauth2/v2.0/authorize?${params}`
}

/**
 * Admin-consent URL — this is what "add the app to your org" actually is. A
 * Global Admin follows it, approves the application permissions, and Entra
 * creates the service principal (the enterprise app) in their tenant.
 *
 * The `organizations` authority lets any work/school tenant consent; the
 * tenant we end up bound to comes back as the `tenant` query parameter on the
 * callback, which is where EntraIntegration.tenantId is set from.
 */
export function buildAdminConsentUrl(opts: { clientId: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: GRAPH_DEFAULT_SCOPE,
    redirect_uri: consentRedirectUri(),
    state: opts.state,
  })
  return `${ENTRA_LOGIN_HOST}/organizations/v2.0/adminconsent?${params}`
}

export type TokenResponse = {
  idToken: string
  accessToken: string | null
  refreshToken: string | null
  expiresAt: Date | null
}

export class EntraAuthError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = "EntraAuthError"
  }
}

export async function exchangeCode(opts: {
  tenantId: string
  clientId: string
  encryptedSecret: string
  code: string
  codeVerifier: string
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: decryptSecret(opts.encryptedSecret),
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: signInRedirectUri(),
    code_verifier: opts.codeVerifier,
    scope: ENTRA_SIGNIN_SCOPES.join(" "),
  })

  const res = await fetch(`${ENTRA_LOGIN_HOST}/${opts.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  const json = (await res.json().catch(() => ({}))) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !json.id_token) {
    throw new EntraAuthError(
      json.error_description ?? json.error ?? `token exchange failed (${res.status})`,
      "exchange_failed",
    )
  }

  return {
    idToken: json.id_token,
    accessToken: json.access_token ?? null,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
  }
}

// ─── ID token verification ────────────────────────────────────────────────────

export type IdTokenClaims = {
  sub: string
  oid: string
  tid: string
  email: string
  name: string | null
  preferredUsername: string | null
}

type Jwk = { kid?: string; kty?: string; use?: string; n?: string; e?: string; x5c?: string[] }

// JWKS are stable for hours and Microsoft rate-limits the discovery endpoint,
// so cache per tenant for an hour. A rotated key that is not yet cached shows
// up as a cache miss (unknown kid) and triggers an immediate refetch.
const jwksCache = new Map<string, { keys: Jwk[]; expiresAt: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000

async function getSigningKey(tenantId: string, kid: string): Promise<Jwk | null> {
  const cached = jwksCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) {
    const hit = cached.keys.find((k) => k.kid === kid)
    if (hit) return hit
  }

  const res = await fetch(`${ENTRA_LOGIN_HOST}/${tenantId}/discovery/v2.0/keys`)
  if (!res.ok) return null
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  jwksCache.set(tenantId, { keys, expiresAt: Date.now() + JWKS_TTL_MS })
  return keys.find((k) => k.kid === kid) ?? null
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
}

/**
 * Verify an Entra ID token end to end: RS256 signature against the tenant's
 * published JWKS, then every claim that scopes the token to this org and this
 * sign-in attempt.
 *
 * The signature check is redundant with TLS to the token endpoint (OIDC Core
 * §3.1.3.7 permits skipping it there) but cheap, and it is the difference
 * between "we trust the transport" and "we verified the issuer".
 */
export async function verifyIdToken(opts: {
  idToken: string
  tenantId: string
  clientId: string
  nonce: string
}): Promise<IdTokenClaims> {
  const parts = opts.idToken.split(".")
  if (parts.length !== 3) throw new EntraAuthError("malformed id_token", "invalid_token")

  const [rawHeader, rawPayload, rawSignature] = parts

  let header: { alg?: string; kid?: string }
  let payload: Record<string, unknown>
  try {
    header = decodeSegment(rawHeader) as { alg?: string; kid?: string }
    payload = decodeSegment(rawPayload)
  } catch {
    throw new EntraAuthError("id_token is not valid JWT JSON", "invalid_token")
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new EntraAuthError(`unsupported id_token alg: ${header.alg}`, "invalid_token")
  }

  const jwk = await getSigningKey(opts.tenantId, header.kid)
  if (!jwk?.n || !jwk.e) {
    throw new EntraAuthError("no matching signing key for id_token", "invalid_token")
  }

  const publicKey = crypto.createPublicKey({
    key: { kty: "RSA", n: jwk.n, e: jwk.e },
    format: "jwk",
  })
  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(rawSignature, "base64url"),
  )
  if (!verified) throw new EntraAuthError("id_token signature check failed", "invalid_token")

  // ── Claims ────────────────────────────────────────────────────────────────
  const iss = typeof payload.iss === "string" ? payload.iss : ""
  if (iss !== `${ENTRA_LOGIN_HOST}/${opts.tenantId}/v2.0`) {
    throw new EntraAuthError(`unexpected issuer: ${iss}`, "issuer_mismatch")
  }

  const aud = payload.aud
  const audOk = Array.isArray(aud) ? aud.includes(opts.clientId) : aud === opts.clientId
  if (!audOk) throw new EntraAuthError("id_token audience mismatch", "audience_mismatch")

  // tid pins the token to the tenant this org consented — without it a token
  // minted for another tenant by the same multi-tenant app would be accepted.
  const tid = typeof payload.tid === "string" ? payload.tid : ""
  if (tid.toLowerCase() !== opts.tenantId.toLowerCase()) {
    throw new EntraAuthError("id_token tenant mismatch", "tenant_mismatch")
  }

  if (payload.nonce !== opts.nonce) {
    throw new EntraAuthError("id_token nonce mismatch", "nonce_mismatch")
  }

  const now = Math.floor(Date.now() / 1000)
  const exp = typeof payload.exp === "number" ? payload.exp : 0
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0
  const SKEW = 300 // Entra's own documented clock-skew allowance
  if (exp && exp + SKEW < now) throw new EntraAuthError("id_token expired", "token_expired")
  if (nbf && nbf - SKEW > now) throw new EntraAuthError("id_token not yet valid", "token_expired")

  // oid is the immutable directory object id; sub is per-app pairwise. We key
  // the directory link on oid so it survives a UPN rename or app re-consent.
  const oid = typeof payload.oid === "string" ? payload.oid : ""
  const sub = typeof payload.sub === "string" ? payload.sub : ""
  if (!oid || !sub) throw new EntraAuthError("id_token missing oid/sub", "invalid_token")

  const preferredUsername =
    typeof payload.preferred_username === "string" ? payload.preferred_username : null
  const emailClaim = typeof payload.email === "string" ? payload.email : null
  // Entra omits `email` unless the app requested the email scope and the user
  // has a mail attribute; preferred_username is the reliable fallback and is
  // the UPN for work accounts.
  const email = (emailClaim ?? preferredUsername ?? "").trim().toLowerCase()
  if (!email.includes("@")) {
    throw new EntraAuthError("id_token carries no usable email claim", "no_email")
  }

  return {
    sub,
    oid,
    tid,
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    preferredUsername,
  }
}

export function __resetJwksCacheForTests(): void {
  jwksCache.clear()
}
