
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGateway } from '@/hooks/use-gateway'
import { queryKeys, TODO_WRITE_KEY } from '@/lib/query-keys'
import { patchSessionBackgroundActivity, removeFromSessionsCache } from '@/hooks/use-sessions'
import { mergeTodoIntoCaches } from '@/routes/todos/todo-edit-request'
import type { BackgroundActivity, SessionsResponse } from '@/lib/api'
import { GATEWAY_EVENTS, type GatewayEvent } from '@jinn/gateway-events'

/** The one company mutation event (Todo, Workflow definition, run). */
function handleCompanyChanged(
  qc: ReturnType<typeof useQueryClient>,
  p: Record<string, unknown>,
  pending: Set<string>,
): void {
  const entity = typeof p.entity === 'string' ? p.entity : ''
  const id = typeof p.id === 'string' ? p.id : ''
  if (entity === 'todo') {
    // Apply the safe version-aware patch synchronously; an older event can never
    // overwrite a newer cached revision. The patch alone cannot insert a created
    // Todo or prove that it still belongs under the board's other filters, so
    // every todo event ALSO schedules the debounced reconciliation pass (ICI-570).
    const value = p.value
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string') {
      mergeTodoIntoCaches(qc, value as { id: string; version?: number })
    }
    pending.add('todos')
    if (id) pending.add(`todo:${id}`)
  } else if (entity === 'workflow-definition') {
    qc.invalidateQueries({ queryKey: queryKeys.workflows.all })
    if (id) qc.invalidateQueries({ queryKey: queryKeys.workflows.definition(id) })
  } else if (entity === 'workflow-run') {
    const workflowId = typeof p.workflowId === 'string' ? p.workflowId : ''
    const runId = typeof p.runId === 'string' ? p.runId : ''
    if (workflowId) {
      qc.invalidateQueries({ queryKey: queryKeys.workflows.runs(workflowId) })
      if (runId) qc.invalidateQueries({ queryKey: queryKeys.workflows.run(workflowId, runId) })
    }
  }
  // Loss recovery for the invoking transcript; normal session:delta stays the
  // surgical live path when the session is streaming.
  if (typeof p.sessionId === 'string' && p.sessionId) {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId) })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.transcript(p.sessionId) })
  }
}

/**
 * Subscribes to WebSocket events and invalidates React Query caches.
 * Mount once at app root (in client-providers.tsx).
 */
export function useQueryInvalidation() {
  const qc = useQueryClient()
  const { subscribe, connectionSeq } = useGateway()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())
  const scheduleFlushRef = useRef<() => void>(() => {})
  const previousConnectionSeqRef = useRef(connectionSeq)

  useEffect(() => {
    function clearTimers() {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      timerRef.current = null
      maxTimerRef.current = null
    }

    function flush() {
      clearTimers()
      // A Todo mutation (drag commit, editor save, approval decision) holds an
      // optimistic view of the todo caches — a refetch landing mid-flight could
      // clobber it. Defer ONLY the todo keys and retry after the next quiet
      // window; every other category flushes now.
      const deferTodos = qc.isMutating({ mutationKey: TODO_WRITE_KEY }) > 0
      const kept = new Set<string>()
      for (const key of pendingRef.current) {
        if (key === 'todos' || key.startsWith('todo:')) {
          if (deferTodos) {
            kept.add(key)
          } else if (key === 'todos') {
            qc.invalidateQueries({ queryKey: ['work-items'] })
            qc.invalidateQueries({ queryKey: ['work-item-tree'] })
            qc.invalidateQueries({ queryKey: ['departments'] })
          } else {
            const id = key.slice('todo:'.length)
            qc.invalidateQueries({ queryKey: ['work-item', id] })
            qc.invalidateQueries({ queryKey: ['work-item-comments', id] })
            qc.invalidateQueries({ queryKey: ['work-item-attachments', id] })
          }
          continue
        }
        if (key.startsWith('cron-run:')) {
          const jobId = key.slice('cron-run:'.length)
          qc.invalidateQueries({ queryKey: ['cron-runs', jobId] })
          qc.invalidateQueries({ queryKey: queryKeys.cron.all })
          qc.invalidateQueries({ queryKey: queryKeys.cron.jobs })
          continue
        }
        switch (key) {
          case 'sessions':
            qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
            break
          case 'work-item-sessions':
            qc.invalidateQueries({ queryKey: ['work-item-sessions'] })
            break
          case 'cron':
            // The cron routes query a raw ['cron-jobs'] key that ['cron'] does
            // not prefix-match, so the visible list needs its own invalidation.
            qc.invalidateQueries({ queryKey: queryKeys.cron.all })
            qc.invalidateQueries({ queryKey: queryKeys.cron.jobs })
            break
          case 'skills':
            qc.invalidateQueries({ queryKey: queryKeys.skills.all })
            break
          case 'org':
            qc.invalidateQueries({ queryKey: queryKeys.org.all })
            break
          case 'engines':
            qc.invalidateQueries({ queryKey: queryKeys.engines.all })
            break
          case 'config':
            qc.invalidateQueries({ queryKey: queryKeys.config })
            break
          case 'status':
            qc.invalidateQueries({ queryKey: queryKeys.status })
            break
          case 'instance-migration':
            qc.invalidateQueries({ queryKey: queryKeys.instanceMigration })
            break
        }
      }
      pendingRef.current = kept
      if (kept.size > 0) scheduleFlush()
    }

    function scheduleFlush() {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, 1000)
      if (!maxTimerRef.current) maxTimerRef.current = setTimeout(flush, 2000)
    }

    scheduleFlushRef.current = scheduleFlush
    const unsub = subscribe((frame: GatewayEvent) => {
      const { event, payload } = frame
      const p = payload as Record<string, unknown> | undefined

      switch (event) {
        case 'pins:changed':
          qc.invalidateQueries({ queryKey: queryKeys.pins })
          return
        case 'notes:changed':
          qc.invalidateQueries({ queryKey: queryKeys.notes.all })
          if (typeof p?.path === 'string' && p.path) {
            qc.invalidateQueries({ queryKey: queryKeys.notes.document(p.path) })
          }
          return
        case 'experiments:changed':
          qc.invalidateQueries({ queryKey: ['experiments'] })
          if (typeof p?.id === 'string' && p.id) {
            qc.invalidateQueries({ queryKey: ['experiments', p.id] })
          }
          return
        case 'session:started':
        case 'session:created':
          // A freshly created session (e.g. a delegated child) joins the same
          // list/linked-Todo caches as a started one.
          pendingRef.current.add('sessions')
          pendingRef.current.add('work-item-sessions')
          break
        case 'company:changed':
          if (p) handleCompanyChanged(qc, p, pendingRef.current)
          break
        case 'session:updated':
          pendingRef.current.add('sessions')
          pendingRef.current.add('work-item-sessions')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'session:deleted':
          // Drop it from the merged list now; merge-on-refetch would otherwise
          // keep it as a previously-loaded extra.
          if (p?.sessionId) removeFromSessionsCache(qc, [p.sessionId as string])
          pendingRef.current.add('sessions')
          pendingRef.current.add('work-item-sessions')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'session:background':
          // Surgical cache patch only — no invalidation/refetch storm. These
          // fire on every background-activity change (including cleared=null).
          // A delegated child is the exception: its runtime state contributes
          // to transitive parent summaries, so refresh the session collection
          // after the existing debounce. Top-level sessions stay patch-only.
          if (p?.sessionId) {
            const cached = qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)
            const changedSession = cached?.sessions.find((session) => session.id === p.sessionId)
            const hasParent = typeof changedSession?.parentSessionId === 'string' && changedSession.parentSessionId.length > 0
            patchSessionBackgroundActivity(
              qc,
              p.sessionId as string,
              (p.backgroundActivity as BackgroundActivity | null) ?? null,
              typeof p.transportState === 'string' ? p.transportState : undefined,
            )
            if (hasParent) {
              pendingRef.current.add('sessions')
              break
            }
          }
          return
        case 'session:completed':
        case GATEWAY_EVENTS.sessionStopped:
          pendingRef.current.add('sessions')
          pendingRef.current.add('work-item-sessions')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'cron:reloaded':
          pendingRef.current.add('cron')
          break
        case GATEWAY_EVENTS.cronRunFinished:
          pendingRef.current.add(`cron-run:${payload.jobId}`)
          break
        case 'skills:changed':
          pendingRef.current.add('skills')
          break
        case 'org:changed':
          // A turn (e.g. the onboarding genie hatching an employee) rewrote org/.
          // Refetch the org/employee list so the new employee shows in the sidebar
          // live, without a manual page refresh.
          pendingRef.current.add('org')
          break
        case 'config:reloaded':
          pendingRef.current.add('config')
          pendingRef.current.add('engines')
          pendingRef.current.add('status')
          pendingRef.current.add('instance-migration')
          break
        case 'engines:updated':
          pendingRef.current.add('engines')
          break
        default:
          return // No invalidation for unknown events
      }

      // Trailing quiet-window debounce with a hard ceiling: sustained gateway
      // traffic still reconciles pending caches every two seconds.
      scheduleFlush()
    })

    return () => {
      unsub()
      clearTimers()
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = () => {}
    }
  }, [subscribe, qc])

  useEffect(() => {
    if (connectionSeq === previousConnectionSeqRef.current) return
    previousConnectionSeqRef.current = connectionSeq
    pendingRef.current.add('todos')
    qc.invalidateQueries({ queryKey: queryKeys.workflows.all })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    scheduleFlushRef.current()
  }, [connectionSeq, qc])
}
