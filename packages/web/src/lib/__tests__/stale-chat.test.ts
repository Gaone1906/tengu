import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildContinuationPrompt,
  dismissStaleChat,
  isStaleChatDismissed,
  shouldSuggestFreshChat,
} from '../stale-chat'

const policy = {
  enabled: true,
  tokenThreshold: 300_000,
  staleAfterMinutes: 60,
}

const eligible = {
  policy,
  status: 'idle',
  contextTokens: 300_000,
  lastActivity: '2026-08-02T10:00:00.000Z',
  now: Date.parse('2026-08-02T11:00:00.000Z'),
  dismissed: false,
}

describe('shouldSuggestFreshChat', () => {
  it('returns true when every requirement is met', () => {
    expect(shouldSuggestFreshChat(eligible)).toBe(true)
  })

  it('returns false when disabled', () => {
    expect(shouldSuggestFreshChat({ ...eligible, policy: { ...policy, enabled: false } })).toBe(false)
  })

  it('returns false while the session is running', () => {
    expect(shouldSuggestFreshChat({ ...eligible, status: 'running' })).toBe(false)
  })

  it('returns false below the token threshold', () => {
    expect(shouldSuggestFreshChat({ ...eligible, contextTokens: 299_999 })).toBe(false)
  })

  it('returns false before the idle window', () => {
    expect(shouldSuggestFreshChat({ ...eligible, now: eligible.now - 1 })).toBe(false)
  })

  it('returns false after dismissal', () => {
    expect(shouldSuggestFreshChat({ ...eligible, dismissed: true })).toBe(false)
  })
})

describe('stale chat dismissals', () => {
  beforeEach(() => localStorage.clear())

  it('survives a later read for the same session', () => {
    dismissStaleChat('session-1')
    expect(isStaleChatDismissed('session-1')).toBe(true)
    expect(isStaleChatDismissed('session-2')).toBe(false)
  })

  it('caps the stored dismissal history', () => {
    for (let index = 0; index < 110; index++) dismissStaleChat(`session-${index}`)
    expect(isStaleChatDismissed('session-0')).toBe(false)
    expect(isStaleChatDismissed('session-109')).toBe(true)
  })
})

describe('buildContinuationPrompt', () => {
  it('names the previous session without asking to restart the task', () => {
    const prompt = buildContinuationPrompt('session-previous')
    expect(prompt).toContain('session-previous')
    expect(prompt).toContain('continuation')
    expect(prompt).toContain('one line')
    expect(prompt).toContain('Do not restart')
  })
})
