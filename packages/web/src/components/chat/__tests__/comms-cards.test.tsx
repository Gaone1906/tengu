import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { parseAgentRelay } from '../agent-relay'
import { ChatBlockInline } from '../chat-blocks'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

describe('agent relays', () => {
  it('parses the banner form with and without a hop tag', () => {
    expect(parseAgentRelay({
      id: 'r1',
      role: 'notification',
      content: '📨 From market-scout: Found three fresh checkout threads.',
      timestamp: 1,
    })).toEqual({
      fromLabel: 'market-scout',
      fromDisplay: 'Market Scout',
      hops: undefined,
      maxHops: undefined,
      text: 'Found three fresh checkout threads.',
    })

    expect(parseAgentRelay({
      id: 'r2',
      role: 'notification',
      content: '📨 From growth-ops [hop 2/12]: Relaying from scout: cross-reference first.',
      timestamp: 1,
    })).toMatchObject({ fromLabel: 'growth-ops', hops: 2, maxHops: 12, text: 'Relaying from scout: cross-reference first.' })
  })

  it('parses the engine-prompt form and strips the reply instruction', () => {
    const parsed = parseAgentRelay({
      id: 'r3',
      role: 'notification',
      content: '📨 Message from session abc-123 (jinn-dev) [hop 3/12]:\n\nTypecheck is green.\n\nTo reply: send_to_session { sessionId: "abc-123" }. If this exchange is going in circles, stop.',
      timestamp: 1,
    })
    expect(parsed).toMatchObject({ fromLabel: 'jinn-dev', hops: 3, text: 'Typecheck is green.' })
  })

  it('does not claim ordinary notifications or user messages', () => {
    expect(parseAgentRelay({ id: 'n', role: 'notification', content: 'Usage limit reached.', timestamp: 1 })).toBeNull()
    expect(parseAgentRelay({ id: 'u', role: 'user', content: '📨 From x: hi', timestamp: 1 })).toBeNull()
  })

  it('renders collapsed with a hop badge and expands to the message body', () => {
    const messages: Message[] = [{
      id: 'relay',
      role: 'notification',
      content: '📨 From growth-ops [hop 2/12]: Cross-reference the drop-off complaints against the flag gaps.',
      timestamp: 100,
    }]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)

    expect(container.querySelector('[data-comms-state="relay"]')).toBeTruthy()
    expect(container.querySelector('.notification-msg-bubble')).toBeNull()
    expect(screen.getByText('messaged')).toBeTruthy()
    expect(screen.getByText('hop 2')).toBeTruthy()
    expect(screen.queryByText(/📨/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText(/Cross-reference the drop-off complaints/)).toBeTruthy()
  })

  it('hides the hop badge for first-hop sends', () => {
    const messages: Message[] = [{
      id: 'relay',
      role: 'notification',
      content: '📨 From market-scout: Fresh threads found.',
      timestamp: 100,
    }]
    render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.queryByText(/hop/)).toBeNull()
  })
})

describe('dispatch rows', () => {
  it('lifts send_to_session tool calls out of the tool group as a generic dispatch row', () => {
    const messages: Message[] = [
      { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: 100, toolCall: 'file_read' },
      { id: 't2', role: 'assistant', content: 'Used send_to_session', timestamp: 101, toolCall: 'mcp__jinn__send_to_session' },
      { id: 't3', role: 'assistant', content: 'Used file_edit', timestamp: 102, toolCall: 'file_edit' },
    ]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)

    const dispatch = container.querySelector('[data-dispatch="generic"]')
    expect(dispatch).toBeTruthy()
    expect(dispatch!.textContent).toContain('Messaged')
    expect(dispatch!.textContent).toContain('another session')
    // The surrounding tool calls stay grouped (as two split groups of one).
    expect(screen.getAllByText(/1 tool/).length).toBe(2)
  })

  it('skips raw send_to_session calls when a structured dispatch block exists', () => {
    const messages: Message[] = [
      { id: 't1', role: 'assistant', content: 'Used send_to_session', timestamp: 100, toolCall: 'send_to_session' },
      {
        id: 'b1',
        role: 'assistant',
        content: 'Followed up',
        timestamp: 101,
        blocks: [{
          id: 'dp-1',
          type: 'dispatch',
          version: 1,
          status: 'done',
          payload: {
            targetSessionId: 'child-9',
            employee: 'jinn-dev',
            employeeDisplay: 'Jinn Dev',
            preview: 'Also check the mobile breakpoint.',
            sentAt: 101,
          },
        }],
      },
    ]
    const onOpenThread = vi.fn()

    const { container } = render(
      <ChatMessages messages={messages} loading={false} onOpenThread={onOpenThread} />,
    )

    expect(container.querySelector('[data-dispatch="generic"]')).toBeNull()
    const linked = container.querySelector('[data-dispatch="linked"]')
    expect(linked).toBeTruthy()
    expect(linked!.textContent).toContain('Followed up')
    expect(linked!.textContent).toContain('Jinn Dev')
    expect(linked!.textContent).toContain('Also check the mobile breakpoint.')
    fireEvent.click(linked as HTMLElement)
    expect(onOpenThread).toHaveBeenCalledWith('child-9')
  })
})

describe('dispatch block inline', () => {
  it('renders a linked dispatch block row', () => {
    const onOpenThread = vi.fn()
    render(
      <ChatBlockInline
        onOpenThread={onOpenThread}
        block={{
          id: 'dp-2',
          type: 'dispatch',
          version: 1,
          status: 'done',
          payload: {
            targetSessionId: 'child-7',
            employee: 'analyst',
            employeeDisplay: 'Analyst',
            preview: 'Pull the 28-day baseline.',
            sentAt: 1,
          },
        }}
      />,
    )
    const row = screen.getByRole('button', { name: /Followed up with Analyst/ })
    fireEvent.click(row)
    expect(onOpenThread).toHaveBeenCalledWith('child-7')
  })
})
