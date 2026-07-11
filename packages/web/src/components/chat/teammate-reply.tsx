import { api } from '@/lib/api'
import { stripMarkdown } from '@/lib/strip-markdown'
import { clockTime, CommsLedgerRow } from './comms-callout'
import type { CommsPeekData } from './thread-peek'
import type { Message } from '@/lib/conversations'

export interface TeammateReplyData {
  kind: 'reply' | 'error'
  employee: string
  employeeDisplay: string
  childSessionId?: string
  preview: string
  /** Gateway contract (meta.fullMessage): the child's full final message,
   *  persisted with the notification. When present the report panel renders it
   *  directly — no fetch, and it survives child-session deletion. */
  fullMessage?: string
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
      const fullMessage = typeof meta.fullMessage === 'string' && meta.fullMessage.trim()
        ? meta.fullMessage
        : undefined
      return {
        kind: meta.kind === 'child-reply' ? 'reply' : 'error',
        employee,
        employeeDisplay,
        childSessionId,
        preview: previewAfterHeader(message.content),
        ...(fullMessage ? { fullMessage } : {}),
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

/* ── Full-reply fetch (consumed by the report panel) ────── */

// The gateway clips the callback banner to a one-line 220-char preview
// (callbacks.ts _clean). The child's actual final message is still fetchable,
// so when the report panel opens for a legacy callback (no meta.fullMessage)
// we look it up and swap it in. Keyed by message id: fetched once per card,
// never for collapsed rows.
export const fullReplyCache = new Map<string, string | null>()

/** Mirror of the gateway's `_clean` word-boundary clip — used to recognise
 *  which child message a given preview was cut from. */
export function cleanLikeGateway(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  const cut = oneLine.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

export async function fetchFullReply(childSessionId: string, preview: string): Promise<string | null> {
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

/* ── Component ──────────────────────────────────────────── */

interface TeammateReplyProps {
  data: TeammateReplyData
  timestamp: number
  messageId: string
  /** Open the read-only report panel (peek). */
  onPeek?: (peek: CommsPeekData) => void
  /** Fallback when no peek surface is mounted: jump straight to the thread. */
  onOpenThread?: (sessionId: string) => void
  dense?: boolean
  arriving?: boolean
  arrivalDelayMs?: number
}

export function TeammateReply({ data, timestamp, messageId, onPeek, onOpenThread, dense, arriving, arrivalDelayMs }: TeammateReplyProps) {
  const error = data.kind === 'error'
  const hint = stripMarkdown(data.preview.split('\n')[0]) || (error ? "Couldn't finish" : '')
  const time = clockTime(timestamp)

  const open = () => {
    if (onPeek) {
      onPeek({
        kind: data.kind,
        employee: data.employee,
        displayName: data.employeeDisplay,
        sessionId: data.childSessionId,
        messageId,
        timestamp,
        preview: data.preview,
        fullMessage: data.fullMessage,
      })
    } else if (data.childSessionId && onOpenThread) {
      onOpenThread(data.childSessionId)
    }
  }

  return (
    <CommsLedgerRow
      employee={data.employee}
      displayName={data.employeeDisplay}
      hint={hint}
      time={time}
      error={error}
      dense={dense}
      arriving={arriving}
      arrivalDelayMs={arrivalDelayMs}
      ariaLabel={`${data.employeeDisplay} ${error ? "couldn't finish" : 'replied'}, ${time}. Open report.`}
      stateAttr={data.kind}
      onOpen={open}
    />
  )
}
