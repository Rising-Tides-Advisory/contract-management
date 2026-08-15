/**
 * Extracted plain text for a contract.
 *
 * Deliberately separate from GET /api/contracts/[id], which returns only a
 * `hasExtractedText` presence flag to keep the detail payload light — extracted
 * text can run to hundreds of kilobytes. Callers that actually need the text
 * (the document viewer's DOCX fallback, which the browser cannot render) fetch
 * it here.
 */
import { resolveAuth } from "@/lib/auth/middleware"
import { prisma } from "@/lib/db/client"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { SECURE_HEADERS } from "@/lib/api-headers"

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const ctx = await resolveAuth(req)
  if (!ctx) return new Response("Unauthorized", { status: 401 })

  const rl = await rateLimit(`${ctx.organizationId}:contract-text`, 60, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  const contract = await prisma.contract.findUnique({
    where: { id: params.id },
    select: { organizationId: true, extractedText: true },
  })

  // 404 rather than 403 for another org's contract — do not leak existence.
  if (!contract || contract.organizationId !== ctx.organizationId) {
    return new Response("Not Found", { status: 404 })
  }

  return Response.json(
    { extractedText: contract.extractedText },
    { headers: SECURE_HEADERS },
  )
}
