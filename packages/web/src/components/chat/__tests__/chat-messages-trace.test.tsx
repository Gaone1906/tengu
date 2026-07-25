import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { formatMessage } from '../chat-messages'

/** Engines sometimes leak scratchpad tags into the visible answer (issue #85).
 *  The tag must never render raw, and the prose inside it must not be lost. */
describe('formatMessage reasoning trace tags', () => {
  it('folds a trace block instead of printing the raw tag', () => {
    render(<div>{formatMessage('<analysis>\nWeighing the options.\n</analysis>\nHere is the answer.')}</div>)

    expect(screen.queryByText('<analysis>')).toBeNull()
    expect(screen.queryByText('</analysis>')).toBeNull()
    expect(screen.getByText('Here is the answer.')).toBeTruthy()

    // Content is folded away, not dropped — it appears once expanded.
    expect(screen.queryByText('Weighing the options.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Analysis/ }))
    expect(screen.getByText('Weighing the options.')).toBeTruthy()
  })

  it('folds an unterminated block (mid-stream) to the end of the message', () => {
    render(<div>{formatMessage('<thinking>\nStill going')}</div>)

    expect(screen.queryByText('<thinking>')).toBeNull()
    expect(screen.getByRole('button', { name: /Thinking/ })).toBeTruthy()
  })

  it('swallows a stray closing tag', () => {
    render(<div>{formatMessage('Done.\n</analysis>')}</div>)

    expect(screen.queryByText('</analysis>')).toBeNull()
    expect(screen.getByText('Done.')).toBeTruthy()
  })

  it('leaves non-trace tags alone', () => {
    render(<div>{formatMessage('<details>')}</div>)

    expect(screen.getByText('<details>')).toBeTruthy()
  })

  /** A leaked compaction message is `<analysis>…</analysis>` then
   *  `<summary>…</summary>` — folding only the first half still dumps the recap. */
  it('folds the summary half of a leaked compaction message', () => {
    render(
      <div>
        {formatMessage(
          '<analysis>\nWeighing the options.\n</analysis>\n<summary>\nThis session is being continued.\n</summary>',
        )}
      </div>,
    )

    expect(screen.queryByText('<summary>')).toBeNull()
    expect(screen.queryByText('</summary>')).toBeNull()
    expect(screen.queryByText('This session is being continued.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Summary/ }))
    expect(screen.getByText('This session is being continued.')).toBeTruthy()
  })
})
