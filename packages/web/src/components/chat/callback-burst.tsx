import { Fragment } from 'react'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { clockTime } from './comms-callout'
import { TeammateReply, type TeammateReplyData } from './teammate-reply'
import type { CommsPeekData } from './thread-peek'
import type { Message } from '@/lib/conversations'

/**
 * The T3 burst stack: 2+ callbacks arriving near-simultaneously compose into
 * ONE grouped entry — overlapping chips, "N reports" + the time range, then
 * the individual ledger lines railed underneath at a denser rhythm. The pile
 * gets quieter as it grows instead of louder.
 */

/** Consecutive callbacks group when each lands within this window of the previous. */
export const BURST_WINDOW_MS = 5 * 60 * 1000

export interface BurstEntry {
  data: TeammateReplyData
  msg: Message
  messageId: string
}

/** "3:42-3:45 PM" (shared meridiem trimmed off the start), or one time when the range collapses. */
export function formatBurstRange(first: number, last: number): string {
  const from = clockTime(first)
  const to = clockTime(last)
  if (from === to) return from
  const meridiem = to.slice(-3)
  const fromTrimmed = from.endsWith(meridiem) ? from.slice(0, -3) : from
  return `${fromTrimmed}-${to}`
}

interface CallbackBurstProps {
  entries: BurstEntry[]
  onPeek?: (peek: CommsPeekData) => void
  /** Message ids that just arrived live, with their stagger index (+90ms each). */
  arrivals?: Map<string, number>
}

export function CallbackBurst({ entries, onPeek, arrivals }: CallbackBurstProps) {
  const first = entries[0].msg.timestamp
  const last = entries[entries.length - 1].msg.timestamp
  const range = formatBurstRange(first, last)
  const metaWords = [`${entries.length} reports`, range]

  return (
    <div
      role="group"
      aria-label={`${entries.length} reports, ${clockTime(first)} to ${clockTime(last)}`}
      className="min-w-0"
      data-comms-burst={entries.length}
    >
      <div className="flex min-h-7 items-center gap-[var(--space-2)] py-0.5">
        <span className="flex shrink-0" aria-hidden="true">
          {entries.map((entry, index) => (
            <EmployeeAvatar
              key={entry.messageId}
              name={entry.data.employee}
              size={18}
              fontSize={10}
              className={`bg-[var(--fill-secondary)] ${index > 0 ? '-ml-1.5' : ''}`}
              style={{ boxShadow: '0 0 0 2px var(--bg)' }}
            />
          ))}
        </span>
        <span className="flex min-w-0 items-center gap-[7px]">
          {metaWords.map((word, index) => (
            <Fragment key={index}>
              {index > 0 && (
                <span aria-hidden="true" className="size-[2.5px] shrink-0 rounded-full bg-[var(--text-quaternary)] opacity-45" />
              )}
              <span className="truncate text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]">
                {word}
              </span>
            </Fragment>
          ))}
        </span>
      </div>
      <div className="relative ml-0.5 min-w-0 pl-[18px] before:absolute before:bottom-1 before:left-2 before:top-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--fill-primary)]">
        {entries.map((entry) => {
          const arrivalIndex = arrivals?.get(entry.messageId)
          return (
            <TeammateReply
              key={entry.messageId}
              data={entry.data}
              timestamp={entry.msg.timestamp}
              messageId={entry.messageId}
              onPeek={onPeek}
              dense
              arriving={arrivalIndex !== undefined}
              arrivalDelayMs={arrivalIndex !== undefined ? arrivalIndex * 90 : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}
