import { useRef, useState } from "react"

/* GRS-019 — the inspector's two containers (absorbs 016f).
 *
 * Desktop: a floating side panel (Style B) — an opaque elevated card inset from
 * the canvas edge, no hairline seam. Mobile: an opaque bottom sheet (Style A)
 * over a scrim — rounded top, grabber, --shadow-overlay, never see-through.
 * Both render the same inspector content; only the shell differs. CSS-hidden
 * per breakpoint (content components carry no ids that could collide). */

export function InspectorPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="hidden w-[360px] shrink-0 p-3 pl-0 md:block">
      <div className="h-full overflow-hidden rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]">
        {children}
      </div>
    </div>
  )
}

/** Bottom sheet with grabber drag-to-dismiss (spec §8): drag the grabber past
 * the threshold and the sheet follows the finger, then exits in 120ms
 * --ease-smooth; a short drag springs back. Tap-scrim dismiss preserved. */
export function InspectorSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const [dragY, setDragY] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const startY = useRef<number | null>(null)
  const dragging = startY.current !== null && !leaving

  const onTouchStart = (e: React.TouchEvent) => {
    if (leaving) return
    startY.current = e.touches[0].clientY
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null || leaving) return
    setDragY(Math.max(0, e.touches[0].clientY - startY.current))
  }
  const onTouchEnd = () => {
    if (startY.current === null || leaving) return
    startY.current = null
    if (dragY > 80) {
      setLeaving(true)
      setDragY(window.innerHeight)
      window.setTimeout(onClose, 130)
    } else {
      setDragY(0)
    }
  }

  return (
    <>
      <div
        className="absolute inset-0 z-10 md:hidden"
        style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
        aria-hidden
        onClick={onClose}
      />
      <div
        data-testid="wf-sheet"
        className="absolute inset-x-0 bottom-0 z-20 flex max-h-[78%] flex-col rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-overlay)] md:hidden"
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? "none" : "transform 120ms var(--ease-smooth)",
        }}
      >
        <div
          className="flex shrink-0 justify-center pb-2 pt-2.5"
          style={{ touchAction: "none" }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <span className="h-[5px] w-9 rounded-full bg-[var(--fill-primary)]" aria-hidden />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </>
  )
}
