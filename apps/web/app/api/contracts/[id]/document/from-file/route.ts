import { resolveAuth, requireWriteScope } from "@/lib/auth/middleware"
import { requestContext } from "@/lib/context"
import { prisma } from "@/lib/db/client"
import { documentConvertQueue } from "@/lib/jobs/queues"

/**
 * Seed the editor from a file already attached to the contract.
 *
 * Uploading a PDF/DOCX on the Files tab fills `Contract.extractedText` for
 * search and AI, but never creates a `ContractDocument` — so the Editor tab
 * opened on an empty page for every contract that arrived as an upload, with
 * no way to get the text in short of re-uploading the same file through the
 * editor's own import dialog. This reuses that import pipeline against the
 * file the contract already has.
 *
 * The job is queued on `document.convert` with the same payload shape as
 * /document/import, so the existing /document/import/[jobId] route polls it.
 */

const READ_ONLY_STATUSES = new Set([
  "AWAITING_SIGNATURE",
  "ACTIVE",
  "EXPIRED",
  "TERMINATED",
  "ARCHIVED",
])

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function detectFileType(filename: string, mimeType: string): "docx" | "pdf" | null {
  if (mimeType === DOCX_MIME || filename.toLowerCase().endsWith(".docx")) return "docx"
  if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) return "pdf"
  return null
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await resolveAuth(req)
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const scopeError = requireWriteScope(ctx)
  if (scopeError) return scopeError
  if (ctx.role === "viewer") {
    return Response.json({ error: "viewer role cannot import documents" }, { status: 403 })
  }

  return requestContext.run(ctx, async () => {
    const contract = await prisma.contract.findUnique({
      where: { id: params.id },
      select: { id: true, organizationId: true, status: true },
    })
    if (!contract || contract.organizationId !== ctx.organizationId) {
      return new Response("Not Found", { status: 404 })
    }

    if (READ_ONLY_STATUSES.has(contract.status)) {
      return Response.json({ error: "read_only_status" }, { status: 422 })
    }

    let fileId: string | undefined
    try {
      const body = (await req.json()) as { fileId?: unknown }
      if (typeof body?.fileId === "string") fileId = body.fileId
    } catch {
      // No body — fall through to "latest file".
    }

    const file = await prisma.contractFile.findFirst({
      where: { contractId: params.id, ...(fileId ? { id: fileId } : {}) },
      orderBy: [{ isLatest: "desc" }, { createdAt: "desc" }],
      select: { id: true, filename: true, storageKey: true, mimeType: true },
    })
    if (!file) {
      return Response.json({ error: "no_file" }, { status: 404 })
    }

    const fileType = detectFileType(file.filename, file.mimeType)
    if (!fileType) {
      return Response.json({ error: "invalid_file_type" }, { status: 422 })
    }

    const job = await documentConvertQueue.add("convert", {
      contractId: params.id,
      storageKey: file.storageKey,
      requestedById: ctx.userId,
      fileType,
      jobId: "", // overwritten below using the actual BullMQ job id
    })
    if (job.id) {
      await job.updateData({
        contractId: params.id,
        storageKey: file.storageKey,
        requestedById: ctx.userId,
        fileType,
        jobId: job.id,
      })
    }

    return Response.json({ jobId: job.id, filename: file.filename }, { status: 202 })
  })
}
