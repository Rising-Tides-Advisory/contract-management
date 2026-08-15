/**
 * GET    /api/entra — connection status for the current org
 * PUT    /api/entra — save app-registration credentials and sign-in policy
 * DELETE /api/entra — disconnect (drops the synced directory with it)
 *
 * EntraIntegration is deliberately outside the org-scope Prisma extension (see
 * lib/db/client.ts), so every query here filters on ctx.organizationId itself.
 */
import { resolveAuth, requireWriteScope } from "@/lib/auth/middleware"
import { hasRole } from "@/lib/auth/roles"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { SECURE_HEADERS } from "@/lib/api-headers"
import {
  ENTRA_GRAPH_APP_PERMISSIONS,
  JIT_ASSIGNABLE_ROLES,
  consentRedirectUri,
  normalizeDomains,
  signInRedirectUri,
} from "@/lib/entra/config"
import { encryptSecret } from "@/lib/entra/crypto"
import { clearTokenCache } from "@/lib/entra/graph"
import { logger } from "@/lib/logger"
import { z } from "zod"

const SaveSchema = z.object({
  clientId: z.string().uuid("Client ID must be the application (client) ID GUID"),
  /** Omitted on edit — an existing secret is kept rather than blanked. */
  clientSecret: z.string().min(8).max(512).optional(),
  emailDomains: z.array(z.string().max(253)).max(50).default([]),
  ssoEnabled: z.boolean().default(true),
  autoProvision: z.boolean().default(true),
  defaultRole: z.enum(JIT_ASSIGNABLE_ROLES).default("member"),
  directorySyncEnabled: z.boolean().default(true),
})

/** Never returns the secret — only whether one is stored. */
const publicSelect = {
  id: true,
  clientId: true,
  tenantId: true,
  tenantName: true,
  consentGrantedAt: true,
  consentError: true,
  ssoEnabled: true,
  emailDomains: true,
  autoProvision: true,
  defaultRole: true,
  directorySyncEnabled: true,
  lastSyncedAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  lastSyncUserCount: true,
  createdAt: true,
  updatedAt: true,
  connectedBy: { select: { id: true, name: true, email: true } },
  consentGrantedBy: { select: { id: true, name: true, email: true } },
} as const

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasRole(ctx.role, "admin")) return Response.json({ error: "Forbidden" }, { status: 403 })

  return requestContext.run(ctx, async () => {
    const integration = await prisma.entraIntegration.findFirst({
      where: { organizationId: ctx.organizationId },
      select: publicSelect,
    })

    return Response.json(
      {
        integration,
        // Everything the admin needs to fill in the Azure portal, served from
        // the same place that consumes it so the two can never drift.
        setup: {
          redirectUris: [signInRedirectUri(), consentRedirectUri()],
          graphApplicationPermissions: ENTRA_GRAPH_APP_PERMISSIONS,
        },
      },
      { headers: SECURE_HEADERS },
    )
  })
}

export async function PUT(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError
  if (!hasRole(ctx.role, "admin")) return Response.json({ error: "Forbidden" }, { status: 403 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = SaveSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    )
  }
  const input = parsed.data

  return requestContext.run(ctx, async () => {
    const existing = await prisma.entraIntegration.findFirst({
      where: { organizationId: ctx.organizationId },
      select: { id: true, clientId: true },
    })

    if (!existing && !input.clientSecret) {
      return Response.json({ error: "A client secret is required to connect" }, { status: 422 })
    }

    const emailDomains = normalizeDomains(input.emailDomains)
    if (input.ssoEnabled && emailDomains.length === 0) {
      // Without a domain there is nothing to match a sign-in address against,
      // so the button on the login page could never route to this org.
      return Response.json(
        { error: "Add at least one email domain to enable Microsoft sign-in" },
        { status: 422 },
      )
    }

    const policy = {
      clientId: input.clientId,
      emailDomains,
      ssoEnabled: input.ssoEnabled,
      autoProvision: input.autoProvision,
      defaultRole: input.defaultRole,
      directorySyncEnabled: input.directorySyncEnabled,
    }

    // Changing the client id or the secret invalidates the consent we hold:
    // the service principal in the tenant is tied to the application id, and a
    // stale cached token would keep working until it expired.
    const credentialsChanged =
      !!input.clientSecret || (!!existing && existing.clientId !== input.clientId)

    const integration = existing
      ? await prisma.entraIntegration.update({
          where: { id: existing.id },
          data: {
            ...policy,
            ...(input.clientSecret ? { encryptedSecret: encryptSecret(input.clientSecret) } : {}),
            ...(existing.clientId !== input.clientId
              ? { tenantId: null, tenantName: null, consentGrantedAt: null, consentError: null }
              : {}),
          },
          select: publicSelect,
        })
      : await prisma.entraIntegration.create({
          data: {
            ...policy,
            organizationId: ctx.organizationId,
            encryptedSecret: encryptSecret(input.clientSecret!),
            connectedById: ctx.userId,
          },
          select: publicSelect,
        })

    if (credentialsChanged && existing) clearTokenCache(existing.id)

    logger.info(
      { organizationId: ctx.organizationId, created: !existing },
      "[entra] integration saved",
    )
    return Response.json({ integration }, { headers: SECURE_HEADERS })
  })
}

export async function DELETE(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError
  if (!hasRole(ctx.role, "admin")) return Response.json({ error: "Forbidden" }, { status: 403 })

  return requestContext.run(ctx, async () => {
    const existing = await prisma.entraIntegration.findFirst({
      where: { organizationId: ctx.organizationId },
      select: { id: true },
    })
    if (!existing) return Response.json({ error: "Not Found" }, { status: 404 })

    // EntraDirectoryUser rows cascade, and Contract.responsiblePartyId is ON
    // DELETE SET NULL — contracts survive, they just fall back to the owner.
    await prisma.entraIntegration.delete({ where: { id: existing.id } })
    clearTokenCache(existing.id)

    logger.info({ organizationId: ctx.organizationId }, "[entra] integration disconnected")
    return new Response(null, { status: 204, headers: SECURE_HEADERS })
  })
}
