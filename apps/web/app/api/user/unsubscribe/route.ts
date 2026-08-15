import { NextResponse } from "next/server"
import { prisma } from "@/lib/db/client"
import { verifyUnsubscribeToken } from "@/lib/notifications/unsubscribe-token"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get("token")
  if (!token) {
    return Response.json({ error: "invalid_token" }, { status: 400 })
  }

  const decoded = verifyUnsubscribeToken(token)
  if (!decoded) {
    return Response.json({ error: "invalid_token" }, { status: 400 })
  }

  const { userId, orgId, eventName } = decoded

  // Directory-only recipients: someone in the org's Entra tenant who is named
  // as responsible for a contract but has no ClauseFlow account. There is no
  // User row to hang a UserNotificationPreference off, so the opt-out lives on
  // the directory row itself.
  if (userId.startsWith("entra:")) {
    const directoryUserId = userId.slice("entra:".length)
    const updated = await prisma.entraDirectoryUser.updateMany({
      where: { id: directoryUserId, organizationId: orgId },
      data: { notifyEnabled: false },
    })
    if (updated.count === 0) {
      return Response.json({ error: "invalid_token" }, { status: 400 })
    }
    // No session to redirect into — these recipients cannot sign in — so
    // confirm inline instead of bouncing them to a settings page.
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:system-ui,sans-serif;color:#1f2937;background:#f9fafb;padding:48px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px">
    <h1 style="margin:0 0 8px;font-size:18px;font-weight:600">You're unsubscribed</h1>
    <p style="margin:0;color:#6b7280;font-size:14px">
      You will no longer receive ClauseFlow contract notifications at this address.
      If you should not have been listed as responsible for a contract, let your
      contracts team know so they can update it.
    </p>
  </div>
</body></html>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  }

  const member = await prisma.member.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { userId: true },
  })
  if (!member) {
    return Response.json({ error: "invalid_token" }, { status: 400 })
  }

  await prisma.userNotificationPreference.upsert({
    where: {
      userId_organizationId_eventName: {
        userId,
        organizationId: orgId,
        eventName,
      },
    },
    update: { emailEnabled: false },
    create: { userId, organizationId: orgId, eventName, emailEnabled: false },
  })

  const redirectUrl = new URL(
    `/settings/profile/notifications?unsubscribed=1&event=${encodeURIComponent(eventName)}`,
    url.origin,
  )
  return NextResponse.redirect(redirectUrl)
}
