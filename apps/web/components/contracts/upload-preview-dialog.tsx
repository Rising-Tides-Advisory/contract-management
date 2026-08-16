"use client"

/**
 * The same document-beside-the-dates surface as the contract detail page, but
 * for the upload wizard — before the contract exists.
 *
 * Nothing has been persisted at this point, so there is no signed URL and no
 * stored extracted text to fetch. PDFs render straight from the File the user
 * picked, via an object URL, which is both simpler and faster than a round
 * trip. DOCX still cannot be rendered by a browser, so it falls back to the
 * text the extract-preview route already pulled out on its way to the AI —
 * returned in that same response rather than re-parsed here.
 *
 * "Save" fills in the form. The contract is created later, by the wizard.
 */

import { useEffect, useState } from "react"
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

interface Props {
  file: File
  /** Text the extract-preview route read out of the document, if any. */
  documentText: string | null
  /** Whether that text was cut short by the extractor's character cap. */
  documentTextTruncated?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** yyyy-MM-dd, as currently held by the wizard form. */
  startDate: string
  endDate: string
  onApply: (dates: { startDate: string; endDate: string }) => void
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}

export function UploadPreviewDialog({
  file,
  documentText,
  documentTextTruncated = false,
  open,
  onOpenChange,
  startDate,
  endDate,
  onApply,
}: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const isPdf = isPdfFile(file)

  useEffect(() => {
    if (!open || !isPdf) return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => {
      URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [open, isPdf, file])

  const textNote = [
    isPdf
      ? "Showing the text read from this document."
      : "Word documents cannot be displayed in the browser — showing the extracted text.",
    documentTextTruncated
      ? "This is the opening section only; the extractor reads up to 8,000 characters."
      : null,
  ]
    .filter(Boolean)
    .join(" ")

  const source: DocumentSource =
    isPdf && url
      ? { kind: "pdf", url, title: file.name }
      : documentText
        ? { kind: "text", text: documentText, note: textNote }
        : {
            kind: "unavailable",
            message:
              "This document could not be displayed. You can still enter the dates by hand on the form.",
          }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-6xl, not max-w-6xl — DialogContent's own sm:max-w-sm would
          otherwise win from the media query and pin this to 384px. */}
      <DialogContent className="sm:max-w-6xl h-[85vh] flex flex-col gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{file.name}</span>
          </DialogTitle>
          <DialogDescription>
            Read the contract and set the dates AI could not determine.
          </DialogDescription>
        </DialogHeader>

        <DocumentDateReview
          source={source}
          initialStartDate={startDate}
          initialEndDate={endDate}
          onSave={(dates) => {
            onApply(dates)
            onOpenChange(false)
          }}
          saveLabel="Use these dates"
          savingLabel="Applying…"
          footnote="These fill the Timeline fields on the form. Nothing is saved until you create the contract."
          idPrefix="upload-preview"
        />
      </DialogContent>
    </Dialog>
  )
}
