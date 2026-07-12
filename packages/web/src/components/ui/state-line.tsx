import { useEffect, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'

export type StateLineState = 'dispatched' | 'working' | 'waiting' | 'replied' | 'error'

interface StateLineProps {
  state: StateLineState
  dispatchedAt?: number
  repliedAt?: number
  label?: string
  className?: string
}

function elapsedMinutes(start: number | undefined, end: number): number | null {
  if (!start || !Number.isFinite(start)) return null
  return Math.max(0, Math.floor((end - start) / 60_000))
}

export function StateLine({ state, dispatchedAt, repliedAt, label, className = '' }: StateLineProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (state !== 'working' && state !== 'waiting') return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [state])

  const text = label ?? (state === 'dispatched'
    ? 'Delegated'
    : state === 'working'
      ? 'Working'
      : state === 'waiting'
        ? 'Waiting'
      : state === 'replied'
        ? 'Replied'
        : "Couldn't finish")
  const end = state === 'working' || state === 'waiting' ? now : repliedAt ?? now
  const minutes = state === 'working' || state === 'waiting' || state === 'replied' || state === 'error'
    ? elapsedMinutes(dispatchedAt, end)
    : null
  const tone = state === 'working'
    ? 'text-[var(--system-blue)]'
    : state === 'waiting'
      ? 'text-[var(--system-orange)]'
    : state === 'error'
      ? 'text-[var(--system-red)]'
      : 'text-[var(--text-tertiary)]'

  return (
    <span
      data-state-line={state}
      className={`inline-flex min-h-4 items-center gap-[6px] text-[length:var(--text-caption1)] font-[var(--weight-medium)] [font-variant-numeric:tabular-nums] ${tone} ${className}`}
    >
      {state === 'working' && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none"
        />
      )}
      {state === 'waiting' && (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--system-orange)]" />
      )}
      {state === 'dispatched' && (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--text-quaternary)]" />
      )}
      {state === 'replied' && <Check size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
      {state === 'error' && <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}
      <span>{text}{minutes !== null ? ` · ${minutes}m` : ''}</span>
    </span>
  )
}
