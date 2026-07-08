import { describe, expect, it } from 'vitest'
import { resolveSendTap, resolveTranscriptLanding } from '../chat-input'

describe('resolveSendTap — armed-send state machine', () => {
  const base = { isStop: false, armed: false, sttPending: false, hasContent: false }

  it('interrupts a streaming turn regardless of anything else', () => {
    expect(resolveSendTap({ ...base, isStop: true })).toBe('stop')
    // Stop wins even mid-STT or while armed.
    expect(resolveSendTap({ isStop: true, armed: true, sttPending: true, hasContent: true })).toBe('stop')
  })

  it('arms an auto-send when tapped during the STT pending window', () => {
    // Recording/transcribing, nothing typed yet → arm.
    expect(resolveSendTap({ ...base, sttPending: true })).toBe('arm')
    // Even with pre-typed text, a tap during STT queues the combined message.
    expect(resolveSendTap({ ...base, sttPending: true, hasContent: true })).toBe('arm')
  })

  it('a second tap while armed cancels the queued send', () => {
    expect(resolveSendTap({ ...base, armed: true, sttPending: true })).toBe('disarm')
  })

  it('sends normally when there is content and no STT is pending', () => {
    expect(resolveSendTap({ ...base, hasContent: true })).toBe('send')
  })

  it('does nothing on an empty field with no pending STT', () => {
    expect(resolveSendTap(base)).toBe('noop')
  })
})

describe('resolveTranscriptLanding — what happens when words land', () => {
  it('fills the field (no send) when nothing was armed', () => {
    expect(resolveTranscriptLanding(false, 'hello there')).toBe('fill')
    expect(resolveTranscriptLanding(false, '')).toBe('fill')
  })

  it('auto-sends when armed and the transcript carried words', () => {
    expect(resolveTranscriptLanding(true, 'send this now')).toBe('send')
    // Leading/trailing whitespace still counts as real content.
    expect(resolveTranscriptLanding(true, '  hi  ')).toBe('send')
  })

  it('disarms without sending when armed but the transcript is empty', () => {
    expect(resolveTranscriptLanding(true, '')).toBe('disarm')
    expect(resolveTranscriptLanding(true, '   ')).toBe('disarm')
    expect(resolveTranscriptLanding(true, '\n\t')).toBe('disarm')
  })
})
