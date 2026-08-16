import { resolveAuth } from "@/lib/auth/middleware"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { captureServerEvent } from "@/lib/posthog-server"
import { contractTextFilter } from "@/lib/search-filter"
import { logger } from "@/lib/logger"
import { Prisma } from "@prisma/client"

const RESULT_SELECT = {
  id: true,
  title: true,
  contractType: true,
  status: true,
  counterpartyName: true,
  value: true,
  currency: true,
  endDate: true,
  createdAt: true,
} as const

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })

  // Rate limit: 30 req/min per org
  const rl = await rateLimit(`${ctx.organizationId}:search`, 30, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  return requestContext.run(ctx, async () => {
    const url = new URL(req.url)
    const q = (url.searchParams.get("q") ?? "").trim()
    const limit = (() => {
      const n = parseInt(url.searchParams.get("limit") ?? "20", 10)
      return Number.isNaN(n) ? 20 : Math.min(Math.max(1, n), 100)
    })()
    const offset = (() => {
      const n = parseInt(url.searchParams.get("offset") ?? "0", 10)
      return Number.isNaN(n) ? 0 : Math.max(0, n)
    })()

    if (!q) {
      return Response.json({ results: [], total: 0 })
    }

    captureServerEvent(ctx.userId, "search_performed", {
      query: q.slice(0, 50),
      organizationId: ctx.organizationId,
    })

    const orgId = ctx.organizationId

    /**
     * Substring search over title / counterparty / notes, optionally widened to
     * the extracted document body.
     *
     * Every fallback here used to match `title` alone, so a query that only
     * appeared in the counterparty name came back empty whenever the FTS path
     * did not answer it — which is every query if `search_tsv` is missing from
     * the database, because the raw query throws and lands in the catch below.
     */
    async function substringSearch(includeExtractedText: boolean) {
      const where = {
        organizationId: orgId,
        status: { not: "ARCHIVED" as const },
        ...contractTextFilter(q, { includeExtractedText }),
      }
      const [results, total] = await Promise.all([
        prisma.contract.findMany({
          where,
          select: RESULT_SELECT,
          orderBy: { updatedAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.contract.count({ where }),
      ])
      return { results, total }
    }

    // Short queries (< 3 chars) would produce noisy tsquery results — match
    // them as a plain substring instead.
    if (q.length < 3) {
      return Response.json(await substringSearch(false))
    }

    // Full-text search via PostgreSQL tsvector / tsquery.
    // The generated `search_tsv` column covers title + counterpartyName +
    // notes; extractedText is excluded from the index because it can exceed
    // PostgreSQL's tsvector size limit, so it is reached via the widened
    // substring pass below.
    // $queryRaw with Prisma.sql ensures safe parameterization — never $queryRawUnsafe
    type FTSRow = {
      id: string
      title: string
      contractType: string | null
      status: string
      counterpartyName: string | null
      value: number | null
      currency: string | null
      endDate: Date | null
      createdAt: Date
      organizationId: string
    }

    let rows: FTSRow[]
    try {
      rows = await prisma.$queryRaw<FTSRow[]>(
        Prisma.sql`
          SELECT
            id,
            title,
            "contractType",
            status,
            "counterpartyName",
            value,
            currency,
            "endDate",
            "createdAt",
            "organizationId"
          FROM "Contract"
          WHERE "organizationId" = ${orgId}
            AND "status" != 'ARCHIVED'
            AND search_tsv @@ plainto_tsquery('english', ${q})
          ORDER BY ts_rank(search_tsv, plainto_tsquery('english', ${q})) DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      )
    } catch (err) {
      // tsquery parse failure, or the search_tsv column/GIN index is absent
      // because the FTS migration has not been applied to this database.
      // Log it — silently degrading to substring search hides a missing
      // migration behind results that merely look a bit worse.
      logger.warn({ err, requestId: ctx.requestId }, "[search] FTS query failed — falling back to substring search")
      return Response.json(await substringSearch(true))
    }

    // Count query for pagination — same WHERE clause, no LIMIT/OFFSET
    type CountRow = { count: bigint }
    let countRows: CountRow[]
    try {
      countRows = await prisma.$queryRaw<CountRow[]>(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "Contract"
          WHERE "organizationId" = ${orgId}
            AND "status" != 'ARCHIVED'
            AND search_tsv @@ plainto_tsquery('english', ${q})
        `
      )
    } catch {
      countRows = [{ count: BigInt(rows.length) }]
    }

    const total = Number(countRows[0]?.count ?? rows.length)

    // FTS found nothing — widen to a substring pass, which also reaches
    // partial words ("telu") and the unindexed extracted document text.
    if (rows.length === 0) {
      const fallback = await substringSearch(true)
      if (fallback.results.length > 0) return Response.json(fallback)
    }

    return Response.json({ results: rows, total })
  })
}
