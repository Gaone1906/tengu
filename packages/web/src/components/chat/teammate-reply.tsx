import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { stripMarkdown } from '@/lib/strip-markdown'
import { StateLine } from '@/components/ui/state-line'
import { CalloutRail, clockTime, CommsCallout } from './comms-callout'
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

/* ── Full-reply fetch ───────────────────────────────────── */

// The gateway clips the callback banner to a one-line 220-char preview
// (callbacks.ts _clean). The child's actual final message is still fetchable,
// so on first expand we look it up and swap it in — the callout then carries
// the FULL reply with its original formatting. Keyed by message id: fetched
// once per card, never for collapsed rows.
const fullReplyCache = new Map<string, string | null>()

/** Mirror of the gateway's `_clean` word-boundary clip — used to recognise
 *  which child message a given preview was cut from. */
export function cleanLikeGateway(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  const cut = oneLine.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

async function fetchFullReply(childSessionId: string, preview: string): Promise<string | null> {
  const session = await api.getSession(childSessionId, { last: 40 }) as Record<string, unknown>
  const messages = Array.isArray(session.messages) ? session.messages as Array<Record<string, unknown>> : []
  // Newest-first provenance match: find the assistant message this preview was
  // clipped from. The exact match keeps historical callbacks honest — a child
  // that ran again later never gets its NEWER reply attributed to an OLD card.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const content = typeof message.content === 'string' ? message.content : ''
    if (content && cleanLikeGateway(content) === preview) return content
  }
  return null
}

function useFullReply(data: TeammateReplyData, messageId: string, expanded: boolean): string | null {
  const [full, setFull] = useState<string | null>(() => fullReplyCache.get(messageId) ?? null)

  useEffect(() => {
    if (!expanded || data.kind !== 'reply' || !data.childSessionId || !data.preview) return
    if (fullReplyCache.has(messageId)) {
      setFull(fullReplyCache.get(messageId) ?? null)
      return
    }
    let cancelled = false
    fetchFullReply(data.childSessionId, data.preview)
      .then((text) => {
        fullReplyCache.set(messageId, text)
        if (!cancelled) setFull(text)
      })
      .catch(() => { /* preview stays — the honest fallback */ })
    return () => { cancelled = true }
  }, [expanded, data, messageId])

  return full
}

/* ── Component ──────────────────────────────────────────── */

interface TeammateReplyProps {
  data: TeammateReplyData
  timestamp: number
  messageId: string
  renderContent: (text: string) => ReactNode
  onOpenThread?: (sessionId: string) => void
}

export function TeammateReply({ data, timestamp, messageId, renderContent, onOpenThread }: TeammateReplyProps) {
  const [expanded, setExpanded] = useState(false)
  const error = data.kind === 'error'
  const full = useFullReply(data, messageId, expanded)
  const bodyText = full ?? data.preview
  const hint = stripMarkdown(data.preview.split('\n')[0]) || (error ? "Couldn't finish" : '')

  return (
    <CommsCallout
      employee={data.employee}
      displayName={data.employeeDisplay}
      meta={error
        ? [{ text: "couldn't finish", tone: 'error' }, { text: clockTime(timestamp) }]
        : [{ text: 'replied' }, { text: clockTime(timestamp) }]}
      hint={hint}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      stateAttr={data.kind}
    >
      <CalloutRail error={error}>
        {error && <StateLine state="error" className="mb-[3px]" />}
        {bodyText && (
          <div className={`max-w-[62ch] text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] ${error ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
            {renderContent(bodyText)}
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
      </CalloutRail>
    </CommsCallout>
  )
}
