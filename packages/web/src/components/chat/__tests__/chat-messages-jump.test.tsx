import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

const stickState = {
  showJump: true,
  unreadCount: 0,
  scrollToBottom: vi.fn(),
}

vi.mock('@/hooks/use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    containerRef: vi.fn(),
    showJump: stickState.showJump,
    unreadCount: stickState.unreadCount,
    scrollToBottom: stickState.scrollToBottom,
  }),
}))

const messages: Message[] = [{
  id: 'm1',
  role: 'assistant',
  content: 'Latest answer',
  timestamp: 100,
}]

afterEach(() => {
  stickState.showJump = true
  stickState.unreadCount = 0
  stickState.scrollToBottom.mockReset()
  vi.useRealTimers()
})

describe('ChatMessages jump affordance', () => {
  it('pins the jump control to the visible scrollport instead of the scrollable transcript', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: /jump to latest/i })
    const scroller = document.querySelector('.chat-messages-scroll')
    expect(scroller).toBeTruthy()
    expect(scroller?.contains(jump)).toBe(false)
  })

  it('uses an icon-only visible action with the label kept for accessibility', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(within(jump).queryByText(/jump to latest/i)).toBeNull()
  })

  it('shows only a compact numeric unread badge when detached messages accumulate', () => {
    stickState.unreadCount = 3

    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: /3 new messages/i })
    const badge = within(jump).getByText('3')
    expect(badge.className).toContain('absolute')
    expect(within(jump).queryByText(/new messages/i)).toBeNull()
  })

  it('keeps the jump control mounted briefly for an exit animation', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy()

    stickState.showJump = false
    rerender(<ChatMessages messages={messages} loading={false} />)

    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    const exiting = document.querySelector('[data-state="exiting"]') as HTMLButtonElement | null
    expect(exiting).toBeTruthy()
    expect(exiting?.getAttribute('aria-hidden')).toBe('true')
    expect(exiting?.getAttribute('tabindex')).toBe('-1')

    act(() => { vi.runAllTimers() })
    expect(document.querySelector('[data-state="exiting"]')).toBeNull()
  })
})
