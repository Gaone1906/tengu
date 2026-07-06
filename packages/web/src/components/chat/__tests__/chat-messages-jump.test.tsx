import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

  it('keeps the touch affordance at 40px and shrinks only for fine pointers', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(jump.className).toContain('h-10')
    expect(jump.className).toContain('w-10')
    expect(jump.className).toContain('[@media(pointer:fine)]:h-9')
    expect(jump.className).toContain('[@media(pointer:fine)]:w-9')
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

describe('ChatMessages older history loading', () => {
  it('loads older messages automatically near the top without exposing a top button', () => {
    const onLoadOlderMessages = vi.fn()
    render(
      <ChatMessages
        messages={messages}
        loading={false}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollTop', { value: 120, writable: true, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true })

    fireEvent.scroll(scroller)

    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /load older/i })).toBeNull()
  })

  it('preserves the visible message position when older messages are prepended', () => {
    const rects = new Map<string, { top: number; bottom: number }>()
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('chat-messages-scroll')) {
        return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) }
      }
      const id = this.getAttribute('data-message-id')
      const rect = id ? rects.get(id) : null
      if (rect) {
        return { ...rect, left: 0, right: 500, width: 500, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => ({}) }
      }
      return { top: 900, bottom: 940, left: 0, right: 500, width: 500, height: 40, x: 0, y: 900, toJSON: () => ({}) }
    })
    const onLoadOlderMessages = vi.fn()
    const initial: Message[] = [
      { id: 'm3', role: 'assistant', content: 'three', timestamp: 3 },
      { id: 'm4', role: 'assistant', content: 'four', timestamp: 4 },
    ]
    const older: Message[] = [
      { id: 'm1', role: 'assistant', content: 'one', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'two', timestamp: 2 },
      ...initial,
    ]
    rects.set('m3', { top: 40, bottom: 90 })
    const { rerender } = render(
      <ChatMessages
        messages={initial}
        loading={false}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollTop', { value: 120, writable: true, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true })

    fireEvent.scroll(scroller)

    rects.set('m3', { top: 640, bottom: 690 })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2600, writable: true, configurable: true })
    rerender(
      <ChatMessages
        messages={older}
        loading={false}
        hasOlderMessages={false}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    expect(scroller.scrollTop).toBe(720)
    rectSpy.mockRestore()
  })
})
