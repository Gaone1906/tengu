import { useCallback, useEffect, useRef, useState } from "react"
import { clearTodoJournal, loadTodoJournal, persistTodoJournal } from "./todo-private-state"

export interface TodoEditableDraft {
  title: string
  body: string
  assignee: string | null
  department: string | null
  priority: number
}

export type TodoDraftPatch = Partial<TodoEditableDraft>
export type TodoSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

interface PendingSave {
  revision: number
  patch: TodoDraftPatch
}

function sameDraft(a: TodoEditableDraft, b: TodoEditableDraft): boolean {
  return a.title === b.title
    && a.body === b.body
    && a.assignee === b.assignee
    && a.department === b.department
    && a.priority === b.priority
}

function patchBetween(from: TodoEditableDraft, to: TodoEditableDraft): TodoDraftPatch {
  const patch: TodoDraftPatch = {}
  for (const key of Object.keys(to) as (keyof TodoEditableDraft)[]) {
    if (from[key] !== to[key]) (patch as Record<string, unknown>)[key] = to[key]
  }
  return patch
}

function hasPatch(patch: TodoDraftPatch): boolean {
  return Object.keys(patch).length > 0
}

/**
 * Item-scoped revision queue. Recovery journals only the locally dirty field
 * patch, never a stale full server snapshot. A recovered patch overlays fresh
 * server data; same-field conflicts keep the unsaved local operator value
 * dirty while unrelated remote changes survive.
 */
export function useTodoDraft({
  id,
  initial,
  serverVersion,
  save: saveRemote,
}: {
  id: string
  initial: TodoEditableDraft
  serverVersion?: string
  save: (patch: TodoDraftPatch) => Promise<void>
}) {
  const recoveredAtMount = useRef({ id, value: loadTodoJournal(id) })
  const recovered = recoveredAtMount.current.id === id ? recoveredAtMount.current.value : null
  const startingDraft = recovered ? { ...initial, ...recovered.patch } : initial
  const startingRevision = recovered && hasPatch(recovered.patch) ? recovered.revision : 0
  const startingConflict = !!recovered?.baselineVersion
    && !!serverVersion
    && recovered.baselineVersion !== serverVersion
    && hasPatch(recovered.patch)

  const [draft, setDraftState] = useState(startingDraft)
  const [status, setStatus] = useState<TodoSaveStatus>(startingRevision > 0 ? "dirty" : "idle")
  const [error, setError] = useState<string | null>(null)
  const [recoveredConflict, setRecoveredConflict] = useState(startingConflict)
  const draftRef = useRef(startingDraft)
  const baselineRef = useRef(initial)
  const baselineVersionRef = useRef(recovered?.baselineVersion ?? serverVersion)
  const saveRef = useRef(saveRemote)
  const pendingRef = useRef<PendingSave | null>(null)
  const activeRef = useRef<PendingSave | null>(null)
  const runningRef = useRef(false)
  const failedRef = useRef(false)
  const localRevisionRef = useRef(startingRevision)
  const acknowledgedRevisionRef = useRef(0)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)

  saveRef.current = saveRemote

  const publishDraft = useCallback((next: TodoEditableDraft) => {
    draftRef.current = next
    if (mountedRef.current) setDraftState(next)
  }, [])

  const journalPatch = useCallback((): TodoDraftPatch => {
    const patch = patchBetween(baselineRef.current, draftRef.current)
    // While transport is unresolved, retain desired values for every field it
    // may mutate. This makes an edit-then-revert recoverable even if the first
    // request commits immediately before a reload.
    for (const field of Object.keys(activeRef.current?.patch ?? {}) as (keyof TodoEditableDraft)[]) {
      ;(patch as Record<string, unknown>)[field] = draftRef.current[field]
    }
    return patch
  }, [])

  const persistLatest = useCallback(() => {
    persistTodoJournal(id, {
      revision: localRevisionRef.current,
      patch: journalPatch(),
      baselineVersion: baselineVersionRef.current,
    })
  }, [id, journalPatch])

  const acknowledgeEmpty = useCallback((): boolean => {
    if (runningRef.current || pendingRef.current || failedRef.current) return false
    if (hasPatch(patchBetween(baselineRef.current, draftRef.current))) return false
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
    const hasRecovered = !!stored && hasPatch(stored.patch)
    const nextDraft = hasRecovered ? { ...initial, ...stored.patch } : initial
    const nextRevision = hasRecovered ? stored.revision : 0
    if (!hasRecovered) clearTodoJournal(id)
    baselineRef.current = initial
    baselineVersionRef.current = stored?.baselineVersion ?? serverVersion
    draftRef.current = nextDraft
    localRevisionRef.current = nextRevision
    acknowledgedRevisionRef.current = 0
    pendingRef.current = null
    activeRef.current = null
    runningRef.current = false
    failedRef.current = false
    setDraftState(nextDraft)
    setStatus(hasRecovered ? "dirty" : "idle")
    setError(null)
    setRecoveredConflict(!!stored?.baselineVersion
      && !!serverVersion
      && stored.baselineVersion !== serverVersion
      && hasRecovered)

    return () => {
      mountedRef.current = false
      epochRef.current += 1
    }
    // Identity, not background query object churn, owns a draft lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const unsavedPatch = useCallback((): TodoDraftPatch => patchBetween(baselineRef.current, draftRef.current), [])

  const queueLatest = useCallback(() => {
    const patch = patchBetween(baselineRef.current, draftRef.current)
    if (!hasPatch(patch)) {
      pendingRef.current = null
      return
    }
    pendingRef.current = { revision: localRevisionRef.current, patch }
  }, [])

  const drain = useCallback(async () => {
    if (runningRef.current || failedRef.current || !pendingRef.current) return
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
      persistLatest()
      try {
        await saveRef.current(request.patch)
      } catch (cause) {
        if (epoch !== epochRef.current) return
        activeRef.current = null
        runningRef.current = false
        failedRef.current = true
        queueLatest()
        persistLatest()
        if (mountedRef.current) {
          setStatus("error")
          setError(cause instanceof Error ? cause.message : "Couldn't save")
        }
        return
      }
      if (epoch !== epochRef.current) return

      baselineRef.current = { ...baselineRef.current, ...request.patch }
      acknowledgedRevisionRef.current = Math.max(acknowledgedRevisionRef.current, request.revision)
      activeRef.current = null
      // Always rebase after acknowledgement: a local revert can be empty
      // against the old baseline yet require a compensating second request.
      queueLatest()
      if (pendingRef.current) persistLatest()
    }

    runningRef.current = false
    if (!acknowledgeEmpty()) {
      persistLatest()
      if (mountedRef.current) setStatus("dirty")
    } else if (mountedRef.current) {
      setStatus("saved")
    }
  }, [acknowledgeEmpty, persistLatest, queueLatest])

  const change = useCallback(<K extends keyof TodoEditableDraft>(field: K, value: TodoEditableDraft[K]) => {
    if (draftRef.current[field] === value) return
    const next = { ...draftRef.current, [field]: value }
    localRevisionRef.current += 1
    publishDraft(next)
    if (runningRef.current) queueLatest()
    if (!acknowledgeEmpty()) {
      persistLatest()
      if (mountedRef.current && !runningRef.current && !failedRef.current) setStatus("dirty")
    }
  }, [acknowledgeEmpty, persistLatest, publishDraft, queueLatest])

  const save = useCallback((patch: TodoDraftPatch) => {
    const next = { ...draftRef.current, ...patch }
    if (!sameDraft(next, draftRef.current)) {
      localRevisionRef.current += 1
      publishDraft(next)
    }
    queueLatest()
    if (acknowledgeEmpty()) return
    persistLatest()
    void drain()
  }, [acknowledgeEmpty, drain, persistLatest, publishDraft, queueLatest])

  const retry = useCallback(() => {
    if (!failedRef.current) return
    failedRef.current = false
    if (mountedRef.current) setError(null)
    queueLatest()
    if (acknowledgeEmpty()) return
    persistLatest()
    void drain()
  }, [acknowledgeEmpty, drain, persistLatest, queueLatest])

  const discard = useCallback(() => {
    epochRef.current += 1
    pendingRef.current = null
    activeRef.current = null
    runningRef.current = false
    failedRef.current = false
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
    const currentDraft = draftRef.current
    const localPatch = patchBetween(baselineRef.current, currentDraft)
    const merged = { ...next, ...localPatch }
    const versionConflict = hasPatch(localPatch)
      && !!baselineVersionRef.current
      && !!nextVersion
      && baselineVersionRef.current !== nextVersion
    baselineRef.current = next
    baselineVersionRef.current = nextVersion
    draftRef.current = merged
    const stillDirty = hasPatch(patchBetween(next, merged))
    if (stillDirty) persistLatest()
    else {
      acknowledgedRevisionRef.current = localRevisionRef.current
      clearTodoJournal(id, acknowledgedRevisionRef.current)
    }
    if (mountedRef.current) {
      if (!sameDraft(currentDraft, merged)) setDraftState(merged)
      setStatus(stillDirty ? "dirty" : "idle")
      setError(null)
      setRecoveredConflict((current) => current || versionConflict)
    }
  }, [id, persistLatest])

  const effectivePatch = patchBetween(baselineRef.current, draftRef.current)
  const hasUnsaved = hasPatch(effectivePatch)
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
    unsavedPatch,
    hasUnsaved,
    isAcknowledged,
  }
}
