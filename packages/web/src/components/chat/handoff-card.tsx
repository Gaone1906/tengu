import { ChevronRight } from 'lucide-react'
import type { ChatBlock, JsonValue } from '@/lib/blocks'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { QuietCard } from '@/components/ui/quiet-card'
import { StateLine, type StateLineState } from '@/components/ui/state-line'
import type { CommsPeekData } from './thread-peek'

function text(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function timestamp(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface DelegationVisualState {
  state: StateLineState
  label: string
  ariaState: string
}

export function delegationStateForBlock(block: ChatBlock): DelegationVisualState {
  if (block.status === 'done' || block.status === 'completed') return { state: 'replied', label: 'Replied', ariaState: 'replied' }
  if (block.status === 'error') return { state: 'error', label: "Couldn't finish", ariaState: "couldn't finish" }
  if (block.status === 'waiting') return { state: 'waiting', label: 'Waiting', ariaState: 'waiting' }
  if (block.status === 'running') return { state: 'working', label: 'Working', ariaState: 'working' }
  return { state: 'dispatched', label: 'Delegated', ariaState: 'delegated' }
}

interface HandoffCardProps {
  block: ChatBlock
  onPeek?: (peek: CommsPeekData) => void
}

export function HandoffCard({ block, onPeek }: HandoffCardProps) {
  const employee = text(block.payload.employee, 'delegate')
  const employeeDisplay = text(block.payload.employeeDisplay, employee)
  const title = text(block.payload.title, block.title || 'Delegated task')
  const childSessionId = text(block.payload.childSessionId)
  const dispatchedAt = timestamp(block.payload.dispatchedAt)
  const repliedAt = timestamp(block.payload.repliedAt)
  const visual = delegationStateForBlock(block)
  const interactive = Boolean(childSessionId && onPeek)
  const body = (
    <>
      <EmployeeChip employee={employee} displayName={employeeDisplay} size={36} showName={false} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-[var(--space-2)] text-[length:var(--text-footnote)] leading-[var(--leading-snug)]">
          <span className="truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{employeeDisplay}</span>
          <span className="shrink-0 font-[var(--weight-regular)] text-[var(--text-tertiary)]">handed off</span>
        </span>
        <span className="mt-px line-clamp-2 text-pretty text-[length:var(--text-footnote)] leading-[var(--leading-normal)] text-[var(--text-secondary)]">
          {title}
        </span>
        <StateLine
          state={visual.state}
          label={visual.label}
          dispatchedAt={dispatchedAt}
          repliedAt={repliedAt}
          className="mt-[var(--space-1)]"
        />
      </span>
      {interactive && <ChevronRight size={14} aria-hidden="true" className="ml-[var(--space-1)] shrink-0 text-[var(--text-quaternary)]" />}
    </>
  )
  const layout = 'my-[var(--space-2)] flex min-h-16 w-full max-w-[480px] items-center gap-[var(--space-3)] py-[var(--space-3)] pl-[var(--space-3)] pr-[var(--space-4)] text-left'

  if (interactive) return (
    <QuietCard
      onClick={() => onPeek!({
        kind: 'delegation',
        employee,
        displayName: employeeDisplay,
        sessionId: childSessionId,
        messageId: block.id,
        timestamp: dispatchedAt ?? Date.now(),
        preview: title,
      })}
      aria-label={`${employeeDisplay}, ${visual.ariaState}. Open preview.`}
      className={`${layout} cursor-pointer`}
      data-handoff-state={visual.state}
      data-handoff-interactive="true"
      data-block-id={block.id}
    >
      {body}
    </QuietCard>
  )

  return (
    <div
      className={`${layout} rounded-[var(--radius-xl)] bg-[var(--fill-tertiary)] shadow-[var(--shadow-subtle)]`}
      data-handoff-state={visual.state}
      data-handoff-interactive="false"
      data-block-id={block.id}
    >
      {body}
    </div>
  )
}
