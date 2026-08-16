"use client"

/**
 * Read-only view of the org's email delivery configuration.
 *
 * Email delivery is configured under Settings → Integrations → Communication.
 * Notifications shows it because "how do contract events reach me" is the
 * question this page answers, but every control lives on the Integrations page
 * so there is exactly one place to change it.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { ExternalLink } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/** Deep link that opens Integrations on the tab holding this setting. */
export const EMAIL_DELIVERY_SETTINGS_HREF =
  "/settings/integrations?category=Communication"

interface EmailConfig {
  fromAddress: string | null
  messageStream: string | null
  hasToken: boolean
}

export function EmailDeliveryStatus() {
  const [config, setConfig] = useState<EmailConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/org/email-config", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EmailConfig | null) => {
        if (data) setConfig(data)
      })
      .catch(() => {
        /* status is informational — a failure just leaves it unknown */
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Email delivery</h2>
          <p className="text-xs text-muted-foreground">
            Where invitations, renewal alerts and approvals are sent from
          </p>
        </div>
        {!loading && (
          <Badge variant={config?.hasToken ? "default" : "outline"}>
            {config?.hasToken ? "Postmark connected" : "Using server default"}
          </Badge>
        )}
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3">
        {loading ? (
          <Skeleton className="h-8 w-2/3" />
        ) : config?.hasToken ? (
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">From</dt>
              <dd className="font-medium">{config.fromAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Stream</dt>
              <dd className="font-medium">{config.messageStream}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            This organization has no email configuration of its own, so mail is
            sent using the server-level settings.
          </p>
        )}

        <Link
          href={EMAIL_DELIVERY_SETTINGS_HREF}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:opacity-80 transition-opacity"
        >
          {config?.hasToken
            ? "Manage in Integrations"
            : "Configure in Integrations"}
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </section>
  )
}
