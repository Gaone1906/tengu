import { useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import { dateBounds, statusesFor, type TodoFilters } from "@/lib/todos"
import { queryKeys } from "@/lib/query-keys"

/* GRS-021d/027 + design-todos §7 — the Todos data layer. The ledger fans out
 * one compact query per status (the gateway takes a single status per call and
 * caps limit at 20), merges, and carries per-status TRUE totals when the
 * gateway reports them. The COO attention inbox stays a single server-derived
 * compact feed (`needsAttentionFor=me`). */

const OPEN_STATUSES: ReadonlySet<WorkItemStatusWire> = new Set<WorkItemStatusWire>([
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
])

export interface LedgerData {
  items: WorkItemCompactWire[]
  /** True per-status totals when the gateway paginates (§7.1); fetched counts
   *  otherwise — callers may only claim "more exists" when these disagree. */
  totalsByStatus: Partial<Record<WorkItemStatusWire, number>>
  /** Statuses where the gateway reported a real total (Show-more is honest). */
  paginated: boolean
}

/** The ledger fetch: filters map 1:1 to server query params (§4.3). `q` rides
 *  the dedicated search endpoint; `since` is passed for gateways that honour
 *  it (older ones ignore it — the view applies the defensive client pass). */
export function useLedgerItems(filters: TodoFilters, now: number) {
  const statuses = statusesFor(filters)
  const { since } = dateBounds(filters.date, now)
  const shared = {
    assignee: filters.assignee,
    department: filters.department,
    source: filters.source,
  }
  const key = ["work-items", "ledger", filters.status, filters.assignee ?? "", filters.department ?? "", filters.source ?? "", filters.date ?? "", filters.q ?? ""]
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<LedgerData> => {
      const results = await Promise.all(
        statuses.map(async (status) => {
          const r = filters.q
            ? await api.searchWorkItems({ text: filters.q, status, ...shared, limit: 20 })
            : await api.listWorkItems({ status, ...shared, since, limit: 20 })
          return { status, ...r }
        }),
      )
      // An item has exactly one status, so per-status calls never overlap; the
      // map is just an id-keyed merge (defensive against any future overlap).
      const map = new Map<string, WorkItemCompactWire>()
      const totalsByStatus: Partial<Record<WorkItemStatusWire, number>> = {}
      let paginated = false
      for (const r of results) {
        for (const it of r.workItems) map.set(it.id, it)
        totalsByStatus[r.status] = r.total ?? r.workItems.length
        if (r.total != null) paginated = true
      }
      return { items: [...map.values()], totalsByStatus, paginated }
    },
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
      const result = await api.listWorkItems({ needsAttentionFor: "me", limit: 20 })
      return result.workItems
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
