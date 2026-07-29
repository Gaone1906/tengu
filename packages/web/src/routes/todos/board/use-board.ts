import { useCallback, useMemo } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import {
  api,
  type DepartmentSummaryWire,
  type WorkItemCompactWire,
  type WorkItemStatusWire,
  type WorkItemTreeWire,
} from "@/lib/api"
import { dateBounds, type TodoFilters } from "@/lib/todos"
import type { BoardId } from "./board-route"
import { boardKey } from "./board-route"

/* Todos v2 slice 6 — the board data layer (design-doc §11 queries).
 * One infinite query per status column, scoped per board:
 *   My requests   → createdBy=operator + rootsOnly
 *   department    → department=<slug> + rootsOnly
 *   Everything    → rootsOnly (no board-scope filter)
 * True per-column counts come from each query's `total` (the gateway counts the
 * whole filtered set before LIMIT/OFFSET — never a capped page length). */

export const PIPELINE_STATUSES: readonly WorkItemStatusWire[] = ["backlog", "assigned", "executing", "in_review"]
export const EXCEPTION_STATUSES: readonly WorkItemStatusWire[] = ["blocked", "escalated"]
export const CLOSED_STATUSES: readonly WorkItemStatusWire[] = ["done", "cancelled"]
const BOARD_STATUSES: readonly WorkItemStatusWire[] = [...PIPELINE_STATUSES, ...EXCEPTION_STATUSES, ...CLOSED_STATUSES]
const OPEN_STATUSES: readonly WorkItemStatusWire[] = [...PIPELINE_STATUSES, ...EXCEPTION_STATUSES]

export const BOARD_PAGE_SIZE = 20

/** Server params for a board scope (pure — unit-tested). Boards show roots
 *  only (§4): children live in the in-place tree tray, not as cards. */
export function boardScopeParams(board: BoardId): { createdBy?: string; department?: string; rootsOnly: true } {
  if (board.kind === "my") return { createdBy: "operator", rootsOnly: true }
  if (board.kind === "department") return { department: board.slug, rootsOnly: true }
  return { rootsOnly: true }
}

export interface BoardColumnData {
  status: WorkItemStatusWire
  items: WorkItemCompactWire[]
  /** TRUE server count for this column's scope+filter. */
  total: number
  hasMore: boolean
  loadMore: () => void
  loadingMore: boolean
}

interface BoardPage {
  workItems: WorkItemCompactWire[]
  total: number
  nextOffset: number | null
}

async function fetchBoardPage(
  board: BoardId,
  status: WorkItemStatusWire,
  filters: TodoFilters,
  since: string | undefined,
  until: string | undefined,
  offset: number,
): Promise<BoardPage> {
  const scope = boardScopeParams(board)
  const r = await api.listWorkItems({
    status,
    ...scope,
    // A department board IS its department filter; other chips pass through.
    department: scope.department ?? filters.department,
    assignee: filters.assignee,
    source: filters.source,
    label: filters.label,
    q: filters.q,
    since,
    until,
    offset,
    limit: BOARD_PAGE_SIZE,
  })
  return { workItems: r.workItems, total: r.total ?? r.workItems.length, nextOffset: r.nextOffset ?? null }
}

export function boardColumnQueryKey(board: BoardId, status: WorkItemStatusWire, filters: TodoFilters): readonly unknown[] {
  return [
    "work-items", "board", boardKey(board), status,
    filters.assignee ?? "", filters.department ?? "", filters.source ?? "", filters.date ?? "",
    filters.label ?? "", filters.q ?? "",
  ]
}

function useBoardColumn(board: BoardId, status: WorkItemStatusWire, filters: TodoFilters, now: number, enabled: boolean) {
  const { since, until } = dateBounds(filters.date, now)
  return useInfiniteQuery({
    queryKey: boardColumnQueryKey(board, status, filters),
    queryFn: ({ pageParam }) => fetchBoardPage(board, status, filters, since, until, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
}

export interface BoardData {
  /** One entry per status, board order; closed statuses included (the rail pages them). */
  columns: Record<WorkItemStatusWire, BoardColumnData>
  isLoading: boolean
  isError: boolean
  error: unknown
  /** Sum of the four PIPELINE totals — the header's "N open". Blocked and
   *  escalated read out separately (the mock's "11 open · 1 blocked"). */
  openTotal: number
  closedTotal: number
}

export function useBoardData(board: BoardId, filters: TodoFilters, now: number, enabled = true): BoardData {
  // Hooks are unconditional: one query per status in fixed order.
  const backlog = useBoardColumn(board, "backlog", filters, now, enabled)
  const assigned = useBoardColumn(board, "assigned", filters, now, enabled)
  const executing = useBoardColumn(board, "executing", filters, now, enabled)
  const inReview = useBoardColumn(board, "in_review", filters, now, enabled)
  const blocked = useBoardColumn(board, "blocked", filters, now, enabled)
  const escalated = useBoardColumn(board, "escalated", filters, now, enabled)
  const done = useBoardColumn(board, "done", filters, now, enabled)
  const cancelled = useBoardColumn(board, "cancelled", filters, now, enabled)
  const queries = [backlog, assigned, executing, inReview, blocked, escalated, done, cancelled]

  return useMemo((): BoardData => {
    const columns = {} as Record<WorkItemStatusWire, BoardColumnData>
    BOARD_STATUSES.forEach((status, i) => {
      const q = queries[i]
      const pages = q.data?.pages ?? []
      columns[status] = {
        status,
        items: pages.flatMap((p) => p.workItems),
        total: pages.length > 0 ? pages[pages.length - 1].total : 0,
        hasMore: q.hasNextPage ?? false,
        loadMore: () => {
          if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage()
        },
        loadingMore: q.isFetchingNextPage,
      }
    })
    const openTotal = PIPELINE_STATUSES.reduce((sum, s) => sum + columns[s].total, 0)
    const closedTotal = CLOSED_STATUSES.reduce((sum, s) => sum + columns[s].total, 0)
    const firstError = queries.find((q) => q.isError)
    return {
      columns,
      isLoading: queries.some((q) => q.isPending && !q.isPlaceholderData),
      isError: !!firstError,
      error: firstError?.error ?? null,
      openTotal,
      closedTotal,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the 8 query results are the dependencies
  }, [backlog.data, assigned.data, executing.data, inReview.data, blocked.data, escalated.data, done.data, cancelled.data,
      backlog.isFetchingNextPage, assigned.isFetchingNextPage, executing.isFetchingNextPage, inReview.isFetchingNextPage,
      blocked.isFetchingNextPage, escalated.isFetchingNextPage, done.isFetchingNextPage, cancelled.isFetchingNextPage,
      // Error/pending flips carry no data change — the states surfaces
      // (skeleton, calm error card) need them as dependencies too.
      backlog.isError, assigned.isError, executing.isError, inReview.isError,
      blocked.isError, escalated.isError, done.isError, cancelled.isError,
      backlog.isPending, assigned.isPending, executing.isPending, inReview.isPending,
      blocked.isPending, escalated.isPending, done.isPending, cancelled.isPending])
}

// ── Switcher data ───────────────────────────────────────────────────────────

/** Open counts for the switcher menu rows, fetched lazily when the menu opens
 *  (one limit-1 query per scope; `totals` carries the truth). */
export function useBoardMenuCounts(departments: DepartmentSummaryWire[] | undefined, enabled: boolean) {
  const slugs = (departments ?? []).map((d) => d.slug)
  return useQuery({
    queryKey: ["work-items", "board-menu-counts", slugs.join(",")],
    enabled: enabled && departments !== undefined,
    staleTime: 10_000,
    queryFn: async (): Promise<{ my: number; byDepartment: Record<string, number> }> => {
      const openOf = (totals: Partial<Record<WorkItemStatusWire, number>> | undefined): number =>
        OPEN_STATUSES.reduce((sum, s) => sum + (totals?.[s] ?? 0), 0)
      const [mine, ...perDept] = await Promise.all([
        api.listWorkItems({ createdBy: "operator", rootsOnly: true, limit: 1 }),
        ...slugs.map((slug) => api.listWorkItems({ department: slug, rootsOnly: true, limit: 1 })),
      ])
      const byDepartment: Record<string, number> = {}
      slugs.forEach((slug, i) => {
        byDepartment[slug] = openOf(perDept[i].totals)
      })
      return { my: openOf(mine.totals), byDepartment }
    },
  })
}

// ── Tree enrichment ─────────────────────────────────────────────────────────
// One tree fetch per visible card (the ledger's open-details precedent): the
// tree's FULL root row carries priority, its totals carry the roll-up counts,
// and its spendUsd is the derived subtree spend — three card needs, one call.
// Expansion then renders instantly from the same cache.

export function useBoardTrees(ids: string[]) {
  const key = [...ids].sort().join(",")
  return useQuery({
    queryKey: ["work-items", "board-trees", key],
    enabled: ids.length > 0,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Map<string, WorkItemTreeWire>> => {
      const settled = await Promise.allSettled(ids.map((id) => api.getWorkItemTree(id)))
      const map = new Map<string, WorkItemTreeWire>()
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") map.set(ids[i], s.value.tree)
      })
      return map
    },
  })
}

// ── Mutations (drag commits) ────────────────────────────────────────────────

/** Cross-column drop = a status transition on the operator PUT lane. The UI
 *  pre-checked legality; a runtime refusal surfaces the gateway's words. */
export function useBoardTransition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: WorkItemStatusWire; note?: string }) =>
      api.setWorkItemStatus(id, status),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item"] })
    },
  })
}

/** Within-column drop = a rank edit through the metadata pen (CAS-guarded). */
export function useBoardRank() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, rank, expectedVersion }: { id: string; rank: number; expectedVersion: number }) =>
      api.updateWorkItem(id, {
        patch: { rank },
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    },
  })
}

/** The tray's quick add — a sub-task born in backlog under its parent. */
export function useCreateSubTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ parentId, title }: { parentId: string; title: string }) =>
      api.createWorkItem({ title, parentId }),
    onSettled: (_data, _error, { parentId }) => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item-tree", parentId] })
    },
  })
}

/** Ids worth enriching with detail (spend, priority, reason, session) — the
 *  open-details pattern the ledger already pays for; bounded for calm. */
export function boardDetailIds(columns: Record<WorkItemStatusWire, BoardColumnData>, cap = 60): string[] {
  const ids: string[] = []
  for (const status of BOARD_STATUSES) {
    for (const item of columns[status]?.items ?? []) {
      ids.push(item.id)
      if (ids.length >= cap) return ids
    }
  }
  return ids
}

export const BOARD_STATUS_ORDER = BOARD_STATUSES
