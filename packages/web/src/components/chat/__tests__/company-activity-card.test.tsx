import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { CompanyActivityCard } from '../company-activity-card'
import { ChatBlockInline } from '../chat-blocks'
import type { ChatBlock } from '@/lib/blocks'

// A private Todo whose canonical identity must never reach the rendered DOM.
// CANON is deliberately distinctive so a leak is unmistakable and no human-facing
// field (title/summary/facts) can coincidentally contain it.
const CANON = 'wi_PROBE_LEAK_CANARY'

function probeTodoBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: `todo:${CANON}`,
    type: 'todo-activity',
    version: 5,
    status: 'waiting',
    title: 'Sensitive matter',
    summary: 'In review',
    payload: {
      todoId: CANON,
      action: 'transitioned',
      status: 'in_review',
      assignee: 'legal',
      actor: 'counsel',
      updatedAt: '2026-07-12T01:00:00.000Z',
      preview: 'Reviewing the draft',
    },
    ...overrides,
  }
}

/** Every identity-bearing surface of a rendered subtree: markup, each element's
 * attribute values, all link targets, and visible text. */
function domSurfaces(root: HTMLElement) {
  const attrs: string[] = []
  const walk = (el: Element) => {
    for (const attr of Array.from(el.attributes)) attrs.push(`${attr.name}=${attr.value}`)
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
  const hrefs = Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '')
  return { outer: root.outerHTML, inner: root.innerHTML, text: root.textContent ?? '', attrs, hrefs }
}

function expectNoCanonicalId(root: HTMLElement) {
  const { outer, inner, text, attrs, hrefs } = domSurfaces(root)
  expect(outer).not.toContain(CANON)
  expect(inner).not.toContain(CANON)
  expect(text).not.toContain(CANON)
  for (const attr of attrs) expect(attr).not.toContain(CANON)
  for (const href of hrefs) expect(href).not.toContain(CANON)
}

function storageDump(store: Storage): string {
  let out = ''
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i) ?? ''
    out += `${key}=${store.getItem(key) ?? ''}\n`
  }
  return out
}

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

function renderPersistentCard(block: ChatBlock): Harness {
  const router = createMemoryRouter(
    [{ path: '*', element: <CompanyActivityCard block={block} /> }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  return { router }
}

describe('CompanyActivityCard', () => {
  afterEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

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

  it('never renders the canonical Todo id anywhere in the card DOM (markup, attributes, text, hrefs)', () => {
    const { container } = render(
      <MemoryRouter><CompanyActivityCard block={probeTodoBlock()} /></MemoryRouter>,
    )
    // The card's real, human-facing content still renders…
    expect(screen.getByText('Sensitive matter')).toBeTruthy()
    expect(screen.getByText('Todo')).toBeTruthy()
    // …but the canonical Todo identity appears on no rendered surface.
    expectNoCanonicalId(container as HTMLElement)
  })

  it('never leaks the canonical Todo id through the real chat block wrapper (ChatBlockInline)', () => {
    const { container } = render(
      <MemoryRouter><ChatBlockInline block={probeTodoBlock()} /></MemoryRouter>,
    )
    expect(screen.getByText('Sensitive matter')).toBeTruthy()
    expectNoCanonicalId(container as HTMLElement)
  })

  it('keeps the canonical Todo id out of the URL, history, and storage — at rest and after Open', async () => {
    const user = userEvent.setup()
    const router = createMemoryRouter(
      [
        { path: '/', element: <CompanyActivityCard block={probeTodoBlock()} /> },
        { path: '/todos', element: <div>Todos page</div> },
      ],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)

    const assertClean = () => {
      const loc = router.state.location
      expect(loc.pathname + loc.search + (loc.hash ?? '')).not.toContain(CANON)
      expect(JSON.stringify(loc.state ?? null)).not.toContain(CANON)
      expect(storageDump(window.sessionStorage)).not.toContain(CANON)
      expect(storageDump(window.localStorage)).not.toContain(CANON)
    }
    assertClean()

    // Open drills into the ledger by the hashed private ref only — never the id.
    await user.click(screen.getByRole('button', { name: 'Open Sensitive matter todo' }))
    expect(router.state.location.pathname).toBe('/todos')
    assertClean()
  })

  it('patches a todo card in place on same-id updates and replaces it on id change, never leaking the id', () => {
    const initial = probeTodoBlock()
    const { container, rerender } = render(
      <MemoryRouter><CompanyActivityCard key={initial.id} block={initial} /></MemoryRouter>,
    )
    const node1 = container.firstElementChild as HTMLElement
    expect(screen.getByText(/In review/i)).toBeTruthy()
    expectNoCanonicalId(container as HTMLElement)

    // Same block.id, new payload → React reconciles in place by its key (not by
    // any DOM attribute): the exact same root DOM node is patched.
    const patched = probeTodoBlock({ version: 6, payload: { ...probeTodoBlock().payload, status: 'done' } })
    rerender(<MemoryRouter><CompanyActivityCard key={patched.id} block={patched} /></MemoryRouter>)
    expect(container.firstElementChild).toBe(node1)
    expect(screen.getByText(/^Done$/)).toBeTruthy()
    expectNoCanonicalId(container as HTMLElement)

    // Different block.id → React remounts: the card is replaced with a new node.
    const replacement = probeTodoBlock({
      id: 'todo:wi_OTHER_CANARY',
      payload: { ...probeTodoBlock().payload, todoId: 'wi_OTHER_CANARY' },
    })
    rerender(<MemoryRouter><CompanyActivityCard key={replacement.id} block={replacement} /></MemoryRouter>)
    expect(container.firstElementChild).not.toBe(node1)
    expectNoCanonicalId(container as HTMLElement)
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

  it('opens a historical persisted definition receipt with a legacy path in the editor without rewriting it', async () => {
    const user = userEvent.setup()
    const historical = definitionBlock({
      payload: {
        ...definitionBlock().payload,
        openPath: '/workflow/release-review',
      },
    })
    const { router } = renderCard(historical)

    await user.click(screen.getByRole('button', { name: 'Open Release review workflow' }))

    expect(historical.payload.openPath).toBe('/workflow/release-review')
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/workflow/release-review?mode=edit',
    )
  })

  it.each([
    ['an external URL', 'https://example.invalid/workflow/release-review'],
    ['a different Workflow', '/workflow/other-workflow?mode=edit'],
    ['the wrong lens', '/workflow/release-review?mode=runs&run=run-other'],
  ])('does not let %s redirect a definition receipt away from its editor', async (_label, openPath) => {
    const user = userEvent.setup()
    const { router } = renderCard(definitionBlock({
      payload: { ...definitionBlock().payload, openPath },
    }))

    await user.click(screen.getByRole('button', { name: 'Open Release review workflow' }))

    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/workflow/release-review?mode=edit',
    )
  })

  it.each([
    ['a different Workflow', '/workflow/other-workflow?mode=runs&run=run-20260712010101-abcd1234'],
    ['a different run', '/workflow/release-review?mode=runs&run=run-other'],
  ])('does not let %s redirect a run receipt away from its exact execution', async (_label, openPath) => {
    const user = userEvent.setup()
    const { router } = renderCard(runBlock({
      payload: { ...runBlock().payload, openPath },
    }))

    await user.click(screen.getByRole('button', { name: 'Open Release review workflow run' }))

    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234',
    )
  })

  it.each(['click', 'keyboard'])('Open by %s does not toggle Preview', async (activation) => {
    const user = userEvent.setup()
    const { router } = renderPersistentCard(definitionBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow' })
    const open = screen.getByRole('button', { name: 'Open Release review workflow' })

    expect(preview.getAttribute('aria-expanded')).toBe('false')
    if (activation === 'click') {
      await user.click(open)
    } else {
      open.focus()
      await user.keyboard('{Enter}')
    }

    expect(preview.getAttribute('aria-expanded')).toBe('false')
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
    // Handle the card by its non-identifying type tag, never the canonical id.
    const card = document.querySelector('[data-block-type]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).not.toMatch(/\bborder\b/)
  })

  it('indents the wrapped mobile action row inside its basis box, never with an outside margin', () => {
    // Box-model regression (browser-verified separately with Playwright at 320/360/390):
    // at ≤504px the action row wraps to its own line as flex-basis:100% + shrink-0,
    // so it already fills the card's flex content box. An arbitrary-value LEFT MARGIN
    // there lives OUTSIDE the border-box and pushes the 100%-basis row 40px past the
    // card — 32px past its right edge, overflowing the scroller. The indent must ride in
    // PADDING (inside the border-box under Tailwind's box-border) and the base margin
    // must be zeroed at the breakpoint.
    renderCard(runBlock())
    const row = screen.getByRole('button', { name: 'Open Release review workflow run' }).parentElement as HTMLElement
    expect(row).toBeTruthy()
    expect(row.className).toContain('max-[504px]:basis-full')
    expect(row.className).toMatch(/max-\[504px\]:pl-\[/) // indent moved inside the basis box
    expect(row.className).not.toMatch(/max-\[504px\]:ml-\[/) // no outside-the-box arbitrary margin
    expect(row.className).toContain('max-[504px]:ml-0') // base --space-1 margin neutralized on mobile
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

  it('closes an open Preview on Escape from the trigger and returns focus to it', async () => {
    const user = userEvent.setup()
    renderCard(runBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    await user.click(preview)
    expect(screen.getByRole('region', { name: 'Release review workflow run details' })).toBeTruthy()

    preview.focus()
    await user.keyboard('{Escape}')

    expect(preview.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Release review workflow run details' })).toBeNull()
    expect(document.activeElement).toBe(preview)
  })

  it('closes an open Preview on Escape from inside the details region and returns focus', async () => {
    const user = userEvent.setup()
    renderCard(runBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    await user.click(preview)
    const region = screen.getByRole('region', { name: 'Release review workflow run details' })
    region.focus()

    await user.keyboard('{Escape}')

    expect(preview.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Release review workflow run details' })).toBeNull()
    expect(document.activeElement).toBe(preview)
  })

  it('ignores unrelated keys and does not navigate on Escape', async () => {
    const user = userEvent.setup()
    const { router } = renderCard(runBlock())
    const preview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    await user.click(preview)
    preview.focus()

    await user.keyboard('{ArrowDown}')
    expect(preview.getAttribute('aria-expanded')).toBe('true') // unrelated key leaves it open

    await user.keyboard('{Escape}')
    expect(preview.getAttribute('aria-expanded')).toBe('false')
    expect(router.state.location.pathname).toBe('/') // Escape never triggers Open/navigation
  })

  const TONE_CASES: Array<[string, ChatBlock]> = [
    ['waiting', runBlock()],
    ['working', runBlock({ status: 'running', payload: { ...runBlock().payload, runStatus: 'running' } })],
    ['done', definitionBlock()],
    ['error', runBlock({ status: 'error', payload: { ...runBlock().payload, runStatus: 'failed' } })],
    ['neutral', runBlock({ status: 'running', payload: { ...runBlock().payload, runStatus: 'cancelled' } })],
  ]

  it.each(TONE_CASES)('renders %s status copy on a readable ≥AA token, tone via the mark', (tone, block) => {
    renderCard(block)
    const line = document.querySelector(`[data-activity-state="${tone}"]`) as HTMLElement
    expect(line).toBeTruthy()
    // Readable copy sits on --text-secondary (≥4.5:1 in both themes)…
    expect(line.className).toContain('text-[var(--text-secondary)]')
    // …never on the sub-AA tokens the browser axe flagged in light.
    expect(line.className).not.toContain('--text-tertiary')
    expect(line.className).not.toContain('--system-orange')
    expect(line.className).not.toContain('--system-blue')
  })

  it('renders the kind label on a readable ≥AA token, not sub-AA tertiary ink', () => {
    renderCard(runBlock())
    const kind = screen.getByText('Workflow run')
    expect(kind.className).toContain('text-[var(--text-secondary)]')
    expect(kind.className).not.toContain('text-[var(--text-tertiary)]')
  })

  it('renders expanded fact labels on a readable ≥AA token', async () => {
    const user = userEvent.setup()
    renderCard(runBlock())
    await user.click(screen.getByRole('button', { name: 'Preview Release review workflow run' }))
    const label = screen.getByText('Needs')
    expect(label.className).toContain('text-[var(--text-secondary)]')
    expect(label.className).not.toContain('text-[var(--text-tertiary)]')
  })

  it('scopes Escape to the currently open card only', async () => {
    const user = userEvent.setup()
    const other = definitionBlock()
    const router = createMemoryRouter(
      [{ path: '/', element: (
        <>
          <CompanyActivityCard block={runBlock()} />
          <CompanyActivityCard block={other} />
        </>
      ) }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)

    const runPreview = screen.getByRole('button', { name: 'Preview Release review workflow run' })
    await user.click(runPreview)
    runPreview.focus()
    await user.keyboard('{Escape}')

    expect(runPreview.getAttribute('aria-expanded')).toBe('false')
    // The other card was never opened and is untouched by the run card's Escape.
    expect(screen.getByRole('button', { name: 'Preview Release review workflow' }).getAttribute('aria-expanded')).toBe('false')
  })
})
