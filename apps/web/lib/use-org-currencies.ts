"use client"

/**
 * The org's currency list, for pickers.
 *
 * Returns the built-in defaults immediately and swaps in the org's configured
 * list when `/api/org` responds, so a picker never renders empty and a failed
 * request degrades to the old hardcoded behaviour instead of breaking the form.
 */

import { useEffect, useState } from "react"
import {
  DEFAULT_ENABLED_CURRENCIES,
  FALLBACK_CURRENCY,
  type OrgCurrencySettings,
} from "@/lib/currencies"

const FALLBACK: OrgCurrencySettings = {
  enabled: [...DEFAULT_ENABLED_CURRENCIES],
  default: FALLBACK_CURRENCY,
}

export function useOrgCurrencies(): OrgCurrencySettings & { loaded: boolean } {
  const [settings, setSettings] = useState<OrgCurrencySettings>(FALLBACK)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/api/org")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: { currencies?: OrgCurrencySettings }) => {
        if (cancelled) return
        if (data.currencies?.enabled?.length) setSettings(data.currencies)
      })
      .catch(() => {
        /* keep the fallback list */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { ...settings, loaded }
}

/**
 * The list to render in a picker, guaranteeing `current` is present.
 *
 * A contract created before the org narrowed its currency list would otherwise
 * show a blank select and silently rewrite its currency on the next save.
 */
export function pickerOptions(enabled: string[], current?: string | null): string[] {
  if (current && !enabled.includes(current)) return [current, ...enabled]
  return enabled
}
