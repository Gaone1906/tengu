import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  api,
  TodoApiError,
  isPositiveTodoVersion,
  type WorkItemDetailWire,
  type WorkItemEditPatch,
  type WorkItemEditRequest,
  type WorkItemFullWire,
} from "@/lib/api"
import {
  isTodoIdempotencyConflictError,
  isTodoVersionConflictError,
  operatorSafeTodoError,
} from "@/lib/todos"
import {
  invalidateTodoCaches,
  maximumTodoVersion,
  mergeTodoIntoCaches,
  newTodoEditRequest,
} from "./todo-edit-request"
import { todoPrivateRef } from "./todo-private-state"

export type TodoQuickEditField = keyof WorkItemEditPatch

interface StoredQuickEdit {
  expiresAt: number
  baseline: WorkItemEditPatch
  request: WorkItemEditRequest
  state: "prepared" | "dispatched" | "uncertain" | "conflict"
  failureCode?: "idempotency"
}

type StoredQuickEdits = Record<string, StoredQuickEdit>

interface RuntimeEdit {
  id: string
  desired: WorkItemEditPatch
  baseline: WorkItemEditPatch
  request?: WorkItemEditRequest
  running: boolean
  waiters: Array<() => void>
}

export interface TodoQuickEditRecovery {
  fields: TodoQuickEditField[]
  sameFieldConflict: boolean
  busy: boolean
  error: string | null
  reloadOnly: boolean
}

const STORAGE_KEY = "jinn:todo-quick-edit:v1"
const TTL_MS = 24 * 60 * 60 * 1_000
const MAX_STORED = 50
const QUICK_FIELDS = new Set<TodoQuickEditField>(["title", "body", "assignee", "department", "priority", "rank"])
const QUICK_STATES = new Set<StoredQuickEdit["state"]>(["prepared", "dispatched", "uncertain", "conflict"])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validQuickPatch(value: unknown): value is WorkItemEditPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).length > 0 && Object.entries(value).every(([key, field]) => {
    if (!QUICK_FIELDS.has(key as TodoQuickEditField)) return false
    if (key === "title" || key === "body") return typeof field === "string"
    if (key === "assignee" || key === "department") return field === null || typeof field === "string"
    return typeof field === "number" && Number.isFinite(field)
  })
}

function validStoredQuickEdit(value: unknown): value is StoredQuickEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<StoredQuickEdit>
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)
    || !candidate.request || !validQuickPatch(candidate.request.patch)
    || !validQuickPatch(candidate.baseline)
    || !isPositiveTodoVersion(candidate.request.expectedVersion)
    || typeof candidate.request.idempotencyKey !== "string"
    || !UUID_PATTERN.test(candidate.request.idempotencyKey)
    || !candidate.state || !QUICK_STATES.has(candidate.state)
    || (candidate.failureCode !== undefined && candidate.failureCode !== "idempotency")) return false
  const patch = patchFields(candidate.request.patch)
  return patch.length === patchFields(candidate.baseline).length
    && patch.every((field) => Object.prototype.hasOwnProperty.call(candidate.baseline, field))
}

function readStored(): StoredQuickEdits {
  if (typeof sessionStorage === "undefined") return {}
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as StoredQuickEdits
    const now = Date.now()
    const entries = Object.entries(parsed)
      .filter(([ref, value]) => /^td_[a-z0-9]+$/i.test(ref)
        && validStoredQuickEdit(value) && value.expiresAt > now)
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt || a[0].localeCompare(b[0]))
      .slice(0, MAX_STORED)
    const clean = Object.fromEntries(entries)
    if (JSON.stringify(clean) !== JSON.stringify(parsed)) writeStored(clean)
    return clean
  } catch {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* unavailable */ }
    return {}
  }
}

function writeStored(value: StoredQuickEdits): void {
  if (typeof sessionStorage === "undefined") return
  try {
    if (Object.keys(value).length === 0) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch { /* recovery remains live in memory */ }
}

function loadStored(id: string): StoredQuickEdit | null {
  return readStored()[todoPrivateRef(id)] ?? null
}

export function hasTodoQuickEditRecovery(id: string): boolean {
  return loadStored(id) !== null
}

export function clearTodoQuickEditRecoveryByRef(ref: string): void {
  if (!/^td_[a-z0-9]+$/i.test(ref)) return
  const all = readStored()
  delete all[ref]
  writeStored(all)
}

function storeRequest(id: string, value: Omit<StoredQuickEdit, "expiresAt">): void {
  const all = readStored()
  all[todoPrivateRef(id)] = { ...value, expiresAt: Date.now() + TTL_MS }
  const capped = Object.fromEntries(Object.entries(all)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt || a[0].localeCompare(b[0]))
    .slice(0, MAX_STORED))
  writeStored(capped)
}

function clearStored(id: string): void {
  const all = readStored()
  delete all[todoPrivateRef(id)]
  writeStored(all)
}

function patchFields(patch: WorkItemEditPatch): TodoQuickEditField[] {
  return Object.keys(patch) as TodoQuickEditField[]
}

function fieldValue(item: WorkItemFullWire, field: TodoQuickEditField): unknown {
  return item[field]
}

function baselineFor(item: WorkItemFullWire, patch: WorkItemEditPatch): WorkItemEditPatch {
  return Object.fromEntries(patchFields(patch).map((field) => [field, fieldValue(item, field)])) as WorkItemEditPatch
}

function conflictFields(item: WorkItemFullWire, baseline: WorkItemEditPatch): TodoQuickEditField[] {
  return patchFields(baseline).filter((field) => !Object.is(fieldValue(item, field), baseline[field]))
}

function mergeSavedDetail(current: WorkItemDetailWire | undefined, item: WorkItemFullWire): WorkItemDetailWire | undefined {
  if (!current) return current
  const version = current.workItem.version
  if (isPositiveTodoVersion(version) && (!isPositiveTodoVersion(item.version) || item.version < version)) return current
  return { ...current, workItem: { ...current.workItem, ...item } }
}

async function refreshBestEffort(client: QueryClient, id: string): Promise<void> {
  try { await invalidateTodoCaches(client, id) } catch { /* transport outcome stays authoritative */ }
}

async function loadAuthoritativeDetail(client: QueryClient, id: string): Promise<WorkItemDetailWire> {
  let remote = await api.getWorkItem(id)
  if (remote.workItem.id !== id) throw new TodoApiError(409, "Todo detail identity changed", "TODO_VERSION_CONFLICT")
  let maximum = maximumTodoVersion(client, id)
  if (!isPositiveTodoVersion(remote.workItem.version) || (maximum !== undefined && maximum > remote.workItem.version)) {
    remote = await api.getWorkItem(id)
    if (remote.workItem.id !== id) throw new TodoApiError(409, "Todo detail identity changed", "TODO_VERSION_CONFLICT")
    maximum = maximumTodoVersion(client, id)
  }
  const version = remote.workItem.version
  if (!isPositiveTodoVersion(version) || (maximum !== undefined && maximum > version)) {
    throw new TodoApiError(409, "A newer Todo revision requires a fresh detail", "TODO_VERSION_CONFLICT", maximum)
  }
  client.setQueryData<WorkItemDetailWire>(["work-item", id], (current) => {
    if (!current || !isPositiveTodoVersion(current.workItem.version) || version >= current.workItem.version) return remote
    return current
  })
  return remote
}

function isAmbiguousTransport(error: unknown): boolean {
  return !(error instanceof TodoApiError) && (error instanceof TypeError || error instanceof DOMException)
}

/** Serialized conditional editor for compact Todo surfaces. The only durable
 * identity is the existing per-tab private surrogate; stored values are the
 * operator-authored patch plus immutable transport metadata, never raw ids. */
export function useTodoQuickEdit() {
  const client = useQueryClient()
  const entries = useRef(new Map<string, RuntimeEdit>())
  const recoveries = useRef(new Map<string, TodoQuickEditRecovery>())
  const mounted = useRef(true)
  const [recoveryEntry, setRecoveryEntry] = useState<{ id: string; value: TodoQuickEditRecovery } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rankResetRevision, setRankResetRevision] = useState(0)
  const [rankResetId, setRankResetId] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resetRank = useCallback((id: string) => {
    if (!mounted.current) return
    setRankResetId(id)
    setRankResetRevision((value) => value + 1)
  }, [])

  const publishRecovery = useCallback((id: string, value: TodoQuickEditRecovery) => {
    recoveries.current.set(id, value)
    setRecoveryEntry((current) => !current || current.id === id ? { id, value } : current)
  }, [])

  const removeRecovery = useCallback((id: string) => {
    recoveries.current.delete(id)
    setRecoveryEntry((current) => {
      if (current?.id !== id) return current
      const next = recoveries.current.entries().next().value as [string, TodoQuickEditRecovery] | undefined
      return next ? { id: next[0], value: next[1] } : null
    })
  }, [])

  const settle = useCallback((entry: RuntimeEdit) => {
    entry.running = false
    const waiters = entry.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }, [])

  const enterConflict = useCallback(async (entry: RuntimeEdit, cause: unknown) => {
    const reloadOnly = isTodoIdempotencyConflictError(cause)
    let same: TodoQuickEditField[] = patchFields(entry.desired)
    try {
      const fresh = await loadAuthoritativeDetail(client, entry.id)
      same = conflictFields(fresh.workItem, entry.baseline)
    } catch {
      // Without a full fresh row, automatic rebase is intentionally blocked.
    }
    if (entry.request) storeRequest(entry.id, {
      baseline: entry.baseline,
      request: entry.request,
      state: "conflict",
      failureCode: reloadOnly ? "idempotency" : undefined,
    })
    if (mounted.current) {
      publishRecovery(entry.id, {
        fields: patchFields(entry.desired),
        sameFieldConflict: reloadOnly || same.length > 0,
        busy: false,
        error: operatorSafeTodoError(cause, "Couldn't save this Todo. Reload it before trying again."),
        reloadOnly,
      })
      if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
    }
  }, [client, publishRecovery, resetRank])

  const run = useCallback(async (entry: RuntimeEdit, exactReplay = false): Promise<void> => {
    if (entry.running) return
    entry.running = true
    if (mounted.current) setError(null)
    try {
      for (;;) {
        let request = entry.request
        if (!request || !exactReplay) {
          const remote = await loadAuthoritativeDetail(client, entry.id)
          const expectedVersion = remote.workItem.version
          if (!isPositiveTodoVersion(expectedVersion)) throw new TodoApiError(428, "Missing version", "TODO_PRECONDITION_REQUIRED")
          entry.baseline = baselineFor(remote.workItem, entry.desired)
          request = newTodoEditRequest(entry.desired, expectedVersion)
          entry.request = request
          storeRequest(entry.id, { baseline: entry.baseline, request, state: "prepared" })
        }
        storeRequest(entry.id, { baseline: entry.baseline, request, state: "dispatched" })
        let result: Awaited<ReturnType<typeof api.updateWorkItem>>
        try {
          result = await api.updateWorkItem(entry.id, request)
        } catch (cause) {
          if (isTodoVersionConflictError(cause) || isTodoIdempotencyConflictError(cause)) {
            await refreshBestEffort(client, entry.id)
            await enterConflict(entry, cause)
          } else if (isAmbiguousTransport(cause)) {
            storeRequest(entry.id, { baseline: entry.baseline, request, state: "uncertain" })
            if (mounted.current) setError("The connection ended before this edit was confirmed. It will be replayed exactly.")
          } else {
            clearStored(entry.id)
            if (mounted.current) {
              setError(operatorSafeTodoError(cause, "Couldn't save this Todo. Reload it and try again."))
              if (Object.prototype.hasOwnProperty.call(request.patch, "rank")) resetRank(entry.id)
            }
            entries.current.delete(entry.id)
          }
          settle(entry)
          return
        }

        let maximumBeforeMerge = maximumTodoVersion(client, entry.id)
        if (maximumBeforeMerge !== undefined && maximumBeforeMerge > result.workItem.version) {
          await refreshBestEffort(client, entry.id)
          maximumBeforeMerge = maximumTodoVersion(client, entry.id)
          if (maximumBeforeMerge !== undefined && maximumBeforeMerge > result.workItem.version) {
            await enterConflict(entry, new TodoApiError(409, "A newer Todo superseded this response", "TODO_VERSION_CONFLICT", maximumBeforeMerge))
            settle(entry)
            return
          }
        }

        mergeTodoIntoCaches(client, result.workItem)
        client.setQueryData<WorkItemDetailWire>(["work-item", entry.id], (current) => mergeSavedDetail(current, result.workItem))
        await refreshBestEffort(client, entry.id)
        const maximum = maximumTodoVersion(client, entry.id)
        if (maximum !== undefined && maximum > result.workItem.version) {
          await enterConflict(entry, new TodoApiError(409, "A newer Todo superseded this edit", "TODO_VERSION_CONFLICT", maximum))
          settle(entry)
          return
        }
        // A successful idempotency replay proves the original request ran, but
        // the returned row must still confirm every desired field before that
        // intent can be acknowledged.
        if (patchFields(request.patch).some((field) => !Object.is(fieldValue(result.workItem, field), request.patch[field]))) {
          await enterConflict(entry, new TodoApiError(409, "The confirmed row diverged from the desired edit", "TODO_VERSION_CONFLICT", result.workItem.version))
          settle(entry)
          return
        }
        // A stale invalidation response cannot leave any cache below the
        // confirmed row even when no newer revision exists.
        mergeTodoIntoCaches(client, result.workItem)
        client.setQueryData<WorkItemDetailWire>(["work-item", entry.id], (current) => mergeSavedDetail(current, result.workItem))
        clearStored(entry.id)
        for (const field of patchFields(request.patch)) {
          if (Object.is(entry.desired[field], request.patch[field])) delete entry.desired[field]
        }
        entry.request = undefined
        exactReplay = false
        if (patchFields(entry.desired).length === 0) {
          entries.current.delete(entry.id)
          if (mounted.current) removeRecovery(entry.id)
          settle(entry)
          return
        }
        // A queued edit is conditional on the just-confirmed whole row. It
        // gets a fresh logical key and the returned version without allowing
        // a stale list projection to replace that acknowledgement.
        entry.baseline = baselineFor(result.workItem, entry.desired)
        entry.request = newTodoEditRequest(entry.desired, result.workItem.version)
        storeRequest(entry.id, { baseline: entry.baseline, request: entry.request, state: "prepared" })
        exactReplay = true
      }
    } catch (cause) {
      if (isTodoVersionConflictError(cause)) await enterConflict(entry, cause)
      else if (mounted.current) {
        setError(operatorSafeTodoError(cause, "Couldn't load the current Todo before saving."))
        if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
      }
      settle(entry)
    }
  }, [client, enterConflict, removeRecovery, resetRank, settle])

  const edit = useCallback((id: string, patch: WorkItemEditPatch): Promise<void> => {
    let entry = entries.current.get(id)
    if (!entry) {
      entry = { id, desired: {}, baseline: {}, running: false, waiters: [] }
      entries.current.set(id, entry)
    }
    entry.desired = { ...entry.desired, ...patch }
    const promise = new Promise<void>((resolve) => entry!.waiters.push(resolve))
    void run(entry)
    return promise
  }, [run])

  const hasOutstanding = useCallback((id: string): boolean => {
    return entries.current.has(id) || hasTodoQuickEditRecovery(id)
  }, [])

  const recover = useCallback(async (id: string): Promise<void> => {
    const stored = loadStored(id)
    if (!stored) return
    let entry = entries.current.get(id)
    if (!entry) {
      entry = {
        id,
        desired: { ...stored.request.patch },
        baseline: { ...stored.baseline },
        request: { ...stored.request, patch: { ...stored.request.patch } },
        running: false,
        waiters: [],
      }
      entries.current.set(id, entry)
    }
    if (stored.state === "conflict") {
      await enterConflict(entry, new TodoApiError(
        409,
        "Recovered conflict",
        stored.failureCode === "idempotency" ? "TODO_IDEMPOTENCY_CONFLICT" : "TODO_VERSION_CONFLICT",
        stored.request.expectedVersion,
      ))
      return
    }
    await run(entry, true)
  }, [enterConflict, run])

  const reconcile = useCallback(async (mode: "reload" | "rebase" | "overwrite") => {
    const active = recoveryEntry
    if (!active) return
    const entry = entries.current.get(active.id)
    if (!entry) return
    if (active.value.reloadOnly && mode !== "reload") return
    publishRecovery(active.id, { ...active.value, busy: true, error: null })
    try {
      const fresh = await loadAuthoritativeDetail(client, entry.id)
      if (mode === "reload") {
        clearStored(entry.id)
        entries.current.delete(entry.id)
        removeRecovery(entry.id)
        setError(null)
        resetRank(entry.id)
        return
      }
      const same = conflictFields(fresh.workItem, entry.baseline)
      if (mode === "rebase" && same.length > 0) {
        publishRecovery(active.id, { ...active.value, sameFieldConflict: true, busy: false, error: null })
        return
      }
      entry.baseline = baselineFor(fresh.workItem, entry.desired)
      entry.request = newTodoEditRequest(entry.desired, fresh.workItem.version!)
      storeRequest(entry.id, { baseline: entry.baseline, request: entry.request, state: "prepared" })
      removeRecovery(entry.id)
      await run(entry, true)
    } catch (cause) {
      publishRecovery(active.id, { ...active.value, busy: false, error: operatorSafeTodoError(cause, "Couldn't reconcile this Todo. Try again.") })
    }
  }, [client, publishRecovery, recoveryEntry, removeRecovery, resetRank, run])

  return {
    edit,
    hasOutstanding,
    recover,
    recovery: recoveryEntry?.value ?? null,
    error,
    rankResetRevision,
    rankResetId,
    reload: () => reconcile("reload"),
    rebase: () => reconcile("rebase"),
    overwrite: () => reconcile("overwrite"),
  }
}
