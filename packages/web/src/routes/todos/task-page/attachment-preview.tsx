import { useCallback, useRef, useState, type ReactNode } from "react"
import { ImageLightbox, type ImageLightboxItem } from "@/components/ui/image-lightbox"
import { api, type WorkItemAttachmentWire } from "@/lib/api"

/* Todos v2 — an image attachment is something you look at, not a filename you
 * download: ONE thumbnail tile shared by the item-level grid (attachments.tsx)
 * and the comment chip row (activity.tsx), opening that source's image gallery
 * in the shared dialog. A URL that fails to decode drops out of `canPreview`,
 * so the call site falls back to its row treatment instead of parking a
 * broken-image glyph in the page. */

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

export interface AttachmentPreview {
  /** Image bytes we still believe in — false once the browser failed the URL. */
  canPreview: (attachment: WorkItemAttachmentWire) => boolean
  open: (attachment: WorkItemAttachmentWire, gallery: WorkItemAttachmentWire[], opener: HTMLElement) => void
  fail: (attachment: WorkItemAttachmentWire) => void
  lightbox: ReactNode
}

interface ActivePreview {
  attachment: WorkItemAttachmentWire
  gallery: WorkItemAttachmentWire[]
}

export function useAttachmentPreview(): AttachmentPreview {
  const [active, setActive] = useState<ActivePreview | null>(null)
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set())
  const opener = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setActive(null)
    const target = opener.current
    window.setTimeout(() => target?.focus(), 0)
  }, [])

  const fail = (attachment: WorkItemAttachmentWire) => {
    setBroken((current) => new Set(current).add(attachment.id))
    if (active?.attachment.id === attachment.id) close()
  }

  return {
    canPreview: (attachment) => isImageMime(attachment.mime) && !broken.has(attachment.id),
    open: (attachment, gallery, target) => {
      opener.current = target
      setActive({ attachment, gallery })
    },
    fail,
    lightbox: active ? (
      <AttachmentLightbox
        attachment={active.attachment}
        gallery={active.gallery}
        onNavigate={(attachment) => setActive((current) => current ? { ...current, attachment } : null)}
        onClose={close}
        onFail={() => fail(active.attachment)}
      />
    ) : null,
  }
}

export function AttachmentTile({
  attachment,
  preview,
  gallery,
  meta,
  action,
  dense,
  testId,
}: {
  attachment: WorkItemAttachmentWire
  preview: AttachmentPreview
  gallery: WorkItemAttachmentWire[]
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
        onClick={(event) => preview.open(attachment, gallery, event.currentTarget)}
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
  gallery,
  onNavigate,
  onClose,
  onFail,
}: {
  attachment: WorkItemAttachmentWire
  gallery: WorkItemAttachmentWire[]
  onNavigate: (attachment: WorkItemAttachmentWire) => void
  onClose: () => void
  onFail: () => void
}) {
  const toLightboxItem = (candidate: WorkItemAttachmentWire): ImageLightboxItem => ({
    id: candidate.id,
    url: api.workItemAttachmentUrl(candidate.workItemId, candidate.id),
    name: candidate.filename,
  })
  return (
    <ImageLightbox
      image={toLightboxItem(attachment)}
      gallery={gallery.map(toLightboxItem)}
      onNavigate={(next) => {
        const candidate = gallery.find((entry) => entry.id === next.id)
        if (candidate) onNavigate(candidate)
      }}
      onClose={onClose}
      onError={onFail}
    />
  )
}
