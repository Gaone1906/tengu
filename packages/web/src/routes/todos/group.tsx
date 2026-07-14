import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import type { Employee, WorkItemCompactWire, WorkItemDetailWire } from "@/lib/api"
import { StateCircle, type StateGlyphKey } from "./state-glyph"
import { TodoRow } from "./row"

/* design-todos §4.2 — a collection gets ONE grouped inset: a quiet
 * --bg-secondary container carrying the page's only card shadow, with flat
 * hoverable rows inside. §4.5 — rows drag to reorder within their group
 * (manual rank): grip or long-press lifts, siblings shift out of the way, the
 * landing slot renders as a rounded --fill-quaternary blank, ⌘↑/⌘↓ moves the
 * focused row. Cross-group drag is deliberately out (a group change is a
 * status transition owned by the gateway). */

interface DragState {
  id: string
  fromIndex: number
  toIndex: number
  /** Pointer travel from the lift point. */
  dy: number
  /** Measured heights of every row at lift time (drag math stays stable). */
  heights: number[]
  /** offsetTop of every row at lift time. */
  tops: number[]
}

/** Where the lifted row lands: the count of other rows whose midpoint sits
 *  above the dragged row's current center. */
function targetIndex(drag: DragState): number {
  const { fromIndex, dy, heights, tops } = drag
  const center = tops[fromIndex] + dy + heights[fromIndex] / 2
  let above = 0
  for (let i = 0; i < heights.length; i++) {
    if (i === fromIndex) continue
    if (center > tops[i] + heights[i] / 2) above++
  }
  return Math.max(0, Math.min(heights.length - 1, above))
}

export function TodoGroup({
  glyph,
  label,
  count,
  countSuffix,
  items,
  detailById,
  byName,
  onOpen,
  onRename,
  onReorder,
  collapsible = false,
  defaultOpen = true,
  hiddenCount = 0,
  onShowMore,
  loadingMore = false,
  now,
  testId,
}: {
  glyph: StateGlyphKey
  label: string
  /** TRUE total for the group (server total when known, else fetched count). */
  count: number
  /** e.g. "this week" after the Done count. */
  countSuffix?: string
  items: WorkItemCompactWire[]
  detailById?: Map<string, WorkItemDetailWire>
  byName: Map<string, Employee>
  onOpen: (id: string) => void
  onRename?: (id: string, title: string) => Promise<void>
  /** Manual-rank reorder within this group; absent → no drag affordance. */
  onReorder?: (id: string, fromIndex: number, toIndex: number) => void
  collapsible?: boolean
  defaultOpen?: boolean
  hiddenCount?: number
  onShowMore?: () => void
  /** A wider server page is in flight for this group's Show-more. */
  loadingMore?: boolean
  now?: number
  testId?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [announce, setAnnounce] = useState("")
  const wrapRefs = useRef<(HTMLDivElement | null)[]>([])
  const dragRef = useRef<DragState | null>(null)
  const reducedMotion = useMemo(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  useEffect(() => {
    dragRef.current = drag
  }, [drag])

  const beginDrag = useCallback(
    (id: string, index: number, clientY: number) => {
      const tops: number[] = []
      const heights: number[] = []
      for (let i = 0; i < items.length; i++) {
        const el = wrapRefs.current[i]
        tops.push(el?.offsetTop ?? i * 48)
        heights.push(el?.offsetHeight ?? 48)
      }
      const state: DragState = { id, fromIndex: index, toIndex: index, dy: 0, heights, tops }
      setDrag(state)

      const onMove = (e: PointerEvent) => {
        const cur = dragRef.current
        if (!cur) return
        const dy = e.clientY - clientY
        const next = { ...cur, dy }
        next.toIndex = targetIndex(next)
        setDrag(next)
        e.preventDefault()
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
        const cur = dragRef.current
        setDrag(null)
        if (cur && cur.toIndex !== cur.fromIndex) onReorder?.(cur.id, cur.fromIndex, cur.toIndex)
      }
      window.addEventListener("pointermove", onMove, { passive: false })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    },
    [items.length, onReorder],
  )

  const gripDown = useCallback(
    (id: string, index: number) => (e: React.PointerEvent) => {
      if (!onReorder) return
      e.preventDefault()
      beginDrag(id, index, e.clientY)
    },
    [beginDrag, onReorder],
  )

  const keyMove = useCallback(
    (id: string, index: number) => (e: React.KeyboardEvent) => {
      if (!onReorder || !(e.metaKey || e.ctrlKey)) return
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
      e.preventDefault()
      e.stopPropagation()
      const to = e.key === "ArrowUp" ? index - 1 : index + 1
      if (to < 0 || to >= items.length) return
      onReorder(id, index, to)
      setAnnounce(`Moved to position ${to + 1} of ${items.length}`)
    },
    [items.length, onReorder],
  )

  const showBody = !collapsible || open
  const chevronOpen = !collapsible || open

  return (
    <section className="mb-[22px]" data-testid={testId}>
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => collapsible && setOpen((v) => !v)}
        aria-expanded={collapsible ? open : undefined}
        className="flex min-h-11 w-full items-center gap-2 px-1.5 text-left disabled:cursor-default"
        data-testid={testId ? `${testId}-header` : undefined}
      >
        <StateCircle keyOf={glyph} size={20} />
        <span className="text-[length:var(--text-footnote)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-secondary)]">
          {label}
        </span>
        <span className="text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
          {count}
          {countSuffix ? ` ${countSuffix}` : ""}
        </span>
        {collapsible && (
          <ChevronDown
            size={13}
            strokeWidth={2.4}
            className="ml-auto text-[var(--text-quaternary)] transition-transform duration-200 ease-[var(--ease-smooth)]"
            style={{ transform: chevronOpen ? undefined : "rotate(-90deg)" }}
            aria-hidden
          />
        )}
      </button>

      {showBody && (
        <div className="relative rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
          {/* Landing slot — a rounded blank where the lifted row will settle. */}
          {drag && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-[5px] right-[5px] rounded-[13px] bg-[var(--fill-quaternary)]"
              style={{
                // Moving down: the gap opens under the last shifted row; moving
                // up (or not at all): it opens at the target row's own top.
                top:
                  drag.toIndex > drag.fromIndex
                    ? drag.tops[drag.toIndex] + drag.heights[drag.toIndex] - drag.heights[drag.fromIndex]
                    : drag.tops[drag.toIndex],
                height: drag.heights[drag.fromIndex],
              }}
            />
          )}
          {items.map((item, i) => {
            let shift = 0
            let lifted = false
            if (drag) {
              if (item.id === drag.id) lifted = true
              else if (drag.toIndex > drag.fromIndex && i > drag.fromIndex && i <= drag.toIndex) shift = -drag.heights[drag.fromIndex]
              else if (drag.toIndex < drag.fromIndex && i >= drag.toIndex && i < drag.fromIndex) shift = drag.heights[drag.fromIndex]
            }
            return (
              <div
                key={item.id}
                data-todo-anchor={item.id}
                ref={(el) => {
                  wrapRefs.current[i] = el
                }}
                onKeyDown={keyMove(item.id, i)}
                className={lifted ? "relative z-10 rounded-[13px] bg-[var(--bg-tertiary)] shadow-[var(--shadow-overlay)]" : "relative"}
                style={
                  lifted
                    ? { transform: reducedMotion ? `translateY(${drag!.dy}px)` : `translateY(${drag!.dy}px) scale(1.015)`, cursor: "grabbing" }
                    : {
                        transform: shift ? `translateY(${shift}px)` : undefined,
                        transition: reducedMotion ? undefined : "transform 240ms var(--ease-smooth)",
                      }
                }
              >
                <TodoRow
                  item={item}
                  detail={detailById?.get(item.id)}
                  byName={byName}
                  onOpen={onOpen}
                  onRename={onRename}
                  onGripPointerDown={onReorder ? gripDown(item.id, i) : undefined}
                  onMoveUp={onReorder && i > 0 ? () => onReorder(item.id, i, i - 1) : undefined}
                  onMoveDown={onReorder && i < items.length - 1 ? () => onReorder(item.id, i, i + 1) : undefined}
                  now={now}
                />
              </div>
            )
          })}
          {hiddenCount > 0 && onShowMore && (
            <button
              type="button"
              onClick={onShowMore}
              disabled={loadingMore}
              data-testid={testId ? `${testId}-more` : undefined}
              className="flex min-h-11 w-full items-center gap-1.5 rounded-[13px] pl-[42px] pr-3 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] disabled:opacity-50 max-[500px]:pl-[46px]"
            >
              <ChevronDown size={11} strokeWidth={2.4} aria-hidden />
              {loadingMore ? "Loading…" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </section>
  )
}

/** §4.8 — skeleton keeps the exact 46px row geometry so nothing shifts when
 *  data lands. Never a centered "Loading…" string. */
export function GroupSkeleton() {
  const widths = ["46%", "58%", "38%"]
  const metas = [64, 40, 52]
  return (
    <section className="mb-[22px]" data-testid="todos-skeleton" aria-hidden>
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
        <span className="h-3 w-16 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      </div>
      <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
        {widths.map((w, i) => (
          <div key={i} className="flex min-h-[46px] items-center gap-2.5 py-[7px] pl-2 pr-3">
            <span
              className="ml-[24px] size-6 flex-none rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite] max-[500px]:ml-0"
              style={{ animationDelay: `${i * 200}ms` }}
            />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: w, animationDelay: `${i * 200}ms` }}
            />
            <span className="flex-1" />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: metas[i], animationDelay: `${i * 200}ms` }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

/** §4.8 — the Active lens with no open work. */
export function LedgerEmpty() {
  return (
    <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]" data-testid="active-empty">
      <div className="px-6 pb-10 pt-[46px] text-center">
        <div
          className="mx-auto mb-[18px] grid size-16 place-items-center rounded-[22px]"
          style={{
            background: "color-mix(in srgb, var(--system-green) 13%, transparent)",
            color: "var(--system-green)",
            boxShadow: "var(--inset-shine)",
          }}
          aria-hidden
        >
          <Check size={28} strokeWidth={2.2} />
        </div>
        <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          All quiet.
        </h3>
        <p className="mx-auto mt-2 max-w-[300px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
          No open work right now. New todos land here the moment the company mints them.
        </p>
      </div>
    </div>
  )
}

/** §4.8 — filtered-empty always offers the way back. */
export function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-6 py-14 text-center" data-testid="filtered-empty">
      <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">No todos match.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-2 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
      >
        Clear filters
      </button>
    </div>
  )
}
