import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownView } from '../markdown-view'

describe('MarkdownView code', () => {
  it('renders fenced chrome and leaves inline code unchanged', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.useFakeTimers()

    try {
      render(
        <MarkdownView
          isDark
          content={[
            '`inline-value`',
            '',
            '```ts',
            'const answer = 42;',
            '```',
            '',
            '```',
            'alpha',
            'beta',
            '```',
            '',
            '```',
            'single-line',
            '```',
          ].join('\n')}
        />,
      )

      expect(screen.getByText('ts')).toBeTruthy()
      expect(screen.getAllByText('text')).toHaveLength(2)

      const inline = screen.getByText('inline-value')
      expect(inline.tagName).toBe('CODE')
      expect(inline.getAttribute('style')).toContain('background: var(--fill-secondary)')
      expect(inline.closest('.code-block-wrap')).toBeNull()

      const copyControls = screen.getAllByRole('button', { name: 'Copy code' })
      expect(copyControls).toHaveLength(3)
      const copy = copyControls[2]
      fireEvent.click(copy)
      await act(async () => {})

      expect(writeText).toHaveBeenCalledWith('single-line')
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the copy control a 34px tap target', () => {
    render(
      <MarkdownView
        isDark
        content={['```ts', 'const answer = 42;', '```'].join('\n')}
      />,
    )

    const copy = screen.getByRole('button', { name: 'Copy code' })
    expect(copy.classList.contains('h-[34px]')).toBe(true)
    expect(copy.classList.contains('w-[34px]')).toBe(true)
  })
})
