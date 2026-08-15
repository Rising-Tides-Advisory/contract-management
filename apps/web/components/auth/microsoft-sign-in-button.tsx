"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

/** Microsoft's four-square mark, inlined so the button has no external asset. */
function MicrosoftMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

/**
 * Home-realm discovery button.
 *
 * ClauseFlow's Entra credentials are per-organization, so there is no single
 * Microsoft endpoint to send everyone to: the work email decides which tenant
 * (and which app registration) the sign-in belongs to. The address already
 * typed into the login form is reused, and only asked for when it is missing.
 */
export function MicrosoftSignInButton({
  email,
  callbackURL,
  onNeedEmail,
}: {
  email: string
  callbackURL?: string
  /** Called when the form's email field is empty, so the page can focus it. */
  onNeedEmail?: () => void
}) {
  const t = useTranslations("auth")
  const te = useTranslations("errors")
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes("@")) {
      toast.info(t("microsoftEmailPrompt"))
      onNeedEmail?.()
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/auth/entra/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, callbackURL }),
      })

      if (res.status === 404) {
        toast.error(t("microsoftNotConfigured"))
        return
      }
      if (!res.ok) {
        toast.error(te("serverError"))
        return
      }

      const { url } = (await res.json()) as { url?: string }
      if (!url) {
        toast.error(te("serverError"))
        return
      }

      // Full navigation, not a fetch: the browser has to land on Microsoft's
      // domain so an existing Entra session (and any conditional-access
      // prompt) applies. Keep the spinner up — this page is going away.
      toast.info(t("microsoftRedirecting"))
      window.location.assign(url)
    } catch {
      toast.error(te("serverError"))
      setLoading(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full gap-2"
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <MicrosoftMark className="h-4 w-4" />
      )}
      {t("continueWithMicrosoft")}
    </Button>
  )
}
