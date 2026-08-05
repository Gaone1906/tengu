import { useCallback, useRef, useState, type ReactNode } from "react"
import { Play, X } from "lucide-react"
import { ImageLightbox, type ImageLightboxItem } from "@/components/ui/image-lightbox"
import { VideoPlayer } from "@/components/ui/video-player"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
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

export function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/")
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
    canPreview: (attachment) => isVideoMime(attachment.mime) || (isImageMime(attachment.mime) && !broken.has(attachment.id)),
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
  const video = isVideoMime(attachment.mime)
  const [posterFailed, setPosterFailed] = useState(false)
  return (
    <div className={`group/tile relative ${dense ? "w-[118px]" : ""}`}>
      <button
        type="button"
        data-testid={testId ?? `attachment-tile-${attachment.id}`}
        aria-label={`${video ? "Play" : "Preview"} ${attachment.filename}`}
        onClick={(event) => preview.open(attachment, gallery, event.currentTarget)}
        className={`focus-ring block w-full overflow-hidden rounded-[14px] bg-[var(--fill-tertiary)] text-left outline-none transition-colors hover:bg-[var(--fill-secondary)] ${
          dense ? "shadow-[var(--shadow-ambient)]" : ""
        }`}
      >
        {video && posterFailed ? (
          <span
            role="img"
            aria-label={`${attachment.filename} preview unavailable`}
            className={`grid w-full place-items-center bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ${dense ? "h-[70px]" : "aspect-[3/2]"}`}
          >
            <Play size={dense ? 20 : 26} fill="currentColor" strokeWidth={1.4} aria-hidden className="ml-0.5" />
          </span>
        ) : (
          <img
            src={video ? `${url}?poster=1` : url}
            alt={video ? `${attachment.filename} preview` : attachment.filename}
            loading="lazy"
            decoding="async"
            onError={() => video ? setPosterFailed(true) : preview.fail(attachment)}
            className={`block w-full object-cover ${dense ? "h-[70px]" : "aspect-[3/2]"}`}
          />
        )}
        {video && !posterFailed && (
          <span className="pointer-events-none absolute left-1/2 top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--material-thick)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
            <Play size={16} fill="currentColor" strokeWidth={1.4} aria-hidden className="ml-0.5" />
          </span>
        )}
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
  if (isVideoMime(attachment.mime)) {
    return <AttachmentVideoDialog attachment={attachment} onClose={onClose} />
  }
  const imageGallery = gallery.filter((candidate) => isImageMime(candidate.mime))
  const toLightboxItem = (candidate: WorkItemAttachmentWire): ImageLightboxItem => ({
    id: candidate.id,
    url: api.workItemAttachmentUrl(candidate.workItemId, candidate.id),
    name: candidate.filename,
  })
  return (
    <ImageLightbox
      image={toLightboxItem(attachment)}
      gallery={imageGallery.map(toLightboxItem)}
      onNavigate={(next) => {
        const candidate = imageGallery.find((entry) => entry.id === next.id)
        if (candidate) onNavigate(candidate)
      }}
      onClose={onClose}
      onError={onFail}
    />
  )
}

function AttachmentVideoDialog({
  attachment,
  onClose,
}: {
  attachment: WorkItemAttachmentWire
  onClose: () => void
}) {
  const url = api.workItemAttachmentUrl(attachment.workItemId, attachment.id)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="attachment-video-dialog"
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="bg-[var(--scrim)]"
        className="w-[min(960px,calc(100vw-24px))] max-w-none border-0 bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">{attachment.filename}</DialogTitle>
        <VideoPlayer src={url} name={attachment.filename} className="max-w-none" />
        <button
          type="button"
          aria-label="Close video"
          onClick={onClose}
          className="focus-ring absolute -right-1 -top-11 grid size-10 place-items-center rounded-[var(--radius-md)] bg-[var(--material-thick)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-xl transition-transform active:scale-[0.96]"
        >
          <X size={18} strokeWidth={1.8} aria-hidden />
        </button>
      </DialogContent>
    </Dialog>
  )
}
