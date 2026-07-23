import { useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  api,
  type Employee,
  type WorkItemCompactWire,
  type WorkItemDetailWire,
  type WorkItemLabelWire,
  type WorkItemStatusWire,
} from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"

/* GRS-021d/027 + design-todos §7 → slice 6 — the shared Todos data layer.
 * The board owns its own per-column infinite queries (board/use-board.ts);
 * this module keeps the cross-surface hooks: canonical-by-id detail, the
 * server-derived attention feed (`needsAttentionFor=me`), org/roster lookups,
 * the label registry, approvals, and the guarded status transition. The
 * legacy ledger machinery retired with the list page at the stage-C cutover. */

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

/** Resolve a public Todo identifier directly. JIN-N is the database/API/browser
 * identity, so deep links never reverse-scan list pages or derive a second key. */
export function useTodoById(todoId: string | null) {
  return useQuery<WorkItemDetailWire | null>({
    queryKey: ["work-item", todoId ?? ""],
    enabled: Boolean(todoId),
    staleTime: 10_000,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkItemDetailWire | null> => {
      if (!todoId) return null
      try {
        return await api.getWorkItem(todoId, signal)
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 404) return null
        throw error
      }
    },
  })
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

/** The shared label registry (slice 3) — same cache key the pickers use. */
export function useLabelRegistry(enabled = true) {
  return useQuery({
    queryKey: ["labels"],
    queryFn: async (): Promise<WorkItemLabelWire[]> => (await api.listLabels()).labels,
    enabled,
    staleTime: 60_000,
  })
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
