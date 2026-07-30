import { useState, type ReactNode } from "react"
import { Download, X } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { api, type WorkItemAttachmentWire } from "@/lib/api"

/* Todos v2 — an image attachment is something you look at, not a filename you
 * download: ONE thumbnail tile shared by the item-level grid (attachments.tsx)
 * and the comment chip row (activity.tsx), opening the full-size view in the
 * shared dialog (Esc / backdrop / ×, focus returns to the tile). A URL that
 * fails to decode drops out of `canPreview`, so the call site falls back to its
 * row treatment instead of parking a broken-image glyph in the page. */

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

export interface AttachmentPreview {
  /** Image bytes we still believe in — false once the browser failed the URL. */
  canPreview: (attachment: WorkItemAttachmentWire) => boolean
  open: (attachment: WorkItemAttachmentWire) => void
  fail: (attachment: WorkItemAttachmentWire) => void
  lightbox: ReactNode
}

export function useAttachmentPreview(): AttachmentPreview {
  const [active, setActive] = useState<WorkItemAttachmentWire | null>(null)
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set())

  const fail = (attachment: WorkItemAttachmentWire) => {
    setBroken((current) => new Set(current).add(attachment.id))
    setActive((current) => (current?.id === attachment.id ? null : current))
  }

  return {
    canPreview: (attachment) => isImageMime(attachment.mime) && !broken.has(attachment.id),
    open: (attachment) => setActive(attachment),
    fail,
    lightbox: active ? (
      <AttachmentLightbox attachment={active} onClose={() => setActive(null)} onFail={() => fail(active)} />
    ) : null,
  }
}

export function AttachmentTile({
  attachment,
  preview,
  meta,
  action,
  dense,
  testId,
}: {
  attachment: WorkItemAttachmentWire
  preview: AttachmentPreview
  /** Second caption line — `size · who · when` on the item, size in the feed. */
  meta?: string
  /** Overlay affordance (the item-level remove ×), revealed on hover/focus. */
  action?: ReactNode
  /** Feed chips are fixed-width and caption-light; item tiles fill their cell. */
  dense?: boolean
  testId?: string
}) {
  const url = api.workItemAttachmentUrl(attachment.workItemId, attachment.id)
  return (
    <div className={`group/tile relative ${dense ? "w-[118px]" : ""}`}>
      <button
        type="button"
        data-testid={testId ?? `attachment-tile-${attachment.id}`}
        aria-label={`Preview ${attachment.filename}`}
        onClick={() => preview.open(attachment)}
        className={`focus-ring block w-full overflow-hidden rounded-[14px] bg-[var(--fill-tertiary)] text-left outline-none transition-colors hover:bg-[var(--fill-secondary)] ${
          dense ? "shadow-[var(--shadow-ambient)]" : ""
        }`}
      >
        <img
          src={url}
          alt={attachment.filename}
          loading="lazy"
          decoding="async"
          onError={() => preview.fail(attachment)}
          className={`block w-full object-cover ${dense ? "h-[70px]" : "aspect-[3/2]"}`}
        />
        <span
          data-testid={`attachment-caption-${attachment.id}`}
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-[var(--material-thick)] to-transparent opacity-0 transition-opacity duration-150 group-focus-within/tile:opacity-100 [@media(hover:hover)]:group-hover/tile:opacity-100 ${
            dense ? "px-2 pb-1.5 pt-6" : "px-2.5 pb-2 pt-8"
          }`}
        >
          <span className={`block truncate font-medium text-[var(--text-primary)] ${dense ? "text-[11px]" : "text-[12.5px]"}`}>
            {attachment.filename}
          </span>
          {meta && (
            <span className={`block truncate text-[var(--text-quaternary)] ${dense ? "text-[10px]" : "text-[11px]"}`}>
              {meta}
            </span>
          )}
        </span>
      </button>
      {action}
    </div>
  )
}

function AttachmentLightbox({
  attachment,
  onClose,
  onFail,
}: {
  attachment: WorkItemAttachmentWire
  onClose: () => void
  onFail: () => void
}) {
  const url = api.workItemAttachmentUrl(attachment.workItemId, attachment.id)
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="attachment-lightbox"
        className="w-[calc(100vw-24px)] max-w-none gap-0 border-0 bg-transparent p-0 shadow-none sm:w-[min(1100px,calc(100vw-96px))] sm:max-w-none"
      >
        <DialogTitle className="sr-only">{attachment.filename}</DialogTitle>
        <img
          src={url}
          alt={attachment.filename}
          decoding="async"
          onError={onFail}
          className="mx-auto block max-h-[calc(100dvh-160px)] w-auto max-w-full rounded-[14px] bg-[var(--bg-secondary)] object-contain shadow-[var(--shadow-overlay)]"
        />
        <div
          className="mx-auto mt-2.5 flex w-fit max-w-full items-center gap-1 rounded-full py-1.5 pl-4 pr-1.5 backdrop-blur-[20px]"
          style={{ background: "var(--material-thick)", boxShadow: "var(--shadow-overlay)" }}
        >
          <span className="min-w-0 truncate pr-2 text-[13px] font-medium text-[var(--text-primary)]">{attachment.filename}</span>
          <a
            href={url}
            download={attachment.filename}
            aria-label={`Download ${attachment.filename}`}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <Download size={15} strokeWidth={2} aria-hidden />
          </a>
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
