import { useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"

/* GRS-021d/027 — the Todos data layer. The active board still uses compact
 * status lists; the COO attention inbox is now a single server-derived compact
 * feed (`needsAttentionFor=me`) so React does not reconstruct authority routing
 * with status fanout + detail fetches. */

const BOARD_STATUSES: readonly WorkItemStatusWire[] = [
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
  "done",
]

const OPEN_STATUSES: ReadonlySet<WorkItemStatusWire> = new Set<WorkItemStatusWire>([
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
])

export function useBoardItems() {
  return useQuery({
    queryKey: ["work-items", "board"],
    queryFn: async (): Promise<WorkItemCompactWire[]> => {
      const results = await Promise.all(BOARD_STATUSES.map((status) => api.listWorkItems({ status, limit: 20 })))
      // An item has exactly one status, so per-status calls never overlap; the map
      // is just an id-keyed merge (defensive against any future overlap).
      const map = new Map<string, WorkItemCompactWire>()
      for (const r of results) for (const it of r.workItems) map.set(it.id, it)
      return [...map.values()]
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
