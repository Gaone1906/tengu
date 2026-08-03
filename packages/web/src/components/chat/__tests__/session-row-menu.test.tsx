import { cloneElement, type ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, asChild, ...props }: React.ComponentProps<'button'> & { asChild?: boolean }) =>
    asChild
      ? cloneElement(children as ReactElement, props)
      : <button type="button" {...props}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, asChild, ...props }: React.ComponentProps<'button'> & { asChild?: boolean }) =>
    asChild
      ? cloneElement(children as ReactElement, props)
      : <button type="button" {...props}>{children}</button>,
  ContextMenuSeparator: () => <hr />,
}))

import { SessionRowMenu, sessionMenuCapabilities } from '../session-row-menu'

const runningWorkflow = {
  id: 'session-42',
  status: 'running',
  source: 'workflow',
  sourceRef: 'workflow:daily-report:run-42:writer:1',
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

describe('sessionMenuCapabilities', () => {
  it('exposes workflow navigation and stop only for an active resolvable workflow run', () => {
    expect(sessionMenuCapabilities(runningWorkflow)).toEqual({
      workflowRunPath: '/workflow/daily-report/runs/run-42',
      canStop: true,
    })
  })

  it('withholds workflow navigation for malformed and non-workflow sessions', () => {
    expect(sessionMenuCapabilities({
      id: 'malformed',
      status: 'idle',
      source: 'workflow',
      sourceRef: 'workflow:incomplete',
    })).toEqual({ workflowRunPath: null, canStop: false })

    expect(sessionMenuCapabilities({
      id: 'web-session',
      status: 'idle',
      source: 'web',
      sourceRef: 'workflow:daily-report:run-42:writer:1',
    })).toEqual({ workflowRunPath: null, canStop: false })
  })
})

describe.each(['dropdown', 'context'] as const)('SessionRowMenu %s variant', (variant) => {
  const onRename = vi.fn()
  const onTogglePin = vi.fn()
  const onDuplicate = vi.fn()
  const onArchive = vi.fn()
  const onStop = vi.fn()
  const onDelete = vi.fn()
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  it('keeps existing actions and adds workflow, stop, and copy actions', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <SessionRowMenu
          variant={variant}
          session={runningWorkflow}
          isPinned={false}
          isArchived={false}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onDuplicate={onDuplicate}
          onArchive={onArchive}
          onStop={onStop}
          onDelete={onDelete}
        />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pin' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Duplicate…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive chat' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open workflow run' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy Session ID' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Delete session/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete session/ }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('link', { name: 'Open workflow run' }))
    expect(screen.getByTestId('location').textContent).toBe('/workflow/daily-report/runs/run-42')

    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(onStop).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Copy Session ID' }))
    expect(writeText).toHaveBeenCalledWith('session-42')
  })

  it('withholds workflow and stop actions from an idle web session', () => {
    render(
      <MemoryRouter>
        <SessionRowMenu
          variant={variant}
          session={{ id: 'web-session', status: 'idle', source: 'web' }}
          isPinned
          isArchived
          onRename={onRename}
          onTogglePin={onTogglePin}
          onDuplicate={onDuplicate}
          onArchive={onArchive}
          onStop={onStop}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', { name: 'Unpin' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unarchive chat' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open workflow run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop session' })).toBeNull()
  })
})
