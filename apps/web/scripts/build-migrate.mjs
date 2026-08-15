/**
 * Applies pending Prisma migrations during the Vercel production build.
 *
 * Runs before `next build` so a deploy never ships code that expects a table
 * the database does not have — the failure mode that has bitten this project
 * twice (OrgEmailConfig, and the initial schema).
 *
 * It deliberately does nothing in three cases:
 *
 *   1. SKIP_BUILD_MIGRATE is set — the escape hatch. If migrating during the
 *      build turns out not to work in this environment, set it in the Vercel
 *      project and redeploy; no code change needed to recover.
 *   2. Not running on Vercel — a local `pnpm build` must never migrate a remote
 *      database as a side effect.
 *   3. VERCEL_ENV is not "production" — preview deployments currently share one
 *      Neon database with production (the integration's per-deployment branch
 *      options are off), so migrating on preview would migrate production.
 *      Remove this guard only if previews get their own database branch.
 *
 * A missing direct URL or a failed migration fails the build. Deploying code
 * against a schema that was not migrated is worse than not deploying.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, delimiter } from "node:path"
import { fileURLToPath } from "node:url"

const SKIP = process.env.SKIP_BUILD_MIGRATE

if (SKIP) {
  console.log(`[build-migrate] SKIP_BUILD_MIGRATE=${SKIP} — skipping migrations.`)
  process.exit(0)
}

if (!process.env.VERCEL) {
  console.log("[build-migrate] Not a Vercel build — skipping migrations.")
  process.exit(0)
}

if (process.env.VERCEL_ENV !== "production") {
  console.log(
    `[build-migrate] VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"} — skipping. ` +
      "Preview shares the production database, so only production migrates.",
  )
  process.exit(0)
}

// Same alias chain prisma.config.ts uses. Migrations need the DIRECT connection:
// `migrate deploy` takes an advisory lock and runs DDL, neither of which
// survives a transaction pooler.
const DIRECT_URL =
  [
    process.env.DIRECT_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
  ].find((v) => v && v.trim() !== "") ?? ""

if (!DIRECT_URL) {
  console.error(
    "[build-migrate] No direct database URL available at build time.\n" +
      "  Looked for: DIRECT_URL, DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING.\n" +
      "\n" +
      "  If those are set on the project, the likely cause is that they are marked\n" +
      "  Sensitive in Vercel. Either unmark the direct-connection variable, or set\n" +
      "  SKIP_BUILD_MIGRATE=1 and keep running migrations manually with:\n" +
      "    DIRECT_URL='<direct url>' pnpm --filter web db:migrate:prod",
  )
  process.exit(1)
}

// Resolve the Prisma CLI explicitly rather than trusting PATH. Package-manager
// scripts add node_modules/.bin, but this script must not depend on how it was
// invoked — a missing binary would otherwise read as a migration failure.
const webRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const binDirs = [
  join(webRoot, "node_modules", ".bin"),
  join(webRoot, "..", "..", "node_modules", ".bin"),
].filter((d) => existsSync(d))

// Never log the URL itself — it carries the database password.
console.log("[build-migrate] Applying pending migrations to the production database…")

const result = spawnSync("prisma", ["migrate", "deploy"], {
  stdio: "inherit",
  cwd: webRoot,
  env: {
    ...process.env,
    DIRECT_URL,
    PATH: [...binDirs, process.env.PATH].filter(Boolean).join(delimiter),
  },
  shell: true,
})

if (result.status !== 0) {
  console.error(
    "[build-migrate] `prisma migrate deploy` failed — failing the build rather " +
      "than shipping code against an un-migrated schema.",
  )
  process.exit(result.status ?? 1)
}

console.log("[build-migrate] Migrations applied.")
