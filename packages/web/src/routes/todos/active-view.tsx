import { useCallback, useMemo, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemDetailWire } from "@/lib/api"
import {
  groupBoard,
  groupHistory,
  isHistoryView,
  isOpen,
  isRecentDone,
  rankBetween,
  type DisplayGroup,
  type TodoFilters,
} from "@/lib/todos"
import type { StateGlyphKey } from "./state-glyph"
import type { LedgerData } from "./use-todos"
import { TodoGroup, LedgerEmpty, FilteredEmpty } from "./group"

/* design-todos §2–4 — Active is the ledger: every status group is ONE grouped
 * inset in a single 840px column (the kanban is retired), Done is a collapsed
 * disclosure, and a closed-status filter regroups the same list by date. The
 * page default (20 rows) caps each group with a quiet Show-more; headers show
 * the truest total the gateway can report — nothing is silently hidden. */

const PAGE_SIZE = 20

const GROUP_GLYPH: Record<DisplayGroup, StateGlyphKey> = {
  executing: "executing",
  review: "review",
  assigned: "assigned",
  backlog: "backlog",
  done: "done",
}

/** The underlying statuses whose server totals a display group aggregates. */
const GROUP_STATUSES: Record<DisplayGroup, readonly ("backlog" | "assigned" | "executing" | "blocked" | "in_review" | "escalated" | "done")[]> = {
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
  onClearFilters,
  filtered,
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
  onClearFilters: () => void
  /** Any filter set → empty state offers Clear instead of All-quiet. */
  filtered: boolean
  now: number
}) {
  const [visible, setVisible] = useState<Record<string, number>>({})
  // Manual order overrides, per group, applied over the server order until the
  // gateway persists rank (§7.3) — a successful PATCH makes these permanent.
  const [orderOverride, setOrderOverride] = useState<Record<string, string[]>>({})

  const history = isHistoryView(filters)
  const showMore = useCallback((key: string, total: number) => {
    setVisible((v) => ({ ...v, [key]: Math.min((v[key] ?? PAGE_SIZE) + PAGE_SIZE, total) }))
  }, [])

  // The ledger shows open work + done inside the recent window; a history view
  // (closed-status filter) shows everything it fetched, regrouped by date.
  const ledgerItems = useMemo(
    () => data.items.filter((i) => isOpen(i.status) || isRecentDone(i, now)),
    [data.items, now],
  )
  const groups = useMemo(() => (history ? [] : groupBoard(ledgerItems)), [history, ledgerItems])
  const historyGroups = useMemo(() => (history ? groupHistory(data.items, now) : []), [history, data.items, now])

  const orderedItems = useCallback(
    (key: string, items: WorkItemCompactWire[]): WorkItemCompactWire[] => {
      const order = orderOverride[key]
      if (!order) return items
      const pos = new Map(order.map((id, i) => [id, i]))
      return items.slice().sort((a, b) => (pos.get(a.id) ?? order.length) - (pos.get(b.id) ?? order.length))
    },
    [orderOverride],
  )

  const reorder = useCallback(
    (key: string, items: WorkItemCompactWire[]) => (id: string, fromIndex: number, toIndex: number) => {
      const ids = items.map((i) => i.id)
      ids.splice(fromIndex, 1)
      ids.splice(toIndex, 0, id)
      setOrderOverride((o) => ({ ...o, [key]: ids }))
      // Midpoint rank between the new neighbours (their current rank, else none).
      const byId = new Map(items.map((i) => [i.id, i]))
      const before = toIndex > 0 ? (byId.get(ids[toIndex - 1])?.rank ?? null) : null
      const after = toIndex < ids.length - 1 ? (byId.get(ids[toIndex + 1])?.rank ?? null) : null
      onRankChange(id, rankBetween(before, after))
    },
    [onRankChange],
  )

  if ((history ? data.items : ledgerItems).length === 0) {
    return filtered ? <FilteredEmpty onClear={onClearFilters} /> : <LedgerEmpty />
  }

  if (history) {
    return (
      <div data-testid="todos-history">
        {historyGroups.map((g) => {
          const shown = visible[g.bucket] ?? PAGE_SIZE
          const items = g.items.slice(0, shown)
          return (
            <TodoGroup
              key={g.bucket}
              glyph={filters.status === "cancelled" ? "cancelled" : "done"}
              label={g.label}
              count={g.items.length}
              items={items}
              detailById={detailById}
              byName={byName}
              onOpen={onOpen}
              onRename={onRename}
              hiddenCount={Math.max(0, g.items.length - shown)}
              onShowMore={() => showMore(g.bucket, g.items.length)}
              now={now}
              testId={`todos-group-${g.bucket}`}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div data-testid="todos-ledger">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => {
          const isDone = g.group === "done"
          const ordered = orderedItems(g.group, g.items)
          const shown = visible[g.group] ?? PAGE_SIZE
          const items = ordered.slice(0, shown)
          // Truest total: the per-status server totals when the gateway reports
          // them, else what we actually fetched.
          const total = GROUP_STATUSES[g.group].reduce((sum, s) => sum + (data.totalsByStatus[s] ?? 0), 0) || g.items.length
          return (
            <TodoGroup
              key={g.group}
              glyph={GROUP_GLYPH[g.group]}
              label={g.label}
              count={total}
              countSuffix={isDone ? "this week" : undefined}
              items={items}
              detailById={detailById}
              byName={byName}
              onOpen={onOpen}
              onRename={onRename}
              onReorder={isDone ? undefined : reorder(g.group, ordered)}
              collapsible={isDone}
              defaultOpen={!isDone}
              hiddenCount={Math.max(0, ordered.length - shown)}
              onShowMore={() => showMore(g.group, ordered.length)}
              now={now}
              testId={`todos-group-${g.group}`}
            />
          )
        })}
    </div>
  )
}
