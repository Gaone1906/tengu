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

const FIELDS = ["title", "body", "assignee", "department", "priority"] as const

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
  const startingConflicts = new Set<TodoDraftField>()
  if (recoveredRequest?.state === "conflict") {
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

  const startingFailure: FailureKind = recoveredRequest
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
    recoveredRequest ? recoveryError(recoveredRequest.state) : null,
  )
  const [recoveredConflict, setRecoveredConflict] = useState(startingConflicts.size > 0 || startingFailure === "conflict")
  const [conflictFields, setConflictFields] = useState<TodoDraftField[]>([...startingConflicts])

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
  const runningRef = useRef(false)
  const failureRef = useRef<FailureKind>(startingFailure)
  const localRevisionRef = useRef(recoveredFields.size > 0 ? recovered?.revision ?? 1 : 0)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)
  const saveRef = useRef(saveRemote)
  const loadRemoteRef = useRef(loadRemote)
  const runActiveRef = useRef<() => Promise<void>>(async () => undefined)

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

  const persistedFields = useCallback((active = activeRef.current): Set<TodoDraftField> => new Set([
    ...dirtyFieldsRef.current,
    ...fieldsOf(active?.patch ?? {}),
  ]), [])

  const payloadFor = useCallback((active = activeRef.current): TodoJournalPayload | null => {
    const fields = persistedFields(active)
    if (fields.size === 0 && !active) return null
    const version = active?.expectedVersion ?? baselineVersionRef.current
    return {
      revision: Math.max(1, localRevisionRef.current),
      patch: patchFor(fields, draftRef.current),
      baseline: baselineFor(fields, baselineByFieldRef.current, remoteRef.current),
      baselineVersion: version,
      uncertainFields: active?.state === "uncertain" ? fieldsOf(active.patch) : undefined,
      request: active ?? undefined,
    }
  }, [persistedFields])

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

  const localPersistenceError = useCallback((request: TodoJournalRequest, preserveConflict: boolean) => {
    activeRef.current = request
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
    runningRef.current = false
    failureRef.current = null
    dirtyFieldsRef.current.clear()
    baselineByFieldRef.current = {}
    publishConflict(new Set())
    if (mountedRef.current) {
      setError(null)
      setStatus(nextStatus)
      setRecoveredConflict(false)
    }
  }, [publishConflict])

  const failAtomicTransition = useCallback((request: TodoJournalRequest) => {
    activeRef.current = { ...request, state: "uncertain" }
    runningRef.current = false
    failureRef.current = "ambiguous"
    if (mountedRef.current) {
      setStatus("error")
      setError(new TypeError("The save result could not be committed locally"))
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
      if (previousActive) {
        if (!transitionActive(previousActive, null)) return false
      } else {
        clearTodoJournal(id, localRevisionRef.current)
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
    const nextPayload = payloadFor(nextRequest)
    if (!nextPayload) return false
    const installed = previousActive
      ? transitionActive(previousActive, nextPayload)
      : (persistTodoJournal(id, nextPayload), true)
    const durable = installed
      ? durableRequest(nextRequest, new Set<TodoJournalRequest["state"]>(["prepared"]))
      : null
    if (!durable) {
      if (previousActive?.state === "conflict") {
        localPersistenceError(previousActive, true)
      } else {
        localPersistenceError(nextRequest, false)
      }
      return false
    }
    activeRef.current = nextRequest
    failureRef.current = null
    if (!retainConflict) publishConflict(new Set())
    if (mountedRef.current) {
      setError(null)
      setStatus("saving")
      if (!retainConflict) setRecoveredConflict(false)
    }
    void runActiveRef.current()
    return true
  }, [durableRequest, id, localPersistenceError, markClean, payloadFor, publishConflict, transitionActive])

  const settleSuccessfulRequest = useCallback((request: TodoJournalRequest, result: TodoSaveResult) => {
    const { remote } = result
    if (!isTodoRemoteSnapshot(remote)) {
      failAtomicTransition(request)
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
      const nextPayload = payloadFor(conflictRequest)
      if (!nextPayload || !transitionActive(request, nextPayload)) {
        failAtomicTransition(request)
        return
      }
      activeRef.current = conflictRequest
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

    publishConflict(new Set())
    runningRef.current = false
    if (!installFreshRequest(remote.version, request)) failAtomicTransition(request)
  }, [failAtomicTransition, installFreshRequest, payloadFor, publishConflict, publishDraft, transitionActive])

  const runActive = useCallback(async () => {
    const request = activeRef.current
    if (!request || runningRef.current || request.state === "conflict") return
    runningRef.current = true
    const epoch = epochRef.current
    if (request.state === "prepared"
      && !durableRequest(request, new Set<TodoJournalRequest["state"]>(["prepared"]))) {
      activeRef.current = request
      persistCurrent()
      if (!durableRequest(request, new Set<TodoJournalRequest["state"]>(["prepared"]))) {
        localPersistenceError(request, false)
        return
      }
    }
    const dispatched: TodoJournalRequest = request.state === "uncertain"
      ? request
      : { ...request, state: "dispatched" }
    activeRef.current = dispatched
    persistCurrent()
    const durable = durableRequest(dispatched, new Set<TodoJournalRequest["state"]>([dispatched.state]))
    if (!durable) {
      const stored = loadTodoJournal(id)?.request
      localPersistenceError(stored && sameRequest(stored, request) ? stored : request, false)
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
      activeRef.current = { ...request, state }
      runningRef.current = false
      failureRef.current = conflict ? "conflict" : ambiguous ? "ambiguous" : "definitive"
      if (conflict) publishConflict(new Set(fieldsOf(request.patch)))
      persistCurrent()
      if (mountedRef.current) {
        setStatus("error")
        setError(cause)
        setRecoveredConflict(conflict || conflictFieldsRef.current.size > 0)
      }
    }
  }, [durableRequest, id, localPersistenceError, persistCurrent, publishConflict, settleSuccessfulRequest])
  runActiveRef.current = runActive

  const adoptFreshForIntent = useCallback((remote: TodoRemoteSnapshot): Set<TodoDraftField> | null => {
    if (!isPositiveTodoVersion(remote.version)) return null
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
    const conflicts = new Set<TodoDraftField>()
    if (storedRequest?.state === "conflict") {
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
    const nextFailure: FailureKind = storedRequest
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
    runningRef.current = false
    failureRef.current = nextFailure
    localRevisionRef.current = storedFields.size > 0 ? stored?.revision ?? 1 : 0
    publishDraft(nextDraft)
    publishConflict(conflicts)
    setStatus(nextFailure ? "error" : storedFields.size > 0 ? "dirty" : "idle")
    setError(storedRequest ? recoveryError(storedRequest.state) : null)
    setRecoveredConflict(conflicts.size > 0 || nextFailure === "conflict")

    if (storedRequest && new Set<TodoJournalRequest["state"]>(["prepared", "dispatched", "uncertain"]).has(storedRequest.state)) queueMicrotask(() => {
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
    const active = activeRef.current
    if (!dirtyFieldsRef.current.has(field)) {
      (baselineByFieldRef.current as Record<string, unknown>)[field] = remoteRef.current[field]
    }
    localRevisionRef.current += 1
    publishDraft({ ...draftRef.current, [field]: value })
    if ((!active || failureRef.current === "definitive") && value === remoteRef.current[field]) {
      dirtyFieldsRef.current.delete(field)
      conflictFieldsRef.current.delete(field)
      delete baselineByFieldRef.current[field]
    } else {
      dirtyFieldsRef.current.add(field)
      if (value === remoteRef.current[field]) conflictFieldsRef.current.delete(field)
    }
    publishConflict(new Set(conflictFieldsRef.current))

    if (active && failureRef.current === "definitive" && !runningRef.current) {
      const next = dirtyFieldsRef.current.size > 0 ? payloadFor(null) : null
      const retired = transitionTodoJournal(id, requestFingerprint(active), previousRevision, next)
      if (retired) {
        activeRef.current = null
        failureRef.current = null
        setError(null)
        if (dirtyFieldsRef.current.size === 0) markClean("idle")
        else if (mountedRef.current) setStatus("dirty")
        return
      }
    }

    if (!active && dirtyFieldsRef.current.size === 0) {
      clearTodoJournal(id, localRevisionRef.current)
      failureRef.current = null
      if (mountedRef.current) {
        setStatus("idle")
        setError(null)
      }
      return
    }
    persistCurrent()
    if (mountedRef.current && !runningRef.current && !failureRef.current) setStatus("dirty")
  }, [id, markClean, payloadFor, persistCurrent, publishConflict, publishDraft])

  const save = useCallback((patch: TodoDraftPatch) => {
    for (const field of fieldsOf(patch)) {
      const value = patch[field] as never
      if (draftRef.current[field] !== value) change(field, value)
    }
    if (dirtyFieldsRef.current.size === 0 && !activeRef.current) {
      markClean("idle")
      clearTodoJournal(id, localRevisionRef.current)
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
  }, [acquireVersionAndSave, change, id, installFreshRequest, markClean, persistCurrent])

  const retry = useCallback(() => {
    const active = activeRef.current
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
  }, [acquireVersionAndSave, installFreshRequest])

  const discard = useCallback(() => {
    epochRef.current += 1
    const active = activeRef.current
    if (active) transitionActive(active, null)
    else clearTodoJournal(id)
    remoteRef.current = initial
    baselineVersionRef.current = isPositiveTodoVersion(serverVersion) ? serverVersion : undefined
    localRevisionRef.current = 0
    markClean("idle")
    publishDraft(initial)
  }, [id, initial, markClean, publishDraft, serverVersion, transitionActive])

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
    if (!isPositiveTodoVersion(remote.version) || runningRef.current) return
    const active = activeRef.current
    if (active && !transitionActive(active, null)) return
    if (!active) clearTodoJournal(id)
    remoteRef.current = remote.draft
    baselineVersionRef.current = remote.version
    localRevisionRef.current = 0
    markClean("idle")
    publishDraft(remote.draft)
  }, [id, markClean, publishDraft, transitionActive])

  const rebaseRemote = useCallback((remote: TodoRemoteSnapshot) => {
    if (!isPositiveTodoVersion(remote.version) || runningRef.current) return
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
    if (!installFreshRequest(remote.version, previousActive, !!previousActive)) {
      if (previousActive && previousActive.state !== "conflict") failAtomicTransition(previousActive)
    }
  }, [adoptFreshForIntent, failAtomicTransition, installFreshRequest, publishConflict])

  const overwriteRemote = useCallback((remote: TodoRemoteSnapshot) => {
    if (!isPositiveTodoVersion(remote.version) || runningRef.current) return
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
    if (!installFreshRequest(remote.version, previousActive, !!previousActive)) {
      if (previousActive && previousActive.state !== "conflict") failAtomicTransition(previousActive)
    }
  }, [failAtomicTransition, installFreshRequest, publishConflict, publishDraft])

  const hasUnsaved = dirtyFieldsRef.current.size > 0
    || conflictFieldsRef.current.size > 0
    || !!activeRef.current
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
    hasUnsaved,
    isAcknowledged: !hasUnsaved,
  }
}
