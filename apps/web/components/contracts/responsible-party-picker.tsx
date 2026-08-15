"use client"

/**
 * Picks the person accountable for a contract out of the org's synced Entra
 * directory.
 *
 * Renders nothing when the org has no directory: without an Entra integration
 * there is nobody to pick, and an empty control would read as a broken feature
 * rather than an unconfigured one.
 */

import { useEffect, useRef, useState } from "react"
import { Loader2, Search, UserRoundCheck, X } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import type { EntraDirectoryPerson } from "@/lib/types"

function addressOf(p: EntraDirectoryPerson): string {
  return p.mail ?? p.userPrincipalName
}

export function ResponsiblePartyPicker({
  contractId,
  value,
  canEdit,
  onChange,
}: {
  contractId: string
  value: EntraDirectoryPerson | null | undefined
  canEdit: boolean
  onChange?: (person: EntraDirectoryPerson | null) => void
}) {
  const [directoryAvailable, setDirectoryAvailable] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<EntraDirectoryPerson[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // One probe on mount decides whether this control exists at all.
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/entra/directory?limit=1", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setDirectoryAvailable(!!data && Array.isArray(data.users) && data.users.length > 0)
      })
      .catch(() => setDirectoryAvailable(false))
    return () => controller.abort()
  }, [])

  // Debounced search — the directory endpoint reads a local snapshot, but a
  // request per keystroke is still wasted work.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      fetch(`/api/entra/directory?limit=20&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((data) => setResults(data.users ?? []))
        .catch(() => {})
        .finally(() => setSearching(false))
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickAway)
    return () => document.removeEventListener("mousedown", onClickAway)
  }, [open])

  async function assign(person: EntraDirectoryPerson | null) {
    setSaving(true)
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responsiblePartyId: person?.id ?? null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error(body.error ?? "Couldn't update the responsible party")
        return
      }
      onChange?.(person)
      setOpen(false)
      setQuery("")
      toast.success(
        person
          ? `${person.displayName} is now responsible for this contract`
          : "Responsible party cleared",
      )
    } catch {
      toast.error("Couldn't update the responsible party")
    } finally {
      setSaving(false)
    }
  }

  if (directoryAvailable === false || directoryAvailable === null) return null

  return (
    <div ref={containerRef} className="relative">
      <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Responsible party
      </p>

      {value ? (
        <div className="flex items-center gap-2">
          <UserRoundCheck className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">{value.displayName}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {value.jobTitle ? `${value.jobTitle} · ` : ""}
              {addressOf(value)}
            </p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => assign(null)}
              disabled={saving}
              className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Clear responsible party"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Not set — notifications follow the owner
        </p>
      )}

      {canEdit && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
        >
          {value ? "Change" : "Assign from directory"}
        </button>
      )}

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-72 rounded-[var(--radius)] border border-border bg-card p-2 shadow-lg">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your directory"
              className="h-8 pl-7 text-xs"
            />
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto">
            {searching && (
              <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Searching...
              </p>
            )}
            {!searching && results.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">No matches.</p>
            )}
            {!searching &&
              results.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  disabled={saving}
                  onClick={() => assign(person)}
                  className="flex w-full items-start gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{person.displayName}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {person.department ? `${person.department} · ` : ""}
                      {addressOf(person)}
                    </p>
                  </div>
                  {!person.userId && (
                    // Worth calling out: this person will be emailed even though
                    // they cannot sign in, which is the point of the feature but
                    // surprising if you assume the picker lists teammates.
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                      No account
                    </span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
