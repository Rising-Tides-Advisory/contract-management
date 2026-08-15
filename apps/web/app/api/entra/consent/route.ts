/**
 * GET /api/entra/consent — start the admin-consent flow.
 *
 * Redirects a Global Admin to Microsoft, where approving the request creates
 * ClauseFlow's service principal in their tenant — that is what "adding it as
 * an enterprise app" means — and grants the Graph application permissions in
 * one step.
 */
import { resolveAuth } from "@/lib/auth/middleware"
import { hasRole } from "@/lib/auth/roles"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { buildAdminConsentUrl } from "@/lib/entra/oidc"
import { createState } from "@/lib/entra/state"

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasRole(ctx.role, "admin")) return Response.json({ error: "Forbidden" }, { status: 403 })

  return requestContext.run(ctx, async () => {
    const integration = await prisma.entraIntegration.findFirst({
      where: { organizationId: ctx.organizationId },
      select: { id: true, clientId: true },
    })
    if (!integration) {
      return Response.json(
        { error: "Save your Entra app registration credentials first" },
        { status: 409 },
      )
    }

    const state = await createState({
      purpose: "consent",
      integrationId: integration.id,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    })

    return new Response(null, {
      status: 302,
      headers: { Location: buildAdminConsentUrl({ clientId: integration.clientId, state }) },
    })
  })
}
