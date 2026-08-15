/**
 * Browser-side Sentry init.
 *
 * Next.js loads this file automatically. It replaces `sentry.client.config.ts`,
 * which @sentry/nextjs 10 deprecates and which stops working under Turbopack.
 *
 * `onRouterTransitionStart` is exported so navigation spans are attached to the
 * App Router's transitions — without it, client-side route changes are missing
 * from traces.
 */
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.01,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
