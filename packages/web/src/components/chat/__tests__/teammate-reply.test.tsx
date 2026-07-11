import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { cleanLikeGateway, parseTeammateReply } from '../teammate-reply'
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

  it('arrives collapsed to one line and expands on tap to the rail body', () => {
    const onOpenThread = vi.fn()
    const { container } = render(
      <ChatMessages messages={[replyMessage()]} loading={false} onOpenThread={onOpenThread} />,
    )

    // Collapsed: attribution + meta + hint, no rail body, no 📩 glyph.
    expect(screen.getByText('Design Lead')).toBeTruthy()
    expect(screen.getByText('replied')).toBeTruthy()
    expect(screen.queryByText(/📩/)).toBeNull()
    expect(container.querySelector('.notification-msg-bubble')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Design Lead thread' })).toBeNull()

    const head = screen.getByRole('button', { expanded: false })
    fireEvent.click(head)

    // Expanded: markdown body + thread action.
    expect(screen.getByText('direction').tagName).toBe('STRONG')
    fireEvent.click(screen.getByRole('button', { name: 'Open Design Lead thread' }))
    expect(onOpenThread).toHaveBeenCalledWith('child-123')
  })

  it('renders the meta words with symmetric rendered dot separators, not glyph dots', () => {
    const { container } = render(<ChatMessages messages={[replyMessage()]} loading={false} />)
    const callout = container.querySelector('[data-comms-state="reply"]')
    expect(callout).toBeTruthy()
    expect(callout!.textContent).not.toContain('·')
    // Two meta words → two rendered separator dots.
    expect(callout!.querySelectorAll('span[aria-hidden="true"].rounded-full').length).toBe(2)
  })

  it("swaps in the child session's full final message on expand", async () => {
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

    render(
      <ChatMessages
        messages={[replyMessage({ content: `📩 design-lead replied\n${preview}` })]}
        loading={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    await waitFor(() => {
      expect(screen.getByText(/Full detail: the spatial layout/)).toBeTruthy()
    })
    expect(getSession).toHaveBeenCalledWith('child-123', { last: 40 })
  })

  it('keeps the preview when no child message matches the callback provenance', async () => {
    getSession.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'A completely different newer reply.' }],
    })

    render(<ChatMessages messages={[replyMessage()]} loading={false} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(screen.getByText('direction').tagName).toBe('STRONG')
    expect(screen.queryByText(/completely different newer reply/)).toBeNull()
  })

  it('renders errors with the tinted meta + rail while ordinary notifications keep the banner', () => {
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

    expect(container.querySelector('[data-comms-state="error"]')).toBeTruthy()
    expect(screen.getByText("couldn't finish")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText("Couldn't finish")).toBeTruthy()
    expect(screen.getByText('The build failed.')).toBeTruthy()
    expect(getSession).not.toHaveBeenCalled()

    expect(screen.getByText('Usage limit reached; retrying later.').closest('.notification-msg-bubble')).toBeTruthy()
  })
})
