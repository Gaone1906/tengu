import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { parseTeammateReply } from '../teammate-reply'
import type { Message } from '@/lib/conversations'

describe('teammate replies', () => {
  it('prefers structured callback metadata and preserves its thread target', () => {
    const message: Message = {
      id: 'reply',
      role: 'notification',
      content: '📩 design-lead replied\nCanvas direction is ready.',
      timestamp: 1_780_000_000_000,
      meta: {
        kind: 'child-reply',
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        childSessionId: 'child-123',
      },
    }

    expect(parseTeammateReply(message)).toEqual({
      kind: 'reply',
      employee: 'design-lead',
      employeeDisplay: 'Design Lead',
      childSessionId: 'child-123',
      preview: 'Canvas direction is ready.',
    })
  })

  it('parses only anchored historical callback shapes', () => {
    expect(parseTeammateReply({
      id: 'legacy',
      role: 'notification',
      content: '📩 Design Lead replied\nLegacy preview',
      timestamp: 1,
    })).toMatchObject({ kind: 'reply', employeeDisplay: 'Design Lead', preview: 'Legacy preview' })

    expect(parseTeammateReply({
      id: 'error',
      role: 'notification',
      content: "⚠️ Platform Engineer couldn't finish\nBuild failed.",
      timestamp: 1,
    })).toMatchObject({ kind: 'error', employeeDisplay: 'Platform Engineer', preview: 'Build failed.' })

    expect(parseTeammateReply({
      id: 'other',
      role: 'notification',
      content: 'Notice: 📩 Design Lead replied\nNot anchored',
      timestamp: 1,
    })).toBeNull()
  })

  it('renders a reply as a third voice and opens the child thread', () => {
    const onOpenThread = vi.fn()
    const messages: Message[] = [{
      id: 'reply',
      role: 'notification',
      content: '📩 design-lead replied\nCanvas **direction** is ready.',
      timestamp: Date.now(),
      meta: {
        kind: 'child-reply',
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        childSessionId: 'child-123',
      },
    }]

    const { container } = render(
      <ChatMessages messages={messages} loading={false} onOpenThread={onOpenThread} />,
    )

    expect(screen.getByText('Design Lead')).toBeTruthy()
    expect(screen.getByText(/· replied ·/)).toBeTruthy()
    expect(screen.getByText('direction').tagName).toBe('STRONG')
    expect(screen.queryByText(/📩/)).toBeNull()
    expect(container.querySelector('.notification-msg-bubble')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Design Lead thread' }))
    expect(onOpenThread).toHaveBeenCalledWith('child-123')
  })

  it("renders errors with a tinted rail label while ordinary notifications keep the banner", () => {
    const messages: Message[] = [
      {
        id: 'error',
        role: 'notification',
        content: "⚠️ platform-engineer couldn't finish\nThe build failed.",
        timestamp: 100,
        meta: {
          kind: 'child-error',
          employee: 'platform-engineer',
          employeeDisplay: 'Platform Engineer',
          childSessionId: 'child-456',
        },
      },
      {
        id: 'rate-limit',
        role: 'notification',
        content: 'Usage limit reached; retrying later.',
        timestamp: 101,
      },
    ]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)

    expect(screen.getByText("Couldn't finish")).toBeTruthy()
    expect(screen.getByText('The build failed.')).toBeTruthy()
    expect(container.querySelector('[data-teammate-state="error"]')).toBeTruthy()
    expect(screen.getByText('Usage limit reached; retrying later.').closest('.notification-msg-bubble')).toBeTruthy()
  })
})
