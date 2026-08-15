"use client"

/**
 * Last-resort error boundary.
 *
 * `app/error.tsx` only catches errors thrown below the root layout. When the
 * root layout itself throws, Next.js renders this instead — and because it
 * replaces the layout, it has to supply its own <html> and <body>.
 *
 * Sentry does not report React render errors on its own, so the capture here is
 * what makes a broken root layout visible rather than a silent white screen.
 * Styling is inline: a failure this high up may be the stylesheet not loading.
 */

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          padding: "1rem",
          background: "#fafafa",
          color: "#18181b",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "24rem" }}>
          <p
            style={{
              fontSize: "3.75rem",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1,
              margin: 0,
              color: "#4f46e5",
            }}
          >
            500
          </p>
          <h1 style={{ marginTop: "1rem", fontSize: "1.5rem", fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#71717a" }}>
            An unexpected error occurred. Try reloading the page — if it keeps
            happening, contact support.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "0.25rem",
                fontSize: "0.75rem",
                color: "#a1a1aa",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              Error ID: {error.digest}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              height: "2.25rem",
              padding: "0 1rem",
              borderRadius: "0.375rem",
              border: "none",
              background: "#4f46e5",
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
