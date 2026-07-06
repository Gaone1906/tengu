import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VoiceMessage } from '../voice-message'

describe('VoiceMessage lazy audio', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not construct an Audio element until playback starts', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const pause = vi.fn()
    const play = vi.fn(() => Promise.resolve())
    const AudioMock = vi.fn(function MockAudio(this: {
      addEventListener: typeof addEventListener
      removeEventListener: typeof removeEventListener
      pause: typeof pause
      play: typeof play
      currentTime: number
      duration: number
      src: string
    }, src?: string) {
      this.addEventListener = addEventListener
      this.removeEventListener = removeEventListener
      this.pause = pause
      this.play = play
      this.currentTime = 0
      this.duration = 0
      this.src = src ?? ''
    })
    vi.stubGlobal('Audio', AudioMock)

    render(<VoiceMessage src="/api/files/voice.m4a" duration={12} waveform={[0.2, 0.5]} isUser={false} />)

    expect(AudioMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))

    expect(AudioMock).toHaveBeenCalledWith('/api/files/voice.m4a')
    expect(play).toHaveBeenCalled()
  })
})
