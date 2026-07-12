import { useCallback, useEffect, useRef, useState } from "react"
import type { WorkItemEditRequest } from "@/lib/api"
import { isPositiveTodoVersion } from "@/lib/api"
import { isTodoVersionConflictError } from "@/lib/todos"
import { newTodoEditRequest } from "./todo-edit-request"
import {
  clearTodoJournal,
  loadTodoJournal,
  persistTodoJournal,
  transitionTodoJournal,
  type TodoDraftField,
  type TodoJournalPayload,
  type TodoJournalRequest,
  type TodoJournalRequestFingerprint,
} from "./todo-private-state"

export interface TodoEditableDraft {
  title: string
  body: string
  assignee: string | null
  department: string | null
  priority: number
}

export type TodoDraftPatch = Partial<TodoEditableDraft>
export type TodoSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

export interface TodoRemoteSnapshot {
  draft: TodoEditableDraft
  version: number
}

export interface TodoSaveResult {
  remote: TodoRemoteSnapshot
  replayed: boolean
}

type FailureKind = "ambiguous" | "definitive" | "conflict" | null

function fieldsOf(patch: TodoDraftPatch): TodoDraftField[] {
  return Object.keys(patch) as TodoDraftField[]
}

function patchFor(fields: Iterable<TodoDraftField>, draft: TodoEditableDraft): TodoDraftPatch {
  const patch: TodoDraftPatch = {}
  for (const field of fields) (patch as Record<string, unknown>)[field] = draft[field]
  return patch
}

function baselineFor(
  fields: Iterable<TodoDraftField>,
  baselines: Partial<TodoEditableDraft>,
  fallback: TodoEditableDraft,
): TodoDraftPatch {
  const patch: TodoDraftPatch = {}
  for (const field of fields) {
    const value = Object.prototype.hasOwnProperty.call(baselines, field)
      ? baselines[field]
      : fallback[field]
    ;(patch as Record<string, unknown>)[field] = value
  }
  return patch
}

function requestFingerprint(request: TodoJournalRequest): TodoJournalRequestFingerprint {
  return {
    revision: request.revision,
    patch: { ...request.patch },
    expectedVersion: request.expectedVersion,
    idempotencyKey: request.idempotencyKey,
  }
}

function transportRequest(request: TodoJournalRequest): WorkItemEditRequest {
  return {
    patch: { ...request.patch },
    expectedVersion: request.expectedVersion,
    idempotencyKey: request.idempotencyKey,
  }
}

function isAmbiguousTransportFailure(cause: unknown): boolean {
  return cause instanceof TypeError
    || (typeof DOMException !== "undefined"
      && cause instanceof DOMException
      && (cause.name === "AbortError" || cause.name === "NetworkError"))
}

function isTodoEditableDraft(value: unknown): value is TodoEditableDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Record<string, unknown>
  return typeof draft.title === "string"
    && typeof draft.body === "string"
    && (draft.assignee === null || typeof draft.assignee === "string")
    && (draft.department === null || typeof draft.department === "string")
    && typeof draft.priority === "number"
    && Number.isFinite(draft.priority)
}

function isTodoRemoteSnapshot(value: unknown): value is TodoRemoteSnapshot {
  if (!value || typeof value !== "object") return false
  const remote = value as Partial<TodoRemoteSnapshot>
  return isPositiveTodoVersion(remote.version) && isTodoEditableDraft(remote.draft)
}

function samePatch(a: TodoDraftPatch, b: TodoDraftPatch): boolean {
  const aFields = fieldsOf(a)
  const bFields = fieldsOf(b)
  return aFields.length === bFields.length
    && aFields.every((field) => Object.prototype.hasOwnProperty.call(b, field) && Object.is(a[field], b[field]))
}

function sameRequest(a: TodoJournalRequest, b: TodoJournalRequest): boolean {
  return a.revision === b.revision
    && a.expectedVersion === b.expectedVersion
    && a.idempotencyKey === b.idempotencyKey
    && samePatch(a.patch, b.patch)
}

function recoveryError(state: TodoJournalRequest["state"]): unknown | null {
  if (state === "conflict") return null
  if (state === "failed") return new Error("The previous save did not complete")
  return new TypeError("The previous save response was not confirmed")
}

function cleanupRecoveryError(): Error {
  return new Error("This draft could not be cleared locally. Check browser storage and try again.")
}

/**
 * A Todo draft has two deliberately separate clocks: latest desired intent and
 * one immutable conditional request. A transport retry can only replay the
 * latter; a newer request is minted only after an authoritative response has
 * retired it atomically in the recovery journal.
 */
export function useTodoDraft({
  id,
  initial,
  serverVersion,
  save: saveRemote,
  loadRemote,
}: {
  id: string
  initial: TodoEditableDraft
  serverVersion?: number
  save: (request: WorkItemEditRequest) => Promise<TodoSaveResult>
  loadRemote?: () => Promise<TodoRemoteSnapshot>
}) {
  const recoveredAtMount = useRef({ id, value: loadTodoJournal(id) })
  const recovered = recoveredAtMount.current.id === id ? recoveredAtMount.current.value : null
  const recoveredFields = new Set<TodoDraftField>(fieldsOf(recovered?.patch ?? {}))
  const recoveredRequest = recovered?.request ?? null
  const startingDraft = recovered ? { ...initial, ...recovered.patch } : initial
  const startingConflicts = new Set<TodoDraftField>(recovered?.conflictFields ?? [])
  if (startingConflicts.size === 0 && recoveredRequest?.state === "conflict") {
    for (const field of recoveredFields) {
      const baseline = recovered?.baseline[field]
      const sent = recoveredRequest.patch[field]
      if ((initial[field] !== baseline || (sent !== undefined && initial[field] !== sent))
        && startingDraft[field] !== initial[field]) startingConflicts.add(field)
    }
    if (startingConflicts.size === 0) {
      for (const field of fieldsOf(recoveredRequest.patch)) startingConflicts.add(field)
    }
  } else if (recovered && !recoveredRequest && isPositiveTodoVersion(serverVersion)) {
    for (const field of recoveredFields) {
      if (initial[field] !== recovered.baseline[field] && startingDraft[field] !== initial[field]) {
        startingConflicts.add(field)
      }
    }
  }

  const startingFailure: FailureKind = recovered?.cleanupPending ? "definitive" : recoveredRequest
    ? recoveredRequest.state === "conflict"
      ? "conflict"
      : recoveredRequest.state === "failed"
        ? "definitive"
        : "ambiguous"
    : startingConflicts.size > 0 ? "conflict" : null

  const [draft, setDraftState] = useState(startingDraft)
  const [status, setStatus] = useState<TodoSaveStatus>(
    startingFailure ? "error" : recoveredFields.size > 0 ? "dirty" : "idle",
  )
  const [error, setError] = useState<unknown | null>(
    recovered?.cleanupPending ? cleanupRecoveryError() : recoveredRequest ? recoveryError(recoveredRequest.state) : null,
  )
  const [recoveredConflict, setRecoveredConflict] = useState(startingConflicts.size > 0 || startingFailure === "conflict")
  const [conflictFields, setConflictFields] = useState<TodoDraftField[]>([...startingConflicts])
  const [cleanupPending, setCleanupPending] = useState(!!recovered?.cleanupPending)

  const draftRef = useRef(startingDraft)
  const remoteRef = useRef(initial)
  const baselineByFieldRef = useRef<Partial<TodoEditableDraft>>({ ...(recovered?.baseline ?? {}) })
  const baselineVersionRef = useRef<number | undefined>(
    !recoveredRequest && isPositiveTodoVersion(serverVersion)
      ? serverVersion
      : isPositiveTodoVersion(recovered?.baselineVersion)
        ? recovered.baselineVersion
        : isPositiveTodoVersion(serverVersion) ? serverVersion : undefined,
  )
  const dirtyFieldsRef = useRef(recoveredFields)
  const conflictFieldsRef = useRef(startingConflicts)
  const activeRef = useRef<TodoJournalRequest | null>(recoveredRequest)
  const activeDurableRef = useRef(!!recoveredRequest)
  const cleanupPendingRef = useRef(!!recovered?.cleanupPending)
  const cleanupSnapshotRef = useRef<TodoRemoteSnapshot | null>(null)
  const cleanupIntentFieldsRef = useRef(new Set<TodoDraftField>(recovered?.cleanupIntentFields ?? []))
  const cleanupSaveRequestedRef = useRef(recovered?.cleanupSaveRequested === true)
  const runningRef = useRef(false)
  const failureRef = useRef<FailureKind>(startingFailure)
  const localRevisionRef = useRef(recovered ? recovered.revision : 0)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)
  const saveRef = useRef(saveRemote)
  const loadRemoteRef = useRef(loadRemote)
  const runActiveRef = useRef<() => Promise<void>>(async () => undefined)
  const installFreshRequestRef = useRef<(
    version: number,
    previousActive?: TodoJournalRequest | null,
    retainConflict?: boolean,
  ) => boolean>(() => false)

  saveRef.current = saveRemote
  loadRemoteRef.current = loadRemote

  const publishDraft = useCallback((next: TodoEditableDraft) => {
    draftRef.current = next
    if (mountedRef.current) setDraftState(next)
  }, [])

  const publishConflict = useCallback((fields: Set<TodoDraftField>) => {
    conflictFieldsRef.current = fields
    if (mountedRef.current) {
      setConflictFields([...fields])
      setRecoveredConflict(fields.size > 0 || failureRef.current === "conflict")
    }
  }, [])

  const payloadFor = useCallback((
    active = activeRef.current,
    conflicts = conflictFieldsRef.current,
  ): TodoJournalPayload | null => {
    const fields = new Set([
      ...dirtyFieldsRef.current,
      ...conflicts,
      ...fieldsOf(active?.patch ?? {}),
      ...cleanupIntentFieldsRef.current,
    ])
    if (fields.size === 0 && !active && !cleanupPendingRef.current) return null
    const version = active?.expectedVersion ?? baselineVersionRef.current
    return {
      revision: Math.max(1, localRevisionRef.current),
      patch: patchFor(fields, draftRef.current),
      baseline: baselineFor(fields, baselineByFieldRef.current, remoteRef.current),
      baselineVersion: version,
      uncertainFields: active?.state === "uncertain" ? fieldsOf(active.patch) : undefined,
      conflictFields: conflicts.size > 0 ? [...conflicts] : undefined,
      cleanupPending: cleanupPendingRef.current || undefined,
      cleanupIntentFields: cleanupPendingRef.current ? [...cleanupIntentFieldsRef.current] : undefined,
      cleanupSaveRequested: cleanupPendingRef.current && cleanupSaveRequestedRef.current ? true : undefined,
      request: active ?? undefined,
    }
  }, [])

  const persistCurrent = useCallback(() => {
    const payload = payloadFor()
    if (payload) persistTodoJournal(id, payload)
    else clearTodoJournal(id, localRevisionRef.current)
  }, [id, payloadFor])

  const durableRequest = useCallback((
    request: TodoJournalRequest,
    states: ReadonlySet<TodoJournalRequest["state"]>,
  ): TodoJournalRequest | null => {
    const stored = loadTodoJournal(id)
    if (stored?.revision !== Math.max(1, localRevisionRef.current)
      || !stored.request
      || !states.has(stored.request.state)
      || !sameRequest(stored.request, request)) return null
    return stored.request
  }, [id])

  const localPersistenceError = useCallback((request: TodoJournalRequest | null, preserveConflict: boolean, durable = false) => {
    activeRef.current = request
    activeDurableRef.current = durable
    runningRef.current = false
    failureRef.current = preserveConflict ? "conflict" : "definitive"
    if (mountedRef.current) {
      setStatus("error")
      setError(new Error("This draft could not be saved locally. Check browser storage and try again."))
      setRecoveredConflict(preserveConflict || conflictFieldsRef.current.size > 0)
    }
  }, [])

  const markClean = useCallback((nextStatus: TodoSaveStatus = "idle") => {
    activeRef.current = null
    activeDurableRef.current = false
    cleanupPendingRef.current = false
    cleanupSnapshotRef.current = null
    cleanupIntentFieldsRef.current.clear()
    cleanupSaveRequestedRef.current = false
    runningRef.current = false
    failureRef.current = null
    dirtyFieldsRef.current.clear()
    baselineByFieldRef.current = {}
    publishConflict(new Set())
    if (mountedRef.current) {
      setError(null)
      setStatus(nextStatus)
      setRecoveredConflict(false)
      setCleanupPending(false)
    }
  }, [publishConflict])

  const failAtomicTransition = useCallback((request: TodoJournalRequest, visibleError?: unknown) => {
    activeRef.current = { ...request, state: "uncertain" }
    activeDurableRef.current = true
    runningRef.current = false
    failureRef.current = "ambiguous"
    if (mountedRef.current) {
      setStatus("error")
      setError(visibleError ?? new TypeError("The save result could not be committed locally"))
    }
  }, [])

  const transitionActive = useCallback((
    current: TodoJournalRequest,
    next: TodoJournalPayload | null,
  ): boolean => transitionTodoJournal(
    id,
    requestFingerprint(current),
    Math.max(1, localRevisionRef.current),
    next,
  ), [id])

  const blockCleanup = useCallback((active: TodoJournalRequest | null, target: TodoRemoteSnapshot | null) => {
    if (!cleanupPendingRef.current) {
      cleanupIntentFieldsRef.current = new Set()
      cleanupSaveRequestedRef.current = false
    }
    cleanupPendingRef.current = true
    cleanupSnapshotRef.current = target
    activeRef.current = active
    activeDurableRef.current = !!active
    runningRef.current = false
    failureRef.current = "definitive"
    persistCurrent()
    if (mountedRef.current) {
      setStatus("error")
      setError(cleanupRecoveryError())
      setCleanupPending(true)
    }
  }, [persistCurrent])

  const removeJournal = useCallback((active: TodoJournalRequest | null): boolean => (
    active && activeDurableRef.current
      ? transitionActive(active, null)
      : clearTodoJournal(id, cleanupPendingRef.current ? undefined : localRevisionRef.current)
  ), [id, transitionActive])

  const knownSnapshot = useCallback((
    draft = remoteRef.current,
    version = baselineVersionRef.current,
  ): TodoRemoteSnapshot | null => isPositiveTodoVersion(version) ? { draft, version } : null, [])

  const durableIntent = useCallback((): boolean => {
    const stored = loadTodoJournal(id)
    return !!stored
      && stored.revision === Math.max(1, localRevisionRef.current)
      && !stored.request
      && samePatch(stored.patch, patchFor(dirtyFieldsRef.current, draftRef.current))
  }, [id])

  const durableCleanupIntent = useCallback((): boolean => {
    if (!cleanupPendingRef.current) return true
    const stored = loadTodoJournal(id)
    if (!stored?.cleanupPending
      || stored.revision !== Math.max(1, localRevisionRef.current)
      || (stored.cleanupSaveRequested === true) !== cleanupSaveRequestedRef.current) return false
    const storedFields = new Set(stored.cleanupIntentFields ?? [])
    return storedFields.size === cleanupIntentFieldsRef.current.size
      && [...cleanupIntentFieldsRef.current].every((field) => storedFields.has(field))
  }, [id])

  const retryCleanup = useCallback(async () => {
    if (!cleanupPendingRef.current || runningRef.current) return
    persistCurrent()
    if (!durableCleanupIntent()) {
      if (mountedRef.current) setError(cleanupRecoveryError())
      return
    }
    const epoch = epochRef.current
    let target = cleanupSnapshotRef.current
    if (!target) {
      const readRemote = loadRemoteRef.current
      if (!readRemote) {
        if (mountedRef.current) setError(cleanupRecoveryError())
        return
      }
      runningRef.current = true
      try {
        const remote = await readRemote()
        if (epoch !== epochRef.current) return
        if (!isTodoRemoteSnapshot(remote)) {
          runningRef.current = false
          if (mountedRef.current) setError(cleanupRecoveryError())
          return
        }
        target = remote
        cleanupSnapshotRef.current = remote
      } catch {
        if (epoch !== epochRef.current) return
        runningRef.current = false
        if (mountedRef.current) setError(cleanupRecoveryError())
        return
      }
      runningRef.current = false
    }
    persistCurrent()
    if (!durableCleanupIntent()) {
      if (mountedRef.current) setError(cleanupRecoveryError())
      return
    }
    const active = activeRef.current
    if (!removeJournal(active)) {
      blockCleanup(active && activeDurableRef.current ? active : null, target)
      return
    }
    const saveRequested = cleanupSaveRequestedRef.current
    const desired = draftRef.current
    const remaining = new Set<TodoDraftField>()
    for (const field of cleanupIntentFieldsRef.current) {
      if (!Object.is(desired[field], target.draft[field])) remaining.add(field)
    }

    remoteRef.current = target.draft
    baselineVersionRef.current = target.version
    activeRef.current = null
    activeDurableRef.current = false
    cleanupPendingRef.current = false
    cleanupSnapshotRef.current = null
    cleanupIntentFieldsRef.current.clear()
    cleanupSaveRequestedRef.current = false
    runningRef.current = false
    failureRef.current = null
    dirtyFieldsRef.current = remaining
    baselineByFieldRef.current = Object.fromEntries(
      [...remaining].map((field) => [field, target.draft[field]]),
    ) as Partial<TodoEditableDraft>
    const rebased = { ...target.draft }
    for (const field of remaining) (rebased as Record<string, unknown>)[field] = desired[field]
    publishConflict(new Set())
    publishDraft(rebased)
    if (mountedRef.current) {
      setCleanupPending(false)
      setRecoveredConflict(false)
      setError(null)
    }

    if (remaining.size === 0) {
      localRevisionRef.current = 0
      markClean("idle")
      return
    }
    persistCurrent()
    if (!durableIntent()) {
      localPersistenceError(null, false, false)
      return
    }
    if (saveRequested) {
      installFreshRequestRef.current(target.version, null)
    } else if (mountedRef.current) {
      setStatus("dirty")
    }
  }, [blockCleanup, durableCleanupIntent, durableIntent, localPersistenceError, markClean, persistCurrent, publishConflict, publishDraft, removeJournal])

  const installFreshRequest = useCallback((
    version: number,
    previousActive: TodoJournalRequest | null = activeRef.current,
    retainConflict = false,
  ): boolean => {
    if (!isPositiveTodoVersion(version)) return false
    const fields = new Set(dirtyFieldsRef.current)
    for (const field of [...fields]) {
      if (draftRef.current[field] === remoteRef.current[field]) {
        fields.delete(field)
        dirtyFieldsRef.current.delete(field)
        delete baselineByFieldRef.current[field]
      }
    }
    if (fields.size === 0) {
      if (!removeJournal(previousActive)) {
        blockCleanup(previousActive && activeDurableRef.current ? previousActive : null, {
          draft: remoteRef.current,
          version,
        })
        return false
      }
      markClean("saved")
      return true
    }
    const base = newTodoEditRequest(patchFor(fields, draftRef.current), version)
    const nextRequest: TodoJournalRequest = {
      ...base,
      revision: Math.max(1, localRevisionRef.current),
      state: "prepared",
    }
    baselineVersionRef.current = version
    const nextPayload = payloadFor(nextRequest, retainConflict ? conflictFieldsRef.current : new Set())
    if (!nextPayload) return false
    const installed = previousActive
      ? transitionActive(previousActive, nextPayload)
      : (persistTodoJournal(id, nextPayload), true)
    const durable = installed
      ? durableRequest(nextRequest, new Set<TodoJournalRequest["state"]>(["prepared"]))
      : null
    if (!durable) {
      const preservingConflict = conflictFieldsRef.current.size > 0
      if (preservingConflict) {
        localPersistenceError(previousActive && activeDurableRef.current ? previousActive : null, true, !!previousActive && activeDurableRef.current)
      } else {
        localPersistenceError(nextRequest, false, false)
      }
      return false
    }
    activeRef.current = nextRequest
    activeDurableRef.current = true
    failureRef.current = null
    if (!retainConflict) publishConflict(new Set())
    if (mountedRef.current) {
      setError(null)
      setStatus("saving")
      if (!retainConflict) setRecoveredConflict(false)
    }
    void runActiveRef.current()
    return true
  }, [blockCleanup, durableRequest, id, localPersistenceError, markClean, payloadFor, publishConflict, removeJournal, transitionActive])
  installFreshRequestRef.current = installFreshRequest

  const settleSuccessfulRequest = useCallback((request: TodoJournalRequest, result: TodoSaveResult) => {
    const { remote } = result
    if (!isTodoRemoteSnapshot(remote)) {
      failAtomicTransition(request)
      return
    }
    if (remote.version < request.expectedVersion) {
      failAtomicTransition(request, new TypeError("The save returned an older Todo version"))
      return
    }
    const currentDesired = draftRef.current
    const oldBaselines = { ...baselineByFieldRef.current }
    const remaining = new Set<TodoDraftField>()
    const conflicts = new Set<TodoDraftField>()
    const sentFields = new Set(fieldsOf(request.patch))

    for (const field of dirtyFieldsRef.current) {
      const desired = currentDesired[field]
      const current = remote.draft[field]
      if (desired === current) continue
      remaining.add(field)
      if (sentFields.has(field)) {
        if (current !== request.patch[field]) conflicts.add(field)
      } else if (Object.prototype.hasOwnProperty.call(oldBaselines, field)
        && current !== oldBaselines[field]) {
        conflicts.add(field)
      }
    }

    remoteRef.current = remote.draft
    baselineVersionRef.current = remote.version
    dirtyFieldsRef.current = remaining
    const nextBaselines: Partial<TodoEditableDraft> = {}
    for (const field of remaining) {
      const value = sentFields.has(field) && remote.draft[field] === request.patch[field]
        ? remote.draft[field]
        : Object.prototype.hasOwnProperty.call(oldBaselines, field)
          ? oldBaselines[field]
          : remote.draft[field]
      ;(nextBaselines as Record<string, unknown>)[field] = value
    }
    baselineByFieldRef.current = nextBaselines
    const merged = { ...remote.draft }
    for (const field of remaining) (merged as Record<string, unknown>)[field] = currentDesired[field]
    publishDraft(merged)

    if (conflicts.size > 0) {
      const conflictRequest: TodoJournalRequest = { ...request, state: "conflict" }
      conflictFieldsRef.current = conflicts
      const nextPayload = payloadFor(conflictRequest)
      if (!nextPayload || !transitionActive(request, nextPayload)) {
        failAtomicTransition(request)
        return
      }
      activeRef.current = conflictRequest
      activeDurableRef.current = true
      runningRef.current = false
      failureRef.current = "conflict"
      publishConflict(conflicts)
      if (mountedRef.current) {
        setStatus("error")
        setError(null)
        setRecoveredConflict(true)
      }
      return
    }

    runningRef.current = false
    if (!installFreshRequest(remote.version, request)
      && !cleanupPendingRef.current
      && conflictFieldsRef.current.size === 0) failAtomicTransition(request)
  }, [failAtomicTransition, installFreshRequest, payloadFor, publishConflict, publishDraft, transitionActive])

  const runActive = useCallback(async () => {
    const request = activeRef.current
    if (!request || cleanupPendingRef.current || runningRef.current || request.state === "conflict") return
    runningRef.current = true
    const epoch = epochRef.current
    if (request.state === "prepared"
      && !durableRequest(request, new Set<TodoJournalRequest["state"]>(["prepared"]))) {
      activeRef.current = request
      persistCurrent()
      if (!durableRequest(request, new Set<TodoJournalRequest["state"]>(["prepared"]))) {
        localPersistenceError(request, conflictFieldsRef.current.size > 0, false)
        return
      }
      activeDurableRef.current = true
    }
    const dispatched: TodoJournalRequest = request.state === "uncertain"
      ? request
      : { ...request, state: "dispatched" }
    activeRef.current = dispatched
    persistCurrent()
    const durable = durableRequest(dispatched, new Set<TodoJournalRequest["state"]>([dispatched.state]))
    if (!durable) {
      const stored = loadTodoJournal(id)?.request
      const durableStored = stored && sameRequest(stored, request) ? stored : null
      localPersistenceError(durableStored ?? request, conflictFieldsRef.current.size > 0, !!durableStored)
      return
    }
    if (mountedRef.current) {
      setStatus("saving")
      setError(null)
    }
    try {
      const result = await saveRef.current(transportRequest(request))
      if (epoch !== epochRef.current || activeRef.current?.idempotencyKey !== request.idempotencyKey) return
      settleSuccessfulRequest(dispatched, result)
    } catch (cause) {
      if (epoch !== epochRef.current || activeRef.current?.idempotencyKey !== request.idempotencyKey) return
      const conflict = isTodoVersionConflictError(cause)
      const ambiguous = isAmbiguousTransportFailure(cause)
      const state: TodoJournalRequest["state"] = conflict ? "conflict" : ambiguous ? "uncertain" : "failed"
      const terminalRequest: TodoJournalRequest = { ...request, state }
      const terminalConflicts = conflict ? new Set(fieldsOf(request.patch)) : conflictFieldsRef.current
      const terminalPayload = payloadFor(terminalRequest, terminalConflicts)
      let installed = !!terminalPayload && transitionActive(dispatched, terminalPayload)
      // Retry only the verified journal transition. If storage stays unavailable,
      // the transport outcome remains ambiguous and Retry exact-replays this key.
      if (!installed && terminalPayload) installed = transitionActive(dispatched, terminalPayload)
      if (!installed) {
        failAtomicTransition(dispatched, cause)
        return
      }
      activeRef.current = terminalRequest
      activeDurableRef.current = true
      runningRef.current = false
      failureRef.current = conflict ? "conflict" : ambiguous ? "ambiguous" : "definitive"
      if (conflict) publishConflict(terminalConflicts)
      if (mountedRef.current) {
        setStatus("error")
        setError(cause)
        setRecoveredConflict(conflict || conflictFieldsRef.current.size > 0)
      }
    }
  }, [durableRequest, failAtomicTransition, id, localPersistenceError, payloadFor, persistCurrent, publishConflict, settleSuccessfulRequest, transitionActive])
  runActiveRef.current = runActive

  const adoptFreshForIntent = useCallback((remote: TodoRemoteSnapshot): Set<TodoDraftField> | null => {
    if (!isTodoRemoteSnapshot(remote)) return null
    const desired = draftRef.current
    const conflicts = new Set<TodoDraftField>()
    for (const field of dirtyFieldsRef.current) {
      const baseline = baselineByFieldRef.current[field]
      if (Object.prototype.hasOwnProperty.call(baselineByFieldRef.current, field)
        && remote.draft[field] !== baseline
        && desired[field] !== remote.draft[field]) conflicts.add(field)
    }
    remoteRef.current = remote.draft
    baselineVersionRef.current = remote.version
    const merged = { ...remote.draft }
    for (const field of dirtyFieldsRef.current) {
      (merged as Record<string, unknown>)[field] = desired[field]
    }
    publishDraft(merged)
    return conflicts
  }, [publishDraft])

  const acquireVersionAndSave = useCallback(async () => {
    const readRemote = loadRemoteRef.current
    if (!readRemote || runningRef.current || activeRef.current) {
      if (!readRemote && mountedRef.current) {
        failureRef.current = "definitive"
        setStatus("error")
        setError(new Error("A current Todo version is required before saving"))
      }
      return
    }
    runningRef.current = true
    const epoch = epochRef.current
    if (mountedRef.current) {
      setStatus("saving")
      setError(null)
    }
    try {
      const remote = await readRemote()
      if (epoch !== epochRef.current) return
      runningRef.current = false
      if (!isTodoRemoteSnapshot(remote)) {
        failureRef.current = "definitive"
        persistCurrent()
        if (mountedRef.current) {
          setStatus("error")
          setError(new Error("A current Todo version is required before saving"))
        }
        return
      }
      const conflicts = adoptFreshForIntent(remote)
      if (!conflicts) return
      if (conflicts.size > 0) {
        failureRef.current = "conflict"
        publishConflict(conflicts)
        persistCurrent()
        if (mountedRef.current) {
          setStatus("error")
          setRecoveredConflict(true)
        }
        return
      }
      if (!installFreshRequest(remote.version, null) && mountedRef.current) {
        setStatus("error")
        setError(new TypeError("The save request could not be prepared"))
      }
    } catch (cause) {
      if (epoch !== epochRef.current) return
      runningRef.current = false
      failureRef.current = "definitive"
      persistCurrent()
      if (mountedRef.current) {
        setStatus("error")
        setError(cause)
      }
    }
  }, [adoptFreshForIntent, installFreshRequest, persistCurrent, publishConflict])

  useEffect(() => {
    mountedRef.current = true
    epochRef.current += 1
    const stored = loadTodoJournal(id)
    const storedFields = new Set<TodoDraftField>(fieldsOf(stored?.patch ?? {}))
    const storedRequest = stored?.request ?? null
    const nextDraft = stored ? { ...initial, ...stored.patch } : initial
    const conflicts = new Set<TodoDraftField>(stored?.conflictFields ?? [])
    if (conflicts.size === 0 && storedRequest?.state === "conflict") {
      for (const field of storedFields) {
        const baseline = stored?.baseline[field]
        const sent = storedRequest.patch[field]
        if ((initial[field] !== baseline || (sent !== undefined && initial[field] !== sent))
          && nextDraft[field] !== initial[field]) conflicts.add(field)
      }
      if (conflicts.size === 0) for (const field of fieldsOf(storedRequest.patch)) conflicts.add(field)
    } else if (stored && !storedRequest && isPositiveTodoVersion(serverVersion)) {
      for (const field of storedFields) {
        if (initial[field] !== stored.baseline[field] && nextDraft[field] !== initial[field]) conflicts.add(field)
      }
    }
    const nextFailure: FailureKind = stored?.cleanupPending ? "definitive" : storedRequest
      ? storedRequest.state === "conflict" ? "conflict" : storedRequest.state === "failed" ? "definitive" : "ambiguous"
      : conflicts.size > 0 ? "conflict" : null
    remoteRef.current = initial
    draftRef.current = nextDraft
    baselineByFieldRef.current = { ...(stored?.baseline ?? {}) }
    baselineVersionRef.current = !storedRequest && isPositiveTodoVersion(serverVersion)
      ? serverVersion
      : isPositiveTodoVersion(stored?.baselineVersion)
        ? stored.baselineVersion
        : isPositiveTodoVersion(serverVersion) ? serverVersion : undefined
    dirtyFieldsRef.current = storedFields
    activeRef.current = storedRequest
    activeDurableRef.current = !!storedRequest
    cleanupPendingRef.current = !!stored?.cleanupPending
    cleanupSnapshotRef.current = null
    cleanupIntentFieldsRef.current = new Set(stored?.cleanupIntentFields ?? [])
    cleanupSaveRequestedRef.current = stored?.cleanupSaveRequested === true
    runningRef.current = false
    failureRef.current = nextFailure
    localRevisionRef.current = stored ? stored.revision : 0
    publishDraft(nextDraft)
    publishConflict(conflicts)
    setStatus(nextFailure ? "error" : storedFields.size > 0 ? "dirty" : "idle")
    setError(stored?.cleanupPending ? cleanupRecoveryError() : storedRequest ? recoveryError(storedRequest.state) : null)
    setRecoveredConflict(conflicts.size > 0 || nextFailure === "conflict")
    setCleanupPending(!!stored?.cleanupPending)

    if (!stored?.cleanupPending && storedRequest && new Set<TodoJournalRequest["state"]>(["prepared", "dispatched", "uncertain"]).has(storedRequest.state)) queueMicrotask(() => {
      if (mountedRef.current) void runActiveRef.current()
    })

    return () => {
      mountedRef.current = false
      epochRef.current += 1
    }
    // Item identity, not query-object churn, owns the draft lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const unsavedPatch = useCallback((): TodoDraftPatch => patchFor(dirtyFieldsRef.current, draftRef.current), [])

  const change = useCallback(<K extends keyof TodoEditableDraft>(field: K, value: TodoEditableDraft[K]) => {
    if (draftRef.current[field] === value) return
    const previousRevision = Math.max(1, localRevisionRef.current)
    const cleanupTarget = cleanupSnapshotRef.current?.draft ?? null
    const baselineTarget = cleanupTarget ?? remoteRef.current
    let active = activeRef.current
    if (!cleanupPendingRef.current && active && !activeDurableRef.current && !runningRef.current) {
      activeRef.current = null
      active = null
      failureRef.current = conflictFieldsRef.current.size > 0 ? "conflict" : null
      if (mountedRef.current) setError(null)
    }
    if (!dirtyFieldsRef.current.has(field)) {
      (baselineByFieldRef.current as Record<string, unknown>)[field] = baselineTarget[field]
    }
    localRevisionRef.current += 1
    publishDraft({ ...draftRef.current, [field]: value })
    if (cleanupPendingRef.current) {
      if (cleanupTarget && Object.is(value, cleanupTarget[field])) {
        cleanupIntentFieldsRef.current.delete(field)
        dirtyFieldsRef.current.delete(field)
        delete baselineByFieldRef.current[field]
      } else {
        cleanupIntentFieldsRef.current.add(field)
        dirtyFieldsRef.current.add(field)
      }
      publishConflict(new Set(conflictFieldsRef.current))
      persistCurrent()
      if (mountedRef.current) {
        setStatus("error")
        setError(cleanupRecoveryError())
      }
      return
    }
    if ((!active || failureRef.current === "definitive") && value === remoteRef.current[field]) {
      dirtyFieldsRef.current.delete(field)
      delete baselineByFieldRef.current[field]
    } else {
      dirtyFieldsRef.current.add(field)
    }
    publishConflict(new Set(conflictFieldsRef.current))

    if (active && failureRef.current === "definitive" && !runningRef.current) {
      const next = dirtyFieldsRef.current.size > 0 ? payloadFor(null) : null
      const retired = transitionTodoJournal(id, requestFingerprint(active), previousRevision, next)
      if (retired) {
        activeRef.current = null
        activeDurableRef.current = false
        failureRef.current = null
        setError(null)
        if (dirtyFieldsRef.current.size === 0) markClean("idle")
        else if (mountedRef.current) setStatus("dirty")
        return
      }
      if (dirtyFieldsRef.current.size === 0) {
        blockCleanup(active, knownSnapshot())
        return
      }
    }

    if (!active && dirtyFieldsRef.current.size === 0) {
      if (!clearTodoJournal(id, localRevisionRef.current)) {
        blockCleanup(null, knownSnapshot())
        return
      }
      failureRef.current = null
      if (mountedRef.current) {
        setStatus("idle")
        setError(null)
      }
      return
    }
    persistCurrent()
    if (mountedRef.current && !runningRef.current && !failureRef.current) setStatus("dirty")
  }, [blockCleanup, id, knownSnapshot, markClean, payloadFor, persistCurrent, publishConflict, publishDraft])

  const save = useCallback((patch: TodoDraftPatch) => {
    for (const field of fieldsOf(patch)) {
      const value = patch[field] as never
      if (draftRef.current[field] !== value) change(field, value)
    }
    if (cleanupPendingRef.current) {
      const target = cleanupSnapshotRef.current?.draft ?? null
      let metadataChanged = !cleanupSaveRequestedRef.current
      for (const field of fieldsOf(patch)) {
        const desired = draftRef.current[field]
        const shouldKeep = !target || !Object.is(desired, target[field])
        if (shouldKeep !== cleanupIntentFieldsRef.current.has(field)) metadataChanged = true
        if (shouldKeep) {
          cleanupIntentFieldsRef.current.add(field)
          if (!dirtyFieldsRef.current.has(field)) {
            (baselineByFieldRef.current as Record<string, unknown>)[field] = target ? target[field] : remoteRef.current[field]
          }
          dirtyFieldsRef.current.add(field)
        } else {
          cleanupIntentFieldsRef.current.delete(field)
          dirtyFieldsRef.current.delete(field)
          delete baselineByFieldRef.current[field]
        }
      }
      cleanupSaveRequestedRef.current = true
      if (metadataChanged) localRevisionRef.current += 1
      persistCurrent()
      void retryCleanup()
      return
    }
    if (dirtyFieldsRef.current.size === 0 && !activeRef.current) {
      if (clearTodoJournal(id, localRevisionRef.current)) markClean("idle")
      else blockCleanup(null, knownSnapshot())
      return
    }
    if (activeRef.current) {
      persistCurrent()
      if (!runningRef.current && failureRef.current !== "conflict") void runActiveRef.current()
      return
    }
    if (failureRef.current === "conflict" || conflictFieldsRef.current.size > 0) {
      persistCurrent()
      return
    }
    if (isPositiveTodoVersion(baselineVersionRef.current)) {
      installFreshRequest(baselineVersionRef.current, null)
    } else {
      void acquireVersionAndSave()
    }
  }, [acquireVersionAndSave, blockCleanup, change, id, installFreshRequest, knownSnapshot, markClean, persistCurrent, retryCleanup])

  const retry = useCallback(() => {
    const active = activeRef.current
    if (cleanupPendingRef.current) {
      void retryCleanup()
      return
    }
    if (runningRef.current || failureRef.current === "conflict") return
    if (active) {
      void runActiveRef.current()
      return
    }
    if (failureRef.current === "definitive" && dirtyFieldsRef.current.size > 0) {
      failureRef.current = null
      if (mountedRef.current) setError(null)
      if (isPositiveTodoVersion(baselineVersionRef.current)) {
        installFreshRequest(baselineVersionRef.current, null)
      } else {
        void acquireVersionAndSave()
      }
    }
  }, [acquireVersionAndSave, installFreshRequest, retryCleanup])

  const discard = useCallback(() => {
    epochRef.current += 1
    const active = activeRef.current
    if (!removeJournal(active)) {
      blockCleanup(active && activeDurableRef.current ? active : null, knownSnapshot(
        initial,
        isPositiveTodoVersion(serverVersion) ? serverVersion : undefined,
      ))
      return
    }
    remoteRef.current = initial
    baselineVersionRef.current = isPositiveTodoVersion(serverVersion) ? serverVersion : undefined
    localRevisionRef.current = 0
    markClean("idle")
    publishDraft(initial)
  }, [blockCleanup, initial, knownSnapshot, markClean, publishDraft, removeJournal, serverVersion])

  const replaceInitial = useCallback((next: TodoEditableDraft, nextVersion?: number) => {
    if (runningRef.current || activeRef.current) return
    const remote = { draft: next, version: nextVersion }
    if (!isPositiveTodoVersion(remote.version)) return
    const conflicts = adoptFreshForIntent(remote as TodoRemoteSnapshot)
    if (!conflicts) return
    publishConflict(conflicts)
    failureRef.current = conflicts.size > 0 ? "conflict" : null
    persistCurrent()
    if (mountedRef.current) {
      setStatus(conflicts.size > 0 ? "error" : dirtyFieldsRef.current.size > 0 ? "dirty" : "idle")
      setRecoveredConflict(conflicts.size > 0)
      setError(null)
    }
  }, [adoptFreshForIntent, persistCurrent, publishConflict])

  const reloadRemote = useCallback((remote: TodoRemoteSnapshot) => {
    if (!isTodoRemoteSnapshot(remote) || runningRef.current) return
    const active = activeRef.current
    if (!removeJournal(active)) {
      blockCleanup(active && activeDurableRef.current ? active : null, remote)
      return
    }
    remoteRef.current = remote.draft
    baselineVersionRef.current = remote.version
    localRevisionRef.current = 0
    markClean("idle")
    publishDraft(remote.draft)
  }, [blockCleanup, markClean, publishDraft, removeJournal])

  const rebaseRemote = useCallback((remote: TodoRemoteSnapshot) => {
    if (!isTodoRemoteSnapshot(remote) || runningRef.current) return
    const previousActive = activeRef.current
    const conflicts = adoptFreshForIntent(remote)
    if (!conflicts) return
    if (conflicts.size > 0) {
      failureRef.current = "conflict"
      publishConflict(conflicts)
      if (mountedRef.current) {
        setStatus("error")
        setError(null)
        setRecoveredConflict(true)
      }
      return
    }
    for (const field of dirtyFieldsRef.current) {
      (baselineByFieldRef.current as Record<string, unknown>)[field] = remote.draft[field]
    }
    if (!installFreshRequest(remote.version, previousActive, conflictFieldsRef.current.size > 0)) {
      if (previousActive && previousActive.state !== "conflict") failAtomicTransition(previousActive)
    }
  }, [adoptFreshForIntent, failAtomicTransition, installFreshRequest, publishConflict])

  const overwriteRemote = useCallback((remote: TodoRemoteSnapshot) => {
    if (!isTodoRemoteSnapshot(remote) || runningRef.current) return
    const previousActive = activeRef.current
    const desired = draftRef.current
    remoteRef.current = remote.draft
    baselineVersionRef.current = remote.version
    const merged = { ...remote.draft }
    for (const field of dirtyFieldsRef.current) {
      (merged as Record<string, unknown>)[field] = desired[field]
      ;(baselineByFieldRef.current as Record<string, unknown>)[field] = remote.draft[field]
    }
    publishDraft(merged)
    if (!installFreshRequest(remote.version, previousActive, conflictFieldsRef.current.size > 0)) {
      if (previousActive && previousActive.state !== "conflict") failAtomicTransition(previousActive)
    }
  }, [failAtomicTransition, installFreshRequest, publishConflict, publishDraft])

  const hasUnsaved = dirtyFieldsRef.current.size > 0
    || conflictFieldsRef.current.size > 0
    || !!activeRef.current
    || cleanupPending
    || runningRef.current
    || !!failureRef.current

  return {
    draft,
    status,
    error,
    recoveredConflict,
    conflictFields,
    change,
    save,
    retry,
    discard,
    replaceInitial,
    reloadRemote,
    rebaseRemote,
    overwriteRemote,
    unsavedPatch,
    cleanupPending,
    hasUnsaved,
    isAcknowledged: !hasUnsaved,
  }
}
