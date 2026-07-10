import { useMemo } from "react"
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import { dateBounds, statusesFor, type TodoFilters } from "@/lib/todos"
import { queryKeys } from "@/lib/query-keys"

/* GRS-021d/027 + design-todos §7 — the Todos data layer. The ledger fans out
 * one paginated query per status (the gateway pages with limit ≤100 + offset
 * and reports `total` / `nextOffset` per query), merges, and carries the TRUE
 * per-status totals. "Show N more" raises a group's `want` and the fetcher
 * walks `nextOffset` until it has that many rows — the 20-cap is gone. The COO
 * attention inbox stays a single server-derived feed (`needsAttentionFor=me`). */

const OPEN_STATUSES: ReadonlySet<WorkItemStatusWire> = new Set<WorkItemStatusWire>([
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
])

/** One page of ledger rows per Show-more step (mirrors the gateway default). */
export const LEDGER_PAGE_SIZE = 20
const GATEWAY_MAX_LIMIT = 100
const DAY_MS = 24 * 60 * 60 * 1000

/** How many rows the view wants per status; absent = one page. */
export type LedgerWants = Partial<Record<WorkItemStatusWire, number>>

export interface LedgerData {
  items: WorkItemCompactWire[]
  /** TRUE per-status totals for the current filter, straight from the gateway. */
  totalsByStatus: Partial<Record<WorkItemStatusWire, number>>
}

interface StatusPage {
  status: WorkItemStatusWire
  rows: WorkItemCompactWire[]
  total: number
}

/** Fetch up to `want` rows of one status, walking `nextOffset` pages.
 *  Exported for unit tests — the pagination walk is the 20-cap fix. */
export async function fetchStatusRows(
  status: WorkItemStatusWire,
  filters: TodoFilters,
  since: string | undefined,
  want: number,
): Promise<StatusPage> {
  const shared = {
    assignee: filters.assignee,
    department: filters.department,
    source: filters.source,
    since,
  }
  const rows: WorkItemCompactWire[] = []
  let offset = 0
  let total = 0
  for (;;) {
    const limit = Math.min(GATEWAY_MAX_LIMIT, want - rows.length)
    const r = filters.q
      ? await api.searchWorkItems({ text: filters.q, status, ...shared, offset, limit })
      : await api.listWorkItems({ status, ...shared, offset, limit })
    rows.push(...r.workItems)
    total = r.total ?? rows.length
    if (r.nextOffset == null || rows.length >= want) break
    offset = r.nextOffset
  }
  return { status, rows, total }
}

/** The ledger fetch: filters map 1:1 to server query params (§4.3); `q` rides
 *  the search endpoint (title+body — the server owns text matching, the client
 *  never re-filters). In the open lens the Done group is scoped to the recent
 *  7-day window server-side, so its rows AND its total mean "done this week". */
export function useLedgerItems(filters: TodoFilters, now: number, wants: LedgerWants = {}) {
  const statuses = statusesFor(filters)
  const { since } = dateBounds(filters.date, now)
  const wantsKey = statuses.map((s) => `${s}:${wants[s] ?? LEDGER_PAGE_SIZE}`).join(",")
  const key = [
    "work-items", "ledger",
    filters.status, filters.assignee ?? "", filters.department ?? "", filters.source ?? "", filters.date ?? "", filters.q ?? "",
    wantsKey,
  ]
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<LedgerData> => {
      const doneWindowStart = new Date(now - 7 * DAY_MS).toISOString()
      const results = await Promise.all(
        statuses.map((status) => {
          // Open lens: Done means the recent window (the later of the week
          // window and any explicit date filter). History lenses fetch it all.
          const effectiveSince =
            filters.status === "open" && status === "done"
              ? since && since > doneWindowStart ? since : doneWindowStart
              : since
          return fetchStatusRows(status, filters, effectiveSince, wants[status] ?? LEDGER_PAGE_SIZE)
        }),
      )
      // An item has exactly one status, so per-status calls never overlap; the
      // map is just an id-keyed merge (defensive against any future overlap).
      const map = new Map<string, WorkItemCompactWire>()
      const totalsByStatus: Partial<Record<WorkItemStatusWire, number>> = {}
      for (const r of results) {
        for (const it of r.rows) map.set(it.id, it)
        totalsByStatus[r.status] = r.total
      }
      return { items: [...map.values()], totalsByStatus }
    },
    // Show-more changes the key; keep the current rows on screen while the
    // wider fetch lands (no flicker, no scroll jump).
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
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
