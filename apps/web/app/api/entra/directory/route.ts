/**
 * GET /api/entra/directory?q=&limit= — search the synced tenant directory.
 *
 * Backs the responsible-party picker on the contract detail page, so it is
 * open to any member who can edit a contract rather than admins only. Reads
 * the local snapshot, never Graph: a person picker must not put a third-party
 * API in the path of every keystroke.
 */
import { resolveAuth } from "@/lib/auth/middleware"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { SECURE_HEADERS } from "@/lib/api-headers"
import { z } from "zod"

const QuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Include people whose Entra account is disabled — off by default. */
  includeDisabled: z.enum(["true", "false"]).default("false"),
})

export async function GET(req: Request) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return Response.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 422 })
  }
  const { q, limit, includeDisabled } = parsed.data

  return requestContext.run(ctx, async () => {
    const term = q?.trim()
    const users = await prisma.entraDirectoryUser.findMany({
      where: {
        ...(includeDisabled === "true" ? {} : { accountEnabled: true }),
        ...(term
          ? {
              OR: [
                { displayName: { contains: term, mode: "insensitive" } },
                { mail: { contains: term, mode: "insensitive" } },
                { userPrincipalName: { contains: term, mode: "insensitive" } },
                { department: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        displayName: true,
        mail: true,
        userPrincipalName: true,
        jobTitle: true,
        department: true,
        accountEnabled: true,
        userId: true,
      },
      orderBy: { displayName: "asc" },
      take: limit,
    })

    return Response.json({ users }, { headers: SECURE_HEADERS })
  })
}
