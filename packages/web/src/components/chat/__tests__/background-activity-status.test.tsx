import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  BackgroundActivityStatus,
  isBackgroundActivityVisible,
} from '../background-activity-status'
import type { BackgroundActivity } from '@/lib/api'

const NOW = 1_780_000_000_000

/** Fresh-by-default fixture. The component reads real `Date.now()`, so render
 *  tests anchor to it; the pure-function tests pass `NOW` explicitly. */
function activity(overrides: Partial<BackgroundActivity> = {}): BackgroundActivity {
  return {
    activeStreams: 2,
    lastActivityAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isBackgroundActivityVisible', () => {
  it('is visible with fresh active streams', () => {
    expect(isBackgroundActivityVisible(activity(), NOW)).toBe(true)
  })

  it('is hidden when there is no activity at all', () => {
    expect(isBackgroundActivityVisible(null, NOW)).toBe(false)
  })

  it('is hidden with zero active streams', () => {
    expect(isBackgroundActivityVisible(activity({ activeStreams: 0 }), NOW)).toBe(false)
  })

  it('goes stale 5 minutes after the last background call', () => {
    const fresh = activity({ lastActivityAt: new Date(NOW - 4 * 60 * 1000).toISOString() })
    const stale = activity({ lastActivityAt: new Date(NOW - 6 * 60 * 1000).toISOString() })
    expect(isBackgroundActivityVisible(fresh, NOW)).toBe(true)
    expect(isBackgroundActivityVisible(stale, NOW)).toBe(false)
  })
})

describe('BackgroundActivityStatus', () => {
  it('renders a status line with the plural agent count', () => {
    render(<BackgroundActivityStatus activity={activity({ activeStreams: 2 })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('2 agents in background')
    // Compact <sm form: count + noun (the dot carries "working in background").
    expect(short.textContent).toBe('2 agents')
  })

  it('uses the singular label for one agent', () => {
    render(<BackgroundActivityStatus activity={activity({ activeStreams: 1 })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('1 agent in background')
    expect(short.textContent).toBe('1 agent')
  })

  it('renders nothing when idle with no background work', () => {
    render(<BackgroundActivityStatus activity={null} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing for stale activity', () => {
    render(
      <BackgroundActivityStatus
        activity={activity({ lastActivityAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() })}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the node mounted through the exit fade, then unmounts', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <BackgroundActivityStatus activity={activity({ activeStreams: 2 })} />,
    )
    expect(screen.getByRole('status')).toBeTruthy()

    rerender(<BackgroundActivityStatus activity={null} />)
    // Still mounted during the fade-out window (count frozen, no "0 agents" flash)…
    const exiting = screen.getByRole('status')
    expect(exiting.textContent).toContain('2 agents in background')

    // …and gone once the exit transition completes.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
