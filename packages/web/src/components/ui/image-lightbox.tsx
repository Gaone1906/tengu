import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Download, X, ZoomIn } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export interface ImageLightboxItem {
  id: string
  url: string
  name: string
}

interface Point {
  x: number
  y: number
}

type Gesture =
  | { kind: "drag"; pointerId: number; start: Point; zoom: number; pan: Point }
  | {
      kind: "pinch"
      pointerIds: [number, number]
      startDistance: number
      startMidpoint: Point
      startZoom: number
      startPan: Point
      imageCenter: Point
    }

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const SWIPE_THRESHOLD = 88

function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

function panAroundPoint({
  startPan,
  startZoom,
  nextZoom,
  startPoint,
  nextPoint,
  imageCenter,
}: {
  startPan: Point
  startZoom: number
  nextZoom: number
  startPoint: Point
  nextPoint: Point
  imageCenter: Point
}): Point {
  if (nextZoom === MIN_ZOOM) return { x: 0, y: 0 }
  const ratio = nextZoom / startZoom
  return {
    x: nextPoint.x - imageCenter.x - (startPoint.x - imageCenter.x - startPan.x) * ratio,
    y: nextPoint.y - imageCenter.y - (startPoint.y - imageCenter.y - startPan.y) * ratio,
  }
}

export function ImageLightbox({
  image,
  gallery,
  onNavigate,
  onClose,
  onError,
  closeLabel = "Close preview",
  downloadLabel,
}: {
  image: ImageLightboxItem
  gallery: ImageLightboxItem[]
  onNavigate: (image: ImageLightboxItem) => void
  onClose: () => void
  onError?: () => void
  closeLabel?: string
  downloadLabel?: string
}) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setDragging(false)
    pointers.current.clear()
    gesture.current = null
  }, [])

  useEffect(() => resetView(), [image.id, resetView])

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 })
  }, [zoom])

  const navigate = useCallback((direction: -1 | 1) => {
    if (gallery.length < 2) return
    const current = gallery.findIndex((candidate) => candidate.id === image.id)
    const next = (current + direction + gallery.length) % gallery.length
    resetView()
    onNavigate(gallery[next])
  }, [gallery, image.id, onNavigate, resetView])

  const adjustZoom = useCallback((delta: number) => {
    setZoom((current) => clampZoom(current + delta))
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

  useEffect(() => {
    const element = imageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      const imageCenter = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      }
      const point = { x: event.clientX, y: event.clientY }
      const nextZoom = clampZoom(zoom * Math.exp(-event.deltaY * 0.002))
      setPan(panAroundPoint({
        startPan: pan,
        startZoom: zoom,
        nextZoom,
        startPoint: point,
        nextPoint: point,
        imageCenter,
      }))
      setZoom(nextZoom)
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [pan, zoom])

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="attachment-lightbox"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        overlayClassName="bg-[var(--scrim)]"
        className="inset-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
        style={{ left: 0, top: 0, transform: "none", maxWidth: "none" }}
      >
        <DialogTitle className="sr-only">{image.name}</DialogTitle>
        <img
          ref={imageRef}
          data-testid="attachment-lightbox-image"
          data-zoom={String(zoom)}
          src={image.url}
          alt={image.name}
          decoding="async"
          draggable={false}
          onError={onError}
          onDoubleClick={toggleZoom}
          onPointerDown={(event) => {
            const point = { x: event.clientX, y: event.clientY }
            pointers.current.set(event.pointerId, point)
            setDragging(true)
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId)
            } catch {
              // Synthetic pointers have no browser capture target; their events still reach this image.
            }

            const activePointers = [...pointers.current.entries()]
            if (activePointers.length >= 2) {
              event.preventDefault()
              const [[firstId, first], [secondId, second]] = activePointers
              const bounds = event.currentTarget.getBoundingClientRect()
              gesture.current = {
                kind: "pinch",
                pointerIds: [firstId, secondId],
                startDistance: Math.max(1, pointDistance(first, second)),
                startMidpoint: midpoint(first, second),
                startZoom: zoom,
                startPan: pan,
                imageCenter: {
                  x: bounds.left + bounds.width / 2,
                  y: bounds.top + bounds.height / 2,
                },
              }
            } else {
              gesture.current = {
                kind: "drag",
                pointerId: event.pointerId,
                start: point,
                zoom,
                pan,
              }
            }
          }}
          onPointerMove={(event) => {
            if (!pointers.current.has(event.pointerId)) return
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
            const currentGesture = gesture.current
            if (!currentGesture) return

            if (currentGesture.kind === "pinch") {
              const first = pointers.current.get(currentGesture.pointerIds[0])
              const second = pointers.current.get(currentGesture.pointerIds[1])
              if (!first || !second) return
              const nextZoom = clampZoom(
                currentGesture.startZoom * pointDistance(first, second) / currentGesture.startDistance,
              )
              setZoom(nextZoom)
              setPan(panAroundPoint({
                startPan: currentGesture.startPan,
                startZoom: currentGesture.startZoom,
                nextZoom,
                startPoint: currentGesture.startMidpoint,
                nextPoint: midpoint(first, second),
                imageCenter: currentGesture.imageCenter,
              }))
              return
            }

            if (currentGesture.pointerId !== event.pointerId) return
            setPan({
              x: currentGesture.pan.x + event.clientX - currentGesture.start.x,
              y: currentGesture.pan.y + event.clientY - currentGesture.start.y,
            })
          }}
          onPointerUp={(event) => {
            const currentGesture = gesture.current
            if (currentGesture?.kind === "drag" && currentGesture.pointerId === event.pointerId) {
              const deltaX = event.clientX - currentGesture.start.x
              const deltaY = event.clientY - currentGesture.start.y
              if (currentGesture.zoom === MIN_ZOOM) {
                if (deltaY > SWIPE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {
                  onClose()
                } else if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
                  navigate(deltaX < 0 ? 1 : -1)
                } else {
                  setPan({ x: 0, y: 0 })
                }
              }
            }

            pointers.current.delete(event.pointerId)
            gesture.current = null
            setDragging(false)
            try {
              event.currentTarget.releasePointerCapture?.(event.pointerId)
            } catch {
              // Capture may already be gone after a synthetic gesture or interrupted touch.
            }
          }}
          onPointerCancel={(event) => {
            pointers.current.delete(event.pointerId)
            gesture.current = null
            setDragging(false)
            if (zoom === MIN_ZOOM) setPan({ x: 0, y: 0 })
          }}
          className={`block max-h-[calc(100dvh-112px)] w-auto max-w-[calc(100vw-24px)] select-none rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] object-contain shadow-[var(--shadow-overlay)] sm:max-w-[calc(100vw-160px)] ${
            zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
          } ${dragging ? "" : "transition-transform duration-150 ease-out"}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            touchAction: "none",
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
          <span className="min-w-0 truncate pr-2 text-[13px] font-medium text-[var(--text-primary)]">{image.name}</span>
          <button
            type="button"
            data-testid="attachment-lightbox-zoom"
            aria-label={zoom === 1 ? "Zoom in" : "Reset zoom"}
            onClick={toggleZoom}
            className="focus-ring grid size-10 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <ZoomIn size={16} strokeWidth={2} aria-hidden />
          </button>
          <a
            href={image.url}
            download={image.name}
            aria-label={downloadLabel ?? `Download ${image.name}`}
            className="focus-ring grid size-10 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <Download size={16} strokeWidth={2} aria-hidden />
          </a>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="focus-ring grid size-10 flex-none place-items-center rounded-full text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
