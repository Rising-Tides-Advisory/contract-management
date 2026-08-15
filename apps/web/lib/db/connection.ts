/**
 * Postgres connection resolution — shared by the app client, the worker client,
 * and prisma.config.ts (migrations).
 *
 * Supabase exposes two connection strings and they are NOT interchangeable:
 *
 *   Pooled (PgBouncer, port 6543)   → runtime queries. Transaction-mode pooling,
 *                                     so no session state and no advisory locks.
 *   Direct (port 5432)              → migrations. `prisma migrate deploy` takes an
 *                                     advisory lock and issues DDL, both of which
 *                                     fail through a transaction pooler.
 *
 * The Vercel↔Supabase integration injects these as POSTGRES_PRISMA_URL and
 * POSTGRES_URL_NON_POOLING, which is why they are accepted as aliases.
 */
import { env, isServerless } from "@/lib/env"

/** Pooled connection string — used for all runtime queries. */
export function getDatabaseUrl(): string {
  return env("DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL") ?? ""
}

/**
 * Direct (non-pooled) connection string — used for migrations only.
 * Falls back to the pooled URL so a plain self-hosted Postgres (where the two
 * are the same thing) keeps working with no extra configuration.
 */
export function getDirectDatabaseUrl(): string {
  return env("DIRECT_URL", "POSTGRES_URL_NON_POOLING") ?? getDatabaseUrl()
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
