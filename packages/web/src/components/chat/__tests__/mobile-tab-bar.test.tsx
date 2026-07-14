import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MobileTabBar } from '../mobile-tab-bar'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileTabBar />
    </MemoryRouter>
  )
}

describe('MobileTabBar', () => {
  // Notes is feature-gated; the default mobile nav has four icon-only tabs. No visible labels, so the
  // accessible name comes from each tab's aria-label.
  it('renders exactly 4 tabs with accessible names while Notes is disabled', () => {
    renderAt('/')
    const tabs = screen.getAllByRole('link')
    expect(tabs).toHaveLength(4)
    for (const label of ['Chat', 'Todos', 'Workflows', 'More']) {
      expect(screen.getByRole('link', { name: label })).toBeDefined()
    }
  })

  it('marks the Chat tab current on "/" and no other', () => {
    renderAt('/')
    expect(
      screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')
    ).toBe('page')
    for (const label of ['Todos', 'Workflows', 'More']) {
      expect(
        screen.getByRole('link', { name: label }).getAttribute('aria-current')
      ).toBeNull()
    }
  })

  it('marks the Workflows tab current on "/workflow"', () => {
    renderAt('/workflow')
    expect(
      screen.getByRole('link', { name: 'Workflows' }).getAttribute('aria-current')
    ).toBe('page')
    expect(
      screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')
    ).toBeNull()
  })

  it('keeps the More tab lit on the More screen', () => {
    renderAt('/more')
    expect(
      screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')
    ).toBe('page')
  })

  it('keeps the More tab lit on an overflow child (e.g. /settings)', () => {
    renderAt('/settings')
    expect(
      screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')
    ).toBe('page')
    // ...and no primary tab steals the cue.
    for (const label of ['Chat', 'Todos', 'Workflows']) {
      expect(
        screen.getByRole('link', { name: label }).getAttribute('aria-current')
      ).toBeNull()
    }
  })

  // GRS-023: re-tapping the already-active Chat tab scrolls the chat list to the
  // top (HIG tab re-tap). Only fires when Chat is the current tab.
  it('scrolls the chat list to top when the active Chat tab is re-tapped', () => {
    const list = document.createElement('div')
    list.setAttribute('data-chat-list-scroll', '')
    const scrollTo = vi.fn()
    ;(list as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    document.body.appendChild(list)

    renderAt('/')
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })

    document.body.removeChild(list)
  })

  it('does not scroll on Chat tap when Chat is not the active tab', () => {
    const list = document.createElement('div')
    list.setAttribute('data-chat-list-scroll', '')
    const scrollTo = vi.fn()
    ;(list as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    document.body.appendChild(list)

    renderAt('/workflow')
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }))
    expect(scrollTo).not.toHaveBeenCalled()

    document.body.removeChild(list)
  })
})
