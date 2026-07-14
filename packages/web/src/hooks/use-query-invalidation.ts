
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGateway } from '@/hooks/use-gateway'
import { queryKeys } from '@/lib/query-keys'
import { patchSessionBackgroundActivity, removeFromSessionsCache } from '@/hooks/use-sessions'
import { mergeTodoIntoCaches } from '@/routes/todos/todo-edit-request'
import type { BackgroundActivity } from '@/lib/api'

/** The one company mutation event (Todo, Workflow definition, run, trigger). */
function handleCompanyChanged(
  qc: ReturnType<typeof useQueryClient>,
  p: Record<string, unknown>,
): void {
  const entity = typeof p.entity === 'string' ? p.entity : ''
  const id = typeof p.id === 'string' ? p.id : ''
  if (entity === 'todo') {
    // Apply the safe version-aware patch synchronously; an older event can never
    // overwrite a newer cached revision. Absent value → refetch the smallest keys.
    const value = p.value
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string') {
      mergeTodoIntoCaches(qc, value as { id: string; version?: number })
    } else if (id) {
      qc.invalidateQueries({ queryKey: ['work-items'] })
      qc.invalidateQueries({ queryKey: ['work-item', id] })
    }
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
  } else if (entity === 'workflow-trigger') {
    const workflowId = typeof p.workflowId === 'string' ? p.workflowId : ''
    qc.invalidateQueries({ queryKey: queryKeys.workflows.triggers })
    if (workflowId) qc.invalidateQueries({ queryKey: queryKeys.workflows.definition(workflowId) })
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
  const { subscribe } = useGateway()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const unsub = subscribe((event: string, payload: unknown) => {
      const p = payload as Record<string, unknown> | undefined

      switch (event) {
        case 'notes:changed':
          qc.invalidateQueries({ queryKey: queryKeys.notes.all })
          if (typeof p?.path === 'string' && p.path) {
            qc.invalidateQueries({ queryKey: queryKeys.notes.document(p.path) })
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
          if (p) handleCompanyChanged(qc, p)
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
          if (p?.sessionId) {
            patchSessionBackgroundActivity(
              qc,
              p.sessionId as string,
              (p.backgroundActivity as BackgroundActivity | null) ?? null,
              typeof p.transportState === 'string' ? p.transportState : undefined,
            )
          }
          return
        case 'session:completed':
        case 'session:error':
          pendingRef.current.add('sessions')
          pendingRef.current.add('work-item-sessions')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'cron:completed':
        case 'cron:error':
          pendingRef.current.add('cron')
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

      // Debounce: flush pending invalidations after 1000ms of quiet
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        for (const key of pendingRef.current) {
          switch (key) {
            case 'sessions':
              qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
              break
            case 'work-item-sessions':
              qc.invalidateQueries({ queryKey: ['work-item-sessions'] })
              break
            case 'cron':
              qc.invalidateQueries({ queryKey: queryKeys.cron.all })
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
        pendingRef.current.clear()
      }, 1000)
    })

    return () => {
      unsub()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [subscribe, qc])
}
