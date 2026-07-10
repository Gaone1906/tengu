import { useCallback, useMemo } from "react"
import { useQuery, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import { dateBounds, statusesFor, type TodoFilters } from "@/lib/todos"
import { queryKeys } from "@/lib/query-keys"

/* GRS-021d/027 + design-todos §7 — the Todos data layer. The ledger keeps one
 * INFINITE query per status: every request is one fixed-size page
 * (limit=20 + offset), "Show N more" appends the NEXT server page
 * (fetchNextPage → offset=20, 40, …) instead of refetching what's already on
 * screen, and the gateway's `total` per status stays the truth for headers.
 * The COO attention inbox stays a single server-derived feed
 * (`needsAttentionFor=me`). */

const OPEN_STATUSES: ReadonlySet<WorkItemStatusWire> = new Set<WorkItemStatusWire>([
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
])

/** Fixed server page size — every ledger request asks for exactly one page. */
export const LEDGER_PAGE_SIZE = 20
const GATEWAY_MAX_LIMIT = 100
const DAY_MS = 24 * 60 * 60 * 1000

/** Hooks must be called unconditionally, so the ledger mounts one infinite
 *  query per status in this fixed order and enables the ones the filter needs. */
const LEDGER_STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done", "cancelled",
]

export interface LedgerData {
  items: WorkItemCompactWire[]
  /** TRUE per-status totals for the current filter, straight from the gateway. */
  totalsByStatus: Partial<Record<WorkItemStatusWire, number>>
}

export interface LedgerPage {
  workItems: WorkItemCompactWire[]
  total: number
  nextOffset: number | null
}

/** Fetch exactly ONE fixed-size page of one status at `offset`. Exported for
 *  unit tests — incremental paging (never a refetch-all) is the contract. */
export async function fetchStatusPage(
  status: WorkItemStatusWire,
  filters: TodoFilters,
  since: string | undefined,
  until: string | undefined,
  offset: number,
): Promise<LedgerPage> {
  const shared = {
    assignee: filters.assignee,
    department: filters.department,
    source: filters.source,
    since,
    until,
    offset,
    limit: LEDGER_PAGE_SIZE,
  }
  const r = filters.q
    ? await api.searchWorkItems({ text: filters.q, status, ...shared })
    : await api.listWorkItems({ status, ...shared })
  return { workItems: r.workItems, total: r.total ?? r.workItems.length, nextOffset: r.nextOffset ?? null }
}

/** One status's paged rows. The key carries the filter identity plus the Done
 *  window marker (open lens scopes Done to the recent week); the concrete
 *  since/until instants live in the closure so the key doesn't churn with
 *  `now`. */
function useStatusPages(
  status: WorkItemStatusWire,
  filters: TodoFilters,
  since: string | undefined,
  until: string | undefined,
  windowMark: string,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: [
      "work-items", "ledger", status,
      filters.assignee ?? "", filters.department ?? "", filters.source ?? "", filters.date ?? "", filters.q ?? "",
      windowMark,
    ],
    queryFn: ({ pageParam }) => fetchStatusPage(status, filters, since, until, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
    // Keep the previous filter's rows on screen while a new filter's first
    // page lands (no skeleton flash); appends never blank existing pages.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
}

/** The ledger: filters map 1:1 to server query params (§4.3); `q` rides the
 *  search endpoint (title+body — the server owns text matching, the client
 *  never re-filters) and carries the same since/until window + page offsets as
 *  the list endpoint. In the open lens the Done group is scoped to the recent
 *  7-day window server-side, so its rows AND total mean "done this week". */
export function useLedgerItems(filters: TodoFilters, now: number) {
  const active = new Set(statusesFor(filters))
  const { since, until } = dateBounds(filters.date, now)
  const doneWindowStart = new Date(now - 7 * DAY_MS).toISOString()
  // Open lens: Done means the recent window (the later of the week window and
  // any explicit date filter). History lenses fetch the full past.
  const doneScoped = filters.status === "open"
  const doneSince = doneScoped ? (since && since > doneWindowStart ? since : doneWindowStart) : since
  const sinceFor = (s: WorkItemStatusWire) => (s === "done" ? doneSince : since)
  const markFor = (s: WorkItemStatusWire) => (s === "done" && doneScoped ? "recent" : "all")

  // One hook per status, fixed order (see LEDGER_STATUSES).
  const backlog = useStatusPages("backlog", filters, sinceFor("backlog"), until, markFor("backlog"), active.has("backlog"))
  const assigned = useStatusPages("assigned", filters, sinceFor("assigned"), until, markFor("assigned"), active.has("assigned"))
  const executing = useStatusPages("executing", filters, sinceFor("executing"), until, markFor("executing"), active.has("executing"))
  const blocked = useStatusPages("blocked", filters, sinceFor("blocked"), until, markFor("blocked"), active.has("blocked"))
  const inReview = useStatusPages("in_review", filters, sinceFor("in_review"), until, markFor("in_review"), active.has("in_review"))
  const escalated = useStatusPages("escalated", filters, sinceFor("escalated"), until, markFor("escalated"), active.has("escalated"))
  const done = useStatusPages("done", filters, sinceFor("done"), until, markFor("done"), active.has("done"))
  const cancelled = useStatusPages("cancelled", filters, sinceFor("cancelled"), until, markFor("cancelled"), active.has("cancelled"))
  const queries = [backlog, assigned, executing, blocked, inReview, escalated, done, cancelled]
  const pairs = LEDGER_STATUSES.map((status, i) => ({ status, query: queries[i] }))
  const activePairs = pairs.filter((p) => active.has(p.status))

  const isLoading = activePairs.some((p) => p.query.isPending && !p.query.isPlaceholderData)
  const firstError = activePairs.find((p) => p.query.isError)
  const loadingMore = activePairs.some((p) => p.query.isFetchingNextPage || p.query.isPlaceholderData)

  const data = useMemo((): LedgerData | undefined => {
    if (activePairs.some((p) => p.query.data == null)) return undefined
    // An item has exactly one status, so per-status queries never overlap; the
    // map is just an id-keyed merge (defensive against any future overlap).
    const map = new Map<string, WorkItemCompactWire>()
    const totalsByStatus: Partial<Record<WorkItemStatusWire, number>> = {}
    for (const p of activePairs) {
      const pages = p.query.data!.pages
      for (const page of pages) for (const it of page.workItems) map.set(it.id, it)
      totalsByStatus[p.status] = pages[pages.length - 1]?.total ?? 0
    }
    return { items: [...map.values()], totalsByStatus }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pairs derive from the 8 stable queries below
  }, [backlog.data, assigned.data, executing.data, blocked.data, inReview.data, escalated.data, done.data, cancelled.data, filters])

  /** "Show N more": append the NEXT server page for these statuses. */
  const loadMore = useCallback(
    (statuses: readonly WorkItemStatusWire[]) => {
      for (const p of pairs) {
        if (statuses.includes(p.status) && p.query.hasNextPage && !p.query.isFetchingNextPage) {
          void p.query.fetchNextPage()
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchNextPage/hasNextPage are stable per query
    [backlog, assigned, executing, blocked, inReview, escalated, done, cancelled],
  )

  return {
    data,
    isLoading,
    isError: !!firstError,
    error: firstError?.query.error ?? null,
    loadingMore,
    loadMore,
  }
}

/** The People lens needs the FULL open set (per-person counts must come from
 *  everything the server holds, never a capped first page): walk every open
 *  status to exhaustion, with a safety cap. */
const PEOPLE_ROW_CAP = 1000
export function usePeopleItems(enabled = true) {
  return useQuery({
    queryKey: ["work-items", "people-open"],
    queryFn: async (): Promise<WorkItemCompactWire[]> => {
      const pages = await Promise.all(
        [...OPEN_STATUSES].map(async (status) => {
          const rows: WorkItemCompactWire[] = []
          let offset = 0
          for (;;) {
            const r = await api.listWorkItems({ status, offset, limit: GATEWAY_MAX_LIMIT })
            rows.push(...r.workItems)
            if (r.nextOffset == null || rows.length >= PEOPLE_ROW_CAP) break
            offset = r.nextOffset
          }
          return rows
        }),
      )
      return pages.flat()
    },
    enabled,
    staleTime: 10_000,
  })
}

/** Optional active-board detail enrichment (cost/run context + instant sheet seed). */
export function useOpenDetails(openIds: string[], enabled = true) {
  const key = [...openIds].sort().join(",")
  return useQuery({
    queryKey: ["work-items", "open-details", key],
    queryFn: async (): Promise<WorkItemDetailWire[]> => {
      const settled = await Promise.allSettled(openIds.map((id) => api.getWorkItem(id)))
      const out: WorkItemDetailWire[] = []
      for (const s of settled) if (s.status === "fulfilled") out.push(s.value)
      return out
    },
    enabled: enabled && openIds.length > 0,
    staleTime: 10_000,
  })
}

export function openIdsOf(items: WorkItemCompactWire[]): string[] {
  return items.filter((i) => OPEN_STATUSES.has(i.status)).map((i) => i.id)
}

export function useNeedsAttentionItems() {
  return useQuery({
    queryKey: ["work-items", "needs-attention", "me"],
    queryFn: async (): Promise<WorkItemCompactWire[]> => {
      // The attention inbox must not silently cap either — walk the pages.
      const items: WorkItemCompactWire[] = []
      let offset = 0
      for (;;) {
        const r = await api.listWorkItems({ needsAttentionFor: "me", offset, limit: 100 })
        items.push(...r.workItems)
        if (r.nextOffset == null || items.length >= 500) break
        offset = r.nextOffset
      }
      return items
    },
    staleTime: 10_000,
  })
}

export function useOrg() {
  return useQuery({ queryKey: queryKeys.org.all, queryFn: () => api.getOrg(), staleTime: 60_000 })
}

export function useEmployeesByName(employees: Employee[] | undefined): Map<string, Employee> {
  return useMemo(() => new Map((employees ?? []).map((e) => [e.name, e])), [employees])
}

export interface DecideArgs {
  id: string
  decision: "approve" | "reject"
  note?: string
}

/** The operator's approval decision. On settle, invalidate the ledger so the
 *  board + Needs-you set + counts refetch (the view also hides the card
 *  optimistically while this is in flight). */
export function useDecideApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision, note }: DecideArgs) => api.decideWorkItemApproval(id, decision, note),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    },
  })
}

export function useEscalateApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.escalateWorkItemApproval(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    },
  })
}

/** The operator's pen (design-todos §7.4): title/body/assignee/department/
 *  priority/rank edits. 404s on gateways that predate the endpoint — callers
 *  surface the failure quietly; invalidation restores server truth either way. */
export function useUpdateWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateWorkItem>[1] }) =>
      api.updateWorkItem(id, patch),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item"] })
    },
  })
}

/** Guarded status transition — the sheet only offers legal edges; the gateway
 *  stays the authority and refuses anything else readably. */
export function useSetWorkItemStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: WorkItemStatusWire; note?: string }) =>
      api.setWorkItemStatus(id, status, note),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item"] })
    },
  })
}
