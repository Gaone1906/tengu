import type { Ref } from "react"

export function TodoQuickEditRetryActions({
  busy,
  error,
  onRetry,
  onDiscard,
  focusRef,
}: {
  busy: boolean
  error?: string | null
  onRetry: () => void
  onDiscard: () => void
  focusRef?: Ref<HTMLElement>
}) {
  return (
    <section
      ref={focusRef}
      tabIndex={-1}
      role="status"
      aria-label="Todo edit needs attention"
      aria-busy={busy}
      className="mb-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 shadow-[var(--shadow-subtle)] outline-none"
    >
      <div className="flex items-center gap-2 text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
        <span className="size-[7px] flex-none rounded-full bg-[var(--system-orange)]" aria-hidden />
        Local edit not saved
      </div>
      <p className="mt-2 text-pretty text-[length:var(--text-footnote)] leading-[1.48] text-[var(--text-secondary)]">
        Your edit is safely kept in this tab. Retry after the connection returns, or discard it to open the Todo without this change.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {error}
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-1 min-[420px]:grid-cols-2 md:flex md:justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={onRetry}
          aria-label={busy ? "Retrying save" : "Retry save"}
          className="min-h-11 rounded-full bg-[var(--accent-fill)] px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--accent)] transition-transform active:scale-[0.96] disabled:opacity-50"
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="min-h-11 rounded-full px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--system-red)] transition-[background-color,transform] hover:bg-[var(--fill-secondary)] active:scale-[0.96] disabled:opacity-50"
        >
          Discard local edit
        </button>
      </div>
    </section>
  )
}
