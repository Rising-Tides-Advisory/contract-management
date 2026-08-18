/**
 * The "does my email actually work" message.
 *
 * Sent on demand from Settings → Integrations → Communication so an admin can
 * verify a Postmark configuration without waiting for a real renewal alert.
 * It goes through the same `sendEmail` path as every other org notification, so
 * a delivery here proves the exact transport that invitations, alerts and
 * approvals will use.
 */
import { sendEmail, type SendResult } from "@/lib/email/transport"
import { APP_NAME } from "@/lib/brand"

interface TestEmailParams {
  /** Sends through this org's Postmark config when it has one. */
  organizationId: string
  to: string
  organizationName: string
  /** Display name (or email) of the admin who pressed the button. */
  triggeredBy: string
  sentAt: Date
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildTestHtml(params: TestEmailParams): string {
  const { organizationName, triggeredBy, sentAt } = params
  const timestamp = sentAt.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  })

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;color:#1f2937;background:#f9fafb;padding:24px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px">
    <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;color:#111827">Email delivery is working</h2>
    <p style="margin:0 0 24px;color:#6b7280;font-size:14px">This is a test notification from ${APP_NAME}. If it reached your inbox, ${escapeHtml(organizationName)} is set up to receive contract lifecycle email.</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:10px 0;color:#6b7280;width:40%">Organization</td>
        <td style="padding:10px 0;font-weight:500">${escapeHtml(organizationName)}</td>
      </tr>
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:10px 0;color:#6b7280">Requested by</td>
        <td style="padding:10px 0;font-weight:500">${escapeHtml(triggeredBy)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;color:#6b7280">Sent</td>
        <td style="padding:10px 0;font-weight:500">${escapeHtml(timestamp)} UTC</td>
      </tr>
    </table>

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">Invitations, renewal alerts, approvals and event notifications all use this same configuration. No action is needed — you can safely ignore this message.</p>
  </div>
</body>
</html>`.trim()
}

export async function sendTestEmail(params: TestEmailParams): Promise<SendResult> {
  return sendEmail({
    organizationId: params.organizationId,
    to: params.to,
    subject: `[${APP_NAME}] Test email — ${params.organizationName}`,
    html: buildTestHtml(params),
  })
}
