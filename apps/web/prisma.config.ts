import type { PrismaConfig } from "prisma"

/**
 * Prisma CLI configuration (migrations, introspection, studio).
 *
 * Uses the DIRECT connection, not the pooled one. `prisma migrate deploy` takes a
 * Postgres advisory lock and runs DDL — neither survives a transaction-mode pooler
 * such as Supabase's PgBouncer on port 6543. Falls back to the pooled URL when no
 * separate direct URL is configured (plain self-hosted Postgres).
 *
 * Resolution order for the direct URL: DIRECT_URL, then POSTGRES_URL_NON_POOLING
 * (injected by the Vercel↔Supabase integration).
 */
function directUrl(): string {
  const candidates = [
    process.env.DIRECT_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.DATABASE_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL,
  ]
  return candidates.find((v) => v !== undefined && v.trim() !== "") ?? ""
}

export default {
  schema: "prisma/schema.prisma",
  datasource: {
    url: directUrl(),
  },
} satisfies PrismaConfig
