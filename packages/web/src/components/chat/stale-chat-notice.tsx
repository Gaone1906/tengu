import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'

function formatIdleMinutes(minutes: number): string {
  const wholeMinutes = Math.max(0, Math.floor(minutes))
  if (wholeMinutes < 60) return `${wholeMinutes}m`
  const hours = Math.floor(wholeMinutes / 60)
  const remainder = wholeMinutes % 60
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`
}

export function StaleChatNotice({
  contextTokens,
  idleMinutes,
  onDismiss,
  onStartFresh,
}: {
  contextTokens: number
  idleMinutes: number
  onDismiss: () => void
  onStartFresh: () => Promise<void>
}) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startFresh = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      await onStartFresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start a fresh chat')
      setStarting(false)
    }
  }

  return (
    <div
      data-stale-chat-notice
      className="rounded-[var(--radius-xl)] bg-[var(--fill-tertiary)] p-[var(--space-4)] shadow-[var(--shadow-subtle)]"
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-secondary)]">
          <MessageSquarePlus size={18} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-balance text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            Start a fresh chat?
          </h2>
          <p className="mt-[var(--space-1)] text-pretty text-[length:var(--text-footnote)] leading-relaxed text-[var(--text-secondary)]">
            This thread is carrying a lot of context. Continue in a clean chat without losing the handoff.
          </p>
          <p className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] tabular-nums">
            {Math.round(contextTokens / 1_000)}k in context · idle {formatIdleMinutes(idleMinutes)}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {error}
        </p>
      )}

      <div className="mt-[var(--space-4)] flex flex-col-reverse gap-[var(--space-2)] sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onDismiss}
          disabled={starting}
          className="min-h-10 w-full cursor-pointer rounded-[var(--radius-md)] border-none bg-transparent px-[var(--space-4)] text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[background-color,scale] duration-150 hover:bg-[var(--fill-secondary)] active:scale-[0.96] disabled:cursor-default disabled:opacity-50 sm:w-auto"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={() => void startFresh()}
          disabled={starting}
          className="min-h-10 w-full cursor-pointer rounded-[var(--radius-md)] border-none bg-[var(--accent)] px-[var(--space-4)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[opacity,scale] duration-150 active:scale-[0.96] disabled:cursor-default disabled:opacity-60 sm:w-auto"
        >
          {starting ? 'Starting…' : 'Start fresh'}
        </button>
      </div>
    </div>
  )
}
