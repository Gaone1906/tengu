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

interface StoredQuickEditActive {
  request: WorkItemEditRequest
  state: "prepared" | "dispatched" | "uncertain" | "conflict"
  failureCode?: "idempotency"
}

interface StoredQuickEdit {
  expiresAt: number
  desired: WorkItemEditPatch
  baseline: WorkItemEditPatch
  active?: StoredQuickEditActive
  queuedFields?: TodoQuickEditField[]
  queuedPatch?: WorkItemEditPatch
  blocked?: "version" | "idempotency"
  pending?: "retry"
}

type StoredQuickEdits = Record<string, StoredQuickEdit>

interface RuntimeEdit {
  id: string
  desired: WorkItemEditPatch
  baseline: WorkItemEditPatch
  active?: StoredQuickEditActive
  queuedFields: Set<TodoQuickEditField>
  remote?: WorkItemFullWire
  blocked?: "version" | "idempotency"
  pending?: "retry"
  running: boolean
  waiters: Array<() => void>
}

export interface TodoQuickEditRecovery {
  kind: "conflict" | "retry"
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
const QUICK_STATES = new Set<StoredQuickEditActive["state"]>(["prepared", "dispatched", "uncertain", "conflict"])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENVELOPE_KEYS = new Set(["expiresAt", "desired", "baseline", "active", "queuedFields", "queuedPatch", "blocked", "pending"])
const ACTIVE_KEYS = new Set(["request", "state", "failureCode"])
const REQUEST_KEYS = new Set(["patch", "expectedVersion", "idempotencyKey"])

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function validQuickPatch(value: unknown): value is WorkItemEditPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).length > 0 && Object.entries(value).every(([key, field]) => {
    if (!QUICK_FIELDS.has(key as TodoQuickEditField)) return false
    if (key === "title" || key === "body") return typeof field === "string"
    if (key === "assignee" || key === "department") return field === null || typeof field === "string"
    return typeof field === "number" && Number.isFinite(field)
  })
}

function validQuickBaseline(value: unknown): value is WorkItemEditPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).every(([key, field]) => {
    if (!QUICK_FIELDS.has(key as TodoQuickEditField)) return false
    if (key === "title") return typeof field === "string"
    if (key === "body" || key === "assignee" || key === "department") return field === null || typeof field === "string"
    if (key === "rank") return field === null || (typeof field === "number" && Number.isFinite(field))
    return typeof field === "number" && Number.isFinite(field)
  })
}

function validStoredQuickEdit(value: unknown): value is StoredQuickEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!hasOnlyKeys(record, ENVELOPE_KEYS)) return false
  const candidate = value as Partial<StoredQuickEdit>
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)
    || !validQuickPatch(candidate.desired)
    || !validQuickBaseline(candidate.baseline)
    || !Object.keys(candidate.baseline).every((field) => Object.prototype.hasOwnProperty.call(candidate.desired, field))
    || (candidate.blocked !== undefined && candidate.blocked !== "version" && candidate.blocked !== "idempotency")
    || (candidate.pending !== undefined && candidate.pending !== "retry")
    || (candidate.blocked !== undefined && candidate.pending !== undefined)) return false
  if (!candidate.active) return candidate.queuedFields === undefined
    && candidate.queuedPatch === undefined
    && patchFields(candidate.baseline).length <= patchFields(candidate.desired).length
  if (candidate.blocked !== undefined || candidate.pending !== undefined) return false
  const activeRecord = candidate.active as unknown as Record<string, unknown>
  if (!hasOnlyKeys(activeRecord, ACTIVE_KEYS)) return false
  const requestRecord = candidate.active.request as unknown as Record<string, unknown>
  if (!requestRecord || !hasOnlyKeys(requestRecord, REQUEST_KEYS)
    || !validQuickPatch(candidate.active.request.patch)
    || !isPositiveTodoVersion(candidate.active.request.expectedVersion)
    || typeof candidate.active.request.idempotencyKey !== "string"
    || !UUID_PATTERN.test(candidate.active.request.idempotencyKey)
    || !QUICK_STATES.has(candidate.active.state)
    || (candidate.active.failureCode !== undefined
      && !(candidate.active.state === "conflict" && candidate.active.failureCode === "idempotency"))) return false
  if ((candidate.queuedFields === undefined) !== (candidate.queuedPatch === undefined)) return false
  if (candidate.queuedFields !== undefined && (!Array.isArray(candidate.queuedFields)
    || new Set(candidate.queuedFields).size !== candidate.queuedFields.length
    || candidate.queuedFields.some((field) => !QUICK_FIELDS.has(field)
      || !Object.prototype.hasOwnProperty.call(candidate.desired, field))
    || !validQuickPatch(candidate.queuedPatch)
    || patchFields(candidate.queuedPatch).length !== candidate.queuedFields.length
    || patchFields(candidate.queuedPatch).some((field) => !candidate.queuedFields!.includes(field)
      || !Object.is(candidate.desired![field], candidate.queuedPatch![field])))) return false
  const activeFields = patchFields(candidate.active.request.patch)
  const queued = new Set(candidate.queuedFields ?? [])
  const desiredFields = patchFields(candidate.desired)
  return patchFields(candidate.baseline).every((field) => desiredFields.includes(field))
    && desiredFields.every((field) => (activeFields.includes(field) || queued.has(field))
      && (queued.has(field) || Object.is(candidate.desired![field], candidate.active!.request.patch[field])))
    && activeFields.every((field) => Object.prototype.hasOwnProperty.call(candidate.desired, field)
      && Object.prototype.hasOwnProperty.call(candidate.baseline, field))
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

function writeStored(value: StoredQuickEdits): boolean {
  if (typeof sessionStorage === "undefined") return false
  try {
    if (Object.keys(value).length === 0) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function loadStored(id: string): StoredQuickEdit | null {
  return readStored()[todoPrivateRef(id)] ?? null
}

export function hasTodoQuickEditRecovery(id: string): boolean {
  return loadStored(id) !== null
}

export function hasTodoQuickEditRecoveryByRef(ref: string): boolean {
  return /^td_[a-z0-9]+$/i.test(ref) && readStored()[ref] !== undefined
}

export function clearTodoQuickEditRecoveryByRef(ref: string): void {
  if (!/^td_[a-z0-9]+$/i.test(ref)) return
  const all = readStored()
  delete all[ref]
  writeStored(all)
}

function storeEntry(id: string, value: Omit<StoredQuickEdit, "expiresAt">): boolean {
  const all = readStored()
  const ref = todoPrivateRef(id)
  all[ref] = { ...value, expiresAt: Date.now() + TTL_MS }
  const capped = Object.fromEntries(Object.entries(all)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt || a[0].localeCompare(b[0]))
    .slice(0, MAX_STORED))
  if (!writeStored(capped)) return false
  const stored = loadStored(id)
  if (!stored) return false
  const { expiresAt: _storedExpiry, ...storedPayload } = stored
  return JSON.stringify(storedPayload) === JSON.stringify(value)
}

function clearStored(id: string): boolean {
  const all = readStored()
  const ref = todoPrivateRef(id)
  delete all[ref]
  return writeStored(all) && readStored()[ref] === undefined
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

function persistRuntime(entry: RuntimeEdit): boolean {
  const queuedFields = [...entry.queuedFields]
  return storeEntry(entry.id, {
    desired: { ...entry.desired },
    baseline: { ...entry.baseline },
    active: entry.active ? {
      ...entry.active,
      request: { ...entry.active.request, patch: { ...entry.active.request.patch } },
    } : undefined,
    queuedFields: queuedFields.length > 0 ? queuedFields : undefined,
    queuedPatch: queuedFields.length > 0
      ? Object.fromEntries(queuedFields.map((field) => [field, entry.desired[field]])) as WorkItemEditPatch
      : undefined,
    blocked: entry.blocked,
    pending: entry.pending,
  })
}

function hasDurableRetryIntent(entry: RuntimeEdit): boolean {
  const stored = loadStored(entry.id)
  if (!stored || stored.pending !== "retry" || stored.active || stored.blocked) return false
  return JSON.stringify(stored.desired) === JSON.stringify(entry.desired)
    && JSON.stringify(stored.baseline) === JSON.stringify(entry.baseline)
}

function persistConflictTransition(entry: RuntimeEdit, reloadOnly: boolean): boolean {
  entry.pending = undefined
  if (entry.active) {
    entry.active = {
      ...entry.active,
      state: "conflict",
      failureCode: reloadOnly ? "idempotency" : undefined,
    }
  } else {
    entry.blocked = reloadOnly ? "idempotency" : "version"
  }
  if (persistRuntime(entry)) return true

  // A typed conflict definitively retires the dispatched request. If the
  // richer conflict envelope cannot be stored, persist an equivalent
  // no-request gate so recovery can never replay the old key.
  entry.active = undefined
  entry.blocked = reloadOnly ? "idempotency" : "version"
  entry.queuedFields.clear()
  if (persistRuntime(entry)) return true

  clearStored(entry.id)
  return false
}

interface RuntimeIntentSnapshot {
  desired: WorkItemEditPatch
  baseline: WorkItemEditPatch
  queuedFields: Set<TodoQuickEditField>
}

function snapshotIntent(entry: RuntimeEdit): RuntimeIntentSnapshot {
  return {
    desired: { ...entry.desired },
    baseline: { ...entry.baseline },
    queuedFields: new Set(entry.queuedFields),
  }
}

function restoreIntent(entry: RuntimeEdit, snapshot: RuntimeIntentSnapshot): void {
  entry.desired = snapshot.desired
  entry.baseline = snapshot.baseline
  entry.queuedFields = snapshot.queuedFields
}

function addIntent(entry: RuntimeEdit, patch: WorkItemEditPatch): boolean {
  const previous = snapshotIntent(entry)
  for (const field of patchFields(patch)) {
    if (!Object.prototype.hasOwnProperty.call(entry.baseline, field) && entry.remote) {
      entry.baseline[field] = fieldValue(entry.remote, field) as never
    }
    if (entry.active) entry.queuedFields.add(field)
    entry.desired[field] = patch[field] as never
  }
  if (persistRuntime(entry)) return true
  restoreIntent(entry, previous)
  return false
}

function removeSatisfiedIntent(entry: RuntimeEdit, item: WorkItemFullWire): void {
  for (const field of patchFields(entry.desired)) {
    if (!Object.is(entry.desired[field], fieldValue(item, field))) continue
    delete entry.desired[field]
    delete entry.baseline[field]
    entry.queuedFields.delete(field)
  }
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
  const [rankResetRevisions, setRankResetRevisions] = useState<Record<string, number>>({})

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resetRank = useCallback((id: string) => {
    if (!mounted.current) return
    setRankResetRevisions((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
  }, [])

  const publishRecovery = useCallback((id: string, value: TodoQuickEditRecovery) => {
    recoveries.current.set(id, value)
    setRecoveryEntry((current) => {
      if (!current || current.id === id) return { id, value }
      if (value.kind === "conflict" && current.value.kind !== "conflict") return { id, value }
      return current
    })
  }, [])

  const removeRecovery = useCallback((id: string) => {
    recoveries.current.delete(id)
    setRecoveryEntry((current) => {
      if (current?.id !== id) return current
      const ordered = [...recoveries.current.entries()]
      const next = ordered.find(([, value]) => value.kind === "conflict") ?? ordered[0]
      return next ? { id: next[0], value: next[1] } : null
    })
  }, [])

  const settle = useCallback((entry: RuntimeEdit) => {
    entry.running = false
    const waiters = entry.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }, [])

  const abortUnsafeJournal = useCallback((entry: RuntimeEdit) => {
    clearStored(entry.id)
    entries.current.delete(entry.id)
    removeRecovery(entry.id)
    if (mounted.current) {
      setError("This edit couldn't be stored safely. Reload the Todo and try again.")
      if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
    }
    settle(entry)
  }, [removeRecovery, resetRank, settle])

  const enterConflict = useCallback(async (entry: RuntimeEdit, cause: unknown) => {
    const reloadOnly = isTodoIdempotencyConflictError(cause)
    const durable = persistConflictTransition(entry, reloadOnly)
    let same: TodoQuickEditField[] = patchFields(entry.desired)
    try {
      const fresh = await loadAuthoritativeDetail(client, entry.id)
      entry.remote = fresh.workItem
      const missingBaseline = patchFields(entry.desired)
        .filter((field) => !Object.prototype.hasOwnProperty.call(entry.baseline, field))
      same = [...missingBaseline, ...conflictFields(fresh.workItem, entry.baseline)]
    } catch {
      // Without a full fresh row, automatic rebase is intentionally blocked.
    }
    if (mounted.current) {
      publishRecovery(entry.id, {
        kind: "conflict",
        fields: patchFields(entry.desired),
        sameFieldConflict: reloadOnly || same.length > 0,
        busy: false,
        error: durable
          ? operatorSafeTodoError(cause, "Couldn't save this Todo. Reload it before trying again.")
          : "This conflict couldn't be stored safely. Keep this page open and choose how to reconcile it.",
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
        let active = entry.active
        if (!active || !exactReplay) {
          const remote = await loadAuthoritativeDetail(client, entry.id)
          const expectedVersion = remote.workItem.version
          if (!isPositiveTodoVersion(expectedVersion)) throw new TodoApiError(428, "Missing version", "TODO_PRECONDITION_REQUIRED")
          entry.remote = remote.workItem
          for (const field of patchFields(entry.desired)) {
            if (!Object.prototype.hasOwnProperty.call(entry.baseline, field)) {
              entry.baseline[field] = fieldValue(remote.workItem, field) as never
            }
          }
          removeSatisfiedIntent(entry, remote.workItem)
          if (patchFields(entry.desired).length === 0) {
            clearStored(entry.id)
            entries.current.delete(entry.id)
            if (mounted.current) removeRecovery(entry.id)
            settle(entry)
            return
          }
          active = { request: newTodoEditRequest(entry.desired, expectedVersion), state: "prepared" }
          entry.active = active
          entry.pending = undefined
          entry.queuedFields.clear()
        }
        if (active.state === "prepared" && !persistRuntime(entry)) {
          abortUnsafeJournal(entry)
          return
        }
        const request = active.request
        entry.active = { ...active, state: "dispatched" }
        if (!persistRuntime(entry)) {
          abortUnsafeJournal(entry)
          return
        }
        let result: Awaited<ReturnType<typeof api.updateWorkItem>>
        try {
          result = await api.updateWorkItem(entry.id, request)
        } catch (cause) {
          if (isTodoVersionConflictError(cause) || isTodoIdempotencyConflictError(cause)) {
            await enterConflict(entry, cause)
            await refreshBestEffort(client, entry.id)
          } else if (isAmbiguousTransport(cause)) {
            const dispatched = entry.active!
            entry.active = { ...dispatched, state: "uncertain" }
            if (!persistRuntime(entry)) entry.active = dispatched
            if (mounted.current) setError("The connection ended before this edit was confirmed. It will be replayed exactly.")
          } else {
            const failedRankNeedsReset = Object.prototype.hasOwnProperty.call(request.patch, "rank")
              && !entry.queuedFields.has("rank")
            for (const field of patchFields(request.patch)) {
              if (!entry.queuedFields.has(field) && Object.is(entry.desired[field], request.patch[field])) {
                delete entry.desired[field]
                delete entry.baseline[field]
              }
            }
            entry.active = undefined
            entry.blocked = undefined
            entry.pending = undefined
            entry.remote = undefined
            entry.queuedFields.clear()
            if (mounted.current) {
              setError(operatorSafeTodoError(cause, "Couldn't save this Todo. Reload it and try again."))
              if (failedRankNeedsReset) resetRank(entry.id)
            }
            if (patchFields(entry.desired).length > 0) {
              // The rejected payload is retired. Newer intent starts a fresh
              // logical edit from a newly fetched whole-row baseline and key.
              entry.baseline = {}
              entry.pending = "retry"
              if (!persistRuntime(entry)) {
                abortUnsafeJournal(entry)
                return
              }
              exactReplay = false
              continue
            }
            clearStored(entry.id)
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
        for (const field of patchFields(request.patch)) {
          if (!entry.queuedFields.has(field) && Object.is(entry.desired[field], request.patch[field])) {
            delete entry.desired[field]
            delete entry.baseline[field]
          }
        }
        entry.active = undefined
        entry.pending = undefined
        entry.queuedFields.clear()
        entry.remote = result.workItem
        exactReplay = false
        if (patchFields(entry.desired).length === 0) {
          clearStored(entry.id)
          entries.current.delete(entry.id)
          if (mounted.current) removeRecovery(entry.id)
          settle(entry)
          return
        }
        // A queued edit is conditional on the just-confirmed whole row. It
        // gets a fresh logical key and the returned version without allowing
        // a stale list projection to replace that acknowledgement.
        entry.baseline = baselineFor(result.workItem, entry.desired)
        entry.active = { request: newTodoEditRequest(entry.desired, result.workItem.version), state: "prepared" }
        if (!persistRuntime(entry)) {
          abortUnsafeJournal(entry)
          return
        }
        exactReplay = true
      }
    } catch (cause) {
      if (isTodoVersionConflictError(cause)) await enterConflict(entry, cause)
      else if (entry.pending === "retry" && hasDurableRetryIntent(entry)) {
        if (mounted.current) {
          setError(null)
          publishRecovery(entry.id, {
            kind: "retry",
            fields: patchFields(entry.desired),
            sameFieldConflict: false,
            busy: false,
            error: operatorSafeTodoError(cause, "Couldn't reach the current Todo. Your local edit is still saved."),
            reloadOnly: false,
          })
          if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
        }
      }
      else {
        clearStored(entry.id)
        entries.current.delete(entry.id)
        if (mounted.current) {
          setError(operatorSafeTodoError(cause, "Couldn't load the current Todo before saving."))
          if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
        }
      }
      settle(entry)
    }
  }, [abortUnsafeJournal, client, enterConflict, publishRecovery, removeRecovery, resetRank, settle])

  const edit = useCallback((id: string, patch: WorkItemEditPatch): Promise<void> => {
    let entry = entries.current.get(id)
    const created = !entry
    if (!entry) {
      entry = { id, desired: {}, baseline: {}, queuedFields: new Set(), running: false, waiters: [] }
      entries.current.set(id, entry)
    }
    if (!addIntent(entry, patch)) {
      if (created) {
        clearStored(id)
        entries.current.delete(id)
      }
      if (mounted.current) {
        setError("This edit couldn't be stored safely. Reload the Todo and try again.")
        if (Object.prototype.hasOwnProperty.call(patch, "rank")) resetRank(id)
      }
      return Promise.resolve()
    }
    const promise = new Promise<void>((resolve) => entry!.waiters.push(resolve))
    const blocked = entry.blocked !== undefined || entry.active?.state === "conflict"
    if (blocked) {
      const current = recoveries.current.get(id)
      if (current && mounted.current) publishRecovery(id, { ...current, fields: patchFields(entry.desired) })
      return promise
    }
    const exactReplay = entry.active?.state === "uncertain" || entry.active?.state === "dispatched"
    void run(entry, exactReplay)
    return promise
  }, [publishRecovery, resetRank, run])

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
        desired: { ...stored.desired },
        baseline: { ...stored.baseline },
        active: stored.active ? {
          ...stored.active,
          request: { ...stored.active.request, patch: { ...stored.active.request.patch } },
        } : undefined,
        queuedFields: new Set(stored.queuedFields ?? []),
        blocked: stored.blocked,
        pending: stored.pending,
        running: false,
        waiters: [],
      }
      entries.current.set(id, entry)
    }
    if (stored.blocked === "version" || stored.blocked === "idempotency" || stored.active?.state === "conflict") {
      await enterConflict(entry, new TodoApiError(
        409,
        "Recovered conflict",
        stored.blocked === "idempotency" || stored.active?.failureCode === "idempotency"
          ? "TODO_IDEMPOTENCY_CONFLICT"
          : "TODO_VERSION_CONFLICT",
        stored.active?.request.expectedVersion,
      ))
      return
    }
    await run(entry, !!entry.active)
  }, [enterConflict, run])

  const reconcile = useCallback(async (mode: "reload" | "rebase" | "overwrite") => {
    const active = recoveryEntry
    if (!active || active.value.kind !== "conflict") return
    const entry = entries.current.get(active.id)
    if (!entry) return
    if (active.value.reloadOnly && mode !== "reload") return
    const previousIntent = snapshotIntent(entry)
    const previousActive = entry.active
    const previousBlocked = entry.blocked
    const previousPending = entry.pending
    const previousRemote = entry.remote
    publishRecovery(active.id, { ...active.value, busy: true, error: null })
    try {
      const fresh = await loadAuthoritativeDetail(client, entry.id)
      if (mode === "reload") {
        clearStored(entry.id)
        entries.current.delete(entry.id)
        removeRecovery(entry.id)
        setError(null)
        resetRank(entry.id)
        settle(entry)
        return
      }
      removeSatisfiedIntent(entry, fresh.workItem)
      if (patchFields(entry.desired).length === 0) {
        clearStored(entry.id)
        entries.current.delete(entry.id)
        removeRecovery(entry.id)
        setError(null)
        resetRank(entry.id)
        settle(entry)
        return
      }
      const missingBaseline = patchFields(entry.desired)
        .filter((field) => !Object.prototype.hasOwnProperty.call(entry.baseline, field))
      const same = conflictFields(fresh.workItem, entry.baseline)
      if (mode === "rebase" && (missingBaseline.length > 0 || same.length > 0)) {
        publishRecovery(active.id, { ...active.value, sameFieldConflict: true, busy: false, error: null })
        return
      }
      entry.baseline = baselineFor(fresh.workItem, entry.desired)
      entry.remote = fresh.workItem
      entry.blocked = undefined
      entry.pending = undefined
      entry.active = { request: newTodoEditRequest(entry.desired, fresh.workItem.version!), state: "prepared" }
      entry.queuedFields.clear()
      if (!persistRuntime(entry)) {
        restoreIntent(entry, previousIntent)
        entry.active = previousActive
        entry.blocked = previousBlocked
        entry.pending = previousPending
        entry.remote = previousRemote
        publishRecovery(active.id, {
          ...active.value,
          busy: false,
          error: "This edit couldn't be stored safely. Reload the Todo and try again.",
        })
        return
      }
      removeRecovery(entry.id)
      await run(entry, true)
    } catch (cause) {
      publishRecovery(active.id, { ...active.value, busy: false, error: operatorSafeTodoError(cause, "Couldn't reconcile this Todo. Try again.") })
    }
  }, [client, publishRecovery, recoveryEntry, removeRecovery, resetRank, run, settle])

  const retry = useCallback(async () => {
    const active = recoveryEntry
    if (!active || active.value.kind !== "retry") return
    const entry = entries.current.get(active.id)
    if (!entry || entry.pending !== "retry" || entry.running) return
    publishRecovery(active.id, { ...active.value, busy: true, error: null })
    await run(entry, false)
  }, [publishRecovery, recoveryEntry, run])

  const discard = useCallback(async () => {
    const active = recoveryEntry
    if (!active || active.value.kind !== "retry") return
    const entry = entries.current.get(active.id)
    if (!entry || entry.pending !== "retry" || entry.running) return
    publishRecovery(active.id, { ...active.value, busy: true, error: null })
    if (!clearStored(entry.id)) {
      publishRecovery(active.id, {
        ...active.value,
        busy: false,
        error: "This local edit couldn't be discarded safely. Keep this page open and try again.",
      })
      return
    }
    entries.current.delete(entry.id)
    removeRecovery(entry.id)
    if (mounted.current) {
      setError(null)
      if (Object.prototype.hasOwnProperty.call(entry.desired, "rank")) resetRank(entry.id)
    }
    settle(entry)
  }, [publishRecovery, recoveryEntry, removeRecovery, resetRank, settle])

  return {
    edit,
    hasOutstanding,
    hasRecovery: () => recoveries.current.size > 0,
    recover,
    recovery: recoveryEntry?.value ?? null,
    recoveryRef: recoveryEntry ? todoPrivateRef(recoveryEntry.id) : null,
    error,
    rankResetRevisions,
    reload: () => reconcile("reload"),
    rebase: () => reconcile("rebase"),
    overwrite: () => reconcile("overwrite"),
    retry,
    discard,
  }
}
