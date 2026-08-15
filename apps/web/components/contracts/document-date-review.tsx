"use client"

/**
 * The document beside the two dates AI most often fails to produce.
 *
 * Shared by the two places that need it: the contract detail page, where the
 * file lives in storage and saving PATCHes the contract, and the new-contract
 * upload wizard, where the file is still only in the browser and "saving" means
 * filling in the form. Everything those two share — the split layout, the date
 * inputs, the ordering check — lives here; each caller supplies the document
 * and decides what saving means.
 */

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** What to render in the document pane. */
export type DocumentSource =
  | { kind: "loading" }
  /** Anything a browser can render itself — in practice, a PDF. */
  | { kind: "pdf"; url: string; title: string }
  /** Extracted text, for formats the browser cannot render (DOCX). */
  | { kind: "text"; text: string; note?: string }
  | { kind: "unavailable"; message: string }

interface Props {
  source: DocumentSource
  /** yyyy-MM-dd, as a date input expects. */
  initialStartDate: string
  initialEndDate: string
  onSave: (dates: { startDate: string; endDate: string }) => void | Promise<void>
  saveLabel: string
  savingLabel: string
  footnote: string
  /** Namespaces the input ids so two of these can coexist in one document. */
  idPrefix: string
}

export function DocumentDateReview({
  source,
  initialStartDate,
  initialEndDate,
  onSave,
  saveLabel,
  savingLabel,
  footnote,
  idPrefix,
}: Props) {
  const [start, setStart] = useState(initialStartDate)
  const [end, setEnd] = useState(initialEndDate)
  const [saving, setSaving] = useState(false)

  // Re-seed if the caller's values change underneath us — e.g. the detail page
  // refetching a contract after a save.
  useEffect(() => setStart(initialStartDate), [initialStartDate])
  useEffect(() => setEnd(initialEndDate), [initialEndDate])

  async function handleSave() {
    if (start && end && end < start) {
      toast.error("End date cannot be before the start date")
      return
    }
    setSaving(true)
    try {
      await onSave({ startDate: start, endDate: end })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
      {/* ── Document ─────────────────────────────────────────────── */}
      <div className="min-h-0 rounded-[var(--radius)] border border-border bg-muted/30 overflow-hidden">
        {source.kind === "loading" ? (
          <div className="h-full grid place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : source.kind === "pdf" ? (
          <iframe src={source.url} title={source.title} className="w-full h-full border-0" />
        ) : source.kind === "text" ? (
          <div className="h-full overflow-y-auto p-4">
            {source.note && (
              <p className="text-xs text-muted-foreground mb-3">{source.note}</p>
            )}
            <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed font-sans">
              {source.text}
            </pre>
          </div>
        ) : (
          <div className="h-full grid place-items-center px-6 text-center">
            <p className="text-sm text-muted-foreground">{source.message}</p>
          </div>
        )}
      </div>

      {/* ── Dates ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-start`}>Start date</Label>
          <Input
            id={`${idPrefix}-start`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-end`}>End date</Label>
          <Input
            id={`${idPrefix}-end`}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={saving}
          />
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? savingLabel : saveLabel}
        </Button>

        <p className="text-xs text-muted-foreground">{footnote}</p>
      </div>
    </div>
  )
}
