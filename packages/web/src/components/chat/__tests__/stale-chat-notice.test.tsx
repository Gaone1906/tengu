import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StaleChatNotice } from '../stale-chat-notice'

function renderNotice(onStartFresh = vi.fn().mockResolvedValue(undefined), onDismiss = vi.fn()) {
  return {
    onStartFresh,
    onDismiss,
    ...render(
      <StaleChatNotice
        contextTokens={324_500}
        idleMinutes={73}
        onDismiss={onDismiss}
        onStartFresh={onStartFresh}
      />,
    ),
  }
}

describe('StaleChatNotice', () => {
  it('renders the recommendation and context summary', () => {
    renderNotice()
    expect(screen.getByText('Start a fresh chat?')).toBeTruthy()
    expect(screen.getByText('325k in context · idle 1h 13m')).toBeTruthy()
  })

  it('dismisses from its quiet action', () => {
    const { onDismiss } = renderNotice()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('starts at most once while creation is pending', () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const onStartFresh = vi.fn(() => pending)
    renderNotice(onStartFresh)

    const button = screen.getByRole('button', { name: 'Start fresh' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(onStartFresh).toHaveBeenCalledOnce()
    resolve()
  })

  it('keeps the card mounted and shows an error when creation fails', async () => {
    renderNotice(vi.fn().mockRejectedValue(new Error('Gateway unavailable')))
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Gateway unavailable'))
    expect(screen.getByText('Start a fresh chat?')).toBeTruthy()
  })
})
