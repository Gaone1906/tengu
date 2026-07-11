import { ChevronRight } from 'lucide-react'
import type { ChatBlock, JsonValue } from '@/lib/blocks'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { QuietCard } from '@/components/ui/quiet-card'
import { StateLine, type StateLineState } from '@/components/ui/state-line'

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
  if (block.status === 'done') return { state: 'replied', label: 'Replied', ariaState: 'replied' }
  if (block.status === 'error') return { state: 'error', label: "Couldn't finish", ariaState: "couldn't finish" }
  if (block.status === 'running') return { state: 'working', label: 'Working', ariaState: 'working' }
  return { state: 'dispatched', label: 'Delegated', ariaState: 'delegated' }
}

interface HandoffCardProps {
  block: ChatBlock
  onOpenThread?: (sessionId: string) => void
}

export function HandoffCard({ block, onOpenThread }: HandoffCardProps) {
  const employee = text(block.payload.employee, 'delegate')
  const employeeDisplay = text(block.payload.employeeDisplay, employee)
  const title = text(block.payload.title, block.title || 'Delegated task')
  const childSessionId = text(block.payload.childSessionId)
  const dispatchedAt = timestamp(block.payload.dispatchedAt)
  const repliedAt = timestamp(block.payload.repliedAt)
  const visual = delegationStateForBlock(block)

  return (
    <QuietCard
      onClick={() => childSessionId && onOpenThread?.(childSessionId)}
      aria-label={`${employeeDisplay}, ${visual.ariaState}. Open thread.`}
      className="my-[var(--space-2)] flex min-h-16 w-fit max-w-[min(480px,100%)] cursor-pointer items-center gap-[var(--space-3)] py-[var(--space-3)] pl-[var(--space-3)] pr-[var(--space-4)] text-left"
      data-handoff-state={visual.state}
    >
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
      <ChevronRight size={14} aria-hidden="true" className="ml-[var(--space-1)] shrink-0 text-[var(--text-quaternary)]" />
    </QuietCard>
  )
}
