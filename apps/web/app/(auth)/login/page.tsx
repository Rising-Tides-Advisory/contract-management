"use client"

import { useState, useEffect, useRef, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { signIn } from "@/lib/auth/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MicrosoftSignInButton } from "@/components/auth/microsoft-sign-in-button"
import { useTranslations } from "next-intl"

/**
 * Failure reasons the Entra callback redirects back with. Anything not listed
 * (a raw Entra error code, say) falls through to the generic message rather
 * than being echoed into the page.
 */
const ENTRA_ERRORS: Record<string, string> = {
  sso_not_configured: "Microsoft sign-in isn't set up for that email domain.",
  sso_unavailable: "Microsoft sign-in is currently unavailable for your organization.",
  domain_not_allowed: "That Microsoft account isn't allowed to sign in to this workspace.",
  not_a_member:
    "You don't have access to this workspace yet — ask an administrator to invite you.",
  consumer_account: "Personal Microsoft accounts can't be used — sign in with your work account.",
  state_invalid: "That sign-in link expired. Please try again.",
  tenant_mismatch: "That account belongs to a different Microsoft tenant.",
  nonce_mismatch: "Sign-in could not be verified. Please try again.",
  access_denied: "Sign-in was cancelled.",
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackURL = searchParams.get("callbackURL") ?? "/dashboard"
  const t = useTranslations("auth")
  const te = useTranslations("errors")

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  // The Entra callback cannot render a toast itself — it is a server redirect —
  // so it hands the reason back on the query string.
  const entraError = searchParams.get("error")
  useEffect(() => {
    if (!entraError) return
    toast.error(ENTRA_ERRORS[entraError] ?? te("serverError"))
    // Clear it so a refresh doesn't replay the same error.
    window.history.replaceState(null, "", window.location.pathname)
  }, [entraError, te])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await signIn.email({
        email,
        password,
        callbackURL,
      })
      if (result.error) {
        toast.error(result.error.message ?? t("signInFailed"))
      } else {
        router.push(callbackURL)
      }
    } catch {
      toast.error(te("serverError"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">{t("login")}</h1>
        <p className="text-sm text-zinc-500">{t("loginSubtitle")}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            ref={emailRef}
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("password")}</Label>
            <Link href="/forgot-password" className="text-xs text-indigo-600 hover:underline">
              {t("forgotPassword")}
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? t("signingIn") : t("login")}
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-zinc-200" />
        <span className="text-xs uppercase tracking-wide text-zinc-400">
          {t("orContinueWith")}
        </span>
        <span className="h-px flex-1 bg-zinc-200" />
      </div>

      <MicrosoftSignInButton
        email={email}
        callbackURL={callbackURL}
        onNeedEmail={() => emailRef.current?.focus()}
      />
      <p className="mt-4 text-center text-sm text-zinc-500">
        {t("noAccount")}{" "}
        <Link
          href={callbackURL !== "/dashboard" ? `/register?callbackURL=${encodeURIComponent(callbackURL)}` : "/register"}
          className="text-indigo-600 hover:underline"
        >
          {t("createOne")}
        </Link>
      </p>
    </>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
