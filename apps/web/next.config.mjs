import path from "path"
import { fileURLToPath } from "url"
import createNextIntlPlugin from "next-intl/plugin"
import { withSentryConfig } from "@sentry/nextjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const withNextIntl = createNextIntlPlugin("./i18n.ts")

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Expose signing feature flag to the client — derived from DOCUSEAL_API_KEY
  // so users never need to set a separate toggle. No key = signing hidden.
  env: {
    NEXT_PUBLIC_SIGNING_ENABLED: process.env.DOCUSEAL_API_KEY ? "true" : "false",
  },
  output: "standalone",
  // In a pnpm monorepo the root node_modules lives two levels up.
  // Setting this tells Next.js to trace dependencies from the monorepo
  // root so the standalone bundle includes packages like 'next' itself.
  experimental: {
    // Required for the instrumentation.ts hook (OpenTelemetry bootstrap)
    instrumentationHook: true,
    outputFileTracingRoot: path.join(__dirname, "../../"),
    // pdf-parse v1 runs a test file on import — keep it out of the Next.js
    // bundle so it loads at runtime via Node.js require, not at build time.
    // Packages that must be require()d at runtime rather than bundled.
    //   pdf-parse   v1 runs a test file on import — keep it out of the bundle
    //               so it loads at runtime via Node.js require, not at build.
    //   OTel        auto-instrumentation works by hooking module loads, which
    //               bundling defeats outright. Bundling it also drags gRPC,
    //               protobufjs and every optional log-transport into the graph,
    //               each contributing "Critical dependency" or unresolved-module
    //               build warnings for code that never runs unless OTEL_ENABLED.
    //   bullmq      resolves sandboxed processor paths dynamically, which
    //               webpack cannot follow and reports as a critical dependency.
    serverComponentsExternalPackages: [
      "pdf-parse",
      "@opentelemetry/sdk-node",
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/instrumentation",
      "bullmq",
    ],
    // Never serve a stale RSC payload for dynamic pages (those that use
    // cookies/headers or cache:'no-store').  Without this, the client-side
    // Router Cache re-uses the last render for ~30 s, so the dashboard shows
    // outdated contract counts even though the server always fetches fresh data.
    // Static pages keep the default 5-minute cache (300 s).
    staleTimes: {
      dynamic: 0,
      static: 300,
    },
  },
}

export default withSentryConfig(
  withNextIntl(nextConfig),
  {
    org: "aaked",
    project: "aaked-web",
    silent: true,
    widenClientFileUpload: true,
    tunnelRoute: "/monitoring",
    hideSourceMaps: true,
    // `disableLogger` and `automaticVercelMonitors` moved under `webpack` in
    // @sentry/nextjs 10; the top-level spellings are deprecated and warn on
    // every build.
    webpack: {
      treeshake: { removeDebugLogging: true },
      automaticVercelMonitors: true,
    },
  },
)
