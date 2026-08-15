/**
 * Microsoft Entra ID — shared configuration and small pure helpers.
 *
 * Credentials are per-organization: each org registers its own multi-tenant
 * app registration and pastes the client id + secret into ClauseFlow. Nothing
 * about Entra is configured at the deployment level, so a self-hoster running
 * one instance for several companies never has to share an app registration
 * between them.
 */

/** Microsoft identity platform base. */
export const ENTRA_LOGIN_HOST = "https://login.microsoftonline.com"

/** Microsoft Graph v1.0 base. */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0"

/**
 * Application permissions the org's app registration needs, granted in one
 * shot when an admin consents. Surfaced verbatim in the setup UI and docs so
 * the person creating the app registration can copy the list.
 *
 *   User.Read.All      — read the directory user list (responsible-party picker)
 *   Directory.Read.All — read manager relationships (notification escalation)
 */
export const ENTRA_GRAPH_APP_PERMISSIONS = ["User.Read.All", "Directory.Read.All"] as const

/** Delegated scopes requested during interactive sign-in. */
export const ENTRA_SIGNIN_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read"]

/** Scope used for client-credentials (app-only) Graph calls. */
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default"

/** Roles an org may hand to JIT-provisioned members. Never "owner" or "admin". */
export const JIT_ASSIGNABLE_ROLES = ["viewer", "member", "legal"] as const
export type JitAssignableRole = (typeof JIT_ASSIGNABLE_ROLES)[number]

/** Signed state / PKCE material lives this long. Matches Microsoft's own window. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000

/** Consumer tenants can't grant app permissions and aren't a company directory. */
const BLOCKED_TENANTS = new Set([
  "9188040d-6c67-4c5b-b112-36a304b66dad", // MSA / personal Microsoft accounts
])

export function isBlockedTenant(tenantId: string | null | undefined): boolean {
  return !!tenantId && BLOCKED_TENANTS.has(tenantId.toLowerCase())
}

/** App base URL, matching how the CRM routes resolve it. */
export function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "")
}

/** Redirect URI registered in the app registration for the admin-consent flow. */
export function consentRedirectUri(): string {
  return `${appBaseUrl()}/api/entra/consent/callback`
}

/** Redirect URI registered in the app registration for interactive sign-in. */
export function signInRedirectUri(): string {
  return `${appBaseUrl()}/api/auth/entra/callback`
}

/** Lowercased domain part of an email address, or null when it isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain.includes(".") ? domain : null
}

/**
 * Normalize an admin-entered domain list: lowercase, strip a leading "@" or
 * "*.", drop blanks and duplicates. Keeps the stored form canonical so
 * matching is a plain Set lookup rather than a fuzzy compare.
 */
export function normalizeDomains(input: string[]): string[] {
  const out = new Set<string>()
  for (const raw of input) {
    const d = raw.trim().toLowerCase().replace(/^@/, "").replace(/^\*\./, "")
    if (d && d.includes(".") && !/\s/.test(d)) out.add(d)
  }
  return Array.from(out)
}

/**
 * True when `email` belongs to one of `domains`. Subdomains count
 * (finance.acme.com matches acme.com) but lookalikes do not (notacme.com
 * does not match acme.com). An empty domain list matches nothing — callers
 * decide whether "no domains configured" means allow-all.
 */
export function matchesDomain(email: string, domains: string[]): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
}
