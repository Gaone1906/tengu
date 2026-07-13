import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

/**
 * The pre-first-token "Thinking" indicator must share the established assistant
 * content edge: its leading edge equals the `.assistant-msg-row` gutter, exactly
 * like assistant prose (AssistantRowShell), with no extra nested inset.
 *
 * jsdom does not lay out pixels, so we prove the edge structurally: no element
 * between `.assistant-msg-row` and the "Thinking" label may add a left-padding
 * utility (which would shift the content past the gutter). Assistant prose has
 * none, so the indicator must have none either.
 */
describe('Thinking indicator alignment', () => {
  it('does not inset the indicator past the assistant content gutter', () => {
    const messages: Message[] = [{ id: 'u1', role: 'user', content: 'Hi', timestamp: 1 }]
    render(
      <MemoryRouter>
        <ChatMessages messages={messages} loading />
      </MemoryRouter>,
    )

    const label = screen.getByText('Thinking')
    const row = label.closest('.assistant-msg-row')
    expect(row).not.toBeNull()

    // Walk the ancestor chain from the label up to (excluding) the gutter row.
    const insetting: string[] = []
    let el: HTMLElement | null = label as HTMLElement
    while (el && el !== row) {
      for (const cls of Array.from(el.classList)) {
        if (/^pl-/.test(cls) || /^ps-/.test(cls) || /^px-/.test(cls)) insetting.push(cls)
      }
      el = el.parentElement
    }

    expect(insetting).toEqual([])
  })
})
