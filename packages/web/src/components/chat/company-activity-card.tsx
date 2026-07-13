import { useId, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, ListChecks, Play, Workflow } from 'lucide-react'
import type { ChatBlock, JsonValue } from '@/lib/blocks'
import { todoPrivateRef } from '@/routes/todos/todo-private-state'

/* The company-activity object (plan Task 8). A quiet inline receipt — one soft
 * token surface showing the object's name + honest state, a Preview disclosure
 * that opens bounded evidence in place, and a separate plain Open action. Not
 * another voice: no avatar, no sender label, no resting hairline. Same
 * information hierarchy at desktop and true mobile, no horizontal scroll. */

type Tone = 'waiting' | 'working' | 'done' | 'error' | 'neutral'

function text(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Turn a snake/kebab status token into a calm human phrase ("in_review" → "In review"). */
function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value
}

function formatWhen(value: JsonValue | undefined): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

interface KindMeta {
  noun: string
  label: string
  Icon: ComponentType<{ className?: string }>
}

function kindMeta(block: ChatBlock): KindMeta {
  if (block.type === 'todo-activity') return { noun: 'todo', label: 'Todo', Icon: ListChecks }
  if (block.type === 'workflow-definition') return { noun: 'workflow', label: 'Workflow', Icon: Workflow }
  return { noun: 'workflow run', label: 'Workflow run', Icon: Play }
}

interface StateView {
  tone: Tone
  label: string
}

function progressSuffix(payload: ChatBlock['payload']): string {
  const done = num(payload.completedSteps)
  const total = num(payload.totalSteps)
  return done !== undefined && total !== undefined ? ` · ${done} of ${total} steps` : ''
}

function stateView(block: ChatBlock): StateView {
  if (block.type === 'todo-activity') {
    const status = text(block.payload.status)
    const tone: Tone = block.status === 'error'
      ? 'error'
      : /^(done|completed|approved)$/.test(status)
        ? 'done'
        : /^(blocked|escalated|rejected|cancelled|failed)$/.test(status)
          ? 'error'
          : /^(executing|running|in_progress)$/.test(status)
            ? 'working'
            : 'waiting'
    return { tone, label: status ? humanize(status) : humanize(block.status ?? 'updated') }
  }
  if (block.type === 'workflow-definition') {
    const action = text(block.payload.action, 'updated')
    const tone: Tone = /retire/.test(action) ? 'neutral' : 'done'
    const label = action === 'updated' ? `Updated to v${block.version}` : humanize(action)
    return { tone, label }
  }
  const runStatus = text(block.payload.runStatus)
  const base: StateView = /^parked$/.test(runStatus)
    ? { tone: 'waiting', label: 'Waiting for approval' }
    : /^(failed|error)$/.test(runStatus)
      ? { tone: 'error', label: 'Failed' }
      : /^(completed|done)$/.test(runStatus)
        ? { tone: 'done', label: 'Completed' }
        : /^cancelled$/.test(runStatus)
          ? { tone: 'neutral', label: 'Cancelled' }
          : /^(running|dispatched)$/.test(runStatus)
            ? { tone: 'working', label: 'Running' }
            : { tone: 'working', label: runStatus ? humanize(runStatus) : 'Running' }
  return { tone: base.tone, label: `${base.label}${progressSuffix(block.payload)}` }
}

function StateMark({ tone }: { tone: Tone }) {
  if (tone === 'done') return <Check size={12} strokeWidth={2.5} aria-hidden="true" className="mt-[2px] shrink-0" />
  if (tone === 'error') return <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="mt-[2px] shrink-0" />
  if (tone === 'working') {
    return (
      <span
        aria-hidden="true"
        className="mt-[5px] size-1.5 shrink-0 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none"
      />
    )
  }
  const bg = tone === 'waiting' ? 'bg-[var(--system-orange)]' : 'bg-[var(--text-quaternary)]'
  return <span aria-hidden="true" className={`mt-[5px] size-1.5 shrink-0 rounded-full ${bg}`} />
}

const TONE_TEXT: Record<Tone, string> = {
  waiting: 'text-[var(--system-orange)]',
  working: 'text-[var(--system-blue)]',
  done: 'text-[var(--text-tertiary)]',
  error: 'text-[var(--system-red)]',
  neutral: 'text-[var(--text-tertiary)]',
}

interface Fact {
  label: string
  value: string
  emphasis?: 'ask' | 'error'
}

function factsFor(block: ChatBlock): Fact[] {
  const p = block.payload
  const facts: Fact[] = []
  const push = (label: string, value: string | undefined, emphasis?: Fact['emphasis']) => {
    if (value && value.trim()) facts.push({ label, value, emphasis })
  }
  if (block.type === 'todo-activity') {
    push('Assignee', text(p.assignee))
    push('By', text(p.actor))
    push('Approval', p.approvalState ? humanize(text(p.approvalState)) : undefined)
    push('Updated', formatWhen(p.updatedAt))
    push('Note', text(p.preview))
    push('Error', text(p.latestError), 'error')
  } else if (block.type === 'workflow-definition') {
    push('Status', p.definitionStatus ? humanize(text(p.definitionStatus)) : undefined)
    push('Change', p.action ? humanize(text(p.action)) : undefined)
    push('Updated', formatWhen(p.updatedAt))
    push('Note', text(p.preview))
    push('Error', text(p.latestError), 'error')
  } else {
    const failed = /^(failed|error)$/.test(text(p.runStatus))
    push('Needs', text(p.parkedDescription), 'ask')
    const done = num(p.completedSteps)
    const total = num(p.totalSteps)
    if (done !== undefined && total !== undefined) push('Progress', `${done} of ${total} steps`)
    push('Started', formatWhen(p.startedAt))
    push('Ended', formatWhen(p.endedAt))
    if (!failed) push('Last step', text(p.preview))
    push('Error', text(p.latestError), 'error')
  }
  return facts
}

/** Only accept an internal workflow deep link authored by the server. */
function safeWorkflowPath(value: JsonValue | undefined): string | null {
  const path = text(value)
  return /^\/workflow\/[^/]/.test(path) && !path.includes('//') ? path : null
}

export function CompanyActivityCard({ block }: { block: ChatBlock }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const previewRef = useRef<HTMLButtonElement>(null)
  const regionId = useId()

  // Escape closes an open Preview and returns focus to its trigger — the standard
  // disclosure affordance. Scoped to this card's subtree (no global listener, no
  // modal semantics); when collapsed the key bubbles normally for any ancestor.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    previewRef.current?.focus()
  }
  const meta = kindMeta(block)
  const state = stateView(block)
  const facts = factsFor(block)
  const title = block.title || block.summary || meta.label
  const objectName = `${title} ${meta.noun}`

  const openObject = () => {
    if (block.type === 'todo-activity') {
      const todoId = text(block.payload.todoId)
      navigate('/todos', todoId ? { state: { todoRef: todoPrivateRef(todoId) } } : undefined)
      return
    }
    const explicit = safeWorkflowPath(block.payload.openPath)
    if (explicit) { navigate(explicit); return }
    const workflowId = encodeURIComponent(text(block.payload.workflowId))
    if (block.type === 'workflow-definition') { navigate(`/workflow/${workflowId}?mode=edit`); return }
    const runId = encodeURIComponent(text(block.payload.runId))
    navigate(`/workflow/${workflowId}?mode=runs&run=${runId}`)
  }

  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      onKeyDown={handleKeyDown}
      className="my-[var(--space-2)] w-[min(480px,calc(100vw-var(--space-6)))] max-w-full rounded-[var(--radius-xl)] bg-[var(--fill-tertiary)] shadow-[var(--shadow-subtle)]"
    >
      <div className="flex min-h-16 flex-wrap items-center gap-[var(--space-3)] py-[var(--space-3)] pl-[var(--space-3)] pr-[var(--space-2)] max-[504px]:pb-[var(--space-2)]">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-secondary)]"
        >
          <meta.Icon className="size-[17px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-[var(--space-2)] text-[length:var(--text-footnote)] leading-[var(--leading-snug)]">
            <span className="truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</span>
            <span className="shrink-0 font-[var(--weight-regular)] text-[var(--text-tertiary)]">{meta.label}</span>
          </span>
          <span
            className={`mt-[var(--space-1)] flex min-h-4 items-start gap-[6px] text-[length:var(--text-caption1)] font-[var(--weight-medium)] [font-variant-numeric:tabular-nums] ${TONE_TEXT[state.tone]}`}
          >
            <StateMark tone={state.tone} />
            <span className="min-w-0">{state.label}</span>
          </span>
        </span>
        <span className="ml-[var(--space-1)] flex shrink-0 items-center gap-[var(--space-1)] max-[504px]:ml-[calc(36px+var(--space-3)-var(--space-2))] max-[504px]:basis-full">
          {facts.length > 0 && (
            <button
              ref={previewRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={open ? regionId : undefined}
              aria-label={`Preview ${objectName}`}
              className="inline-flex min-h-10 items-center gap-1 rounded-[var(--radius-md)] border-none bg-transparent px-[var(--space-2)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] motion-reduce:transition-none"
            >
              Preview
              <ChevronDown
                size={12}
                strokeWidth={2.25}
                aria-hidden="true"
                className={`shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ease-[var(--ease-smooth)] motion-reduce:transition-none ${open ? 'rotate-180' : 'rotate-0'}`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={openObject}
            aria-label={`Open ${objectName}`}
            className="inline-flex min-h-10 items-center gap-1 rounded-[var(--radius-md)] border-none bg-transparent px-[var(--space-2)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] motion-reduce:transition-none"
          >
            Open
            <ArrowUpRight size={12} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
          </button>
        </span>
      </div>

      {open && facts.length > 0 && (
        <div
          id={regionId}
          role="region"
          tabIndex={-1}
          aria-label={`${objectName} details`}
          className="grid gap-[var(--space-2)] pb-[var(--space-3)] pl-[calc(var(--space-3)+36px+var(--space-3))] pr-[var(--space-3)] outline-none max-[504px]:pl-[var(--space-3)]"
        >
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-h-[18px] items-baseline gap-[var(--space-3)]">
              <span className="w-[76px] shrink-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{fact.label}</span>
              <span
                className={[
                  'min-w-0 break-words text-[length:var(--text-footnote)] leading-[var(--leading-normal)] [font-variant-numeric:tabular-nums]',
                  fact.emphasis === 'error'
                    ? 'text-[var(--system-red)] line-clamp-3'
                    : fact.emphasis === 'ask'
                      ? 'font-[var(--weight-medium)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)]',
                ].join(' ')}
              >
                {fact.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
