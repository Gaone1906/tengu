import { useRef } from "react"
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react"
import { api, type Employee, type WorkItemAttachmentWire } from "@/lib/api"
import { displayNameOf, formatRelativeTime } from "../util"

/* Todos v2 slice 6 — the attachments section (design-doc §7.2.10, mock
 * task-detail.html): inset rows (26px type glyph, filename, `size · who ·
 * when`), hover × to remove, `+ Attach a file` through the multipart route.
 * Item-level rows only — comment-level attachments render as chips inside the
 * activity feed. */

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function uploaderLabel(uploadedBy: string, byName: Map<string, Employee>): string {
  if (uploadedBy === "operator") return "You"
  if (uploadedBy.startsWith("session:")) return "a session"
  return displayNameOf(uploadedBy, byName)
}

export function AttachmentsSection({
  attachments,
  byName,
  onUpload,
  onRemove,
}: {
  attachments: WorkItemAttachmentWire[]
  byName: Map<string, Employee>
  onUpload: (files: File[]) => void
  onRemove: (attachment: WorkItemAttachmentWire) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const itemLevel = attachments.filter((attachment) => attachment.commentId === null)

  return (
    <section data-testid="task-attachments">
      <div
        className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        Attachments
      </div>
      {itemLevel.map((attachment) => (
        <div
          key={attachment.id}
          data-testid={`attachment-row-${attachment.id}`}
          className="group/att -mx-2.5 flex min-h-[38px] items-center gap-2.5 rounded-[10px] px-2.5 py-[5px] text-[14px] hover:bg-[var(--fill-quaternary)]"
        >
          <a
            className="focus-ring -mr-1.5 grid size-[26px] flex-none place-items-center rounded-lg bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] outline-none"
            href={api.workItemAttachmentUrl(attachment.workItemId, attachment.id)}
            download={attachment.filename}
            aria-label={`Download ${attachment.filename}`}
          >
            {isImageMime(attachment.mime) ? <ImageIcon size={13} strokeWidth={1.8} aria-hidden /> : <FileText size={13} strokeWidth={1.8} aria-hidden />}
          </a>
          <span className="ml-1.5 min-w-0 truncate font-medium text-[var(--text-primary)]">{attachment.filename}</span>
          <span className="ml-auto flex-none text-[12px] text-[var(--text-quaternary)]">
            {formatBytes(attachment.bytes)} · {uploaderLabel(attachment.uploadedBy, byName)} · {formatRelativeTime(attachment.createdAt)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${attachment.filename}`}
            data-testid={`attachment-remove-${attachment.id}`}
            onClick={() => onRemove(attachment)}
            className="focus-ring grid size-6 flex-none place-items-center rounded-md text-[var(--text-quaternary)] opacity-0 outline-none transition-opacity hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/att:opacity-100"
          >
            <X size={12} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
      ))}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        data-testid="attachment-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length > 0) onUpload(files)
        }}
      />
      <button
        type="button"
        data-testid="attachment-add"
        onClick={() => inputRef.current?.click()}
        className="focus-ring -mx-2.5 flex min-h-9 w-[calc(100%+20px)] items-center rounded-[10px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-quaternary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
      >
        <Paperclip size={12} strokeWidth={2} aria-hidden className="mr-4" />
        Attach a file
      </button>
    </section>
  )
}
