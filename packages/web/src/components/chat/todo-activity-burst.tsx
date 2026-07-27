import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, ChevronDown, ListChecks } from 'lucide-react'
import type { ChatBlock, JsonValue } from '@/lib/blocks'
import { todoPath } from '@/lib/todo-id'
import { statusMark } from './chat-blocks'

const INITIAL_CHILD_COUNT = 6

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Updated'
}

function blockStatus(block: ChatBlock): string {
  return text(block.payload.status) || block.status || 'queued'
}

export function TodoActivityBurst({ blocks }: { blocks: ChatBlock[] }) {
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)
  const rootId = text(blocks[0]?.payload.rootId) || text(blocks[0]?.payload.todoId)
  const root = blocks.find((block) => (
    text(block.payload.todoId) === rootId && !text(block.payload.parentId)
  ))
  const children = blocks.filter((block) => block !== root)
  const visibleChildren = showAll ? children : children.slice(0, INITIAL_CHILD_COUNT)
  const hiddenCount = children.length - visibleChildren.length
  const title = root?.title || 'Work breakdown'
  const rootStatus = root ? humanize(blockStatus(root)) : 'Created'

  return (
    <div
      data-testid="todo-activity-burst"
      data-root-todo-id={rootId}
      className="my-[var(--space-2)] w-[min(520px,calc(100vw-var(--space-6)))] max-w-full rounded-[var(--radius-xl)] bg-[var(--fill-tertiary)] p-[5px] shadow-[var(--shadow-subtle)]"
    >
      <div className="flex min-h-16 items-center gap-[var(--space-3)] rounded-[calc(var(--radius-xl)-3px)] bg-[var(--bg)] px-[var(--space-3)] py-[var(--space-2)]">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-secondary)]"
        >
          <ListChecks className="size-[17px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-0.5 text-[length:var(--text-footnote)] leading-[var(--leading-snug)]">
            <span className="min-w-0 truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</span>
            <span className="shrink-0 text-[var(--text-secondary)]">Todo · {rootId}</span>
          </span>
          <span className="mt-0.5 block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
            <span>{children.length} sub-task{children.length === 1 ? '' : 's'}</span>
            <span> · {rootStatus}</span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => navigate(todoPath(rootId))}
          aria-label={`Open ${title} todo`}
          className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] border-none bg-transparent text-[var(--text-tertiary)] transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>

      <div className="px-[var(--space-1)] py-[3px]">
        {visibleChildren.map((block) => {
          const todoId = text(block.payload.todoId)
          const status = blockStatus(block)
          return (
            <button
              key={block.id}
              type="button"
              onClick={() => navigate(todoPath(todoId))}
              aria-label={`Open ${block.title || todoId} sub-task`}
              className="flex min-h-10 w-full min-w-0 items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border-none bg-transparent px-[var(--space-2)] text-left transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
            >
              <span className="grid size-4 shrink-0 place-items-center">{statusMark(status)}</span>
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                {block.title || 'Untitled sub-task'}
              </span>
              <span className="shrink-0 text-[length:var(--text-caption2)] [font-variant-numeric:tabular-nums] text-[var(--text-quaternary)]">
                {todoId}
              </span>
            </button>
          )
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="ml-6 inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-md)] border-none bg-transparent px-[var(--space-2)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
          >
            Show {hiddenCount} more
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
