import { ChevronRight, Redo2 } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { stripMarkdown } from '@/lib/strip-markdown'
import type { ChatBlock, JsonValue } from '@/lib/blocks'

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
  onOpenThread?: (sessionId: string) => void
}

export function DispatchRow({ employee, employeeDisplay, preview, targetSessionId, onOpenThread }: DispatchRowProps) {
  const interactive = Boolean(targetSessionId && onOpenThread)
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
          className="shrink-0 [&>span:last-child]:text-[length:var(--text-caption1)]"
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
      aria-label={`Followed up with ${employeeDisplay || 'a delegated session'}. Open thread.`}
      onClick={() => onOpenThread!(targetSessionId!)}
      className={`${layout} cursor-pointer border-none bg-transparent text-left font-[inherit] text-[inherit] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]`}
      data-dispatch="linked"
    >
      {body}
    </button>
  )
}

export function DispatchBlockRow({ block, onOpenThread }: { block: ChatBlock; onOpenThread?: (sessionId: string) => void }) {
  return (
    <DispatchRow
      employee={text(block.payload.employee)}
      employeeDisplay={text(block.payload.employeeDisplay, text(block.payload.employee))}
      preview={text(block.payload.preview)}
      targetSessionId={text(block.payload.targetSessionId) || undefined}
      onOpenThread={onOpenThread}
    />
  )
}
