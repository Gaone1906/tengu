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

  it('maps and renders a working delegation as one open-thread card', () => {
    const onOpenThread = vi.fn()
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
    render(<ChatBlockInline block={block} onOpenThread={onOpenThread} />)

    const card = screen.getByRole('button', { name: 'Design Lead, working. Open thread.' })
    expect(screen.getByText('handed off')).toBeTruthy()
    expect(screen.getByText('Working · 2m')).toBeTruthy()
    fireEvent.click(card)
    expect(onOpenThread).toHaveBeenCalledWith('child-123')
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
