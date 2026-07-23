import type { QueryClient } from "@tanstack/react-query"
import { api, TodoApiError, type WorkItemDetailWire, type WorkItemEditPatch, type WorkItemEditRequest, type WorkItemFullWire } from "@/lib/api"
import { isPositiveTodoVersion, isTodoVersionConflictError } from "@/lib/todos"

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

/* ── The conditional remote-save lane ────────────────────────────────────────
 * Carried over from the retired detail sheet at the stage-C cutover: the task
 * page's pickers/title/body PATCH through this one lane, which keeps every
 * cached Todo projection version-fenced so a slow response can never clobber
 * a newer revision. */

/** The editable projection of a full Todo (the lane's authoritative echo). */
export interface TodoEditableDraft {
  title: string
  body: string
  assignee: string | null
  department: string | null
  priority: number
}

export interface TodoRemoteSnapshot {
  draft: TodoEditableDraft
  version: number
}

function todoRemoteSnapshot(item: WorkItemFullWire): TodoRemoteSnapshot {
  if (!isPositiveTodoVersion(item.version)) {
    throw new Error("Todo response is missing an authoritative version")
  }
  return {
    draft: {
      title: item.title,
      body: item.body ?? "",
      assignee: item.assignee,
      department: item.department,
      priority: item.priority,
    },
    version: item.version,
  }
}

function mergeSavedDetail(
  current: WorkItemDetailWire | undefined,
  incoming: WorkItemFullWire,
): WorkItemDetailWire | undefined {
  if (!current) return current
  const currentVersion = current.workItem.version
  if (isPositiveTodoVersion(currentVersion)
    && (!isPositiveTodoVersion(incoming.version) || incoming.version < currentVersion)) return current
  return { ...current, workItem: { ...current.workItem, ...incoming } }
}

async function refreshTodoCachesBestEffort(queryClient: QueryClient, id: string): Promise<void> {
  try {
    await invalidateTodoCaches(queryClient, id)
  } catch {
    // A cache refresh cannot replace a confirmed response or structured error.
  }
}

/** One conditional detail edit, including both response-time cache fences.
 * Typed backend conflicts refresh caches opportunistically but always rethrow
 * the original object so code/currentVersion survive intact. */
export async function saveTodoDetailRemote(
  queryClient: QueryClient,
  id: string,
  request: WorkItemEditRequest,
) {
  let result: Awaited<ReturnType<typeof api.updateWorkItem>>
  try {
    result = await api.updateWorkItem(id, request)
  } catch (cause) {
    if (isTodoVersionConflictError(cause)) {
      await refreshTodoCachesBestEffort(queryClient, id)
    }
    throw cause
  }

  let maximumBeforeMerge = maximumTodoVersion(queryClient, id)
  if (maximumBeforeMerge !== undefined && maximumBeforeMerge > result.workItem.version) {
    await refreshTodoCachesBestEffort(queryClient, id)
    maximumBeforeMerge = maximumTodoVersion(queryClient, id)
    if (maximumBeforeMerge !== undefined && maximumBeforeMerge > result.workItem.version) {
      throw new TodoApiError(
        409,
        "A newer cached Todo revision superseded this response",
        "TODO_VERSION_CONFLICT",
        maximumBeforeMerge,
      )
    }
  }

  mergeTodoIntoCaches(queryClient, result.workItem)
  queryClient.setQueryData<WorkItemDetailWire>(["work-item", id], (current) => mergeSavedDetail(current, result.workItem))
  await refreshTodoCachesBestEffort(queryClient, id)

  const maximumAfterRefresh = maximumTodoVersion(queryClient, id)
  const exact = queryClient.getQueryData<WorkItemDetailWire>(["work-item", id])
  const exactVersion = exact?.workItem.version
  const authoritativeVersion = Math.max(
    result.workItem.version,
    isPositiveTodoVersion(exactVersion) ? exactVersion : 0,
    maximumAfterRefresh ?? 0,
  )
  if (authoritativeVersion > result.workItem.version) {
    throw new TodoApiError(
      409,
      "A newer refreshed Todo revision superseded this response",
      "TODO_VERSION_CONFLICT",
      authoritativeVersion,
    )
  }

  const remoteItem = exact && exact.workItem.version === result.workItem.version
    ? exact.workItem
    : result.workItem
  return {
    remote: todoRemoteSnapshot(remoteItem),
    replayed: result.replayed,
  }
}
