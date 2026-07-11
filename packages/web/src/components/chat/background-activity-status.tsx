import { useEffect, useState } from 'react'
import type { BackgroundActivity } from '@/lib/api'

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
}: {
  activity: BackgroundActivity | null
}) {
  const active = isBackgroundActivityVisible(activity, Date.now())
  const [rendered, setRendered] = useState(active)
  const [entered, setEntered] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  // Count shown while exiting: freeze the last active count so the label
  // doesn't flash "0 agents" during the fade-out.
  const [shownCount, setShownCount] = useState(activity?.activeStreams ?? 0)

  useEffect(() => {
    if (active) {
      setRendered(true)
      setShownCount(activity?.activeStreams ?? 0)
      // Enter on the next frame so the initial off-state paints and the fade runs.
      const r = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(r)
    }
    setEntered(false)
    if (!rendered) return
    const timer = window.setTimeout(() => setRendered(false), reducedMotion ? 1 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [active, activity?.activeStreams, reducedMotion, rendered])

  if (!rendered) return null

  const n = shownCount
  const long = n === 1 ? '1 agent in background' : `${n} agents in background`
  // Compact <sm form: the pulsing orange dot already carries "working in
  // background" (it's hidden during foreground turns), so count + noun is enough.
  const short = n === 1 ? '1 agent' : `${n} agents`

  return (
    <span
      role="status"
      title="Background work running after the turn ended"
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
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-orange)] animate-[jinn-pulse_1.4s_infinite]" />
      <span className="hidden min-w-0 truncate sm:inline">{long}</span>
      <span className="min-w-0 truncate sm:hidden">{short}</span>
    </span>
  )
}
