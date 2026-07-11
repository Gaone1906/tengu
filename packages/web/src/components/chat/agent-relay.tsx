import { useState, type ReactNode } from 'react'
import { stripMarkdown } from '@/lib/strip-markdown'
import { CalloutRail, clockTime, CommsCallout } from './comms-callout'
import type { Message } from '@/lib/conversations'

/**
 * Agent-to-agent relay (send_to_session): the gateway injects the message as a
 * `📨 From <sender>[ [hop n/m]]: <text>` notification banner. Until a
 * structured meta contract exists (flagged for the gateway lane), the shape is
 * recovered from that text and rendered as the inbound sibling of the
 * child-callback callout — same anatomy, "messaged" voice, hop badge when the
 * chain runs deeper than one hop.
 */

export interface AgentRelayData {
  fromLabel: string
  fromDisplay: string
  hops?: number
  maxHops?: number
  text: string
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
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
}

export function AgentRelay({ data, timestamp, renderContent }: AgentRelayProps) {
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
      </CalloutRail>
    </CommsCallout>
  )
}
