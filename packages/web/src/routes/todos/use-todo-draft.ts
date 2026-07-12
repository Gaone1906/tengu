import { useCallback, useEffect, useRef, useState } from "react"
import {
  clearTodoJournal,
  loadTodoJournal,
  persistTodoJournal,
  type TodoDraftField,
} from "./todo-private-state"
import { isTodoVersionConflictError } from "@/lib/todos"

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
  version?: string
}

interface PendingSave {
  revision: number
  patch: TodoDraftPatch
}

const FIELDS = ["title", "body", "assignee", "department", "priority"] as const

function sameDraft(a: TodoEditableDraft, b: TodoEditableDraft): boolean {
  return FIELDS.every((field) => a[field] === b[field])
}

function patchFor(fields: Iterable<TodoDraftField>, draft: TodoEditableDraft): TodoDraftPatch {
  const patch: TodoDraftPatch = {}
  for (const field of fields) (patch as Record<string, unknown>)[field] = draft[field]
  return patch
}

function baselineFor(fields: Iterable<TodoDraftField>, baselines: Partial<TodoEditableDraft>, fallback: TodoEditableDraft): TodoDraftPatch {
  const patch: TodoDraftPatch = {}
  for (const field of fields) {
    const value = Object.prototype.hasOwnProperty.call(baselines, field)
      ? baselines[field]
      : fallback[field]
    ;(patch as Record<string, unknown>)[field] = value
  }
  return patch
}

function fieldsOf(patch: TodoDraftPatch): TodoDraftField[] {
  return Object.keys(patch) as TodoDraftField[]
}

function isAmbiguousTransportFailure(cause: unknown): boolean {
  return cause instanceof TypeError
    || (typeof DOMException !== "undefined"
      && cause instanceof DOMException
      && (cause.name === "AbortError" || cause.name === "NetworkError"))
}

/**
 * Item-scoped revision queue with explicit local intent. Dirty fields carry
 * their own baselines, and fields from a request whose response was lost stay
 * uncertain until a fresh server read confirms or compensates them.
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
  serverVersion?: string
  save: (patch: TodoDraftPatch) => Promise<void>
  loadRemote?: () => Promise<TodoRemoteSnapshot>
}) {
  const recoveredAtMount = useRef({ id, value: loadTodoJournal(id) })
  const recovered = recoveredAtMount.current.id === id ? recoveredAtMount.current.value : null
  const recoveredFields = new Set<TodoDraftField>(fieldsOf(recovered?.patch ?? {}))
  const recoveredUncertainFields = new Set<TodoDraftField>(recovered?.uncertainFields ?? [])
  const startingDraft = recovered ? { ...initial, ...recovered.patch } : initial
  const startingConflicts = new Set<TodoDraftField>()
  if (recovered && recovered.baselineVersion && serverVersion && recovered.baselineVersion !== serverVersion) {
    for (const field of recoveredFields) {
      if (!recoveredUncertainFields.has(field)
        && field in recovered.baseline
        && initial[field] !== recovered.baseline[field]) startingConflicts.add(field)
    }
  }

  const [draft, setDraftState] = useState(startingDraft)
  const [status, setStatus] = useState<TodoSaveStatus>(recoveredUncertainFields.size > 0 ? "error" : recoveredFields.size > 0 ? "dirty" : "idle")
  const [error, setError] = useState<unknown | null>(recoveredUncertainFields.size > 0 ? new Error("Couldn't confirm the previous save") : null)
  const [recoveredConflict, setRecoveredConflict] = useState(startingConflicts.size > 0)
  const draftRef = useRef(startingDraft)
  const baselineRef = useRef(initial)
  const baselineByFieldRef = useRef<Partial<TodoEditableDraft>>({ ...(recovered?.baseline ?? {}) })
  const baselineVersionRef = useRef(recovered?.baselineVersion ?? serverVersion)
  const dirtyFieldsRef = useRef(recoveredFields)
  const uncertainFieldsRef = useRef(recoveredUncertainFields)
  const conflictFieldsRef = useRef(startingConflicts)
  const saveRef = useRef(saveRemote)
  const loadRemoteRef = useRef(loadRemote)
  const pendingRef = useRef<PendingSave | null>(null)
  const activeRef = useRef<PendingSave | null>(null)
  const runningRef = useRef(false)
  const failedRef = useRef(recoveredUncertainFields.size > 0)
  const localRevisionRef = useRef(recoveredFields.size > 0 ? recovered?.revision ?? 1 : 0)
  const acknowledgedRevisionRef = useRef(0)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)

  saveRef.current = saveRemote
  loadRemoteRef.current = loadRemote

  const publishDraft = useCallback((next: TodoEditableDraft) => {
    draftRef.current = next
    if (mountedRef.current) setDraftState(next)
  }, [])

  const outstandingFields = useCallback(() => new Set<TodoDraftField>([
    ...dirtyFieldsRef.current,
    ...uncertainFieldsRef.current,
  ]), [])

  const persistLatest = useCallback(() => {
    const fields = outstandingFields()
    if (fields.size === 0) return
    persistTodoJournal(id, {
      revision: Math.max(1, localRevisionRef.current),
      patch: patchFor(fields, draftRef.current),
      baseline: baselineFor(fields, baselineByFieldRef.current, baselineRef.current),
      baselineVersion: baselineVersionRef.current,
      uncertainFields: [...uncertainFieldsRef.current],
    })
  }, [id, outstandingFields])

  const acknowledgeIfClear = useCallback((): boolean => {
    if (runningRef.current || pendingRef.current || failedRef.current) return false
    if (dirtyFieldsRef.current.size > 0 || uncertainFieldsRef.current.size > 0 || conflictFieldsRef.current.size > 0) return false
    acknowledgedRevisionRef.current = localRevisionRef.current
    clearTodoJournal(id, acknowledgedRevisionRef.current)
    if (mountedRef.current) {
      setStatus("idle")
      setError(null)
    }
    return true
  }, [id])

  useEffect(() => {
    mountedRef.current = true
    epochRef.current += 1
    const stored = loadTodoJournal(id)
    const storedFields = new Set<TodoDraftField>(fieldsOf(stored?.patch ?? {}))
    const storedUncertainFields = new Set<TodoDraftField>(stored?.uncertainFields ?? [])
    const nextDraft = stored ? { ...initial, ...stored.patch } : initial
    const conflicts = new Set<TodoDraftField>()
    if (stored?.baselineVersion && serverVersion && stored.baselineVersion !== serverVersion) {
      for (const field of storedFields) {
        if (!storedUncertainFields.has(field)
          && field in stored.baseline
          && initial[field] !== stored.baseline[field]) conflicts.add(field)
      }
    }
    if (storedFields.size === 0) clearTodoJournal(id)
    baselineRef.current = initial
    baselineByFieldRef.current = { ...(stored?.baseline ?? {}) }
    baselineVersionRef.current = stored?.baselineVersion ?? serverVersion
    draftRef.current = nextDraft
    dirtyFieldsRef.current = storedFields
    uncertainFieldsRef.current = storedUncertainFields
    conflictFieldsRef.current = conflicts
    localRevisionRef.current = storedFields.size > 0 ? stored?.revision ?? 1 : 0
    acknowledgedRevisionRef.current = 0
    pendingRef.current = null
    activeRef.current = null
    runningRef.current = false
    failedRef.current = storedUncertainFields.size > 0
    setDraftState(nextDraft)
    setStatus(storedUncertainFields.size > 0 ? "error" : storedFields.size > 0 ? "dirty" : "idle")
    setError(storedUncertainFields.size > 0 ? new Error("Couldn't confirm the previous save") : null)
    setRecoveredConflict(conflicts.size > 0)

    return () => {
      mountedRef.current = false
      epochRef.current += 1
    }
    // Identity, not background query object churn, owns a draft lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const unsavedPatch = useCallback((): TodoDraftPatch => patchFor(outstandingFields(), draftRef.current), [outstandingFields])

  const queueLatest = useCallback(() => {
    if (conflictFieldsRef.current.size > 0) {
      pendingRef.current = null
      return
    }
    const fields = outstandingFields()
    if (fields.size === 0) {
      pendingRef.current = null
      return
    }
    pendingRef.current = { revision: localRevisionRef.current, patch: patchFor(fields, draftRef.current) }
  }, [outstandingFields])

  const settleAcknowledgedFields = useCallback((request: PendingSave) => {
    for (const field of fieldsOf(request.patch)) {
      const sent = request.patch[field] as never
      baselineRef.current = { ...baselineRef.current, [field]: sent }
      uncertainFieldsRef.current.delete(field)
      if (draftRef.current[field] === sent) {
        dirtyFieldsRef.current.delete(field)
        delete baselineByFieldRef.current[field]
      } else {
        dirtyFieldsRef.current.add(field)
        ;(baselineByFieldRef.current as Record<string, unknown>)[field] = sent
      }
    }
    acknowledgedRevisionRef.current = Math.max(acknowledgedRevisionRef.current, request.revision)
  }, [])

  const drain = useCallback(async () => {
    if (runningRef.current || failedRef.current || !pendingRef.current || conflictFieldsRef.current.size > 0) return
    runningRef.current = true
    const epoch = epochRef.current
    if (mountedRef.current) {
      setStatus("saving")
      setError(null)
    }

    while (pendingRef.current) {
      const request = pendingRef.current
      pendingRef.current = null
      activeRef.current = request
      // A tab can disappear before this Promise settles. Journal active fields
      // as transport-uncertain before dispatch; a definitive response clears
      // the marker below.
      for (const field of fieldsOf(request.patch)) uncertainFieldsRef.current.add(field)
      persistLatest()
      try {
        await saveRef.current(request.patch)
      } catch (cause) {
        if (epoch !== epochRef.current) return
        const versionConflict = isTodoVersionConflictError(cause)
        if (isAmbiguousTransportFailure(cause)) {
          for (const field of fieldsOf(request.patch)) {
            uncertainFieldsRef.current.add(field)
            dirtyFieldsRef.current.add(field)
          }
        } else {
          for (const field of fieldsOf(request.patch)) uncertainFieldsRef.current.delete(field)
        }
        if (versionConflict) {
          for (const field of fieldsOf(request.patch)) conflictFieldsRef.current.add(field)
        }
        activeRef.current = null
        runningRef.current = false
        failedRef.current = !versionConflict
        queueLatest()
        persistLatest()
        if (mountedRef.current) {
          setStatus("error")
          setError(cause)
          setRecoveredConflict(versionConflict || conflictFieldsRef.current.size > 0)
        }
        return
      }
      if (epoch !== epochRef.current) return

      activeRef.current = null
      settleAcknowledgedFields(request)
      queueLatest()
      if (pendingRef.current) persistLatest()
    }

    runningRef.current = false
    if (!acknowledgeIfClear()) {
      persistLatest()
      if (mountedRef.current) setStatus("dirty")
    } else if (mountedRef.current) {
      setStatus("saved")
    }
  }, [acknowledgeIfClear, persistLatest, queueLatest, settleAcknowledgedFields])

  const change = useCallback(<K extends keyof TodoEditableDraft>(field: K, value: TodoEditableDraft[K]) => {
    if (draftRef.current[field] === value) return
    const wasClean = !dirtyFieldsRef.current.has(field) && !uncertainFieldsRef.current.has(field)
    if (wasClean) (baselineByFieldRef.current as Record<string, unknown>)[field] = baselineRef.current[field]
    const next = { ...draftRef.current, [field]: value }
    localRevisionRef.current += 1
    publishDraft(next)

    if (!uncertainFieldsRef.current.has(field) && value === baselineRef.current[field]) {
      dirtyFieldsRef.current.delete(field)
      conflictFieldsRef.current.delete(field)
      delete baselineByFieldRef.current[field]
    } else {
      dirtyFieldsRef.current.add(field)
    }
    setRecoveredConflict(conflictFieldsRef.current.size > 0)
    if (failedRef.current
      && !runningRef.current
      && dirtyFieldsRef.current.size === 0
      && uncertainFieldsRef.current.size === 0
      && conflictFieldsRef.current.size === 0) {
      pendingRef.current = null
      activeRef.current = null
      failedRef.current = false
      acknowledgedRevisionRef.current = localRevisionRef.current
      clearTodoJournal(id, acknowledgedRevisionRef.current)
      if (mountedRef.current) {
        setStatus("idle")
        setError(null)
      }
      return
    }
    if (runningRef.current) queueLatest()
    if (!acknowledgeIfClear()) {
      persistLatest()
      if (mountedRef.current && !runningRef.current && !failedRef.current) setStatus("dirty")
    }
  }, [acknowledgeIfClear, id, persistLatest, publishDraft, queueLatest])

  const save = useCallback((patch: TodoDraftPatch) => {
    const next = { ...draftRef.current, ...patch }
    if (!sameDraft(next, draftRef.current)) {
      for (const field of fieldsOf(patch)) {
        if (!dirtyFieldsRef.current.has(field) && !uncertainFieldsRef.current.has(field)) {
          ;(baselineByFieldRef.current as Record<string, unknown>)[field] = baselineRef.current[field]
        }
        dirtyFieldsRef.current.add(field)
      }
      localRevisionRef.current += 1
      publishDraft(next)
    }
    if (conflictFieldsRef.current.size > 0) {
      persistLatest()
      return
    }
    queueLatest()
    if (acknowledgeIfClear()) return
    persistLatest()
    void drain()
  }, [acknowledgeIfClear, drain, persistLatest, publishDraft, queueLatest])

  const reconcileAmbiguous = useCallback(async () => {
    const readRemote = loadRemoteRef.current
    if (!readRemote) return
    runningRef.current = true
    const epoch = epochRef.current
    if (mountedRef.current) {
      setStatus("saving")
      setError(null)
    }
    try {
      const preflight = await readRemote()
      if (epoch !== epochRef.current) return
      const intentFields = outstandingFields()
      const desired = patchFor(intentFields, draftRef.current)
      baselineRef.current = preflight.draft
      baselineVersionRef.current = preflight.version
      const rebased = { ...preflight.draft, ...desired }
      publishDraft(rebased)
      const compensationFields = [...intentFields].filter((field) => preflight.draft[field] !== rebased[field])
      if (compensationFields.length > 0) {
        const request: PendingSave = {
          revision: localRevisionRef.current,
          patch: patchFor(compensationFields, rebased),
        }
        activeRef.current = request
        persistLatest()
        await saveRef.current(request.patch)
        activeRef.current = null

        const confirmed = await readRemote()
        if (epoch !== epochRef.current) return
        for (const field of compensationFields) {
          if (confirmed.draft[field] !== request.patch[field]) throw new TypeError("save confirmation did not match")
        }
        baselineRef.current = confirmed.draft
        baselineVersionRef.current = confirmed.version
        const latest = draftRef.current
        const merged = { ...confirmed.draft }
        for (const field of outstandingFields()) (merged as Record<string, unknown>)[field] = latest[field]
        publishDraft(merged)
        settleAcknowledgedFields(request)
      } else {
        for (const field of intentFields) {
          if (preflight.draft[field] === rebased[field]) {
            dirtyFieldsRef.current.delete(field)
            uncertainFieldsRef.current.delete(field)
            delete baselineByFieldRef.current[field]
          }
        }
      }
      failedRef.current = false
      runningRef.current = false
      queueLatest()
      if (pendingRef.current) {
        persistLatest()
        void drain()
      } else if (!acknowledgeIfClear()) {
        persistLatest()
        if (mountedRef.current) setStatus("dirty")
      } else if (mountedRef.current) {
        setStatus("saved")
      }
    } catch (cause) {
      if (epoch !== epochRef.current) return
      for (const field of fieldsOf(activeRef.current?.patch ?? {})) uncertainFieldsRef.current.add(field)
      activeRef.current = null
      runningRef.current = false
      failedRef.current = true
      persistLatest()
      if (mountedRef.current) {
        setStatus("error")
        setError(cause)
      }
    }
  }, [acknowledgeIfClear, drain, outstandingFields, persistLatest, publishDraft, queueLatest, settleAcknowledgedFields])

  const retry = useCallback(() => {
    if (!failedRef.current) return
    if (uncertainFieldsRef.current.size > 0 && loadRemoteRef.current) {
      void reconcileAmbiguous()
      return
    }
    failedRef.current = false
    if (mountedRef.current) setError(null)
    queueLatest()
    if (acknowledgeIfClear()) return
    persistLatest()
    void drain()
  }, [acknowledgeIfClear, drain, persistLatest, queueLatest, reconcileAmbiguous])

  const discard = useCallback(() => {
    epochRef.current += 1
    pendingRef.current = null
    activeRef.current = null
    runningRef.current = false
    failedRef.current = false
    dirtyFieldsRef.current.clear()
    uncertainFieldsRef.current.clear()
    conflictFieldsRef.current.clear()
    baselineByFieldRef.current = {}
    localRevisionRef.current = acknowledgedRevisionRef.current
    clearTodoJournal(id)
    publishDraft(baselineRef.current)
    if (mountedRef.current) {
      setStatus("idle")
      setError(null)
      setRecoveredConflict(false)
    }
  }, [id, publishDraft])

  const replaceInitial = useCallback((next: TodoEditableDraft, nextVersion?: string) => {
    if (runningRef.current || failedRef.current || pendingRef.current) return
    const fields = outstandingFields()
    const currentDraft = draftRef.current
    const versionChanged = !!baselineVersionRef.current && !!nextVersion && baselineVersionRef.current !== nextVersion
    if (versionChanged) {
      for (const field of fields) {
        if (field in baselineByFieldRef.current && next[field] !== baselineByFieldRef.current[field]) {
          conflictFieldsRef.current.add(field)
        }
      }
    }
    baselineRef.current = next
    baselineVersionRef.current = nextVersion
    const merged = { ...next, ...patchFor(fields, currentDraft) }
    publishDraft(merged)
    for (const field of fields) {
      if (!uncertainFieldsRef.current.has(field) && merged[field] === next[field] && !conflictFieldsRef.current.has(field)) {
        dirtyFieldsRef.current.delete(field)
        delete baselineByFieldRef.current[field]
      }
    }
    const conflict = conflictFieldsRef.current.size > 0
    setRecoveredConflict(conflict)
    if (outstandingFields().size > 0) persistLatest()
    else {
      acknowledgedRevisionRef.current = localRevisionRef.current
      clearTodoJournal(id, acknowledgedRevisionRef.current)
    }
    if (mountedRef.current) {
      setStatus(outstandingFields().size > 0 ? "dirty" : "idle")
      setError(null)
    }
  }, [id, outstandingFields, persistLatest, publishDraft])

  const reloadRemote = useCallback((remote: TodoRemoteSnapshot) => {
    baselineRef.current = remote.draft
    baselineVersionRef.current = remote.version
    baselineByFieldRef.current = {}
    dirtyFieldsRef.current.clear()
    uncertainFieldsRef.current.clear()
    conflictFieldsRef.current.clear()
    pendingRef.current = null
    failedRef.current = false
    publishDraft(remote.draft)
    clearTodoJournal(id)
    if (mountedRef.current) {
      setRecoveredConflict(false)
      setStatus("idle")
      setError(null)
    }
  }, [id, publishDraft])

  const prepareOverwrite = useCallback((remote: TodoRemoteSnapshot) => {
    const fields = outstandingFields()
    const desired = patchFor(fields, draftRef.current)
    baselineRef.current = remote.draft
    baselineVersionRef.current = remote.version
    baselineByFieldRef.current = baselineFor(fields, {}, remote.draft)
    conflictFieldsRef.current.clear()
    const merged = { ...remote.draft, ...desired }
    publishDraft(merged)
    setRecoveredConflict(false)
    persistLatest()
    return patchFor(fields, merged)
  }, [outstandingFields, persistLatest, publishDraft])

  const hasUnsaved = dirtyFieldsRef.current.size > 0
    || uncertainFieldsRef.current.size > 0
    || conflictFieldsRef.current.size > 0
    || !!pendingRef.current
    || runningRef.current
    || failedRef.current
  const isAcknowledged = !hasUnsaved

  return {
    draft,
    status,
    error,
    recoveredConflict,
    change,
    save,
    retry,
    discard,
    replaceInitial,
    reloadRemote,
    prepareOverwrite,
    unsavedPatch,
    hasUnsaved,
    isAcknowledged,
  }
}
