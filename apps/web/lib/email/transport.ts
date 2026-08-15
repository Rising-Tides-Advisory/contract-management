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

const POSTMARK_SMTP_HOST = "smtp.postmarkapp.com"
const DEFAULT_FROM = "noreply@aakd.io"

export interface EmailMessage {
  to: string | string[]
  subject: string
  html: string
  /** Extra SMTP headers. Merged after the transport's own defaults. */
  headers?: Record<string, string>
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

function resolveConfig(): TransportConfig | null {
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

/** True when email delivery is configured. Callers skip silently when false. */
export function isEmailConfigured(): boolean {
  return resolveConfig() !== null
}

/** The From address used for all outbound mail. */
export function getFromAddress(): string {
  return env("EMAIL_FROM", "SMTP_FROM", "POSTMARK_FROM") ?? DEFAULT_FROM
}

let cached: { transporter: Transporter; config: TransportConfig } | null = null

function getTransporter(config: TransportConfig): Transporter {
  // Reuse the transporter so nodemailer can keep the SMTP connection pooled
  // across sends, but rebuild it if configuration changed (tests mutate env).
  if (!cached || JSON.stringify(cached.config) !== JSON.stringify(config)) {
    cached = {
      config,
      transporter: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
      }),
    }
  }
  return cached.transporter
}

/**
 * Sends an email. Resolves without sending when email is not configured —
 * callers do not need to guard.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const config = resolveConfig()
  if (!config) return

  const recipients = Array.isArray(message.to) ? message.to : [message.to]
  if (recipients.length === 0) return

  try {
    await getTransporter(config).sendMail({
      from: getFromAddress(),
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
      { err, host: config.host, subject: message.subject, recipientCount: recipients.length },
      "[email] send failed",
    )
    throw err
  }
}
