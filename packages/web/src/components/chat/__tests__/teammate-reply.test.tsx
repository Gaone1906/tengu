import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatMessages, formatMessage } from '../chat-messages'
import { cleanLikeGateway, parseTeammateReply } from '../teammate-reply'
import { ThreadPeek, type CommsPeekData } from '../thread-peek'
import { api } from '@/lib/api'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn() },
}))

const getSession = vi.mocked(api.getSession)

function replyMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `reply-${Math.random().toString(36).slice(2)}`,
    role: 'notification',
    content: '📩 design-lead replied\nCanvas **direction** is ready.',
    timestamp: 1_780_000_000_000,
    meta: {
      kind: 'child-reply',
      employee: 'design-lead',
      employeeDisplay: 'Design Lead',
      childSessionId: 'child-123',
    },
    ...overrides,
  }
}

function peekFor(message: Message): CommsPeekData {
  const data = parseTeammateReply(message)!
  return {
    kind: data.kind,
    employee: data.employee,
    displayName: data.employeeDisplay,
    sessionId: data.childSessionId,
    messageId: message.id,
    timestamp: message.timestamp,
    preview: data.preview,
    fullMessage: data.fullMessage,
  }
}

beforeEach(() => {
  getSession.mockReset()
  getSession.mockResolvedValue({ messages: [] })
})

describe('teammate replies', () => {
  it('prefers structured callback metadata and preserves its thread target', () => {
    expect(parseTeammateReply(replyMessage({ id: 'reply' }))).toEqual({
      kind: 'reply',
      employee: 'design-lead',
      employeeDisplay: 'Design Lead',
      childSessionId: 'child-123',
      preview: 'Canvas **direction** is ready.',
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

  it('parses meta.fullMessage onto the callback data', () => {
    expect(parseTeammateReply(replyMessage({
      id: 'reply-full',
      meta: {
        kind: 'child-reply',
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        childSessionId: 'child-123',
        fullMessage: 'The whole reply.',
      },
    }))).toMatchObject({ kind: 'reply', childSessionId: 'child-123', fullMessage: 'The whole reply.' })
  })

  it('renders the T1 ledger line: chip + name + gist, no meta verb, no expand-in-place', () => {
    const { container } = render(<ChatMessages messages={[replyMessage()]} loading={false} onPeek={vi.fn()} />)

    // One line: name + stripped-markdown gist. The "replied" verb is cut —
    // an employee voice appearing in the thread IS a reply.
    expect(screen.getByText('Design Lead')).toBeTruthy()
    expect(screen.getByText('Canvas direction is ready.')).toBeTruthy()
    expect(screen.queryByText('replied')).toBeNull()
    expect(screen.queryByText(/📩/)).toBeNull()
    expect(container.querySelector('.notification-msg-bubble')).toBeNull()

    // The row is a drill-in, not a disclosure: no aria-expanded anywhere.
    const row = screen.getByRole('button', { name: /Design Lead replied.*Open report/ })
    expect(row.getAttribute('aria-expanded')).toBeNull()
    expect(container.querySelector('[data-comms-state="reply"]')).toBeTruthy()
  })

  it('opens the report peek with the callback payload on click', () => {
    const onPeek = vi.fn()
    const message = replyMessage({ id: 'reply-1' })
    render(<ChatMessages messages={[message]} loading={false} onPeek={onPeek} />)

    fireEvent.click(screen.getByRole('button', { name: /Open report/ }))
    expect(onPeek).toHaveBeenCalledWith({
      kind: 'reply',
      employee: 'design-lead',
      displayName: 'Design Lead',
      sessionId: 'child-123',
      messageId: 'reply-1',
      timestamp: message.timestamp,
      preview: 'Canvas **direction** is ready.',
      fullMessage: undefined,
    })
  })

  it('falls back to opening the thread directly when no peek surface is mounted', () => {
    const onOpenThread = vi.fn()
    render(<ChatMessages messages={[replyMessage()]} loading={false} onOpenThread={onOpenThread} />)
    fireEvent.click(screen.getByRole('button', { name: /Open report/ }))
    expect(onOpenThread).toHaveBeenCalledWith('child-123')
  })

  it('renders errors as a tinted ledger line while ordinary notifications keep the banner', () => {
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

    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    expect(container.querySelector('[data-comms-state="error"]')).toBeTruthy()
    expect(screen.getByText('The build failed.')).toBeTruthy()
    expect(getSession).not.toHaveBeenCalled()
    expect(screen.getByText('Usage limit reached; retrying later.').closest('.notification-msg-bubble')).toBeTruthy()
  })
})

describe('report peek panel', () => {
  it('renders meta.fullMessage with ZERO fetches — surviving child-session deletion', () => {
    getSession.mockRejectedValue(new Error('404 session not found'))
    const fullMessage = [
      'Canvas **direction** is ready.',
      '',
      'Second paragraph the 220-char preview clipped away entirely.',
    ].join('\n')
    const message = replyMessage({
      id: 'reply-full',
      meta: {
        kind: 'child-reply',
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        childSessionId: 'child-deleted',
        fullMessage,
      },
    })

    render(
      <ThreadPeek peek={peekFor(message)} onClose={vi.fn()} onOpenFullChat={vi.fn()} renderContent={formatMessage} />,
    )

    expect(screen.getByText(/Second paragraph the 220-char preview/)).toBeTruthy()
    expect(screen.getByText('direction').tagName).toBe('STRONG')
    expect(getSession).not.toHaveBeenCalled()
  })

  it("lazy-fetches the child's full final message for legacy callbacks (provenance match)", async () => {
    const fullReply = [
      'Canvas **direction** is ready.',
      '',
      'Full detail: the spatial layout keeps left-in/right-out port discipline and the nodes clamp to fixed line counts.',
    ].join('\n')
    const preview = cleanLikeGateway(fullReply)
    getSession.mockResolvedValue({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: fullReply },
      ],
    })
    const message = replyMessage({ id: 'reply-legacy', content: `📩 design-lead replied\n${preview}` })

    render(
      <ThreadPeek peek={peekFor(message)} onClose={vi.fn()} onOpenFullChat={vi.fn()} renderContent={formatMessage} />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Full detail: the spatial layout/)).toBeTruthy()
    })
    expect(getSession).toHaveBeenCalledWith('child-123', { last: 40 })
  })

  it('keeps the preview when no child message matches the callback provenance', async () => {
    getSession.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'A completely different newer reply.' }],
    })
    const message = replyMessage({ id: 'reply-stale' })

    render(
      <ThreadPeek peek={peekFor(message)} onClose={vi.fn()} onOpenFullChat={vi.fn()} renderContent={formatMessage} />,
    )

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(screen.getByText('direction').tagName).toBe('STRONG')
    expect(screen.queryByText(/completely different newer reply/)).toBeNull()
  })

  it('commits "Open full chat" through the nav chain after the grow beat', () => {
    vi.useFakeTimers()
    try {
      const onOpenFullChat = vi.fn()
      const message = replyMessage({
        id: 'reply-commit',
        meta: {
          kind: 'child-reply',
          employee: 'design-lead',
          employeeDisplay: 'Design Lead',
          childSessionId: 'child-123',
          fullMessage: 'Full report.',
        },
      })
      const { container } = render(
        <ThreadPeek peek={peekFor(message)} onClose={vi.fn()} onOpenFullChat={onOpenFullChat} renderContent={formatMessage} />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
      // The surface grows into the full conversation first…
      expect(container.querySelector('[data-peek-phase="commit"]')).toBeTruthy()
      expect(onOpenFullChat).not.toHaveBeenCalled()
      // …then the navigation commits through the existing nav model.
      vi.advanceTimersByTime(400)
      expect(onOpenFullChat).toHaveBeenCalledWith('child-123')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is read-only: no composer, and closes via Escape', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      const message = replyMessage({ id: 'reply-ro' })
      const { container } = render(
        <ThreadPeek peek={peekFor(message)} onClose={onClose} onOpenFullChat={vi.fn()} renderContent={formatMessage} />,
      )

      expect(screen.getByText('Read-only')).toBeTruthy()
      expect(container.querySelector('textarea')).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Design Lead report' })).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(onClose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides "Open full chat" for legacy rows without a session id', () => {
    const message: Message = {
      id: 'legacy',
      role: 'notification',
      content: '📩 Design Lead replied\nLegacy preview',
      timestamp: 1,
    }
    render(
      <ThreadPeek peek={peekFor(message)} onClose={vi.fn()} onOpenFullChat={vi.fn()} renderContent={formatMessage} />,
    )
    expect(screen.queryByRole('button', { name: 'Open full chat' })).toBeNull()
    expect(screen.getByText('Legacy preview')).toBeTruthy()
    expect(getSession).not.toHaveBeenCalled()
  })
})
