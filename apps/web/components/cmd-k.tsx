"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  LayoutDashboard, FileText, Settings, Plus, LogOut,
  Search
} from "lucide-react"
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { ContractStatusBadge } from "@/components/contract-status-badge"
import { signOut } from "@/lib/auth/client"
import { ContractStatus, ContractType } from "@/lib/types"

interface SearchResult {
  id: string
  title: string
  contractType: ContractType | null
  status: ContractStatus
  counterpartyName: string | null
  createdAt: string
}

const NAV_COMMANDS = [
  { label: "Go to Dashboard", href: "/dashboard",     icon: LayoutDashboard },
  { label: "Go to Contracts", href: "/contracts",     icon: FileText },
  { label: "Go to Search",    href: "/search",        icon: Search },
  { label: "Go to Settings",  href: "/settings/org",  icon: Settings },
] as const

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export function CmdK() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const router = useRouter()

  const debouncedQuery = useDebounce(query, 200)

  // Fetch search results whenever the debounced query changes
  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.results ?? [])
      } else {
        setResults([])
      }
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    fetchResults(debouncedQuery)
  }, [debouncedQuery, fetchResults])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setResults([])
    }
  }, [open])

  useEffect(() => {
    function down(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  function run(fn: () => void) {
    setOpen(false)
    fn()
  }

  const showContractsGroup = query.length >= 2

  // cmdk's built-in filter is off (see shouldFilter below) because contract
  // results are already ranked by the search API — re-filtering them against
  // the raw query would drop rows the server matched on notes or document text.
  // Static commands still need to narrow as you type, so they filter here.
  const matchesQuery = useCallback(
    (label: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return label.toLowerCase().includes(q)
    },
    [query],
  )

  const navItems = NAV_COMMANDS.filter((item) => matchesQuery(item.label))

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput
        placeholder="Search contracts or commands..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {/* Contract search results */}
        {showContractsGroup && (
          <>
            <CommandGroup heading="Contracts">
              {results.length === 0 ? (
                <CommandItem disabled value="contracts-empty">
                  {searching
                    ? "Searching…"
                    : `No contracts found for "${query}"`}
                </CommandItem>
              ) : (
                results.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`contract-${r.id}`}
                    onSelect={() => run(() => router.push(`/contracts/${r.id}`))}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{r.title}</span>
                      {r.counterpartyName && (
                        <span className="truncate text-xs text-muted-foreground">
                          {r.counterpartyName}
                        </span>
                      )}
                    </div>
                    <ContractStatusBadge status={r.status} />
                  </CommandItem>
                ))
              )}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {navItems.length > 0 && (
          <CommandGroup heading="Navigation">
            {navItems.map(({ label, icon: Icon, href }) => (
              <CommandItem
                key={href}
                value={label}
                onSelect={() => run(() => router.push(href))}
              >
                <Icon className="mr-2 h-4 w-4" />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {matchesQuery("New Contract") && (
            <CommandItem
              value="New Contract"
              onSelect={() => run(() => router.push("/contracts/new"))}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Contract
            </CommandItem>
          )}
          {/* Always available — the escape hatch to full search with filters. */}
          <CommandItem
            value="Search Contracts"
            onSelect={() => run(() => router.push(`/search${query ? `?q=${encodeURIComponent(query)}` : ``}`))}
          >
            <Search className="mr-2 h-4 w-4" />
            {query ? `Search all contracts for "${query}"` : "Search Contracts"}
          </CommandItem>
        </CommandGroup>
        {matchesQuery("Sign out") && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Account">
              <CommandItem
                value="Sign out"
                onSelect={() => run(() => signOut({ fetchOptions: { onSuccess: () => router.push("/login") } }))}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
