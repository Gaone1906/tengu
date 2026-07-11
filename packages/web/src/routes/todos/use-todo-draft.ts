import { useCallback, useEffect, useRef, useState } from "react"

export interface TodoEditableDraft {
  title: string
  body: string
  assignee: string | null
  department: string | null
  priority: number
}

export type TodoDraftPatch = Partial<TodoEditableDraft>
export type TodoSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

interface StoredDraft {
  revision: number
  draft: TodoEditableDraft
}

interface PendingSave {
  revision: number
  patch: TodoDraftPatch
}

const STORAGE_KEY = "jinn:todo-drafts:v1"

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

function readDrafts(): Record<string, StoredDraft> {
  if (typeof sessionStorage === "undefined") return {}
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, StoredDraft>
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function validStoredDraft(value: StoredDraft | undefined): value is StoredDraft {
  const draft = value?.draft
  return !!draft
    && Number.isInteger(value.revision)
    && value.revision > 0
    && typeof draft.title === "string"
    && typeof draft.body === "string"
    && (typeof draft.assignee === "string" || draft.assignee === null)
    && (typeof draft.department === "string" || draft.department === null)
    && typeof draft.priority === "number"
}

function loadStoredDraft(id: string): StoredDraft | null {
  const value = readDrafts()[id]
  return validStoredDraft(value) ? value : null
}

function persistStoredDraft(id: string, value: StoredDraft): void {
  if (typeof sessionStorage === "undefined") return
  try {
    const drafts = readDrafts()
    drafts[id] = value
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Storage can be unavailable in hardened/private contexts. The in-memory
    // revision queue remains authoritative for the current mount.
  }
}

function clearStoredDraft(id: string, throughRevision?: number): void {
  if (typeof sessionStorage === "undefined") return
  try {
    const drafts = readDrafts()
    const current = drafts[id]
    if (!current || (throughRevision != null && current.revision > throughRevision)) return
    delete drafts[id]
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // See persistStoredDraft: storage failure must never break editing.
  }
}

/**
 * Item-scoped revision queue. Only the latest local revision may become
 * acknowledged: edits made during an active request are coalesced against the
 * last acknowledged baseline, failures retain that latest diff for retry, and
 * a per-item session-storage journal recovers navigation/reload/unmount loss.
 */
export function useTodoDraft({
  id,
  initial,
  save: saveRemote,
}: {
  id: string
  initial: TodoEditableDraft
  save: (patch: TodoDraftPatch) => Promise<void>
}) {
  const recoveredAtMount = useRef<{ id: string; value: StoredDraft | null }>({ id, value: loadStoredDraft(id) })
  const recovered = recoveredAtMount.current.id === id ? recoveredAtMount.current.value : null
  const startingDraft = recovered?.draft ?? initial
  const startingRevision = recovered && !sameDraft(recovered.draft, initial) ? recovered.revision : 0

  const [draft, setDraftState] = useState(startingDraft)
  const [status, setStatus] = useState<TodoSaveStatus>(startingRevision > 0 ? "dirty" : "idle")
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef(startingDraft)
  const baselineRef = useRef(initial)
  const saveRef = useRef(saveRemote)
  const pendingRef = useRef<PendingSave | null>(null)
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

  useEffect(() => {
    mountedRef.current = true
    epochRef.current += 1
    const stored = loadStoredDraft(id)
    const hasRecovered = !!stored && !sameDraft(stored.draft, initial)
    const nextDraft = hasRecovered ? stored.draft : initial
    const nextRevision = hasRecovered ? stored.revision : 0
    if (!hasRecovered) clearStoredDraft(id)
    baselineRef.current = initial
    draftRef.current = nextDraft
    localRevisionRef.current = nextRevision
    acknowledgedRevisionRef.current = 0
    pendingRef.current = null
    runningRef.current = false
    failedRef.current = false
    setDraftState(nextDraft)
    setStatus(hasRecovered ? "dirty" : "idle")
    setError(null)

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
    if (Object.keys(patch).length === 0) {
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
      try {
        await saveRef.current(request.patch)
      } catch (cause) {
        if (epoch !== epochRef.current) return
        runningRef.current = false
        failedRef.current = true
        queueLatest()
        persistStoredDraft(id, { revision: localRevisionRef.current, draft: draftRef.current })
        if (mountedRef.current) {
          setStatus("error")
          setError(cause instanceof Error ? cause.message : "Couldn't save")
        }
        return
      }
      if (epoch !== epochRef.current) return

      baselineRef.current = { ...baselineRef.current, ...request.patch }
      acknowledgedRevisionRef.current = Math.max(acknowledgedRevisionRef.current, request.revision)

      // A save requested during transport may have been calculated against the
      // older baseline. Rebase it after every acknowledgement and keep only the
      // newest local revision.
      if (pendingRef.current) queueLatest()
    }

    runningRef.current = false
    const latestAcknowledged = acknowledgedRevisionRef.current === localRevisionRef.current
      && Object.keys(patchBetween(baselineRef.current, draftRef.current)).length === 0
    if (latestAcknowledged) clearStoredDraft(id, acknowledgedRevisionRef.current)
    else persistStoredDraft(id, { revision: localRevisionRef.current, draft: draftRef.current })
    if (mountedRef.current) setStatus(latestAcknowledged ? "saved" : "dirty")
  }, [id, queueLatest])

  const change = useCallback(<K extends keyof TodoEditableDraft>(field: K, value: TodoEditableDraft[K]) => {
    if (draftRef.current[field] === value) return
    const next = { ...draftRef.current, [field]: value }
    localRevisionRef.current += 1
    publishDraft(next)
    persistStoredDraft(id, { revision: localRevisionRef.current, draft: next })
    if (mountedRef.current && !runningRef.current && !failedRef.current) setStatus("dirty")
  }, [id, publishDraft])

  const save = useCallback((patch: TodoDraftPatch) => {
    const next = { ...draftRef.current, ...patch }
    if (!sameDraft(next, draftRef.current)) {
      localRevisionRef.current += 1
      publishDraft(next)
      persistStoredDraft(id, { revision: localRevisionRef.current, draft: next })
    }
    queueLatest()
    void drain()
  }, [drain, id, publishDraft, queueLatest])

  const retry = useCallback(() => {
    if (!failedRef.current) return
    failedRef.current = false
    if (mountedRef.current) setError(null)
    queueLatest()
    void drain()
  }, [drain, queueLatest])

  const discard = useCallback(() => {
    epochRef.current += 1
    pendingRef.current = null
    runningRef.current = false
    failedRef.current = false
    localRevisionRef.current = acknowledgedRevisionRef.current
    clearStoredDraft(id)
    publishDraft(baselineRef.current)
    if (mountedRef.current) {
      setStatus("idle")
      setError(null)
    }
  }, [id, publishDraft])

  const replaceInitial = useCallback((next: TodoEditableDraft) => {
    const clean = !runningRef.current
      && !failedRef.current
      && !pendingRef.current
      && Object.keys(patchBetween(baselineRef.current, draftRef.current)).length === 0
    if (!clean) return
    baselineRef.current = next
    draftRef.current = next
    acknowledgedRevisionRef.current = localRevisionRef.current
    clearStoredDraft(id, acknowledgedRevisionRef.current)
    if (mountedRef.current) {
      setDraftState(next)
      setStatus("idle")
      setError(null)
    }
  }, [id])

  const hasUnsaved = Object.keys(patchBetween(baselineRef.current, draftRef.current)).length > 0
    || !!pendingRef.current
    || runningRef.current
    || failedRef.current
  const isAcknowledged = !hasUnsaved
    && acknowledgedRevisionRef.current === localRevisionRef.current

  return {
    draft,
    status,
    error,
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
