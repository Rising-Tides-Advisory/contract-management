"use client"

/**
 * Per-org Postmark configuration.
 *
 * The stored token is never returned by the API — `hasToken` only reports
 * whether one exists — so the input always starts empty and an empty submit on
 * an already-configured org is rejected client-side rather than blanking it.
 */

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

interface EmailConfig {
  fromAddress: string | null
  messageStream: string | null
  hasToken: boolean
}

export function EmailConfigSection({ isAdmin }: { isAdmin: boolean }) {
  const [config, setConfig] = useState<EmailConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const [serverToken, setServerToken] = useState("")
  const [fromAddress, setFromAddress] = useState("")
  const [messageStream, setMessageStream] = useState("outbound")

  async function load() {
    try {
      const res = await fetch("/api/org/email-config")
      if (!res.ok) throw new Error()
      const data: EmailConfig = await res.json()
      setConfig(data)
      setFromAddress(data.fromAddress ?? "")
      setMessageStream(data.messageStream ?? "outbound")
    } catch {
      toast.error("Failed to load email configuration")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function save() {
    if (!serverToken.trim()) {
      toast.error("Enter your Postmark server token")
      return
    }
    if (!fromAddress.trim()) {
      toast.error("Enter a From address")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/org/email-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverToken: serverToken.trim(),
          fromAddress: fromAddress.trim(),
          messageStream: messageStream.trim() || undefined,
        }),
      })
      if (!res.ok) {
        // Surface the server's reason rather than a generic failure — the two
        // real causes (encryption key missing, migration not applied) are
        // indistinguishable otherwise.
        let detail = ""
        try {
          const body = await res.json()
          if (typeof body?.error === "string") detail = body.error
        } catch {
          /* non-JSON body — fall through to the generic message */
        }
        throw new Error(detail)
      }
      toast.success("Email configuration saved")
      setServerToken("")
      setEditing(false)
      await load()
    } catch (err) {
      const detail = err instanceof Error ? err.message : ""
      toast.error(detail || "Failed to save email configuration")
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (
      !confirm(
        "Remove this organization's Postmark configuration? Mail will fall back to the server-level settings.",
      )
    )
      return
    try {
      const res = await fetch("/api/org/email-config", { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success("Email configuration removed")
      setServerToken("")
      setEditing(false)
      await load()
    } catch {
      toast.error("Failed to remove email configuration")
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Email delivery</h2>
          <p className="text-xs text-muted-foreground">
            Send invitations, alerts and notifications from your own Postmark account
          </p>
        </div>
        {!loading && (
          <Badge variant={config?.hasToken ? "default" : "outline"}>
            {config?.hasToken ? "Postmark connected" : "Using server default"}
          </Badge>
        )}
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : editing || !config?.hasToken ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="pm-token">Server API token</Label>
              <Input
                id="pm-token"
                type="password"
                autoComplete="off"
                placeholder="Postmark → Servers → API Tokens"
                value={serverToken}
                onChange={(e) => setServerToken(e.target.value)}
                disabled={!isAdmin || saving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pm-from">From address</Label>
              <Input
                id="pm-from"
                type="email"
                placeholder="noreply@yourdomain.com"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                disabled={!isAdmin || saving}
              />
              <p className="text-xs text-muted-foreground">
                Must be a confirmed Sender Signature or on a domain verified in
                Postmark, or every send is rejected.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pm-stream">Message stream</Label>
              <Input
                id="pm-stream"
                placeholder="outbound"
                value={messageStream}
                onChange={(e) => setMessageStream(e.target.value)}
                disabled={!isAdmin || saving}
              />
              <p className="text-xs text-muted-foreground">
                Leave as <code>outbound</code> unless you created a custom stream.
              </p>
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={!isAdmin || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {config?.hasToken && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false)
                    setServerToken("")
                    setFromAddress(config.fromAddress ?? "")
                    setMessageStream(config.messageStream ?? "outbound")
                  }}
                  disabled={saving}
                >
                  Cancel
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">From</dt>
                <dd className="font-medium">{config.fromAddress}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Stream</dt>
                <dd className="font-medium">{config.messageStream}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Token</dt>
                <dd className="font-medium text-muted-foreground">Stored, hidden</dd>
              </div>
            </dl>
            {isAdmin && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Change
                </Button>
                <Button size="sm" variant="destructive" onClick={remove}>
                  Remove
                </Button>
              </div>
            )}
          </>
        )}

        <p className="text-xs text-muted-foreground border-t border-border pt-3">
          Applies to invitations, renewal alerts, approvals and event
          notifications. Password reset emails are sent before sign-in, when
          there is no organization to attribute them to, so they always use the
          server-level configuration.
        </p>
      </div>
    </section>
  )
}
