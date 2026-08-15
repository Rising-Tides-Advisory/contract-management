"use client"

/**
 * Settings → Microsoft Entra ID.
 *
 * Three stages, in the order an admin actually goes through them:
 *   1. Paste the app registration credentials (the org registers its own).
 *   2. Grant admin consent — this is what installs ClauseFlow in the tenant as
 *      an enterprise app and grants the Graph permissions.
 *   3. Set sign-in policy and keep the directory synced.
 */

import { useCallback, useEffect, useState, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { format } from "date-fns"
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/confirm-dialog"

type Integration = {
  id: string
  clientId: string
  tenantId: string | null
  tenantName: string | null
  consentGrantedAt: string | null
  consentError: string | null
  ssoEnabled: boolean
  emailDomains: string[]
  autoProvision: boolean
  defaultRole: string
  directorySyncEnabled: boolean
  lastSyncedAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  lastSyncUserCount: number | null
  connectedBy: { id: string; name: string; email: string } | null
  consentGrantedBy: { id: string; name: string; email: string } | null
}

type Setup = {
  redirectUris: string[]
  graphApplicationPermissions: string[]
}

const CALLBACK_ERRORS: Record<string, string> = {
  consent_declined: "Consent was declined in Microsoft.",
  state_invalid: "That consent link expired — start again.",
  missing_state: "That consent link was incomplete — start again.",
  missing_tenant: "Microsoft didn't return a tenant. Try the consent step again.",
  consumer_account: "Personal Microsoft accounts can't be connected — use your work tenant.",
  tenant_already_linked: "That Microsoft tenant is already connected to another workspace.",
  access_denied: "Consent was cancelled.",
}

/**
 * Why "Continue with Microsoft" is or isn't live.
 *
 * Home-realm discovery matches a sign-in address against integrations that are
 * enabled, consented, bound to a tenant, and carry the domain. When any one of
 * those is missing the login page can only say "not set up for that domain",
 * which is useless to the admin looking at this page — so name the missing
 * piece here instead.
 */
function signInReadiness(i: Integration | null): { live: boolean; detail: string } {
  if (!i) return { live: false, detail: "Save your app registration credentials to begin." }
  if (!i.consentGrantedAt || !i.tenantId) {
    return { live: false, detail: "Admin consent hasn't been granted yet — complete step 2." }
  }
  if (!i.ssoEnabled) {
    return { live: false, detail: "Microsoft sign-in is turned off in the settings below." }
  }
  if (i.emailDomains.length === 0) {
    return { live: false, detail: "No email domains are configured, so no address can route here." }
  }
  return {
    live: true,
    detail: `Anyone with an address at ${i.emailDomains.join(", ")} can sign in with Microsoft.`,
  }
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-[var(--radius)] border border-border bg-muted px-2 py-1.5 text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function EntraSettings() {
  const searchParams = useSearchParams()

  const [loading, setLoading] = useState(true)
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [forbidden, setForbidden] = useState(false)

  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [domains, setDomains] = useState("")
  const [ssoEnabled, setSsoEnabled] = useState(true)
  const [autoProvision, setAutoProvision] = useState(true)
  const [defaultRole, setDefaultRole] = useState("member")
  const [directorySyncEnabled, setDirectorySyncEnabled] = useState(true)

  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const hydrate = useCallback((data: Integration | null) => {
    setIntegration(data)
    if (!data) return
    setClientId(data.clientId)
    setDomains(data.emailDomains.join(", "))
    setSsoEnabled(data.ssoEnabled)
    setAutoProvision(data.autoProvision)
    setDefaultRole(data.defaultRole)
    setDirectorySyncEnabled(data.directorySyncEnabled)
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/entra")
      if (res.status === 403) {
        setForbidden(true)
        return
      }
      if (!res.ok) throw new Error("failed")
      const data = (await res.json()) as { integration: Integration | null; setup: Setup }
      hydrate(data.integration)
      setSetup(data.setup)
    } catch {
      toast.error("Couldn't load the Entra configuration")
    } finally {
      setLoading(false)
    }
  }, [hydrate])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Directory syncs run on the job queue, so the result arrives out of band.
   * Poll until `lastSyncedAt` moves past where it was when we queued the job,
   * or until we give up — a big tenant can outlast a reasonable wait, and the
   * page is still correct either way.
   */
  const pollForSync = useCallback(
    async (since: string | null) => {
      setSyncing(true)
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((r) => setTimeout(r, 2500))
        try {
          const res = await fetch("/api/entra")
          if (!res.ok) break
          const data = (await res.json()) as { integration: Integration | null }
          const next = data.integration
          hydrate(next)
          if (next?.lastSyncedAt && next.lastSyncedAt !== since) {
            if (next.lastSyncStatus === "error") {
              toast.error(next.lastSyncError ?? "Directory sync failed")
            } else {
              toast.success(`Directory synced — ${next.lastSyncUserCount ?? 0} people`)
            }
            setSyncing(false)
            return
          }
        } catch {
          break
        }
      }
      // Ran out of attempts without lastSyncedAt moving. Most often the worker
      // is not running or is still churning through a large tenant; either way
      // silence here reads as "the button does nothing".
      setSyncing(false)
      toast.warning(
        "The directory sync hasn't completed yet. If it never does, check that the ClauseFlow worker process is running.",
      )
    },
    [hydrate],
  )

  // The consent callback is a server redirect, so it reports back on the query
  // string rather than through this component's state.
  useEffect(() => {
    const error = searchParams.get("error")
    const connected = searchParams.get("connected")
    if (error) toast.error(CALLBACK_ERRORS[error] ?? `Consent failed: ${error}`)
    else if (connected) {
      const sync = searchParams.get("sync")
      toast.success(
        sync === "deferred"
          ? "Connected. The first directory sync couldn't be queued — try Sync now in a moment."
          : "Microsoft Entra ID connected — syncing your directory",
      )
      if (sync === "queued") pollForSync(null)
    }
    if (error || connected) window.history.replaceState(null, "", window.location.pathname)
  }, [searchParams, pollForSync])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch("/api/entra", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          emailDomains: domains
            .split(/[,\s]+/)
            .map((d) => d.trim())
            .filter(Boolean),
          ssoEnabled,
          autoProvision,
          defaultRole,
          directorySyncEnabled,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error ?? "Couldn't save the configuration")
        return
      }
      hydrate(body.integration)
      setClientSecret("")
      toast.success("Saved")
    } catch {
      toast.error("Couldn't save the configuration")
    } finally {
      setSaving(false)
    }
  }

  async function handleSync() {
    const since = integration?.lastSyncedAt ?? null
    setSyncing(true)
    try {
      const res = await fetch("/api/entra/sync", { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // The no-worker case is a deployment problem, not a transient one, so
        // give it a long toast — it needs reading, not glancing at.
        toast.error(body.error ?? "Couldn't queue the directory sync", {
          duration: body.noWorker ? 15_000 : undefined,
        })
        setSyncing(false)
        return
      }
      toast.info("Directory sync queued")
      pollForSync(since)
    } catch {
      toast.error("Couldn't queue the directory sync")
      setSyncing(false)
    }
  }

  async function handleDisconnect() {
    try {
      const res = await fetch("/api/entra", { method: "DELETE" })
      if (!res.ok && res.status !== 404) {
        toast.error("Couldn't disconnect")
        return
      }
      hydrate(null)
      setClientId("")
      setClientSecret("")
      setDomains("")
      toast.success("Disconnected from Microsoft Entra ID")
    } catch {
      toast.error("Couldn't disconnect")
    } finally {
      setConfirmDisconnect(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (forbidden) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Microsoft Entra ID</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Only organization administrators can configure single sign-on.
        </p>
      </div>
    )
  }

  const consented = !!integration?.consentGrantedAt

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            Microsoft Entra ID
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with Microsoft, and use your tenant directory to decide who is
            responsible for each contract.
          </p>
        </div>
        {integration && (
          <span
            className={
              consented
                ? "inline-flex shrink-0 items-center rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-medium text-success ring-1 ring-success/30"
                : "inline-flex shrink-0 items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border"
            }
          >
            {consented ? "Connected" : "Consent pending"}
          </span>
        )}
      </header>

      {(() => {
        const { live, detail } = signInReadiness(integration)
        return (
          <div
            className={
              live
                ? "flex items-start gap-2 rounded-[var(--radius)] border border-success/30 bg-success/10 p-3 text-xs text-success"
                : "flex items-start gap-2 rounded-[var(--radius)] border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
            }
          >
            {live ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              <span className="font-medium">
                {live ? "Microsoft sign-in is live." : "Microsoft sign-in is not live yet."}
              </span>{" "}
              {detail}
            </span>
          </div>
        )
      })()}

      {/* ── Step 1: app registration ─────────────────────────────────────── */}
      <section className="rounded-[var(--radius)] border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">1. App registration</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Register an application in your own Entra tenant (Azure portal → App
          registrations → New registration, multitenant), then paste its credentials
          here. ClauseFlow never shares an app registration between organizations.
        </p>

        {setup && (
          <div className="mt-4 space-y-3 rounded-[var(--radius)] border border-border bg-muted/40 p-3">
            {setup.redirectUris.map((uri, i) => (
              <CopyField
                key={uri}
                label={i === 0 ? "Redirect URI (Web) — sign-in" : "Redirect URI (Web) — admin consent"}
                value={uri}
              />
            ))}
            <div>
              <Label className="text-xs text-muted-foreground">
                Graph application permissions to add
              </Label>
              <p className="mt-1 text-xs">
                {setup.graphApplicationPermissions.join(", ")} — added under API permissions
                as <span className="font-medium">Application</span> permissions. Admin
                consent in step 2 grants them.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="clientId">Application (client) ID</Label>
              <Input
                id="clientId"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientSecret">Client secret</Label>
              <Input
                id="clientSecret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={integration ? "•••••••• (leave blank to keep)" : "Client secret value"}
                autoComplete="new-password"
                required={!integration}
              />
            </div>
          </div>

          {/* ── Step 3 fields live in the same form so one save covers them ── */}
          <div className="space-y-1.5">
            <Label htmlFor="domains">Email domains</Label>
            <Input
              id="domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, acme.co.uk"
            />
            <p className="text-xs text-muted-foreground">
              Comma separated. These route the login page&apos;s Microsoft button to your
              tenant, and are the guard on who may be provisioned — guests in your tenant
              from other domains are turned away.
            </p>
          </div>

          <div className="space-y-3">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Allow Microsoft sign-in</span>
                <span className="block text-xs text-muted-foreground">
                  Show &quot;Continue with Microsoft&quot; for people on these domains.
                </span>
              </span>
              <Switch checked={ssoEnabled} onCheckedChange={setSsoEnabled} />
            </label>

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Create accounts on first sign-in</span>
                <span className="block text-xs text-muted-foreground">
                  Anyone on an allowed domain gets an account automatically. Turn off to
                  require an invitation first.
                </span>
              </span>
              <Switch checked={autoProvision} onCheckedChange={setAutoProvision} />
            </label>

            <div className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Role for new members</span>
                <span className="block text-xs text-muted-foreground">
                  Administrators can only be promoted by hand.
                </span>
              </span>
              <Select value={defaultRole} onValueChange={(v) => setDefaultRole(v ?? "member")}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="legal">Legal</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Sync the directory daily</span>
                <span className="block text-xs text-muted-foreground">
                  Keeps the responsible-party picker and manager escalation current.
                </span>
              </span>
              <Switch
                checked={directorySyncEnabled}
                onCheckedChange={setDirectorySyncEnabled}
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {integration ? "Save changes" : "Save and continue"}
            </Button>
            {integration && (
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                onClick={() => setConfirmDisconnect(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            )}
          </div>
        </form>
      </section>

      {/* ── Step 2: admin consent ────────────────────────────────────────── */}
      <section className="rounded-[var(--radius)] border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">2. Admin consent</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A Global Administrator approves the request once. Microsoft then adds ClauseFlow
          to your tenant as an enterprise app with the Graph permissions above.
        </p>

        {integration?.consentError && (
          <p className="mt-3 flex items-start gap-2 rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {integration.consentError}
          </p>
        )}

        {consented && integration && (
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Tenant</dt>
              <dd className="font-medium">{integration.tenantName ?? integration.tenantId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Granted</dt>
              <dd className="font-medium">
                {format(new Date(integration.consentGrantedAt!), "d MMM yyyy, HH:mm")}
                {integration.consentGrantedBy ? ` by ${integration.consentGrantedBy.name}` : ""}
              </dd>
            </div>
          </dl>
        )}

        <Button
          type="button"
          variant={consented ? "outline" : "default"}
          className="mt-4"
          disabled={!integration}
          onClick={() => {
            window.location.assign("/api/entra/consent")
          }}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          {consented ? "Re-grant consent" : "Grant admin consent"}
        </Button>
        {!integration && (
          <p className="mt-2 text-xs text-muted-foreground">
            Save your credentials first.
          </p>
        )}
      </section>

      {/* ── Step 3: directory ────────────────────────────────────────────── */}
      <section className="rounded-[var(--radius)] border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-muted-foreground" />
          3. Directory
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The synced directory is what the responsible-party picker searches, and what
          notification escalation follows when someone has left or is disabled.
        </p>

        {integration?.lastSyncStatus === "error" && integration.lastSyncError && (
          <p className="mt-3 flex items-start gap-2 rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {integration.lastSyncError}
          </p>
        )}

        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">People synced</dt>
            <dd className="font-medium">{integration?.lastSyncUserCount ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd className="font-medium">
              {integration?.lastSyncedAt
                ? format(new Date(integration.lastSyncedAt), "d MMM yyyy, HH:mm")
                : "Never"}
            </dd>
          </div>
        </dl>

        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={!consented || syncing}
          onClick={handleSync}
        >
          {syncing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Sync now
        </Button>
      </section>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Microsoft Entra ID?"
        message="People will no longer be able to sign in with Microsoft, and the synced directory will be removed. Contracts keep their owner, but any responsible party picked from the directory is cleared."
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={handleDisconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  )
}

export default function EntraSettingsPage() {
  return (
    <Suspense fallback={null}>
      <EntraSettings />
    </Suspense>
  )
}
