import { ChevronRight, Redo2 } from 'lucide-react'
import type { CSSProperties } from 'react'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { stripMarkdown } from '@/lib/strip-markdown'
import type { ChatBlock, JsonValue, LiveBlockArrival } from '@/lib/blocks'
import type { CommsPeekData } from './thread-peek'

/**
 * Parent→child dispatch affordance: when the parent sends a follow-up INTO an
 * existing delegated session, the thread shows a quiet outbound one-liner —
 * curved arrow, "Followed up", the child's chip, the message's first line —
 * that opens the child thread. Deliberately smaller than the HandoffCard: a
 * follow-up is smaller news than the original delegation.
 *
 * Full form renders from a `dispatch` chat block (gateway contract, flagged).
 * Until the gateway emits it, bare `send_to_session` tool calls render the
 * generic form — the transcript carries no target or text for those.
 */

function text(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

interface DispatchRowProps {
  employee?: string
  employeeDisplay?: string
  preview?: string
  targetSessionId?: string
  messageId?: string
  timestamp?: number
  onPeek?: (peek: CommsPeekData) => void
}

export function DispatchRow({ employee, employeeDisplay, preview, targetSessionId, messageId, timestamp, onPeek }: DispatchRowProps) {
  const interactive = Boolean(targetSessionId && onPeek)
  const body = (
    <>
      <Redo2 size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="shrink-0 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
        {employeeDisplay ? 'Followed up' : 'Messaged'}
      </span>
      {employeeDisplay && (
        <EmployeeChip
          employee={employee || employeeDisplay}
          displayName={employeeDisplay}
          size={20}
          className="dispatch-chip shrink-0 [&>span:last-child]:text-[length:var(--text-caption1)]"
        />
      )}
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        {preview ? `“${stripMarkdown(preview)}”` : 'another session'}
      </span>
      {interactive && (
        <ChevronRight size={11} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      )}
    </>
  )

  const layout = '-ml-1.5 flex min-h-9 w-fit max-w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)] py-1 pl-1.5 pr-2.5'
  if (!interactive) {
    return (
      <div className={layout} data-dispatch="generic">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-label={`Followed up with ${employeeDisplay || 'a delegated session'}. Open preview.`}
      onClick={() => onPeek!({
        kind: 'dispatch',
        employee: employee || employeeDisplay || 'delegate',
        displayName: employeeDisplay || employee || 'Delegated session',
        sessionId: targetSessionId,
        messageId: messageId || `dispatch-${targetSessionId}`,
        timestamp: timestamp ?? Date.now(),
        preview: preview || 'Followed up',
      })}
      className={`${layout} cursor-pointer border-none bg-transparent text-left font-[inherit] text-[inherit] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]`}
      data-dispatch="linked"
      data-block-id={messageId}
    >
      {body}
    </button>
  )
}

export function DispatchBlockRow({
  block,
  onPeek,
  arrival,
}: {
  block: ChatBlock
  onPeek?: (peek: CommsPeekData) => void
  arrival?: LiveBlockArrival
}) {
  const delayMs = Math.min(120, Math.max(0, arrival?.delayMs ?? 0))
  return (
    <div
      className={`min-w-0 w-full max-w-full ${arrival ? 'dispatch-arrive' : ''}`}
      data-dispatch-arrival={arrival?.nonce}
      style={arrival ? ({ '--arrive-delay': `${delayMs}ms` } as CSSProperties) : undefined}
    >
      <div className={`min-w-0 max-w-full ${arrival ? 'dispatch-arrive-inner' : ''}`}>
        <DispatchRow
          employee={text(block.payload.employee)}
          employeeDisplay={text(block.payload.employeeDisplay, text(block.payload.employee))}
          preview={text(block.payload.preview)}
          targetSessionId={text(block.payload.targetSessionId) || undefined}
          messageId={block.id}
          timestamp={typeof block.payload.sentAt === 'number' ? block.payload.sentAt : undefined}
          onPeek={onPeek}
        />
      </div>
    </div>
  )
}
