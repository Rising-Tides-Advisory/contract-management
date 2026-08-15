import { resolveAuth, requireWriteScope } from "@/lib/auth/middleware"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { requireRole } from "@/lib/auth/roles"
import { z } from "zod"
import { CurrencyCodeSchema, readCurrencySettings } from "@/lib/currencies"

/**
 * A logo is either an absolute http(s) URL (an external CDN) or a root-relative
 * path served by this app.
 *
 * POST /api/org/logo returns the latter — `/api/org/logo?key=...` — because the
 * object lives in private storage and is streamed back through an authenticated
 * route rather than exposed publicly. `z.string().url()` rejects that, so
 * uploading a logo and pressing Save failed with a 422 the UI surfaced as
 * "Failed to update organization".
 *
 * Protocol-relative ("//evil.com") and non-http schemes are still rejected —
 * this value is rendered straight into an <img src>.
 */
const LogoUrlSchema = z.string().max(2048).refine(
  (value) => {
    if (value.startsWith("//")) return false
    if (value.startsWith("/")) return true
    try {
      const { protocol } = new URL(value)
      return protocol === "http:" || protocol === "https:"
    } catch {
      return false
    }
  },
  { message: "Must be an absolute http(s) URL or a root-relative path" },
)

const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  industry: z.string().max(100).optional(),
  logo: LogoUrlSchema.optional().nullable(),
  enabledCurrencies: z.array(CurrencyCodeSchema).min(1).max(60).optional(),
  defaultCurrency: CurrencyCodeSchema.optional(),
})

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })

  return requestContext.run(ctx, async () => {
    const org = await prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      include: { _count: { select: { members: true } } },
    })
    if (!org) return new Response("Not Found", { status: 404 })
    const meta = org.metadata ? (JSON.parse(org.metadata) as Record<string, unknown>) : {}
    return Response.json({
      ...org,
      meta,
      logo: org.logo ?? null,
      currencies: readCurrencySettings(meta),
    })
  })
}

export async function PATCH(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })

  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError

  const roleErr = requireRole(ctx.role, "admin")
  if (roleErr) return roleErr

  return requestContext.run(ctx, async () => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response("Invalid JSON", { status: 400 })
    }

    const parsed = UpdateOrgSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const existing = await prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { metadata: true },
    })
    const meta = existing?.metadata
      ? (JSON.parse(existing.metadata) as Record<string, unknown>)
      : {}
    if (parsed.data.domain !== undefined) meta.domain = parsed.data.domain
    if (parsed.data.timezone !== undefined) meta.timezone = parsed.data.timezone
    if (parsed.data.industry !== undefined) meta.industry = parsed.data.industry

    // Currencies are validated as a pair: a default the org has not enabled
    // would make the create form preselect a currency its picker cannot show.
    // Both the incoming values and the already-stored ones are considered, so
    // sending either field alone still lands on a consistent state.
    if (
      parsed.data.enabledCurrencies !== undefined ||
      parsed.data.defaultCurrency !== undefined
    ) {
      const current = readCurrencySettings(meta)
      const enabled = Array.from(
        new Set(parsed.data.enabledCurrencies ?? current.enabled),
      )
      const preferred = parsed.data.defaultCurrency ?? current.default

      if (!enabled.includes(preferred)) {
        return Response.json(
          { error: `Default currency ${preferred} is not in the enabled list` },
          { status: 422 },
        )
      }

      meta.enabledCurrencies = enabled
      meta.defaultCurrency = preferred
    }

    const org = await prisma.organization.update({
      where: { id: ctx.organizationId },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...("logo" in parsed.data ? { logo: parsed.data.logo } : {}),
        metadata: JSON.stringify(meta),
      },
    })

    return Response.json({
      ...org,
      meta,
      logo: org.logo ?? null,
      currencies: readCurrencySettings(meta),
    })
  })
}
