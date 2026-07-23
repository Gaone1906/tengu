import type { ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"
import { StateCircle } from "../state-glyph"

/* Todos v2 slice 6 — the folded Closed rail (design-doc §2.1). Done and
 * Cancelled never occupy full columns at rest: one 44px vertical strip labeled
 * `Closed · N`, expanding on click into a closed-items column (Done group,
 * then Cancelled, true counts + show-more paging). Cards inside drag only to
 * Backlog — reopening. */

export function ClosedRail({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      data-testid="board-closed-rail"
      aria-label={`Closed, ${count} items — expand`}
      onClick={onExpand}
      className="focus-ring flex min-h-[220px] w-11 flex-none cursor-pointer flex-col items-center gap-2.5 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-0 pb-3.5 pt-2 transition-colors hover:bg-[var(--fill-tertiary)] max-[700px]:hidden"
    >
      <Check size={13} strokeWidth={2.4} aria-hidden className="text-[var(--system-green)]" />
      <span className="text-[12px] font-semibold tracking-[.02em] text-[var(--text-tertiary)]" style={{ writingMode: "vertical-rl" }}>
        Closed
      </span>
      <span className="text-[11px] tabular-nums text-[var(--text-quaternary)]" style={{ writingMode: "vertical-rl" }}>
        {count}
      </span>
    </button>
  )
}

export interface ClosedColumnGroupProps {
  status: "done" | "cancelled"
  count: number
  children: ReactNode
  hasMore: boolean
  loadMore: () => void
  loadingMore: boolean
}

/** One group (Done, then Cancelled) inside the expanded closed column. */
export function ClosedColumnGroup({ status, count, children, hasMore, loadMore, loadingMore }: ClosedColumnGroupProps) {
  if (count === 0) return null
  return (
    <div data-testid={`board-closed-group-${status}`} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-[13px] pt-1">
        <StateCircle keyOf={status} size={20} />
        <span className="text-[13px] font-semibold text-[var(--text-secondary)]">{status === "done" ? "Done" : "Cancelled"}</span>
        <span className="text-[12px] tabular-nums text-[var(--text-quaternary)]">{count}</span>
      </div>
      {children}
      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="min-h-9 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-[13px] text-left text-[12px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  )
}

export function ClosedColumnHeader({ count, onCollapse }: { count: number; onCollapse: () => void }) {
  return (
    <button
      type="button"
      data-testid="board-closed-collapse"
      aria-label="Collapse the closed column"
      onClick={onCollapse}
      className="focus-ring sticky top-0 z-[2] flex items-center gap-2 bg-[var(--bg)] px-[13px] pb-2.5 pt-0.5 text-left"
    >
      <Check size={13} strokeWidth={2.4} aria-hidden className="text-[var(--system-green)]" />
      <span className="text-[13px] font-semibold text-[var(--text-secondary)]">Closed</span>
      <span className="text-[12px] tabular-nums text-[var(--text-quaternary)]">{count}</span>
      <ChevronRight size={12} aria-hidden className="ml-auto rotate-180 text-[var(--text-quaternary)]" />
    </button>
  )
}
