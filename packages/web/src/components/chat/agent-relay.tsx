import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { stripMarkdown } from '@/lib/strip-markdown'
import { CalloutRail, clockTime, CommsCallout } from './comms-callout'
import type { Message } from '@/lib/conversations'

/**
 * Agent-to-agent relay (send_to_session), rendered as the inbound sibling of
 * the child-callback callout — same anatomy, "messaged" voice, hop badge when
 * the chain runs deeper than one hop.
 *
 * Preferred source is the structured gateway contract
 * (meta.kind === "agent-relay": fromSessionId/fromLabel/fromEmployee/hops/
 * maxHops/fullMessage) — it carries the sender's session for the thread link
 * and the un-clipped body. Transcripts persisted before that contract only
 * have the `📨 From <sender>[ [hop n/m]]: <text>` banner, so the text parse
 * stays as the legacy fallback.
 */

export interface AgentRelayData {
  fromLabel: string
  fromDisplay: string
  fromSessionId?: string
  hops?: number
  maxHops?: number
  text: string
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function relayData(fromLabel: string, hop: string | undefined, maxHop: string | undefined, text: string): AgentRelayData {
  return {
    fromLabel,
    fromDisplay: titleCase(fromLabel),
    hops: hop ? Number(hop) : undefined,
    maxHops: maxHop ? Number(maxHop) : undefined,
    text: text.trim(),
  }
}

export function parseAgentRelay(message: Message): AgentRelayData | null {
  if (message.role !== 'notification') return null

  // Structured gateway contract first.
  const meta = record(message.meta)
  if (meta?.kind === 'agent-relay') {
    const fromLabel = typeof meta.fromLabel === 'string' && meta.fromLabel.trim() ? meta.fromLabel.trim() : ''
    const fullMessage = typeof meta.fullMessage === 'string' && meta.fullMessage.trim() ? meta.fullMessage.trim() : ''
    if (fromLabel && fullMessage) {
      const fromEmployee = typeof meta.fromEmployee === 'string' && meta.fromEmployee.trim() ? meta.fromEmployee.trim() : ''
      const fromSessionId = typeof meta.fromSessionId === 'string' && meta.fromSessionId.trim() ? meta.fromSessionId.trim() : undefined
      return {
        fromLabel: fromEmployee || fromLabel,
        fromDisplay: titleCase(fromEmployee || fromLabel),
        ...(fromSessionId ? { fromSessionId } : {}),
        hops: typeof meta.hops === 'number' ? meta.hops : undefined,
        maxHops: typeof meta.maxHops === 'number' ? meta.maxHops : undefined,
        text: fullMessage,
      }
    }
  }

  // Human-facing banner (session-comm-guards.ts displayMessage).
  const banner = message.content.match(/^📨 From ([^\n:]+?)(?: \[hop (\d+)\/(\d+)\])?: ([\s\S]+)$/)
  if (banner) return relayData(banner[1].trim(), banner[2], banner[3], banner[4])

  // Engine-prompt form — shown when a transcript persisted the prompt instead
  // of the banner. The trailing reply-hint instruction is not part of the message.
  const prompt = message.content.match(/^📨 Message from session [\w-]+ \(([^)]+)\)(?: \[hop (\d+)\/(\d+)\])?:\n\n([\s\S]+)$/)
  if (prompt) {
    const body = prompt[4].split(/\n\nTo reply: send_to_session/)[0]
    return relayData(prompt[1].trim(), prompt[2], prompt[3], body)
  }
  return null
}

interface AgentRelayProps {
  data: AgentRelayData
  timestamp: number
  renderContent: (text: string) => ReactNode
  onOpenThread?: (sessionId: string) => void
}

export function AgentRelay({ data, timestamp, renderContent, onOpenThread }: AgentRelayProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <CommsCallout
      employee={data.fromLabel}
      displayName={data.fromDisplay}
      meta={[{ text: 'messaged' }, { text: clockTime(timestamp) }]}
      hopBadge={data.hops && data.hops > 1 ? `hop ${data.hops}` : undefined}
      hint={stripMarkdown(data.text.split('\n')[0])}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      stateAttr="relay"
    >
      <CalloutRail>
        <div className="max-w-[62ch] text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] text-[var(--text-primary)]">
          {renderContent(data.text)}
        </div>
        {data.fromSessionId && onOpenThread && (
          <button
            type="button"
            aria-label={`Open ${data.fromDisplay} thread`}
            onClick={() => onOpenThread(data.fromSessionId!)}
            className="mt-[var(--space-2)] inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent py-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:text-[var(--text-primary)]"
          >
            Open sender <ChevronRight size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
        )}
      </CalloutRail>
    </CommsCallout>
  )
}
