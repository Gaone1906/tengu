import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { api, type WorkItemStatusWire } from "@/lib/api"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { isPositiveTodoVersion } from "@/lib/todos"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function setTodoStatus(value: unknown, id: string, status: WorkItemStatusWire): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const patched = setTodoStatus(entry, id, status)
      if (patched !== entry) changed = true
      return patched
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  if (value.id === id) return value.status === status ? value : { ...value, status }
  let changed = false
  const next: UnknownRecord = { ...value }
  for (const [key, nested] of Object.entries(value)) {
    const patched = setTodoStatus(nested, id, status)
    if (patched !== nested) {
      next[key] = patched
      changed = true
    }
  }
  return changed ? next : value
}

interface CachedTodoStatus {
  status: WorkItemStatusWire
  version?: number
}

function findTodoStatus(value: unknown, id: string): CachedTodoStatus | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTodoStatus(entry, id)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.id === id && typeof value.status === "string") {
    return {
      status: value.status as WorkItemStatusWire,
      version: isPositiveTodoVersion(value.version) ? value.version : undefined,
    }
  }
  for (const nested of Object.values(value)) {
    const found = findTodoStatus(nested, id)
    if (found) return found
  }
  return undefined
}

function rollbackTodoStatus(
  value: unknown,
  id: string,
  optimisticStatus: WorkItemStatusWire,
  previous: CachedTodoStatus,
): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const rolledBack = rollbackTodoStatus(entry, id, optimisticStatus, previous)
      if (rolledBack !== entry) changed = true
      return rolledBack
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  if (value.id === id) {
    if (value.status !== optimisticStatus) return value
    if (previous.version && isPositiveTodoVersion(value.version) && value.version > previous.version) return value
    return { ...value, status: previous.status }
  }
  let changed = false
  const next: UnknownRecord = { ...value }
  for (const [key, nested] of Object.entries(value)) {
    const rolledBack = rollbackTodoStatus(nested, id, optimisticStatus, previous)
    if (rolledBack !== nested) {
      next[key] = rolledBack
      changed = true
    }
  }
  return changed ? next : value
}

interface TodoCacheSnapshot {
  entries: Array<{ queryKey: QueryKey; previous: CachedTodoStatus }>
}

export interface TodoStatusMutationArgs {
  id: string
  status: WorkItemStatusWire
  note?: string
}

type TodoStatusMutationFn = (variables: TodoStatusMutationArgs) => ReturnType<typeof api.setWorkItemStatus>

function snapshotTodoCaches(queryClient: QueryClient, id: string): TodoCacheSnapshot {
  const queries = [
    ...queryClient.getQueriesData({ queryKey: ["work-items"] }),
    ...queryClient.getQueriesData({ queryKey: ["work-item"] }),
  ]
  const entries: TodoCacheSnapshot["entries"] = []
  for (const [queryKey, data] of queries) {
    const previous = findTodoStatus(data, id)
    if (previous) entries.push({ queryKey, previous })
  }
  return { entries }
}

function patchTodoStatusIntoCaches(
  queryClient: QueryClient,
  id: string,
  status: WorkItemStatusWire,
): void {
  queryClient.setQueriesData({ queryKey: ["work-items"] }, (current) => setTodoStatus(current, id, status))
  queryClient.setQueriesData({ queryKey: ["work-item"] }, (current) => setTodoStatus(current, id, status))
}

function restoreTodoCaches(
  queryClient: QueryClient,
  snapshot: TodoCacheSnapshot,
  id: string,
  optimisticStatus: WorkItemStatusWire,
): void {
  for (const { queryKey, previous } of snapshot.entries) {
    queryClient.setQueryData(queryKey, (current: unknown) =>
      rollbackTodoStatus(current, id, optimisticStatus, previous))
  }
}

/** Shared status-write lane for the task surfaces and board drag. */
export function todoStatusMutationOptions(queryClient: QueryClient, mutationFn: TodoStatusMutationFn) {
  return {
    mutationKey: TODO_WRITE_KEY,
    mutationFn,
    onMutate: async ({ id, status }: TodoStatusMutationArgs) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["work-items"] }),
        queryClient.cancelQueries({ queryKey: ["work-item"] }),
      ])
      const snapshot = snapshotTodoCaches(queryClient, id)
      patchTodoStatusIntoCaches(queryClient, id, status)
      return snapshot
    },
    onError: (_error: unknown, variables: TodoStatusMutationArgs, snapshot: TodoCacheSnapshot | undefined) => {
      if (snapshot) restoreTodoCaches(queryClient, snapshot, variables.id, variables.status)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["work-items"] })
      void queryClient.invalidateQueries({ queryKey: ["work-item"] })
    },
  }
}
