/**
 * Per-org Postmark configuration.
 *
 * Mirrors /api/org/ai-config: the token is encrypted at rest with
 * NOTIFICATION_ENCRYPTION_KEY and never returned to the client — GET reports
 * only whether one is stored.
 *
 * This covers org-scoped mail (invitations, renewal alerts, approvals, event
 * notifications). Password reset is system mail sent before authentication,
 * with no org to attribute it to, so it always uses the server-level
 * POSTMARK_* env vars regardless of what is configured here.
 */
import { resolveAuth } from "@/lib/auth/middleware"
import { hasRole } from "@/lib/auth/roles"
import { prisma } from "@/lib/db/client"
import { encrypt } from "@/lib/notifications/crypto"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { SECURE_HEADERS } from "@/lib/api-headers"
import { logger } from "@/lib/logger"
import { z } from "zod"

const UpsertSchema = z.object({
  // Optional so the From address or message stream can be corrected without
  // re-pasting the token — GET never returns it, so requiring it here meant a
  // typo in the From address could only be fixed by fetching the token out of
  // Postmark again. Omitting it keeps the stored one; it is still required
  // when no config exists yet, which POST checks.
  serverToken: z.string().min(1).optional(),
  // Postmark rejects any From address that is not a confirmed Sender Signature
  // or on a verified domain, so this is validated as an address but can only
  // really be checked by sending.
  fromAddress: z.string().email(),
  messageStream: z.string().min(1).max(100).optional(),
})

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return new Response("Unauthorized", { status: 401 })

  const rl = await rateLimit(`${ctx.organizationId}:email-config-read`, 30, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  const config = await prisma.orgEmailConfig.findUnique({
    where: { organizationId: ctx.organizationId },
    select: { fromAddress: true, messageStream: true },
  })

  if (!config) {
    return Response.json(
      { fromAddress: null, messageStream: null, hasToken: false },
      { headers: SECURE_HEADERS },
    )
  }

  return Response.json(
    {
      fromAddress: config.fromAddress,
      messageStream: config.messageStream ?? "outbound",
      hasToken: true,
    },
    { headers: SECURE_HEADERS },
  )
}

export async function POST(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return new Response("Unauthorized", { status: 401 })

  if (!hasRole(ctx.role, "admin")) {
    return new Response("Forbidden", { status: 403 })
  }

  const rl = await rateLimit(`${ctx.organizationId}:email-config-write`, 10, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = UpsertSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { serverToken, fromAddress, messageStream } = parsed.data

  const existing = await prisma.orgEmailConfig.findUnique({
    where: { organizationId: ctx.organizationId },
    select: { organizationId: true },
  })

  if (!serverToken && !existing) {
    return Response.json(
      { error: "A Postmark server token is required" },
      { status: 400 },
    )
  }

  let encryptedToken: string | undefined
  if (serverToken) {
    try {
      encryptedToken = encrypt(serverToken)
    } catch (err) {
      logger.error({ err }, "[email-config] encryption failed")
      return Response.json(
        { error: "Encryption not configured on this server" },
        { status: 500 },
      )
    }
  }

  const config = encryptedToken
    ? await prisma.orgEmailConfig.upsert({
        where: { organizationId: ctx.organizationId },
        create: {
          organizationId: ctx.organizationId,
          encryptedToken,
          fromAddress,
          messageStream: messageStream ?? null,
        },
        update: {
          encryptedToken,
          fromAddress,
          messageStream: messageStream ?? null,
        },
        select: { fromAddress: true, messageStream: true },
      })
    : // No new token — leave encryptedToken untouched.
      await prisma.orgEmailConfig.update({
        where: { organizationId: ctx.organizationId },
        data: { fromAddress, messageStream: messageStream ?? null },
        select: { fromAddress: true, messageStream: true },
      })

  return Response.json(
    {
      fromAddress: config.fromAddress,
      messageStream: config.messageStream ?? "outbound",
      hasToken: true,
    },
    { status: 200, headers: SECURE_HEADERS },
  )
}

export async function DELETE(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return new Response("Unauthorized", { status: 401 })

  if (!hasRole(ctx.role, "admin")) {
    return new Response("Forbidden", { status: 403 })
  }

  const rl = await rateLimit(`${ctx.organizationId}:email-config-delete`, 10, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  // Removing org config falls back to the server-level env config rather than
  // disabling email for the org.
  await prisma.orgEmailConfig.deleteMany({
    where: { organizationId: ctx.organizationId },
  })

  return new Response(null, { status: 204 })
}
