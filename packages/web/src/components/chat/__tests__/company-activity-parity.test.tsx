import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import {
  applyBlockEnvelopeToMessages,
  blockFallbackContent,
  isBlockEnvelope,
  type ChatBlock,
  type ChatBlockEnvelope,
} from '@/lib/blocks'
import type { Message } from '@/lib/conversations'

function runBlock(version: number, over: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: 'workflow-run:release-review:run-20260712010101-abcd1234',
    type: 'workflow-run',
    version,
    status: 'waiting',
    title: 'Release review',
    summary: 'Waiting for approval',
    payload: {
      workflowId: 'release-review',
      runId: 'run-20260712010101-abcd1234',
      action: 'started',
      runStatus: 'parked',
      completedSteps: 1,
      totalSteps: 3,
      parkedDescription: 'Approve the release candidate',
      openPath: '/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234',
    },
    ...over,
  }
}

function renderRouted(messages: Message[]) {
  return render(
    <MemoryRouter>
      <ChatMessages messages={messages} loading={false} />
    </MemoryRouter>,
  )
}

describe('company activity block parity', () => {
  it('renders an unknown future block type through its persisted fallback text', () => {
    const futureEnvelope = {
      op: 'put',
      block: {
        id: 'future-thing:1',
        type: 'galaxy-brain',
        version: 1,
        status: 'running',
        title: 'Something new',
        payload: { note: 'from a newer gateway' },
      },
    }
    // The web guard rejects the unknown type, so it never renders as a card…
    expect(isBlockEnvelope(futureEnvelope)).toBe(false)
    // …but the server-authored fallback text still reaches the reader as prose.
    const messages: Message[] = [{
      id: 'm-future',
      role: 'assistant',
      content: 'Something new · from a newer gateway',
      timestamp: 100,
    }]
    renderRouted(messages)
    expect(screen.getByText('Something new · from a newer gateway')).toBeTruthy()
  })

  it('patches the same block in place without appending a second message', () => {
    const put: ChatBlockEnvelope = { op: 'put', block: runBlock(3) }
    let messages = applyBlockEnvelopeToMessages([], put, blockFallbackContent(put.block), 1000)
    expect(messages).toHaveLength(1)

    const patch: ChatBlockEnvelope = {
      op: 'patch',
      block: runBlock(4, {
        status: 'completed',
        summary: 'Completed',
        payload: {
          workflowId: 'release-review',
          runId: 'run-20260712010101-abcd1234',
          action: 'completed',
          runStatus: 'completed',
          completedSteps: 3,
          totalSteps: 3,
        },
      }),
    }
    messages = applyBlockEnvelopeToMessages(messages, patch, blockFallbackContent(patch.block), 1001)
    // The live patch updates the SAME message id — no duplicate row.
    expect(messages).toHaveLength(1)

    renderRouted(messages)
    expect(screen.getByText(/Completed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Release review workflow run' })).toBeTruthy()
  })

  it('shows identical text and accessible names for a live patch and an API reload', () => {
    // Live path: put then patch through the reducer.
    const live = applyBlockEnvelopeToMessages(
      applyBlockEnvelopeToMessages([], { op: 'put', block: runBlock(3) }, blockFallbackContent(runBlock(3)), 1000),
      { op: 'patch', block: runBlock(4, { status: 'completed', payload: { ...runBlock(4).payload, runStatus: 'completed', completedSteps: 3 } }) },
      '',
      1001,
    )

    // Reload path: the server delivers the settled block already attached.
    const reloadBlock = runBlock(4, { status: 'completed', payload: { ...runBlock(4).payload, runStatus: 'completed', completedSteps: 3 } })
    const reload: Message[] = [{
      id: 'block-msg',
      role: 'assistant',
      content: blockFallbackContent(reloadBlock),
      timestamp: 2000,
      blocks: [reloadBlock],
    }]

    const liveRender = renderRouted(live)
    const liveOpen = liveRender.getByRole('button', { name: 'Open Release review workflow run' })
    expect(liveOpen).toBeTruthy()
    const liveState = liveRender.getByText(/Completed/).textContent
    liveRender.unmount()

    const reloadRender = renderRouted(reload)
    expect(reloadRender.getByRole('button', { name: 'Open Release review workflow run' })).toBeTruthy()
    expect(reloadRender.getByText(/Completed/).textContent).toBe(liveState)
  })
})
