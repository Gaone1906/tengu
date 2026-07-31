import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Download, X, ZoomIn } from "lucide-react"
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
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const url = api.workItemAttachmentUrl(attachment.workItemId, attachment.id)

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setDragging(false)
    drag.current = null
  }, [])

  useEffect(() => resetView(), [attachment.id, resetView])

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 })
  }, [zoom])

  const navigate = useCallback((direction: -1 | 1) => {
    if (gallery.length < 2) return
    const current = gallery.findIndex((candidate) => candidate.id === attachment.id)
    const next = (current + direction + gallery.length) % gallery.length
    resetView()
    onNavigate(gallery[next])
  }, [attachment.id, gallery, onNavigate, resetView])

  const adjustZoom = useCallback((delta: number) => {
    setZoom((current) => Math.min(4, Math.max(1, current + delta)))
  }, [])

  const toggleZoom = useCallback(() => {
    setZoom((current) => current === 1 ? 2 : 1)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && gallery.length > 1) {
        event.preventDefault()
        navigate(-1)
      } else if (event.key === "ArrowRight" && gallery.length > 1) {
        event.preventDefault()
        navigate(1)
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault()
        adjustZoom(0.5)
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault()
        adjustZoom(-0.5)
      } else if (event.key === "0") {
        event.preventDefault()
        resetView()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [adjustZoom, gallery.length, navigate, resetView])

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="attachment-lightbox"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        className="inset-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
        style={{ left: 0, top: 0, transform: "none", maxWidth: "none" }}
      >
        <DialogTitle className="sr-only">{attachment.filename}</DialogTitle>
        <img
          data-testid="attachment-lightbox-image"
          data-zoom={String(zoom)}
          src={url}
          alt={attachment.filename}
          decoding="async"
          draggable={false}
          onError={onFail}
          onDoubleClick={toggleZoom}
          onPointerDown={(event) => {
            if (zoom === 1) return
            event.preventDefault()
            drag.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              panX: pan.x,
              panY: pan.y,
            }
            setDragging(true)
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start || start.pointerId !== event.pointerId) return
            setPan({
              x: start.panX + event.clientX - start.x,
              y: start.panY + event.clientY - start.y,
            })
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return
            drag.current = null
            setDragging(false)
            event.currentTarget.releasePointerCapture?.(event.pointerId)
          }}
          className={`block max-h-[calc(100dvh-112px)] w-auto max-w-[calc(100vw-24px)] select-none rounded-[14px] bg-[var(--bg-secondary)] object-contain shadow-[var(--shadow-overlay)] sm:max-w-[calc(100vw-160px)] ${
            zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
          } ${dragging ? "" : "transition-transform duration-150 ease-out"}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            touchAction: zoom > 1 ? "none" : "manipulation",
          }}
        />
        {gallery.length > 1 && (
          <>
            <button
              type="button"
              data-testid="attachment-lightbox-prev"
              aria-label="Previous image"
              onClick={() => navigate(-1)}
              className="focus-ring absolute left-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-[var(--material-thick)] text-[var(--text-secondary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-[20px] transition-transform duration-150 ease-out hover:text-[var(--text-primary)] active:scale-[0.96] sm:left-6"
            >
              <ChevronLeft size={19} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              data-testid="attachment-lightbox-next"
              aria-label="Next image"
              onClick={() => navigate(1)}
              className="focus-ring absolute right-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-[var(--material-thick)] text-[var(--text-secondary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-[20px] transition-transform duration-150 ease-out hover:text-[var(--text-primary)] active:scale-[0.96] sm:right-6"
            >
              <ChevronRight size={19} strokeWidth={2} aria-hidden />
            </button>
          </>
        )}
        <div
          className="absolute bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 flex w-fit max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-full py-1.5 pl-4 pr-1.5 backdrop-blur-[20px]"
          style={{ background: "var(--material-thick)", boxShadow: "var(--shadow-overlay)" }}
        >
          <span className="min-w-0 truncate pr-2 text-[13px] font-medium text-[var(--text-primary)]">{attachment.filename}</span>
          <button
            type="button"
            data-testid="attachment-lightbox-zoom"
            aria-label={zoom === 1 ? "Zoom in" : "Reset zoom"}
            onClick={toggleZoom}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <ZoomIn size={15} strokeWidth={2} aria-hidden />
          </button>
          <a
            href={url}
            download={attachment.filename}
            aria-label={`Download ${attachment.filename}`}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <Download size={15} strokeWidth={2} aria-hidden />
          </a>
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
