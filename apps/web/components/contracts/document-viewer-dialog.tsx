"use client"

/**
 * Read the source document and correct its dates in one surface.
 *
 * AI extraction misses dates fairly often, and the previous flow was: open the
 * file in a new browser tab, read the dates, switch back, reopen the edit form,
 * type them in. This puts the document and the two date fields side by side so
 * that round trip disappears.
 *
 * PDFs render in an iframe from a short-lived signed URL. DOCX cannot be
 * rendered by the browser, so the text the extraction pipeline already pulled
 * out is shown instead — which is arguably easier to scan for dates anyway.
 */

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { FileText } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DocumentDateReview,
  type DocumentSource,
} from "@/components/contracts/document-date-review"
import type { ContractFile } from "@/lib/types"

interface Props {
  contractId: string
  file: ContractFile | null
  open: boolean
  onOpenChange: (open: boolean) => void
  startDate?: string | null
  endDate?: string | null
  /** Called after a successful save so the page can refetch. */
  onSaved: () => void
}

/** Trims an ISO timestamp to the yyyy-MM-dd a date input expects. */
function toDateInput(value?: string | null): string {
  return value ? value.slice(0, 10) : ""
}

export function DocumentViewerDialog({
  contractId,
  file,
  open,
  onOpenChange,
  startDate,
  endDate,
  onSaved,
}: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [extractedText, setExtractedText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const isPdf = file?.mimeType === "application/pdf"

  useEffect(() => {
    if (!open || !file) return
    let cancelled = false
    setLoading(true)
    setUrl(null)
    setExtractedText(null)

    async function load() {
      try {
        if (isPdf) {
          const res = await fetch(`/api/contracts/${contractId}/upload?fileId=${file!.id}`)
          if (!res.ok) throw new Error()
          const { url: signed } = await res.json()
          if (!cancelled) setUrl(signed)
        } else {
          // No browser-native DOCX rendering — fall back to extracted text.
          // The detail endpoint returns only a presence flag, so use the
          // dedicated text route.
          const res = await fetch(`/api/contracts/${contractId}/text`)
          if (!res.ok) throw new Error()
          const data = await res.json()
          if (!cancelled) setExtractedText(data.extractedText ?? null)
        }
      } catch {
        if (!cancelled) toast.error("Failed to load the document")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, file, contractId, isPdf])

  async function saveDates({ startDate: start, endDate: end }: {
    startDate: string
    endDate: string
  }) {
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: start ? new Date(start).toISOString() : null,
          endDate: end ? new Date(end).toISOString() : null,
        }),
      })
      if (!res.ok) throw new Error()
      toast.success("Dates updated")
      onSaved()
    } catch {
      toast.error("Failed to save dates")
    }
  }

  const source: DocumentSource = loading
    ? { kind: "loading" }
    : isPdf && url
      ? { kind: "pdf", url, title: file?.filename ?? "Contract document" }
      : extractedText
        ? {
            kind: "text",
            text: extractedText,
            note: file?.filename?.toLowerCase().endsWith(".docx")
              ? "Word documents cannot be displayed in the browser — showing the extracted text."
              : "Showing extracted text.",
          }
        : {
            kind: "unavailable",
            message:
              "Nothing to display yet. If this file was just uploaded, text extraction may still be running in the background worker.",
          }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-6xl, not max-w-6xl — DialogContent's own sm:max-w-sm would
          otherwise win from the media query and pin this to 384px. */}
      <DialogContent className="sm:max-w-6xl h-[85vh] flex flex-col gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{file?.filename ?? "Document"}</span>
          </DialogTitle>
          <DialogDescription>
            Read the contract and set the dates AI could not determine.
          </DialogDescription>
        </DialogHeader>

        <DocumentDateReview
          source={source}
          initialStartDate={toDateInput(startDate)}
          initialEndDate={toDateInput(endDate)}
          onSave={saveDates}
          saveLabel="Save dates"
          savingLabel="Saving…"
          footnote="Saving records an edit in this contract's activity log, attributed to you."
          idPrefix="viewer"
        />
      </DialogContent>
    </Dialog>
  )
}
