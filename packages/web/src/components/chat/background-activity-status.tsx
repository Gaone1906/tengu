import { useEffect, useState } from 'react'
import type { BackgroundActivity, DelegatedActivity } from '@/lib/api'

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000
const EXIT_MS = 140

/** True when background work should be surfaced: streams active and the last
 *  activity is fresh (a stream that stopped reporting 5min ago is gone, not
 *  "still working"). Exported for tests. */
export function isBackgroundActivityVisible(
  activity: BackgroundActivity | null,
  nowMs: number,
): boolean {
  const n = activity?.activeStreams ?? 0
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  const stale = lastActivityAt > 0 && nowMs - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
  return n > 0 && !stale
}

interface ActivityCopy {
  kind: 'runtime' | 'delegated-one' | 'delegated-many' | 'delegated-generic'
  long: string
  short: string
  title: string
  count?: number
}

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function activityCopy(
  activity: BackgroundActivity | null,
  delegatedActivity: DelegatedActivity | null,
  employeeDisplayNames: Record<string, string>,
): ActivityCopy | null {
  const delegatedSessions = delegatedActivity?.activeSessions ?? 0
  if (delegatedSessions > 0) {
    const employees = delegatedActivity?.employees ?? []
    const title = `${delegatedSessions} delegated ${delegatedSessions === 1 ? 'task' : 'tasks'} still running`
    if (employees.length === 1) {
      const displayName = employeeDisplayNames[employees[0]] || titleCaseSlug(employees[0])
      return {
        kind: 'delegated-one',
        long: `${displayName} working`,
        short: `Working · ${displayName}`,
        title,
      }
    }
    if (employees.length > 1) {
      return {
        kind: 'delegated-many',
        long: `${employees.length} employees working`,
        short: `${employees.length} working`,
        title,
        count: employees.length,
      }
    }
    return {
      kind: 'delegated-generic',
      long: 'Delegated work in progress',
      short: 'Work in progress',
      title,
    }
  }

  if (!isBackgroundActivityVisible(activity, Date.now())) return null
  const count = activity?.activeStreams ?? 0
  return {
    kind: 'runtime',
    long: count === 1 ? '1 agent in background' : `${count} agents in background`,
    short: count === 1 ? '1 agent' : `${count} agents`,
    title: 'Background work running after the turn ended',
  }
}

/** Live `prefers-reduced-motion` flag; the fade collapses to an opacity swap. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduce(mq.matches)
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/**
 * Idle-but-busy StateLine for the composer toolbar: the session's turn ended
 * but subagents / background tasks are still making API calls. Rendered in the
 * toolbar's flexible middle (between two flex-1 spacers), so appearing and
 * disappearing move NOTHING — ambient state never shifts the page. Purely
 * informational (input stays live); the parent hides it while a foreground
 * turn streams (the "Thinking" indicator owns that) and in the CLI view.
 *
 * Orange is the system's background-work semantic (sidebar dot: blue =
 * foreground running, orange = background) — kept for cross-surface
 * consistency. Exit keeps the node mounted until the fade completes so
 * disappearance is a fade, not a pop.
 */
export function BackgroundActivityStatus({
  activity,
  delegatedActivity = null,
  employeeDisplayNames = {},
}: {
  activity: BackgroundActivity | null
  delegatedActivity?: DelegatedActivity | null
  employeeDisplayNames?: Record<string, string>
}) {
  const currentCopy = activityCopy(activity, delegatedActivity, employeeDisplayNames)
  const active = currentCopy !== null
  const [rendered, setRendered] = useState(active)
  const [entered, setEntered] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  // Copy shown while exiting is frozen so the label does not flash to an idle
  // value during the fade-out.
  const [shownCopy, setShownCopy] = useState<ActivityCopy | null>(currentCopy)

  useEffect(() => {
    if (currentCopy) {
      setRendered(true)
      setShownCopy(currentCopy)
      // Enter on the next frame so the initial off-state paints and the fade runs.
      const r = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(r)
    }
    setEntered(false)
    if (!rendered) return
    const timer = window.setTimeout(() => setRendered(false), reducedMotion ? 1 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [active, currentCopy?.kind, currentCopy?.long, currentCopy?.short, currentCopy?.title, reducedMotion, rendered])

  if (!rendered || !shownCopy) return null

  const renderLabel = (label: string) => {
    if (shownCopy.kind !== 'delegated-many' || shownCopy.count === undefined) return label
    const remainder = label.slice(String(shownCopy.count).length)
    return <><span data-activity-count className="tabular-nums">{shownCopy.count}</span>{remainder}</>
  }

  return (
    <span
      role="status"
      title={shownCopy.title}
      data-testid="background-activity-status"
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)]"
      style={{
        opacity: entered ? 1 : 0,
        transform: reducedMotion ? undefined : entered ? 'translateY(0)' : 'translateY(2px)',
        transition: reducedMotion
          ? 'opacity 1ms linear'
          : `opacity ${entered ? 160 : EXIT_MS}ms var(--ease-smooth), transform ${entered ? 160 : EXIT_MS}ms var(--ease-smooth)`,
      }}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-orange)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" />
      <span className="hidden min-w-0 truncate sm:inline">{renderLabel(shownCopy.long)}</span>
      <span className="min-w-0 truncate sm:hidden">{renderLabel(shownCopy.short)}</span>
    </span>
  )
}
