/**
 * Postgres connection resolution — shared by the app client, the worker client,
 * and prisma.config.ts (migrations).
 *
 * Every managed Postgres host exposes two connection strings, and they are NOT
 * interchangeable:
 *
 *   Pooled   → runtime queries. Transaction-mode pooling, so no session state
 *              and no advisory locks.
 *   Direct   → migrations. `prisma migrate deploy` takes an advisory lock and
 *              issues DDL, both of which fail through a transaction pooler.
 *
 * Hosts disagree on how the two are distinguished and what they name them:
 *
 *   Neon      pooled host has "-pooler" in it; both on port 5432.
 *             Injects DATABASE_URL + DATABASE_URL_UNPOOLED.
 *   Supabase  pooled is port 6543, direct is 5432.
 *             Vercel integration injects POSTGRES_PRISMA_URL + POSTGRES_URL_NON_POOLING.
 *
 * The canonical names are DATABASE_URL and DIRECT_URL; everything else is an
 * alias so a host can be swapped without touching application code.
 */
import { env, isServerless } from "@/lib/env"

/**
 * SSL modes that `pg` currently treats as aliases for `verify-full`.
 *
 * `pg` 8 verifies the certificate chain AND the hostname for all three, but
 * warns on every parse that `pg-connection-string` v3 / `pg` v9 will switch them
 * to libpq semantics — under which `require` encrypts without verifying anything,
 * silently downgrading a Neon or Supabase connection from authenticated TLS to
 * one that a man-in-the-middle can terminate.
 *
 * Rewriting them to an explicit `verify-full` is a no-op against `pg` 8 and
 * pins the strong behaviour across that upgrade. Anything else — including a URL
 * with no `sslmode` (plain local Postgres) or one that opted into libpq
 * semantics with `uselibpqcompat` — is left exactly as written.
 */
const ALIASED_SSL_MODES = new Set(["prefer", "require", "verify-ca"])

export function pinSslVerification(url: string): string {
  if (!url) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url // not a URL we can reason about — hand it through untouched
  }

  if (parsed.searchParams.has("uselibpqcompat")) return url

  const mode = parsed.searchParams.get("sslmode")
  if (!mode || !ALIASED_SSL_MODES.has(mode)) return url

  parsed.searchParams.set("sslmode", "verify-full")
  return parsed.toString()
}

/** Pooled connection string — used for all runtime queries. */
export function getDatabaseUrl(): string {
  return pinSslVerification(
    env("DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL") ?? "",
  )
}

/**
 * Direct (non-pooled) connection string — used for migrations only.
 * Falls back to the pooled URL so a plain self-hosted Postgres (where the two
 * are the same thing) keeps working with no extra configuration.
 */
export function getDirectDatabaseUrl(): string {
  const direct = env("DIRECT_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING")
  return direct ? pinSslVerification(direct) : getDatabaseUrl()
}

/**
 * Per-process `pg` pool size.
 *
 * On Vercel every concurrent lambda instance opens its own pool, so a pool of 20
 * multiplies into hundreds of client connections and exhausts the Supabase pooler.
 * Prisma's guidance for serverless behind PgBouncer is a pool of 1 — the pooler,
 * not the app, is doing the pooling. Long-lived processes (worker, Docker, local
 * dev) keep the larger pool.
 */
export function getPoolSize(): number {
  const explicit = env("DATABASE_POOL_SIZE")
  if (explicit) {
    const parsed = parseInt(explicit, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return isServerless() ? 1 : 20
}
