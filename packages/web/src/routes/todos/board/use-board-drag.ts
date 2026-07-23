import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { canDropOn } from "@/lib/legal-targets"
import { rankBetween } from "@/lib/todos"

/* Todos v2 slice 6 — board drag (design-doc §5, states mock specimen 4).
 * Hand-rolled pointer engine in the group.tsx idiom (no dnd-kit):
 *  - within a column: rank reorder (midpoint math, rankBetween);
 *  - across columns: a drop IS a status transition, so only edges the gateway
 *    will accept are live — illegal/gated columns recede to 38% and render no
 *    slot, which IS the affordance;
 *  - lift: bg-tertiary + shadow-overlay + scale 1.02 + 1.2° tilt (no scale/
 *    tilt under reduced motion); touch lifts on a long-press. */

const LIFT_THRESHOLD_PX = 5
const TOUCH_HOLD_MS = 300

export interface BoardDragState {
  id: string
  item: WorkItemCompactWire
  fromStatus: WorkItemStatusWire
  fromIndex: number
  width: number
  height: number
  /** Ghost top-left in viewport coordinates. */
  x: number
  y: number
  /** Columns that are live drop targets (source column included for rank). */
  legal: ReadonlySet<WorkItemStatusWire>
  /** Hovered LIVE column (null while over dead space / a dimmed column). */
  overStatus: WorkItemStatusWire | null
  /** Slot index within the hovered column (dragged card excluded). */
  overIndex: number
}

export interface BoardDragCallbacks {
  /** Same-column drop at a new position. */
  onRank: (item: WorkItemCompactWire, beforeRank: number | null, afterRank: number | null) => void
  /** Cross-column drop on a live column, at the slot index. */
  onTransition: (item: WorkItemCompactWire, to: WorkItemStatusWire, index: number) => void
}

interface ColumnGeometry {
  status: WorkItemStatusWire
  rect: DOMRect
  cardTops: number[]
  cardHeights: number[]
}

export function useBoardDrag(
  itemsByStatus: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>>,
  openChildrenOf: (id: string) => number,
  callbacks: BoardDragCallbacks,
) {
  const [drag, setDrag] = useState<BoardDragState | null>(null)
  const dragRef = useRef<BoardDragState | null>(null)
  const columnEls = useRef(new Map<WorkItemStatusWire, HTMLElement>())
  const geometryRef = useRef<ColumnGeometry[]>([])
  const itemsRef = useRef(itemsByStatus)
  itemsRef.current = itemsByStatus
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const reducedMotion = useMemo(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  const registerColumn = useCallback((status: WorkItemStatusWire) => (el: HTMLElement | null) => {
    if (el) columnEls.current.set(status, el)
    else columnEls.current.delete(status)
  }, [])

  const measure = useCallback((draggedId: string): ColumnGeometry[] => {
    const out: ColumnGeometry[] = []
    for (const [status, el] of columnEls.current) {
      const rect = el.getBoundingClientRect()
      const cardTops: number[] = []
      const cardHeights: number[] = []
      for (const card of el.querySelectorAll<HTMLElement>("[data-board-card]")) {
        if (card.dataset.boardCard === draggedId) continue
        const r = card.getBoundingClientRect()
        cardTops.push(r.top)
        cardHeights.push(r.height)
      }
      out.push({ status, rect, cardTops, cardHeights })
    }
    return out
  }, [])

  const finishDrag = useCallback((commit: boolean) => {
    const state = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!state || !commit || state.overStatus === null) return
    const { item, fromStatus, fromIndex, overStatus, overIndex } = state
    if (overStatus === fromStatus) {
      const siblings = (itemsRef.current[fromStatus] ?? []).filter((it) => it.id !== item.id)
      // Dropping back into its own gap is a no-op.
      if (overIndex === fromIndex) return
      const before = overIndex > 0 ? siblings[overIndex - 1] : null
      const after = overIndex < siblings.length ? siblings[overIndex] : null
      callbacksRef.current.onRank(item, before?.rank ?? null, after?.rank ?? null)
      return
    }
    callbacksRef.current.onTransition(item, overStatus, overIndex)
  }, [])

  /** Attach to a card's onPointerDown. Lift starts after a small travel
   *  threshold (mouse) or a hold (touch) so plain clicks still open the card. */
  const liftPointerDown = useCallback(
    (event: React.PointerEvent, item: WorkItemCompactWire) => {
      if (event.button !== 0 && event.pointerType !== "touch") return
      const target = event.target as HTMLElement
      // Interactive children (roll-up pill, tray, links) own their pointer.
      if (target.closest("button, a, input, [data-board-card-tree]")) return
      const cardEl = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-board-card]")
        ?? (event.currentTarget as HTMLElement)
      const startX = event.clientX
      const startY = event.clientY
      const rect = cardEl.getBoundingClientRect()
      const grabDX = startX - rect.left
      const grabDY = startY - rect.top
      const isTouch = event.pointerType === "touch"
      let lifted = false
      let holdTimer: number | null = null

      const lift = (x: number, y: number) => {
        lifted = true
        const from = item.status
        const legal = new Set<WorkItemStatusWire>([from])
        const ctx = { openChildren: openChildrenOf(item.id) }
        for (const status of Object.keys(itemsRef.current) as WorkItemStatusWire[]) {
          if (canDropOn(from, status, ctx)) legal.add(status)
        }
        geometryRef.current = measure(item.id)
        const fromIndex = (itemsRef.current[from] ?? []).findIndex((it) => it.id === item.id)
        const state: BoardDragState = {
          id: item.id,
          item,
          fromStatus: from,
          fromIndex: Math.max(0, fromIndex),
          width: rect.width,
          height: rect.height,
          x: x - grabDX,
          y: y - grabDY,
          legal,
          overStatus: from,
          overIndex: Math.max(0, fromIndex),
        }
        dragRef.current = state
        setDrag(state)
      }

      const track = (x: number, y: number) => {
        const state = dragRef.current
        if (!state) return
        let overStatus: WorkItemStatusWire | null = null
        let overIndex = 0
        for (const col of geometryRef.current) {
          if (x >= col.rect.left && x <= col.rect.right && y >= col.rect.top - 60 && y <= Math.max(col.rect.bottom, col.rect.top + 200)) {
            if (!state.legal.has(col.status)) break
            overStatus = col.status
            let above = 0
            for (let i = 0; i < col.cardTops.length; i++) {
              if (y > col.cardTops[i] + col.cardHeights[i] / 2) above++
            }
            overIndex = above
            break
          }
        }
        const next: BoardDragState = { ...state, x: x - grabDX, y: y - grabDY, overStatus, overIndex }
        dragRef.current = next
        setDrag(next)
      }

      const onMove = (e: PointerEvent) => {
        if (!lifted) {
          const travelled = Math.hypot(e.clientX - startX, e.clientY - startY)
          if (isTouch && holdTimer !== null) {
            // Moving before the hold fires = a scroll, not a lift.
            if (travelled > LIFT_THRESHOLD_PX) cleanup()
            return
          }
          if (travelled < LIFT_THRESHOLD_PX) return
          lift(e.clientX, e.clientY)
        }
        e.preventDefault()
        track(e.clientX, e.clientY)
      }

      const cleanup = () => {
        if (holdTimer !== null) window.clearTimeout(holdTimer)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        window.removeEventListener("keydown", onKey)
      }
      const onUp = () => {
        cleanup()
        finishDrag(true)
      }
      const onCancel = () => {
        cleanup()
        finishDrag(false)
      }
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          cleanup()
          finishDrag(false)
        }
      }

      if (isTouch) {
        holdTimer = window.setTimeout(() => {
          holdTimer = null
          lift(startX, startY)
        }, TOUCH_HOLD_MS)
      }
      window.addEventListener("pointermove", onMove, { passive: false })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKey)
    },
    [finishDrag, measure, openChildrenOf],
  )

  useEffect(() => () => {
    dragRef.current = null
  }, [])

  return { drag, registerColumn, liftPointerDown, reducedMotion }
}
