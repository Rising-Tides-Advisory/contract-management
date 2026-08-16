import { resolveAuth, requireWriteScope } from "@/lib/auth/middleware"
import { requireRole } from "@/lib/auth/roles"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { writeActivity } from "@/lib/db/activity"
import {
  contractExtractQueue,
  getContractAiExtractQueue,
  getContractExtractQueue,
} from "@/lib/jobs/queues"
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { logger } from "@/lib/logger"

// ─── POST /api/contracts/[id]/extractions/rerun ───────────────────────────────
// Re-enqueues AI extraction for a contract. Two paths:
//
//   1. Contract.extractedText is populated → go straight to contract.ai_extract.
//   2. It isn't → re-derive the text from the latest stored file by enqueuing
//      contract.extract, which chains embed → ai_extract on its own.
//
// Path 2 exists because a contract can legitimately carry reviewed extraction
// rows while Contract.extractedText is still null: the new-contract wizard
// parses the document in-request (extract-preview) and seeds AIExtraction rows
// from that pass, but only the contract.extract worker ever writes
// extractedText. If that job never landed — worker down, Redis or storage blip,
// pdf-parse failure — the AI Extractions tab looks fully populated while the
// text column is empty. Failing with "Upload a document first" in that state
// tells the user to fix something that isn't broken; the file is right there in
// the Files tab, so re-read it instead.
//
// Both paths run with force: true. A manual re-run is an explicit request for
// fresh values, so the ai_extract worker refreshes already-accepted rows back
// into the review queue rather than skipping them — otherwise the button is a
// silent no-op on any contract whose fields have all been reviewed. Canonical
// Contract columns are left alone; they keep the accepted values until the user
// accepts the new ones.

/**
 * Best-effort "is anyone going to run this?" probe.
 *
 * Enqueuing always succeeds — BullMQ is happy to accept a job no worker will
 * ever pick up — and a stopped worker is the most common self-host failure
 * mode, so without this the UI has nothing to distinguish "processing" from
 * "processing forever". Returns null when the answer is unknown (Redis
 * providers that disallow CLIENT LIST, an older queue stub in tests); only a
 * confident zero is reported as offline.
 */
async function countWorkers(
  getQueue: () => { getWorkersCount?: () => Promise<number> },
): Promise<number | null> {
  try {
    const queue = getQueue()
    if (typeof queue?.getWorkersCount !== "function") return null
    return await queue.getWorkersCount()
  } catch (err) {
    logger.warn({ err }, "[extractions/rerun] worker liveness probe unavailable")
    return null
  }
}

function workerOnline(count: number | null): boolean | null {
  return count === null ? null : count > 0
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const roleError = requireRole(ctx.role, "member")
  if (roleError) return roleError
  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError

  // Rate limit: 10 req/min per org (AI extraction is expensive)
  const rl = await rateLimit(`${ctx.organizationId}:ai-extract`, 10, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

  return requestContext.run(ctx, async () => {
    const contract = await prisma.contract.findUnique({
      where: { id: params.id },
      select: { id: true, organizationId: true, extractedText: true },
    })

    if (!contract || contract.organizationId !== ctx.organizationId) {
      return Response.json({ error: "Not Found" }, { status: 404 })
    }

    if (contract.extractedText) {
      await getContractAiExtractQueue().add("ai_extract", {
        contractId: params.id,
        extractedText: contract.extractedText,
        force: true,
      })

      const activity = await writeActivity(
        params.id,
        ctx.userId,
        "METADATA_EXTRACTED",
        "AI extraction re-triggered manually",
      )

      // `since` is this row's server timestamp. The client watches the activity
      // feed for the pipeline's own terminal row landing after it, which is the
      // only signal that covers a run finishing with nothing changed.
      return Response.json({
        queued: true,
        source: "stored_text",
        since: activity.createdAt,
        workerOnline: workerOnline(await countWorkers(getContractAiExtractQueue)),
      })
    }

    // No stored text — fall back to the document itself.
    const file = await prisma.contractFile.findFirst({
      where: { contractId: params.id },
      orderBy: [{ isLatest: "desc" }, { version: "desc" }],
      select: { id: true, storageKey: true },
    })

    if (!file?.storageKey) {
      return Response.json(
        { error: "no_document", message: "No document to extract from. Upload a PDF or DOCX first." },
        { status: 422 },
      )
    }

    logger.info(
      { contractId: params.id, fileId: file.id },
      "[extractions/rerun] no stored text — re-extracting from the latest file",
    )

    await contractExtractQueue.add("extract", {
      contractId: params.id,
      fileId: file.id,
      storageKey: file.storageKey,
      force: true,
    })

    const activity = await writeActivity(
      params.id,
      ctx.userId,
      "METADATA_EXTRACTED",
      "Text + AI extraction re-triggered manually from the stored document",
    )

    return Response.json({
      queued: true,
      source: "file",
      since: activity.createdAt,
      workerOnline: workerOnline(await countWorkers(getContractExtractQueue)),
    })
  })
}
