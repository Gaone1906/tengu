import { useCallback, useEffect, useMemo, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemDetailWire, WorkItemStatusWire } from "@/lib/api"
import {
  groupBoard,
  groupHistory,
  isHistoryView,
  rankBetween,
  statusesFor,
  type DisplayGroup,
  type TodoFilters,
} from "@/lib/todos"
import type { StateGlyphKey } from "./state-glyph"
import type { LedgerData } from "./use-todos"
import { TodoGroup, LedgerEmpty, FilteredEmpty } from "./group"

/* design-todos §2–4 — Active is the ledger: every status group is ONE grouped
 * inset in a single 840px column (the kanban is retired), Done is a collapsed
 * disclosure, and a closed-status filter regroups the same list by date.
 * Pagination is REAL: the data layer fetches a page per status and the header
 * shows the gateway's true total; "Show N more" asks the page for more rows
 * (`onLoadMore` raises the per-status want → subsequent offsets are fetched).
 * Nothing is silently hidden at any count. */

const GROUP_GLYPH: Record<DisplayGroup, StateGlyphKey> = {
  executing: "executing",
  review: "review",
  assigned: "assigned",
  backlog: "backlog",
  done: "done",
}

/** The underlying statuses whose server totals a display group aggregates. */
export const GROUP_STATUSES: Record<DisplayGroup, readonly WorkItemStatusWire[]> = {
  executing: ["executing", "blocked"],
  review: ["in_review", "escalated"],
  assigned: ["assigned"],
  backlog: ["backlog"],
  done: ["done"],
}

export function ActiveView({
  data,
  filters,
  detailById,
  byName,
  onOpen,
  onRename,
  onRankChange,
  rankReset,
  onLoadMore,
  onClearFilters,
  filtered,
  loadingMore = false,
  now,
}: {
  data: LedgerData
  filters: TodoFilters
  detailById: Map<string, WorkItemDetailWire>
  byName: Map<string, Employee>
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  /** Persist a manual rank (fire-and-forget; the view keeps its local order). */
  onRankChange: (id: string, rank: number) => void
  rankReset?: { id: string; revision: number } | null
  /** Fetch the next server page for these statuses (raises their `want`). */
  onLoadMore: (statuses: readonly WorkItemStatusWire[]) => void
  onClearFilters: () => void
  /** Any filter set → empty state offers Clear instead of All-quiet. */
  filtered: boolean
  /** A wider page is in flight (Show-more clicked; placeholder rows showing). */
  loadingMore?: boolean
  now: number
}) {
  // Per-item rank optimism lets one failed edit reset without masking a
  // different row's confirmed order.
  const [rankOverride, setRankOverride] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!rankReset) return
    setRankOverride((current) => {
      if (!(rankReset.id in current)) return current
      const next = { ...current }
      delete next[rankReset.id]
      return next
    })
  }, [rankReset])

  useEffect(() => {
    setRankOverride((current) => {
      let changed = false
      const next = { ...current }
      for (const item of data.items) {
        if (item.id in next && Object.is(item.rank, next[item.id])) {
          delete next[item.id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [data.items])

  const history = isHistoryView(filters)
  const optimisticItems = useMemo(() => data.items.map((item) => item.id in rankOverride
    ? { ...item, rank: rankOverride[item.id] }
    : item), [data.items, rankOverride])
  const groups = useMemo(() => (history ? [] : groupBoard(optimisticItems)), [history, optimisticItems])
  const historyGroups = useMemo(() => (history ? groupHistory(data.items, now) : []), [history, data.items, now])

  const reorder = useCallback(
    (_key: string, items: WorkItemCompactWire[]) => (id: string, fromIndex: number, toIndex: number) => {
      const ids = items.map((i) => i.id)
      ids.splice(fromIndex, 1)
      ids.splice(toIndex, 0, id)
      // Midpoint rank between the new neighbours (their current rank, else none).
      const byId = new Map(items.map((i) => [i.id, i]))
      const before = toIndex > 0 ? (byId.get(ids[toIndex - 1])?.rank ?? null) : null
      const after = toIndex < ids.length - 1 ? (byId.get(ids[toIndex + 1])?.rank ?? null) : null
      const rank = rankBetween(before, after)
      setRankOverride((current) => ({ ...current, [id]: rank }))
      onRankChange(id, rank)
    },
    [onRankChange],
  )

  if (data.items.length === 0) {
    return filtered ? <FilteredEmpty onClear={onClearFilters} /> : <LedgerEmpty />
  }

  if (history) {
    // History regroups by date; the server pages by status underneath. Fetched
    // rows all render; one trailing Show-more pulls the next page(s).
    const fetched = data.items.length
    const total = Object.values(data.totalsByStatus).reduce((sum, n) => sum + (n ?? 0), 0)
    const remaining = Math.max(0, total - fetched)
    return (
      <div data-testid="todos-history">
        {historyGroups.map((g) => (
          <TodoGroup
            key={g.bucket}
            glyph={filters.status === "cancelled" ? "cancelled" : "done"}
            label={g.label}
            count={g.items.length}
            items={g.items}
            detailById={detailById}
            byName={byName}
            onOpen={onOpen}
            onRename={onRename}
            now={now}
            testId={`todos-group-${g.bucket}`}
          />
        ))}
        {remaining > 0 && (
          <button
            type="button"
            data-testid="todos-history-more"
            disabled={loadingMore}
            onClick={() => onLoadMore(statusesFor(filters))}
            className="mx-auto flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : `Show ${remaining} more`}
          </button>
        )}
      </div>
    )
  }

  return (
    <div data-testid="todos-ledger">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => {
          const isDone = g.group === "done"
          const ordered = g.items
          // TRUE total straight from the gateway (per-status counts of the
          // whole filtered set, not the fetched page).
          const total = GROUP_STATUSES[g.group].reduce((sum, s) => sum + (data.totalsByStatus[s] ?? 0), 0)
          const remaining = Math.max(0, total - ordered.length)
          return (
            <TodoGroup
              key={g.group}
              glyph={GROUP_GLYPH[g.group]}
              label={g.label}
              count={total || ordered.length}
              countSuffix={isDone ? "this week" : undefined}
              items={ordered}
              detailById={detailById}
              byName={byName}
              onOpen={onOpen}
              onRename={onRename}
              onReorder={isDone ? undefined : reorder(g.group, ordered)}
              collapsible={isDone}
              defaultOpen={!isDone}
              hiddenCount={remaining}
              loadingMore={loadingMore}
              onShowMore={() => onLoadMore(GROUP_STATUSES[g.group])}
              now={now}
              testId={`todos-group-${g.group}`}
            />
          )
        })}
    </div>
  )
}
