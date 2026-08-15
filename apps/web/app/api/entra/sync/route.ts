/**
 * POST /api/entra/sync — queue a directory pull now, rather than waiting for
 * the daily cron. Used right after onboarding people in Entra, when the
 * responsible-party picker needs to see them immediately.
 *
 * Returns 202: a large tenant is thousands of Graph round trips, so the work
 * belongs on the `entra.sync_directory` queue like every other heavy job.
 * Callers poll GET /api/entra for `lastSyncedAt` / `lastSyncStatus`.
 */
import { resolveAuth, requireWriteScope } from "@/lib/auth/middleware"
import { hasRole } from "@/lib/auth/roles"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { SECURE_HEADERS } from "@/lib/api-headers"
import { entraSyncQueue } from "@/lib/jobs/queues"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { logger } from "@/lib/logger"

export async function POST(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError
  if (!hasRole(ctx.role, "admin")) return Response.json({ error: "Forbidden" }, { status: 403 })

  // A full directory pull is expensive on both sides. One every 30s per org is
  // plenty for "I just added someone".
  const rl = await rateLimit(`org:entra-sync:${ctx.organizationId}`, 2, 30_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  return requestContext.run(ctx, async () => {
    const integration = await prisma.entraIntegration.findFirst({
      where: { organizationId: ctx.organizationId },
      select: { id: true, tenantId: true, consentGrantedAt: true },
    })
    if (!integration) return Response.json({ error: "Not Found" }, { status: 404 })
    if (!integration.consentGrantedAt || !integration.tenantId) {
      return Response.json({ error: "Admin consent has not been granted yet" }, { status: 409 })
    }

    try {
      await entraSyncQueue.add("sync", {
        triggeredAt: new Date().toISOString(),
        organizationId: ctx.organizationId,
      })
    } catch (err) {
      logger.error(
        { err, organizationId: ctx.organizationId },
        "[entra.sync] could not enqueue directory sync",
      )
      return Response.json({ error: "Couldn't queue the sync — try again shortly" }, { status: 503 })
    }

    return Response.json({ queued: true }, { status: 202, headers: SECURE_HEADERS })
  })
}
