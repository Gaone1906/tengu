import type { CSSProperties } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'

/**
 * The chat's comms ledger line (T1): the one-line resting state for every
 * non-user voice in the thread — child-session callbacks and agent relays.
 * Anatomy: chip 18, name (12 medium secondary), truncated gist; the time and
 * a drill-in chevron fade in on hover only (iOS table-view idiom). The row is
 * a single tap target that opens the read-only report panel — there is no
 * expand-in-place any more.
 *
 * Arrival choreography (`arriving`): the thread makes room, the voice rises
 * in, the chip condenses from a blur, and a one-shot accent wash decays over
 * ~1.6s. Keyframes live in globals.css (`jinn-comm-*`); bursts stagger rows
 * via `--arrive-delay`.
 */

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

interface CommsLedgerRowProps {
  employee: string
  displayName: string
  /** Collapsed one-line gist — the actual signal. */
  hint: string
  /** Clock time, revealed on hover. */
  time: string
  /** Error tone: red name + warning triangle + red-tinted gist. */
  error?: boolean
  /** Relay-chain depth badge, only when the chain runs deeper than one hop. */
  hopBadge?: string
  /** Burst-body rows sit denser (min-h 30). */
  dense?: boolean
  /** Play the arrival choreography (new live rows only). */
  arriving?: boolean
  /** Stagger offset within a burst (+90ms per row). */
  arrivalDelayMs?: number
  ariaLabel: string
  stateAttr: string
  sourceId?: string
  onOpen?: () => void
}

export function CommsLedgerRow({
  employee,
  displayName,
  hint,
  time,
  error,
  hopBadge,
  dense,
  arriving,
  arrivalDelayMs,
  ariaLabel,
  stateAttr,
  sourceId,
  onOpen,
}: CommsLedgerRowProps) {
  const wrapStyle = arriving && arrivalDelayMs
    ? ({ '--arrive-delay': `${arrivalDelayMs}ms` } as CSSProperties)
    : undefined
  const interactive = Boolean(onOpen)
  const content = (
    <>
      <EmployeeChip employee={employee} displayName={displayName} size={18} showName={false} className="comm-chip shrink-0" />
      <span className={`shrink-0 text-[length:var(--text-caption1)] font-[var(--weight-medium)] ${error ? 'text-[var(--system-red)]' : 'text-[var(--text-secondary)]'}`}>
        {displayName}
      </span>
      {error && <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--system-red)]" />}
      {hopBadge && (
        <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] px-1.5 py-px text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-tertiary)]">
          {hopBadge}
        </span>
      )}
      <span className={`min-w-0 flex-1 truncate text-[length:var(--text-footnote)] ${error ? 'text-[color-mix(in_srgb,var(--system-red)_55%,var(--text-tertiary))]' : 'text-[var(--text-tertiary)]'}`}>
        {hint}
      </span>
      <span aria-hidden="true" className={`shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums] ${interactive ? 'opacity-0 transition-opacity duration-150 ease-[var(--ease-smooth)] group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100' : 'opacity-70'}`}>
        {time}
      </span>
      {interactive && (
        <ChevronRight size={12} strokeWidth={2.25} aria-hidden="true" className="shrink-0 -translate-x-0.5 text-[var(--text-quaternary)] opacity-0 transition-[opacity,transform] duration-150 ease-[var(--ease-smooth)] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 [@media(hover:none)]:translate-x-0 [@media(hover:none)]:opacity-100" />
      )}
    </>
  )
  const rowClass = `comm-row group relative -ml-1.5 flex w-full items-center gap-[var(--space-2)] rounded-[8px] py-[3px] pl-1.5 pr-2 text-left font-[inherit] text-[length:inherit] text-[inherit] ${dense ? 'min-h-[30px]' : 'min-h-8'} [@media(hover:none)]:min-h-10`
  return (
    <div
      className={`min-w-0 ${arriving ? 'comm-arrive' : ''}`}
      style={wrapStyle}
      data-comms-state={stateAttr}
      data-comms-interactive={interactive}
      data-source-message-id={sourceId}
    >
      {interactive ? (
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={onOpen}
          className={`${rowClass} cursor-pointer border-none bg-transparent outline-offset-1 transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] focus-visible:bg-[var(--fill-quaternary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] active:bg-[var(--fill-tertiary)]`}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
    </div>
  )
}
