/**
 * One-shot helper: adds the Entra sign-in strings to every locale bundle.
 * Kept in the repo so the next person adding auth strings can see the shape
 * that was used, rather than hand-editing five JSON files.
 *
 *   node scripts/add-entra-i18n.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages")

const AUTH_STRINGS = {
  en: {
    continueWithMicrosoft: "Continue with Microsoft",
    orContinueWith: "or",
    microsoftEmailPrompt: "Enter your work email to continue with Microsoft",
    microsoftNotConfigured: "Microsoft sign-in isn't set up for that email domain",
    microsoftRedirecting: "Redirecting to Microsoft...",
  },
  fr: {
    continueWithMicrosoft: "Continuer avec Microsoft",
    orContinueWith: "ou",
    microsoftEmailPrompt: "Saisissez votre e-mail professionnel pour continuer avec Microsoft",
    microsoftNotConfigured:
      "La connexion Microsoft n'est pas configurée pour ce domaine de messagerie",
    microsoftRedirecting: "Redirection vers Microsoft...",
  },
  de: {
    continueWithMicrosoft: "Mit Microsoft fortfahren",
    orContinueWith: "oder",
    microsoftEmailPrompt:
      "Geben Sie Ihre geschäftliche E-Mail-Adresse ein, um mit Microsoft fortzufahren",
    microsoftNotConfigured: "Für diese E-Mail-Domain ist die Microsoft-Anmeldung nicht eingerichtet",
    microsoftRedirecting: "Weiterleitung zu Microsoft...",
  },
  es: {
    continueWithMicrosoft: "Continuar con Microsoft",
    orContinueWith: "o",
    microsoftEmailPrompt: "Introduce tu correo corporativo para continuar con Microsoft",
    microsoftNotConfigured:
      "El inicio de sesión con Microsoft no está configurado para ese dominio de correo",
    microsoftRedirecting: "Redirigiendo a Microsoft...",
  },
  ar: {
    continueWithMicrosoft: "المتابعة باستخدام Microsoft",
    orContinueWith: "أو",
    microsoftEmailPrompt: "أدخل بريدك الإلكتروني المؤسسي للمتابعة باستخدام Microsoft",
    microsoftNotConfigured: "تسجيل الدخول عبر Microsoft غير مُعدّ لنطاق البريد الإلكتروني هذا",
    microsoftRedirecting: "جارٍ إعادة التوجيه إلى Microsoft...",
  },
}

for (const [locale, strings] of Object.entries(AUTH_STRINGS)) {
  const file = join(messagesDir, `${locale}.json`)
  const bundle = JSON.parse(readFileSync(file, "utf8"))
  bundle.auth = { ...bundle.auth, ...strings }
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`)
  console.log(`updated ${locale}.json`)
}
