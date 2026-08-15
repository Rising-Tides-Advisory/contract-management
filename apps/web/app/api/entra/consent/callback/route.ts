/**
 * GET /api/entra/consent/callback — where Microsoft returns after an admin
 * approves (or declines) the consent request.
 *
 * Microsoft sends back `tenant`, `admin_consent` and our `state`. Trust comes
 * from the state token, which is single-use and stored server-side: the
 * redirect frequently lands in a browser session that is not signed in to
 * ClauseFlow (admins routinely finish this in a fresh window), so the session
 * cookie cannot be the thing that authorizes the write.
 */
import { prisma } from "@/lib/db/client"
import { appBaseUrl, isBlockedTenant } from "@/lib/entra/config"
import { clearTokenCache, fetchTenantName } from "@/lib/entra/graph"
import { consumeState, type ConsentStatePayload } from "@/lib/entra/state"
import { entraSyncQueue } from "@/lib/jobs/queues"
import { logger } from "@/lib/logger"

function settingsRedirect(query: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${appBaseUrl()}/settings/entra?${query}` },
  })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const state = url.searchParams.get("state")
  const tenant = url.searchParams.get("tenant")
  const adminConsent = url.searchParams.get("admin_consent")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  if (!state) return settingsRedirect("error=missing_state")

  const payload = await consumeState<ConsentStatePayload>("consent", state)
  if (!payload) return settingsRedirect("error=state_invalid")

  if (error || adminConsent !== "True") {
    const reason = error ?? "consent_declined"
    await prisma.entraIntegration
      .update({
        where: { id: payload.integrationId },
        data: { consentError: (errorDescription ?? reason).slice(0, 500) },
      })
      .catch(() => {})
    logger.warn(
      { error, errorDescription, organizationId: payload.organizationId },
      "[entra.consent] admin consent not granted",
    )
    return settingsRedirect(`error=${encodeURIComponent(reason)}`)
  }

  if (!tenant) return settingsRedirect("error=missing_tenant")
  if (isBlockedTenant(tenant)) return settingsRedirect("error=consumer_account")

  // One Entra tenant may not back two ClauseFlow orgs on the same deployment:
  // sign-in resolves an org from the tenant, and a second claim on the same
  // tenant would make that resolution ambiguous.
  const conflict = await prisma.entraIntegration.findFirst({
    where: { tenantId: tenant, NOT: { id: payload.integrationId } },
    select: { id: true },
  })
  if (conflict) return settingsRedirect("error=tenant_already_linked")

  const integration = await prisma.entraIntegration.update({
    where: { id: payload.integrationId },
    data: {
      tenantId: tenant,
      consentGrantedAt: new Date(),
      consentGrantedById: payload.userId,
      consentError: null,
    },
    select: {
      id: true,
      organizationId: true,
      clientId: true,
      encryptedSecret: true,
      tenantId: true,
      directorySyncEnabled: true,
    },
  })

  // The tenant changed, so any token minted against the old one is worthless.
  clearTokenCache(integration.id)

  const tenantName = await fetchTenantName(integration)
  if (tenantName) {
    await prisma.entraIntegration
      .update({ where: { id: integration.id }, data: { tenantName } })
      .catch(() => {})
  }

  // Queue the first directory pull rather than running it here. A large tenant
  // is thousands of Graph round trips; holding a redirect open for that is both
  // against the "no heavy work in a route" rule and a timeout waiting to happen.
  // The settings page polls for the result.
  if (integration.directorySyncEnabled) {
    try {
      await entraSyncQueue.add("sync", {
        triggeredAt: new Date().toISOString(),
        organizationId: integration.organizationId,
      })
    } catch (err) {
      // Redis being down must not make consent look like it failed — consent is
      // granted and persisted; the daily cron will pick the directory up.
      logger.error(
        { err, organizationId: integration.organizationId },
        "[entra.consent] could not enqueue initial directory sync",
      )
      return settingsRedirect("connected=1&sync=deferred")
    }
  }

  logger.info(
    { organizationId: integration.organizationId, tenantId: tenant },
    "[entra.consent] admin consent granted",
  )
  return settingsRedirect("connected=1&sync=queued")
}
