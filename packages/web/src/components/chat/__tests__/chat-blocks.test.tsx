import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatBlockInline } from '../chat-blocks'
import type { ChatBlock } from '@/lib/blocks'
import { delegationStateForBlock } from '../handoff-card'

describe('ChatBlockInline', () => {
  it('renders a task-list block with status rows', () => {
    const block: ChatBlock = {
      id: 'plan',
      type: 'task-list',
      version: 1,
      title: 'Plan',
      status: 'running',
      payload: {
        items: [
          { id: 'a', text: 'Read code', status: 'done' },
          { id: 'b', text: 'Patch UI', status: 'running' },
        ],
      },
    }
    render(<ChatBlockInline block={block} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Read code')).toBeTruthy()
    expect(screen.getByText('Patch UI')).toBeTruthy()
  })

  it('maps and renders a working delegation as one preview card', () => {
    const onPeek = vi.fn()
    const block = {
      id: 'dg-wi_123',
      type: 'delegation',
      version: 1,
      status: 'running',
      payload: {
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        title: 'Redesign the workflow canvas as a spatial node editor',
        childSessionId: 'child-123',
        workItemId: 'wi_123',
        dispatchedAt: Date.now() - 120_000,
      },
    } as ChatBlock

    expect(delegationStateForBlock(block)).toMatchObject({ state: 'working', label: 'Working' })
    render(<ChatBlockInline block={block} onPeek={onPeek} />)

    const card = screen.getByRole('button', { name: 'Design Lead, working. Open preview.' })
    expect(screen.getByText('handed off')).toBeTruthy()
    expect(screen.getByText('Working · 2m')).toBeTruthy()
    fireEvent.click(card)
    expect(onPeek).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'delegation',
      employee: 'design-lead',
      sessionId: 'child-123',
      messageId: 'dg-wi_123',
    }))
  })

  it('maps terminal delegation states without changing card anatomy', () => {
    const done = {
      id: 'dg-wi_123',
      type: 'delegation',
      version: 1,
      status: 'done',
      payload: { repliedAt: 2_020, dispatchedAt: 1_000 },
    } as ChatBlock
    const failed = { ...done, status: 'error' } as ChatBlock

    expect(delegationStateForBlock(done)).toMatchObject({ state: 'replied', label: 'Replied' })
    expect(delegationStateForBlock(failed)).toMatchObject({ state: 'error', label: "Couldn't finish" })
  })

  it('maps waiting to a static orange Waiting state with stable elapsed copy', () => {
    const waiting = {
      id: 'dg-waiting',
      type: 'delegation',
      version: 2,
      status: 'waiting',
      payload: { dispatchedAt: Date.now() - 180_000 },
    } as ChatBlock

    expect(delegationStateForBlock(waiting)).toMatchObject({ state: 'waiting', label: 'Waiting' })
    const { container } = render(<ChatBlockInline block={waiting} />)
    expect(screen.getByText('Waiting · 3m')).toBeTruthy()
    expect(container.querySelector('[data-state-line="waiting"]')?.innerHTML).toContain('bg-[var(--system-orange)]')
  })

  it('renders a quiet non-interactive object when no valid child target exists', () => {
    const block = {
      id: 'dg-no-target',
      type: 'delegation',
      version: 1,
      status: 'running',
      payload: { employee: 'design-lead', employeeDisplay: 'Design Lead', title: 'Audit the surface' },
    } as ChatBlock

    const { container } = render(<ChatBlockInline block={block} onPeek={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[data-handoff-interactive="false"]')).toBeTruthy()
    expect(container.querySelector('svg.lucide-chevron-right')).toBeNull()
  })

  it('applies the one-time delegation arrival wrapper with the supplied capped delay', () => {
    const block = {
      id: 'dg-arrival', type: 'delegation', version: 1, status: 'running',
      payload: { employee: 'design-lead', childSessionId: 'child-arrival', title: 'Start work' },
    } as ChatBlock
    const { container } = render(
      <ChatBlockInline block={block} onPeek={vi.fn()} arrival={{ nonce: 3, delayMs: 120 }} />,
    )
    const wrapper = container.querySelector('[data-delegation-arrival="3"]') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(wrapper.style.getPropertyValue('--delegation-arrival-delay')).toBe('120ms')
  })

  it('uses the mobile-safe two-line clamp for a long title at 390px', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const longTitle = 'Research a deliberately long mobile delegation title that would otherwise wrap onto three or four visible lines'
    const block = {
      id: 'dg-mobile',
      type: 'delegation',
      version: 1,
      status: 'running',
      payload: {
        employee: 'design-lead',
        employeeDisplay: 'Design Lead',
        title: longTitle,
        childSessionId: 'child-mobile',
        workItemId: 'wi-mobile',
        dispatchedAt: Date.now(),
      },
    } as ChatBlock

    render(<ChatBlockInline block={block} />)

    const title = screen.getByText(longTitle)
    expect(window.innerWidth).toBe(390)
    expect(title.classList).toContain('line-clamp-2')
    expect(title.classList).not.toContain('block')
    expect(title.classList).not.toContain('[display:-webkit-box]')
  })
})
