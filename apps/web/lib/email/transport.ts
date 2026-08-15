/**
 * Single email transport for the whole app.
 *
 * Two ways to configure it, checked in this order:
 *
 *   1. Postmark — set a server token. Host, port, and auth are derived; Postmark's
 *      SMTP interface uses the same server token as both username and password.
 *   2. Generic SMTP — set SMTP_HOST (+ SMTP_USER / SMTP_PASS). Unchanged behaviour
 *      for self-hosted deployments pointing at their own relay.
 *
 * When neither is configured `sendEmail` is a no-op: email is an optional
 * subsystem and the app is expected to run without it.
 *
 * Note: Postmark rejects mail whose From address is not a confirmed Sender
 * Signature or a verified domain, so EMAIL_FROM must match a domain you have
 * verified in the Postmark dashboard.
 */
import nodemailer, { type Transporter } from "nodemailer"
import { env } from "@/lib/env"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/db/client"
import { decrypt } from "@/lib/notifications/crypto"

const POSTMARK_SMTP_HOST = "smtp.postmarkapp.com"
const DEFAULT_FROM = "noreply@aakd.io"

export interface EmailMessage {
  to: string | string[]
  subject: string
  html: string
  /** Extra SMTP headers. Merged after the transport's own defaults. */
  headers?: Record<string, string>
  /**
   * Send through this organization's own Postmark config when it has one.
   * Omit for system mail with no org context — password reset is sent before
   * the user is authenticated and they may belong to several orgs, so it has
   * no defensible org to attribute and always uses the server-level config.
   */
  organizationId?: string
}

interface TransportConfig {
  host: string
  port: number
  secure: boolean
  auth?: { user: string; pass: string }
  /** Headers applied to every message sent through this transport. */
  defaultHeaders: Record<string, string>
}

function postmarkToken(): string | undefined {
  return env(
    "POSTMARK_SERVER_TOKEN",
    "POSTMARK_API_TOKEN",
    "POSTMARK_TOKEN",
    "POSTMARK_API_KEY",
  )
}

function resolveEnvConfig(): TransportConfig | null {
  const token = postmarkToken()
  if (token) {
    return {
      host: env("POSTMARK_SMTP_HOST") ?? POSTMARK_SMTP_HOST,
      port: Number(env("SMTP_PORT") ?? 587),
      secure: env("SMTP_SECURE") === "true",
      auth: { user: token, pass: token },
      // Postmark routes on this header. "outbound" is the transactional stream
      // every Postmark server starts with; broadcast streams need an explicit name.
      defaultHeaders: {
        "X-PM-Message-Stream": env("POSTMARK_MESSAGE_STREAM") ?? "outbound",
      },
    }
  }

  const host = env("SMTP_HOST")
  if (!host) return null

  const user = env("SMTP_USER")
  return {
    host,
    port: Number(env("SMTP_PORT") ?? 587),
    secure: env("SMTP_SECURE") === "true",
    auth: user ? { user, pass: env("SMTP_PASS") ?? "" } : undefined,
    defaultHeaders: {},
  }
}

/**
 * Per-org Postmark config, or null when the org has none (or its token cannot
 * be decrypted). A decryption failure falls back to the server config rather
 * than dropping the mail — same posture as resolveAiConfig.
 */
async function resolveOrgConfig(
  organizationId: string,
): Promise<{ transport: TransportConfig; from: string } | null> {
  let row
  try {
    row = await prisma.orgEmailConfig.findUnique({
      where: { organizationId },
      select: { encryptedToken: true, fromAddress: true, messageStream: true },
    })
  } catch (err) {
    logger.error({ err, organizationId }, "[email] org config lookup failed")
    return null
  }
  if (!row) return null

  let token: string
  try {
    token = decrypt(row.encryptedToken)
  } catch (err) {
    logger.error({ err, organizationId }, "[email] failed to decrypt org Postmark token")
    return null
  }

  return {
    transport: {
      host: env("POSTMARK_SMTP_HOST") ?? POSTMARK_SMTP_HOST,
      port: Number(env("SMTP_PORT") ?? 587),
      secure: env("SMTP_SECURE") === "true",
      auth: { user: token, pass: token },
      defaultHeaders: { "X-PM-Message-Stream": row.messageStream ?? "outbound" },
    },
    from: row.fromAddress,
  }
}

/**
 * True when the SERVER has email configured. This is the env-level check only —
 * it says nothing about per-org config, so it must not be used to pre-guard an
 * org-scoped send. `sendEmail` already no-ops when nothing resolves.
 * Used for the worker's startup warning.
 */
export function isEmailConfigured(): boolean {
  return resolveEnvConfig() !== null
}

/** The server-level From address. Per-org sends use the org's own address. */
export function getFromAddress(): string {
  return env("EMAIL_FROM", "SMTP_FROM", "POSTMARK_FROM") ?? DEFAULT_FROM
}

// Keyed by config rather than a single slot: with per-org Postmark accounts
// several distinct transports are live at once, and a single-slot cache would
// rebuild on every alternating send.
const transporters = new Map<string, Transporter>()

function getTransporter(config: TransportConfig): Transporter {
  const key = JSON.stringify(config)
  let transporter = transporters.get(key)
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
    })
    transporters.set(key, transporter)
  }
  return transporter
}

/**
 * Sends an email. Resolves without sending when email is not configured —
 * callers do not need to guard.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const recipients = Array.isArray(message.to) ? message.to : [message.to]
  if (recipients.length === 0) return

  // Org config wins; the server env is the fallback. An org with no config —
  // and all system mail, which passes no organizationId — uses the env.
  const org = message.organizationId
    ? await resolveOrgConfig(message.organizationId)
    : null
  const config = org?.transport ?? resolveEnvConfig()
  if (!config) return

  const from = org?.from ?? getFromAddress()

  try {
    await getTransporter(config).sendMail({
      from,
      to: recipients,
      subject: message.subject,
      html: message.html,
      headers: { ...config.defaultHeaders, ...message.headers },
    })
  } catch (err) {
    // Log then rethrow — callers keep the existing behaviour of surfacing send
    // failures (BullMQ jobs retry on them), but a bare SMTP error no longer
    // reaches the caller without a record of which host and message it came from.
    logger.error(
      {
        err,
        host: config.host,
        subject: message.subject,
        recipientCount: recipients.length,
        source: org ? "org" : "env",
        organizationId: message.organizationId,
      },
      "[email] send failed",
    )
    throw err
  }
}
