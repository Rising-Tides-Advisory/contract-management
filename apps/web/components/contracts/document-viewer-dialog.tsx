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
import { FileText, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  const [saving, setSaving] = useState(false)

  const [start, setStart] = useState(toDateInput(startDate))
  const [end, setEnd] = useState(toDateInput(endDate))

  const isPdf = file?.mimeType === "application/pdf"

  useEffect(() => {
    setStart(toDateInput(startDate))
    setEnd(toDateInput(endDate))
  }, [startDate, endDate, open])

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

  async function saveDates() {
    if (start && end && end < start) {
      toast.error("End date cannot be before the start date")
      return
    }
    setSaving(true)
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
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl h-[85vh] flex flex-col gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{file?.filename ?? "Document"}</span>
          </DialogTitle>
          <DialogDescription>
            Read the contract and set the dates AI could not determine.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
          {/* ── Document ───────────────────────────────────────────── */}
          <div className="min-h-0 rounded-[var(--radius)] border border-border bg-muted/30 overflow-hidden">
            {loading ? (
              <div className="h-full grid place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : isPdf && url ? (
              <iframe
                src={url}
                title={file?.filename ?? "Contract document"}
                className="w-full h-full border-0"
              />
            ) : extractedText ? (
              <div className="h-full overflow-y-auto p-4">
                <p className="text-xs text-muted-foreground mb-3">
                  {file?.filename?.toLowerCase().endsWith(".docx")
                    ? "Word documents cannot be displayed in the browser — showing the extracted text."
                    : "Showing extracted text."}
                </p>
                <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed font-sans">
                  {extractedText}
                </pre>
              </div>
            ) : (
              <div className="h-full grid place-items-center px-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Nothing to display yet. If this file was just uploaded, text
                  extraction may still be running in the background worker.
                </p>
              </div>
            )}
          </div>

          {/* ── Dates ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="viewer-start">Start date</Label>
              <Input
                id="viewer-start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="viewer-end">End date</Label>
              <Input
                id="viewer-end"
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                disabled={saving}
              />
            </div>

            <Button onClick={saveDates} disabled={saving} className="w-full">
              {saving ? "Saving…" : "Save dates"}
            </Button>

            <p className="text-xs text-muted-foreground">
              Saving records an edit in this contract&apos;s activity log,
              attributed to you.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
