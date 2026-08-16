/**
 * Send a test email through the org's own delivery configuration.
 *
 * Postmark rejects a From address that is not a confirmed Sender Signature, and
 * a wrong server token only fails at SMTP AUTH time — neither is detectable when
 * the config is saved. This route exercises the real `sendEmail` path so an
 * admin finds out immediately instead of when the first renewal alert silently
 * fails to arrive.
 *
 * The message always goes to the requesting admin's own account email. It is
 * never sent to an address supplied in the request, so this cannot be used to
 * push mail at a third party.
 */
import { resolveAuth } from "@/lib/auth/middleware"
import { hasRole } from "@/lib/auth/roles"
import { prisma } from "@/lib/db/client"
import { sendTestEmail } from "@/lib/email/test-message"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { SECURE_HEADERS } from "@/lib/api-headers"
import { logger } from "@/lib/logger"

/** Cap on the provider error text echoed back to the admin. */
const MAX_DETAIL_LENGTH = 300

/**
 * Nodemailer surfaces the SMTP server's own reply on `response` ("535 …
 * authentication failed", "550 … Sender signature not confirmed"), which is the
 * part an admin can act on. Credentials never appear in it — they travel in the
 * AUTH command, not the reply — but it is still truncated rather than passed
 * through whole.
 */
function providerDetail(err: unknown): string | undefined {
  const candidate =
    (typeof err === "object" && err !== null && "response" in err
      ? String((err as { response?: unknown }).response ?? "")
      : "") || (err instanceof Error ? err.message : "")
  const trimmed = candidate.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…`
    : trimmed
}

export async function POST(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return new Response("Unauthorized", { status: 401 })

  if (!hasRole(ctx.role, "admin")) {
    return new Response("Forbidden", { status: 403 })
  }

  // Deliberately tighter than the config write limit: every allowed call sends
  // real mail and burns the org's Postmark quota.
  const rl = await rateLimit(`${ctx.organizationId}:email-config-test`, 5, 600_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  const [org, user] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true, email: true },
    }),
  ])

  // API-key callers inherit their creator's identity, so this is only empty for
  // a key whose creator has since been deleted.
  if (!user?.email) {
    return Response.json(
      { error: "No email address on your account to send the test to" },
      { status: 400, headers: SECURE_HEADERS },
    )
  }

  let result
  try {
    result = await sendTestEmail({
      organizationId: ctx.organizationId,
      to: user.email,
      organizationName: org?.name ?? "your organization",
      triggeredBy: user.name ?? user.email,
      sentAt: new Date(),
    })
  } catch (err) {
    logger.error(
      { err, organizationId: ctx.organizationId },
      "[email-config] test send failed",
    )
    return Response.json(
      {
        error: "The mail server rejected the message",
        detail: providerDetail(err),
      },
      { status: 502, headers: SECURE_HEADERS },
    )
  }

  // sendEmail is a deliberate no-op when nothing is configured. Reporting that
  // as success would be the exact failure this route exists to catch.
  if (!result.sent) {
    return Response.json(
      {
        error:
          "Email is not configured. Add a Postmark server token above, or set the server-level email environment variables.",
      },
      { status: 400, headers: SECURE_HEADERS },
    )
  }

  return Response.json(
    { sentTo: user.email, source: result.source },
    { status: 200, headers: SECURE_HEADERS },
  )
}
