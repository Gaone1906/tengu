import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'

/**
 * Shared anatomy for the chat's comms callouts (child-session callbacks and
 * agent-to-agent relays): a one-line collapsed head — attribution chip, meta
 * words separated by rendered dots, a truncated first-line hint, a chevron —
 * that expands to a thread-rail quote body. Voices get text, not cards.
 */

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

export interface CalloutMetaWord {
  text: string
  tone?: 'default' | 'error'
}

interface CommsCalloutProps {
  employee: string
  displayName: string
  /** Meta words after the name; each is preceded by a rendered dot separator. */
  meta: CalloutMetaWord[]
  /** Relay-chain depth badge, only shown when the chain is deeper than one hop. */
  hopBadge?: string
  /** Collapsed one-line preview. */
  hint: string
  expanded: boolean
  onToggle: () => void
  stateAttr: string
  children: ReactNode
}

export function CommsCallout({
  employee,
  displayName,
  meta,
  hopBadge,
  hint,
  expanded,
  onToggle,
  stateAttr,
  children,
}: CommsCalloutProps) {
  return (
    <div className="min-w-0" data-comms-state={stateAttr} data-expanded={expanded || undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${displayName} — ${meta.map((word) => word.text).join(', ')}. ${expanded ? 'Collapse' : 'Expand'}.`}
        onClick={onToggle}
        className="-ml-1 flex min-h-9 w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border-none bg-transparent py-1 pl-1 pr-2 text-left font-[inherit] text-[length:inherit] text-[inherit] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]"
      >
        <EmployeeChip employee={employee} displayName={displayName} size={22} className="shrink-0" />
        {/* Meta words with rendered dot separators — symmetric by construction
            (equal flex gaps), not by font side-bearings of a "·" glyph. */}
        <span className="flex shrink-0 items-center gap-[7px]">
          {meta.map((word, index) => (
            <Fragment key={index}>
              <span aria-hidden="true" className="size-[2.5px] shrink-0 rounded-full bg-[var(--text-quaternary)] opacity-45" />
              <span
                className={`whitespace-nowrap text-[length:var(--text-caption1)] font-[var(--weight-medium)] [font-variant-numeric:tabular-nums] ${
                  word.tone === 'error' ? 'text-[var(--system-red)]' : 'text-[var(--text-quaternary)]'
                }`}
              >
                {word.text}
              </span>
            </Fragment>
          ))}
        </span>
        {hopBadge && (
          <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] px-1.5 py-px text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-tertiary)]">
            {hopBadge}
          </span>
        )}
        {expanded
          ? <span className="min-w-0 flex-1" />
          : (
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              {hint}
            </span>
          )}
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          aria-hidden="true"
          className={`shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? 'rotate-180' : 'rotate-0'}`}
        />
      </button>
      {expanded && children}
    </div>
  )
}

/** The established embedded-voice quote: 2px rail, red-mixed for errors. */
export function CalloutRail({ error, children }: { error?: boolean; children: ReactNode }) {
  const railStyle = {
    '--thread-rail': error
      ? 'color-mix(in srgb, var(--system-red) 38%, transparent)'
      : 'var(--fill-primary)',
  } as CSSProperties
  return (
    <div
      style={railStyle}
      className="relative mb-[var(--space-1)] ml-[14px] mt-[2px] min-w-0 pl-[var(--space-4)] before:absolute before:bottom-[3px] before:left-0 before:top-[3px] before:w-0.5 before:rounded-px before:bg-[var(--thread-rail)]"
    >
      {children}
    </div>
  )
}
