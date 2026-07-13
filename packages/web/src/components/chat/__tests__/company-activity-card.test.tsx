import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { CompanyActivityCard } from '../company-activity-card'
import type { ChatBlock } from '@/lib/blocks'

function runBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: 'workflow-run:release-review:run-20260712010101-abcd1234',
    type: 'workflow-run',
    version: 3,
    status: 'waiting',
    title: 'Release review',
    summary: 'Waiting for approval',
    payload: {
      workflowId: 'release-review',
      runId: 'run-20260712010101-abcd1234',
      action: 'started',
      runStatus: 'parked',
      startedAt: '2026-07-12T01:01:01.000Z',
      endedAt: null,
      completedSteps: 1,
      totalSteps: 3,
      parkedDescription: 'Approve the release candidate',
      preview: 'Build verified, artifacts staged for review',
      openPath: '/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234',
    },
    ...overrides,
  }
}

function todoBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: 'todo:wi_release',
    type: 'todo-activity',
    version: 2,
    status: 'waiting',
    title: 'Prepare release',
    summary: 'In review',
    payload: {
      todoId: 'wi_release',
      action: 'transitioned',
      status: 'in_review',
      assignee: 'designer',
      updatedAt: '2026-07-12T01:00:00.000Z',
    },
    ...overrides,
  }
}

function definitionBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: 'workflow-definition:release-review',
    type: 'workflow-definition',
    version: 4,
    status: 'completed',
    title: 'Release review',
    summary: 'Updated to v4',
    payload: {
      workflowId: 'release-review',
      action: 'updated',
      definitionStatus: 'active',
      openPath: '/workflow/release-review?mode=edit',
    },
    ...overrides,
  }
}

interface Harness {
  router: ReturnType<typeof createMemoryRouter>
}

function renderCard(block: ChatBlock): Harness {
  const router = createMemoryRouter(
    [
      { path: '/', element: <CompanyActivityCard block={block} /> },
      { path: '/todos', element: <div>Todos page</div> },
      { path: '/workflow/:id', element: <div>Workflow page</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  return { router }
}

describe('CompanyActivityCard', () => {
  it('renders a workflow-run object with title, kind, and honest state', () => {
    renderCard(runBlock())
    expect(screen.getByText('Release review')).toBeTruthy()
    expect(screen.getByText('Workflow run')).toBeTruthy()
    expect(screen.getByText(/Waiting for approval/)).toBeTruthy()
    expect(screen.getByText(/1 of 3 steps/)).toBeTruthy()
  })

  it('Preview is a collapsed disclosure that opens bounded evidence in place', async () => {
    const user = userEvent.setup()
    renderCard(runBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    expect(preview.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Release review workflow run details' })).toBeNull()

    await user.click(preview)
    expect(preview.getAttribute('aria-expanded')).toBe('true')
    const region = screen.getByRole('region', { name: 'Release review workflow run details' })
    expect(region.textContent).toContain('Approve the release candidate')
  })

  it('Open navigates to the deep link preserving workflowId and runId', async () => {
    const user = userEvent.setup()
    const { router } = renderCard(runBlock())
    await user.click(screen.getByRole('button', { name: 'Open Release review workflow run' }))
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234',
    )
  })

  it('renders a failed run with a bounded error inside Preview', async () => {
    const user = userEvent.setup()
    const longError = `Deploy step exited 1: ${'x'.repeat(6000)}`
    renderCard(runBlock({
      status: 'error',
      summary: 'Failed',
      payload: {
        ...runBlock().payload,
        runStatus: 'failed',
        completedSteps: 2,
        endedAt: '2026-07-12T02:14:00.000Z',
        latestError: longError,
      },
    }))
    expect(screen.getByText(/Failed/)).toBeTruthy()
    expect(screen.getByText(/2 of 3 steps/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Preview Release review workflow run' }))
    const region = screen.getByRole('region', { name: 'Release review workflow run details' })
    expect(region.textContent).toContain('Deploy step exited 1')
  })

  it('renders a Todo object and Open routes to the ledger without the canonical id in the URL', async () => {
    const user = userEvent.setup()
    const { router } = renderCard(todoBlock())
    expect(screen.getByText('Prepare release')).toBeTruthy()
    expect(screen.getByText('Todo')).toBeTruthy()
    expect(screen.getByText(/In review/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open Prepare release todo' }))
    expect(router.state.location.pathname).toBe('/todos')
    expect(router.state.location.search).not.toContain('wi_release')
  })

  it('renders a workflow-definition object and Open routes to the editor', async () => {
    const user = userEvent.setup()
    const { router } = renderCard(definitionBlock())
    expect(screen.getByText('Workflow')).toBeTruthy()
    expect(screen.getByText(/Updated to v4/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open Release review workflow' }))
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/workflow/release-review?mode=edit',
    )
  })

  it('tolerates absent optional data without crashing', () => {
    renderCard(runBlock({
      status: 'running',
      payload: {
        workflowId: 'release-review',
        runId: 'run-x',
        action: 'started',
        runStatus: 'running',
      },
    }))
    expect(screen.getByText('Workflow run')).toBeTruthy()
  })

  it('renders no resting hairline border on the card surface', () => {
    renderCard(runBlock())
    const card = document.querySelector('[data-block-id]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).not.toMatch(/\bborder\b/)
  })

  it('Preview is keyboard operable', async () => {
    const user = userEvent.setup()
    renderCard(runBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    preview.focus()
    expect(document.activeElement).toBe(preview)
    await user.keyboard('{Enter}')
    expect(preview.getAttribute('aria-expanded')).toBe('true')
  })
})
