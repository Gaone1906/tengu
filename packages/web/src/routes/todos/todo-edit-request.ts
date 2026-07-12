import type { QueryClient } from "@tanstack/react-query"
import type { WorkItemEditPatch, WorkItemEditRequest } from "@/lib/api"
import { isPositiveTodoVersion } from "@/lib/todos"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function visitTodoVersions(value: unknown, id: string, versions: number[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitTodoVersions(entry, id, versions)
    return
  }
  if (!isRecord(value)) return
  if (value.id === id && isPositiveTodoVersion(value.version)) versions.push(value.version)
  for (const nested of Object.values(value)) visitTodoVersions(nested, id, versions)
}

function mergeTodoValue(value: unknown, workItem: UnknownRecord & { id: string; version: number }): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const merged = mergeTodoValue(entry, workItem)
      if (merged !== entry) changed = true
      return merged
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  if (value.id === workItem.id) {
    const cachedVersion = value.version
    if (!isPositiveTodoVersion(cachedVersion) || workItem.version >= cachedVersion) {
      return { ...value, ...workItem }
    }
    return value
  }
  let changed = false
  const next: UnknownRecord = { ...value }
  for (const [key, nested] of Object.entries(value)) {
    const merged = mergeTodoValue(nested, workItem)
    if (merged !== nested) {
      next[key] = merged
      changed = true
    }
  }
  return changed ? next : value
}

/** Mint the immutable metadata envelope once per logical Todo edit. */
export function newTodoEditRequest(patch: WorkItemEditPatch, expectedVersion: number): WorkItemEditRequest {
  if (!isPositiveTodoVersion(expectedVersion)) {
    throw new TypeError("Todo expectedVersion must be a positive safe integer")
  }
  return { patch: { ...patch }, expectedVersion, idempotencyKey: crypto.randomUUID() }
}

/** Highest positive safe revision found in any list/search/detail Todo cache. */
export function maximumTodoVersion(queryClient: QueryClient, id: string): number | undefined {
  const versions: number[] = []
  for (const [, data] of queryClient.getQueriesData({ queryKey: ["work-items"] })) {
    visitTodoVersions(data, id, versions)
  }
  for (const [, data] of queryClient.getQueriesData({ queryKey: ["work-item"] })) {
    visitTodoVersions(data, id, versions)
  }
  return versions.length > 0 ? Math.max(...versions) : undefined
}

/** Merge a confirmed response without allowing an older revision to win. */
export function mergeTodoIntoCaches<T extends { id: string; version?: number }>(
  queryClient: QueryClient,
  workItem: T,
): void {
  if (!isPositiveTodoVersion(workItem.version)) return
  const versioned = workItem as UnknownRecord & { id: string; version: number }
  queryClient.setQueriesData({ queryKey: ["work-items"] }, (current) => mergeTodoValue(current, versioned))
  queryClient.setQueriesData({ queryKey: ["work-item"] }, (current) => mergeTodoValue(current, versioned))
}

/** Refetch every list/search projection plus the exact Todo detail. */
export async function invalidateTodoCaches(queryClient: QueryClient, id: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["work-items"] }),
    queryClient.invalidateQueries({ queryKey: ["work-item", id], exact: true }),
  ])
}
