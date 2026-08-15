/**
 * Better Auth plugin: "Continue with Microsoft".
 *
 * Two endpoints, both mounted under /api/auth by the existing [...all] route:
 *
 *   POST /api/auth/entra/discover  — home-realm discovery. Given an email
 *       address, find the organization whose Entra tenant owns that domain and
 *       hand back the authorization URL built from *that org's* app
 *       registration.
 *   GET  /api/auth/entra/callback  — the redirect target. Verifies the id
 *       token, provisions the member if needed, and issues a Better Auth
 *       session.
 *
 * Discovery exists because the credentials are per-organization: there is no
 * single "Microsoft" button target, so the tenant has to be resolved from the
 * address the person typed before the redirect can be built.
 */
import crypto from "node:crypto"
import { createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import type { BetterAuthPlugin, User } from "better-auth"
import * as z from "zod"
import { prisma } from "@/lib/db/client"
import {
  JIT_ASSIGNABLE_ROLES,
  appBaseUrl,
  emailDomain,
  isBlockedTenant,
  matchesDomain,
} from "@/lib/entra/config"
import {
  EntraAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  randomToken,
  verifyIdToken,
  type IdTokenClaims,
} from "@/lib/entra/oidc"
import { consumeState, createState, type SignInStatePayload } from "@/lib/entra/state"
import { writeInAppToOrgMembers } from "@/lib/notifications/write-in-app"
import { rateLimit } from "@/lib/rate-limit"
import { logger } from "@/lib/logger"

const discoverBody = z.object({
  email: z.string().email().max(254),
  /** Where to land after a successful sign-in. Same-origin paths only. */
  callbackURL: z.string().max(512).optional(),
})

/** Only same-origin absolute paths — an open redirect here is an account-takeover primitive. */
function safeCallbackUrl(input: string | undefined): string {
  if (!input) return "/dashboard"
  if (!input.startsWith("/") || input.startsWith("//")) return "/dashboard"
  return input
}

function loginRedirect(reason: string): string {
  return `${appBaseUrl()}/login?error=${encodeURIComponent(reason)}`
}

/**
 * Candidate domains for a lookup, most specific first: an org that registered
 * `acme.com` should still match `finance.acme.com`, without a table scan.
 */
function domainCandidates(domain: string): string[] {
  const labels = domain.split(".")
  const out: string[] = []
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."))
  return out
}

type ResolvedIntegration = {
  id: string
  organizationId: string
  clientId: string
  encryptedSecret: string
  tenantId: string | null
  emailDomains: string[]
  autoProvision: boolean
  defaultRole: string
}

async function findIntegrationForEmail(email: string): Promise<ResolvedIntegration | null> {
  const domain = emailDomain(email)
  if (!domain) return null

  const candidates = await prisma.entraIntegration.findMany({
    where: {
      ssoEnabled: true,
      consentGrantedAt: { not: null },
      tenantId: { not: null },
      emailDomains: { hasSome: domainCandidates(domain) },
    },
    select: {
      id: true,
      organizationId: true,
      clientId: true,
      encryptedSecret: true,
      tenantId: true,
      emailDomains: true,
      autoProvision: true,
      defaultRole: true,
    },
  })

  // `hasSome` matched a suffix; matchesDomain applies the real rule so
  // "notacme.com" can never ride in on a row that registered "acme.com".
  return candidates.find((c) => matchesDomain(email, c.emailDomains)) ?? null
}

export const entraSso = () =>
  ({
    id: "entra-sso",

    endpoints: {
      entraDiscover: createAuthEndpoint(
        "/entra/discover",
        { method: "POST", body: discoverBody },
        async (c) => {
          const { email, callbackURL } = c.body

          // Discovery is unauthenticated by necessity, so throttle it: without
          // a limit it is a directory oracle for "which domains use ClauseFlow".
          const ip =
            c.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            c.request?.headers.get("x-real-ip") ??
            "unknown"
          const rl = await rateLimit(`ip:entra-discover:${ip}`, 10, 60_000)
          if (!rl.allowed) {
            throw c.error("TOO_MANY_REQUESTS", { message: "Too many attempts" })
          }

          const integration = await findIntegrationForEmail(email.toLowerCase())
          if (!integration?.tenantId) {
            throw c.error("NOT_FOUND", {
              message: "No Microsoft sign-in is configured for that email domain",
              code: "sso_not_configured",
            })
          }

          const { verifier, challenge } = createPkcePair()
          const nonce = randomToken(16)
          const state = await createState({
            purpose: "signin",
            integrationId: integration.id,
            organizationId: integration.organizationId,
            tenantId: integration.tenantId,
            nonce,
            codeVerifier: verifier,
            callbackURL: safeCallbackUrl(callbackURL),
          })

          return c.json({
            url: buildAuthorizeUrl({
              tenantId: integration.tenantId,
              clientId: integration.clientId,
              state,
              nonce,
              codeChallenge: challenge,
              loginHint: email,
            }),
          })
        },
      ),

      entraCallback: createAuthEndpoint(
        "/entra/callback",
        {
          method: "GET",
          query: z.object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional(),
            error_description: z.string().optional(),
          }),
        },
        async (c) => {
          const { code, state, error, error_description } = c.query

          if (error) {
            logger.warn({ error, error_description }, "[entra.signin] provider returned an error")
            throw c.redirect(loginRedirect(error))
          }
          if (!code || !state) throw c.redirect(loginRedirect("missing_params"))

          const payload = await consumeState<SignInStatePayload>("signin", state)
          if (!payload) throw c.redirect(loginRedirect("state_invalid"))

          // Re-read the integration: consent can be revoked, or the secret
          // rotated, between the redirect out and the redirect back.
          const integration = await prisma.entraIntegration.findUnique({
            where: { id: payload.integrationId },
            select: {
              id: true,
              organizationId: true,
              clientId: true,
              encryptedSecret: true,
              tenantId: true,
              ssoEnabled: true,
              consentGrantedAt: true,
              emailDomains: true,
              autoProvision: true,
              defaultRole: true,
            },
          })
          if (
            !integration?.tenantId ||
            !integration.ssoEnabled ||
            !integration.consentGrantedAt ||
            integration.tenantId !== payload.tenantId
          ) {
            throw c.redirect(loginRedirect("sso_unavailable"))
          }

          let claims: IdTokenClaims
          try {
            const tokens = await exchangeCode({
              tenantId: integration.tenantId,
              clientId: integration.clientId,
              encryptedSecret: integration.encryptedSecret,
              code,
              codeVerifier: payload.codeVerifier,
            })
            claims = await verifyIdToken({
              idToken: tokens.idToken,
              tenantId: integration.tenantId,
              clientId: integration.clientId,
              nonce: payload.nonce,
            })
          } catch (err) {
            const reason = err instanceof EntraAuthError ? err.reason : "signin_failed"
            logger.warn({ err, organizationId: integration.organizationId }, "[entra.signin] failed")
            throw c.redirect(loginRedirect(reason))
          }

          if (isBlockedTenant(claims.tid)) throw c.redirect(loginRedirect("consumer_account"))

          // The domain allowlist is the JIT guard. A tenant can hold guest
          // accounts from anywhere; without this, consenting to ClauseFlow
          // would let any guest in that tenant provision themselves into the org.
          if (
            integration.emailDomains.length > 0 &&
            !matchesDomain(claims.email, integration.emailDomains)
          ) {
            throw c.redirect(loginRedirect("domain_not_allowed"))
          }

          try {
            const { user, provisioned } = await provisionUser(
              c.context.internalAdapter,
              integration,
              claims,
            )

            const session = await c.context.internalAdapter.createSession(user.id, false, {
              activeOrganizationId: integration.organizationId,
            })
            await setSessionCookie(c, { session, user })

            if (provisioned) {
              // Best-effort: a new colleague appearing in the member list is
              // worth an admin's attention, but never worth failing sign-in.
              writeInAppToOrgMembers(
                integration.organizationId,
                null,
                "member.joined",
                "New member via Microsoft sign-in",
                `${user.name} (${user.email}) joined through Microsoft Entra ID.`,
                user.id,
              ).catch(() => {})
            }

            throw c.redirect(`${appBaseUrl()}${payload.callbackURL}`)
          } catch (err) {
            // c.redirect throws — let the successful redirect above pass through.
            if (err instanceof Response || (err as { status?: unknown })?.status) throw err
            if (err instanceof EntraAuthError) throw c.redirect(loginRedirect(err.reason))
            logger.error(
              { err, organizationId: integration.organizationId },
              "[entra.signin] provisioning failed",
            )
            throw c.redirect(loginRedirect("provisioning_failed"))
          }
        },
      ),
    },
  }) satisfies BetterAuthPlugin

/**
 * The slice of Better Auth's internal adapter this file uses. Declared
 * structurally because `@better-auth/core` is not a direct dependency here —
 * if the upstream shape changes, the call site in the callback fails to
 * typecheck rather than failing at runtime.
 */
type ProvisioningAdapter = {
  findUserByEmail(email: string): Promise<{ user: User } | null>
  createUser(user: {
    email: string
    name: string
    emailVerified: boolean
  }): Promise<User>
  findAccountByProviderId(accountId: string, providerId: string): Promise<unknown>
  linkAccount(account: {
    userId: string
    providerId: string
    accountId: string
  }): Promise<unknown>
}

/**
 * Find or create the ClauseFlow account behind these claims, make sure it is a
 * member of the org that owns the tenant, and point the directory row at it.
 *
 * Matching an existing password account by email is implicit account linking.
 * It is safe in this specific shape: the address was asserted by the very
 * tenant this organization consented to, and it already passed the domain
 * allowlist — so the tenant admin already controls that mailbox.
 */
async function provisionUser(
  adapter: ProvisioningAdapter,
  integration: {
    id: string
    organizationId: string
    autoProvision: boolean
    defaultRole: string
  },
  claims: IdTokenClaims,
): Promise<{ user: User; provisioned: boolean }> {
  const email = claims.email.toLowerCase()
  const displayName = claims.name?.trim() || claims.preferredUsername || email

  const existing = await adapter.findUserByEmail(email)
  let user = existing?.user
  let provisioned = false

  if (!user) {
    if (!integration.autoProvision) {
      throw new EntraAuthError("auto-provisioning disabled", "not_a_member")
    }
    user = await adapter.createUser({
      email,
      name: displayName.slice(0, 100),
      emailVerified: true,
    })
    provisioned = true
  }

  // Link the Entra identity so a later UPN or email change still resolves.
  const linked = await adapter.findAccountByProviderId(claims.oid, "entra")
  if (!linked) {
    await adapter.linkAccount({
      userId: user.id,
      providerId: "entra",
      accountId: claims.oid,
    })
  }

  const membership = await prisma.member.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId: integration.organizationId } },
    select: { id: true },
  })

  if (!membership) {
    if (!integration.autoProvision) {
      throw new EntraAuthError("no membership and auto-provisioning is off", "not_a_member")
    }
    const role = (JIT_ASSIGNABLE_ROLES as readonly string[]).includes(integration.defaultRole)
      ? integration.defaultRole
      : "member"
    await prisma.member.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId: integration.organizationId,
        role,
        createdAt: new Date(),
      },
    })
    provisioned = true
  }

  // Point the directory row at this account. Keyed on the Entra object id, so
  // it works even when the mailbox address differs from the sign-in address.
  await prisma.entraDirectoryUser
    .updateMany({
      where: { integrationId: integration.id, objectId: claims.oid },
      data: { userId: user.id },
    })
    .catch(() => {})

  return { user, provisioned }
}
