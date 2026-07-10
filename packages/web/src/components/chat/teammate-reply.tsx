import type { CSSProperties, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { StateLine } from '@/components/ui/state-line'
import type { Message } from '@/lib/conversations'

export interface TeammateReplyData {
  kind: 'reply' | 'error'
  employee: string
  employeeDisplay: string
  childSessionId?: string
  preview: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function previewAfterHeader(content: string): string {
  const newline = content.indexOf('\n')
  return newline >= 0 ? content.slice(newline + 1).trim() : ''
}

export function parseTeammateReply(message: Message): TeammateReplyData | null {
  if (message.role !== 'notification') return null
  const meta = record(message.meta)
  if (meta?.kind === 'child-reply' || meta?.kind === 'child-error') {
    const employee = typeof meta.employee === 'string' && meta.employee.trim() ? meta.employee.trim() : ''
    const childSessionId = typeof meta.childSessionId === 'string' && meta.childSessionId.trim()
      ? meta.childSessionId.trim()
      : undefined
    if (employee && childSessionId) {
      const employeeDisplay = typeof meta.employeeDisplay === 'string' && meta.employeeDisplay.trim()
        ? meta.employeeDisplay.trim()
        : titleCase(employee)
      return {
        kind: meta.kind === 'child-reply' ? 'reply' : 'error',
        employee,
        employeeDisplay,
        childSessionId,
        preview: previewAfterHeader(message.content),
      }
    }
  }

  const reply = message.content.match(/^📩 ([^\n]+) replied\n([\s\S]*)$/)
  if (reply) {
    const employeeDisplay = reply[1].trim()
    return { kind: 'reply', employee: employeeDisplay, employeeDisplay, preview: reply[2].trim() }
  }
  const error = message.content.match(/^⚠️ ([^\n]+) couldn't finish(?:\n([\s\S]*))?$/)
  if (error) {
    const employeeDisplay = error[1].trim()
    return { kind: 'error', employee: employeeDisplay, employeeDisplay, preview: (error[2] || '').trim() }
  }
  return null
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

interface TeammateReplyProps {
  data: TeammateReplyData
  timestamp: number
  formattedPreview: ReactNode
  onOpenThread?: (sessionId: string) => void
}

export function TeammateReply({ data, timestamp, formattedPreview, onOpenThread }: TeammateReplyProps) {
  const error = data.kind === 'error'
  const railStyle = {
    '--thread-rail': error
      ? 'color-mix(in srgb, var(--system-red) 38%, transparent)'
      : 'var(--fill-primary)',
  } as CSSProperties

  return (
    <div className="my-[var(--space-2)] min-w-0" data-teammate-state={data.kind}>
      <div className="mb-[var(--space-1)] flex min-w-0 items-center gap-[var(--space-2)]">
        <EmployeeChip employee={data.employee} displayName={data.employeeDisplay} size={22} />
        <span className="shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
          {error ? `· ${clockTime(timestamp)}` : `· replied · ${clockTime(timestamp)}`}
        </span>
      </div>
      <div
        style={railStyle}
        className="relative ml-[10px] min-w-0 pl-[var(--space-4)] before:absolute before:bottom-[3px] before:left-0 before:top-[3px] before:w-0.5 before:rounded-px before:bg-[var(--thread-rail)]"
      >
        {error && <StateLine state="error" className="mb-[3px]" />}
        {data.preview && (
          <div className={`max-w-[62ch] text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] ${error ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
            {formattedPreview}
          </div>
        )}
        {data.childSessionId && onOpenThread && (
          <button
            type="button"
            aria-label={`Open ${data.employeeDisplay} thread`}
            onClick={() => onOpenThread(data.childSessionId!)}
            className="mt-[var(--space-2)] inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent py-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:text-[var(--text-primary)]"
          >
            Open thread <ChevronRight size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
