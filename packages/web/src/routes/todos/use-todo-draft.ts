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

/**
 * Item-scoped, serialized draft queue. The draft is always updated before a
 * write begins, failed patches stay at the head of the queue, and an epoch
 * guard makes late responses from a previously-open Todo inert.
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
  const [draft, setDraftState] = useState(initial)
  const [status, setStatus] = useState<TodoSaveStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef(initial)
  const baselineRef = useRef(initial)
  const saveRef = useRef(saveRemote)
  const queueRef = useRef<TodoDraftPatch[]>([])
  const runningRef = useRef(false)
  const failedRef = useRef(false)
  const epochRef = useRef(0)

  saveRef.current = saveRemote

  useEffect(() => {
    epochRef.current += 1
    draftRef.current = initial
    baselineRef.current = initial
    queueRef.current = []
    runningRef.current = false
    failedRef.current = false
    setDraftState(initial)
    setStatus("idle")
    setError(null)
    // Identity, not background query object churn, owns a draft lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const publishDraft = useCallback((next: TodoEditableDraft) => {
    draftRef.current = next
    setDraftState(next)
  }, [])

  const drain = useCallback(async () => {
    if (runningRef.current || failedRef.current || queueRef.current.length === 0) return
    runningRef.current = true
    const epoch = epochRef.current
    setStatus("saving")
    setError(null)

    while (queueRef.current.length > 0) {
      const patch = queueRef.current[0]
      try {
        await saveRef.current(patch)
      } catch (cause) {
        if (epoch !== epochRef.current) return
        failedRef.current = true
        runningRef.current = false
        setStatus("error")
        setError(cause instanceof Error ? cause.message : "Couldn't save")
        return
      }
      if (epoch !== epochRef.current) return
      queueRef.current.shift()
      baselineRef.current = { ...baselineRef.current, ...patch }
    }

    runningRef.current = false
    setStatus("saved")
  }, [])

  const change = useCallback(<K extends keyof TodoEditableDraft>(field: K, value: TodoEditableDraft[K]) => {
    publishDraft({ ...draftRef.current, [field]: value })
    if (!runningRef.current && !failedRef.current) setStatus("dirty")
  }, [publishDraft])

  const save = useCallback((patch: TodoDraftPatch) => {
    publishDraft({ ...draftRef.current, ...patch })
    queueRef.current.push(patch)
    void drain()
  }, [drain, publishDraft])

  const retry = useCallback(() => {
    if (!failedRef.current) return
    failedRef.current = false
    setError(null)
    void drain()
  }, [drain])

  const unsavedPatch = useCallback((): TodoDraftPatch => {
    const patch: TodoDraftPatch = {}
    for (const key of Object.keys(draftRef.current) as (keyof TodoEditableDraft)[]) {
      if (draftRef.current[key] !== baselineRef.current[key]) {
        ;(patch as Record<string, unknown>)[key] = draftRef.current[key]
      }
    }
    return patch
  }, [])

  const discard = useCallback(() => {
    epochRef.current += 1
    queueRef.current = []
    runningRef.current = false
    failedRef.current = false
    publishDraft(baselineRef.current)
    setStatus("idle")
    setError(null)
  }, [publishDraft])

  const replaceInitial = useCallback((next: TodoEditableDraft) => {
    if (runningRef.current || failedRef.current || queueRef.current.length > 0) return
    baselineRef.current = next
    draftRef.current = next
    setDraftState(next)
    setStatus("idle")
    setError(null)
  }, [])

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
    hasUnsaved: Object.keys(unsavedPatch()).length > 0 || queueRef.current.length > 0,
  }
}
