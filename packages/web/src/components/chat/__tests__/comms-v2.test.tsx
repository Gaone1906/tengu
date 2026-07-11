import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages, turnSpacerClass } from '../chat-messages'
import { BURST_WINDOW_MS, formatBurstRange } from '../callback-burst'
import { anchorScrollDuring, canAnchorFold, formatWorkDuration, foldSummaryWords } from '../fold-region'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

function callback(id: string, employee: string, ts: number, preview = `Report from ${employee}.`): Message {
  return {
    id,
    role: 'notification',
    content: `📩 ${employee} replied\n${preview}`,
    timestamp: ts,
    meta: {
      kind: 'child-reply',
      employee,
      employeeDisplay: employee,
      childSessionId: `child-${employee}`,
    },
  }
}

describe('T3 burst grouping', () => {
  it('groups 2+ consecutive callbacks within the window into one burst entry', () => {
    const messages = [
      callback('c1', 'dev', T0),
      callback('c2', 'analyst', T0 + 60_000),
      callback('c3', 'designer', T0 + 120_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    const burst = container.querySelector('[data-comms-burst="3"]')
    expect(burst).toBeTruthy()
    expect(burst!.textContent).toContain('3 reports')
    // The individual ledger lines stay individually openable inside the rail.
    expect(screen.getAllByRole('button', { name: /Open report/ })).toHaveLength(3)
  })

  it('does not group callbacks separated by more than the burst window', () => {
    const messages = [
      callback('c1', 'dev', T0),
      callback('c2', 'analyst', T0 + BURST_WINDOW_MS + 60_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    expect(container.querySelector('[data-comms-burst]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Open report/ })).toHaveLength(2)
  })

  it('breaks the burst run at a non-callback message', () => {
    const messages: Message[] = [
      callback('c1', 'dev', T0),
      { id: 'n1', role: 'notification', content: '📨 From scout: fresh threads.', timestamp: T0 + 10_000 },
      callback('c2', 'analyst', T0 + 20_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    expect(container.querySelector('[data-comms-burst]')).toBeNull()
  })

  it('routes a burst row click through the peek payload', () => {
    const onPeek = vi.fn()
    const messages = [callback('c1', 'dev', T0), callback('c2', 'analyst', T0 + 5_000)]
    render(<ChatMessages messages={messages} loading={false} onPeek={onPeek} />)

    fireEvent.click(screen.getByRole('button', { name: /analyst replied.*Open report/ }))
    expect(onPeek).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reply',
      employee: 'analyst',
      sessionId: 'child-analyst',
    }))
  })

  it('formats the burst time range with a shared meridiem and collapses equal times', () => {
    const at = (h: number, m: number) => new Date(2026, 6, 11, h, m).getTime()
    expect(formatBurstRange(at(15, 42), at(15, 45))).toBe('3:42-3:45 PM')
    expect(formatBurstRange(at(15, 42), at(15, 42))).toBe('3:42 PM')
    expect(formatBurstRange(at(11, 58), at(12, 2))).toBe('11:58 AM-12:02 PM')
  })
})

describe('the post-turn fold', () => {
  const foldedTurn: Message[] = [
    { id: 'u1', role: 'user', content: 'Ship it.', timestamp: T0 },
    { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: T0 + 10_000, toolCall: 'file_read' },
    { id: 't2', role: 'assistant', content: 'Used file_edit', timestamp: T0 + 20_000, toolCall: 'file_edit' },
    callback('c1', 'dev', T0 + 400_000),
    { id: 'a1', role: 'assistant', content: 'Done, shipped.', timestamp: T0 + 430_000 },
  ]

  it('rests answered turns folded behind a work-summary ledger line', () => {
    const { container } = render(<ChatMessages messages={foldedTurn} loading={false} />)

    const summary = screen.getByRole('button', { name: /Worked for 6m, 2 tools, 1 teammate\. Show the work\./ })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    // Rendered dot separators, never glyph middots.
    expect(summary.textContent).not.toContain('·')
    // The evidence is folded away from the accessibility tree; the answer stays.
    const region = container.querySelector('[data-fold-region]')
    expect(region?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('Done, shipped.')).toBeTruthy()
  })

  it('re-expands and re-collapses from the summary line', () => {
    const { container } = render(<ChatMessages messages={foldedTurn} loading={false} />)
    const summary = screen.getByRole('button', { name: /Show the work/ })

    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBeNull()
    expect(screen.getByRole('button', { name: /^2 tools$/ })).toBeTruthy()

    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps unanswered live work open with no summary line', () => {
    const live = foldedTurn.slice(0, 4)
    render(<ChatMessages messages={live} loading />)
    expect(screen.queryByRole('button', { name: /Show the work/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^2 tools$/ })).toBeTruthy()
  })

  it('never folds a region with a still-running tool', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Using file_edit', timestamp: T0 + 1_000, toolCall: 'file_edit' },
      { id: 'a1', role: 'assistant', content: 'Interim note.', timestamp: T0 + 2_000 },
    ]
    render(<ChatMessages messages={messages} loading />)
    expect(screen.queryByRole('button', { name: /Show the work/ })).toBeNull()
    expect(screen.getByRole('button', { name: /1 tool running/i })).toBeTruthy()
  })

  it('formats work durations and omits zero-count summary segments', () => {
    expect(formatWorkDuration(5_000)).toBe('5s')
    expect(formatWorkDuration(90_000)).toBe('1m')
    expect(formatWorkDuration(3_720_000)).toBe('1h 2m')
    expect(foldSummaryWords({ durationMs: 90_000, tools: 0, teammates: 2 })).toEqual(['Worked for 1m', '2 teammates'])
    expect(foldSummaryWords({ durationMs: 1_000, tools: 1, teammates: 0 })).toEqual(['Worked for 1s', '1 tool'])
  })

  it('anchorScrollDuring compensates scrollTop by the anchor bottom delta each frame', () => {
    const scroller = { scrollTop: 100 } as unknown as Element
    let bottom = 500
    const anchor = { getBoundingClientRect: () => ({ bottom }) } as unknown as Element
    const frames: FrameRequestCallback[] = []
    let now = 0
    anchorScrollDuring(scroller, anchor, 100, (cb) => { frames.push(cb); return 1 }, () => now)

    bottom = 480
    now = 16
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(80)

    bottom = 470
    now = 200
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(50)
    // Past the window: no further frames scheduled.
    expect(frames).toHaveLength(0)
  })
})

describe('streaming → final structural parity', () => {
  it('shares one spacer function between the streaming container and the final row', () => {
    expect(turnSpacerClass('user', 'assistant')).toBe('h-[var(--space-6)]')
    expect(turnSpacerClass('notification', 'assistant')).toBe('h-[var(--space-4)]')
    expect(turnSpacerClass('assistant', 'assistant')).toBe('h-[var(--space-1)]')
    expect(turnSpacerClass('user', 'user')).toBe('h-[var(--space-1)]')
  })

  it('renders the streaming container with the after-user spacer the final row will use', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Summarize the sweep.', timestamp: Date.now() - 5_000 },
    ]
    const { container } = render(
      <ChatMessages messages={messages} loading streamingText="Sweep done, three threads flagged" />,
    )
    const streaming = container.querySelector('[data-streaming]')
    expect(streaming).toBeTruthy()
    expect(streaming!.querySelector('.h-\\[var\\(--space-6\\)\\]')).toBeTruthy()
    expect(streaming!.querySelector('.assistant-transcript')).toBeTruthy()
  })

  it('renders a timestamp divider while streaming when the final row will show one', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Old message.', timestamp: Date.now() - 10 * 60 * 1000 },
    ]
    const { container } = render(
      <ChatMessages messages={messages} loading streamingText="Fresh reply" />,
    )
    const streaming = container.querySelector('[data-streaming]')
    expect(streaming!.textContent).toMatch(/Today/)
    expect(streaming!.querySelector('.h-\\[var\\(--space-6\\)\\]')).toBeNull()
  })

  it('renders the streaming shell and the final shell byte-identically (one component)', () => {
    const prev: Message = { id: 'u1', role: 'user', content: 'Go.', timestamp: Date.now() - 5_000 }
    const shellSignature = (root: Element) => {
      const row = root.querySelector('.assistant-msg-row')!
      const bubble = root.querySelector('.assistant-msg-bubble')!
      const transcript = root.querySelector('.assistant-transcript')!
      return [row.className, bubble.className, transcript.className].join('\n')
    }

    const streaming = render(
      <ChatMessages messages={[prev]} loading streamingText="The answer." />,
    )
    const streamingSig = shellSignature(streaming.container.querySelector('[data-streaming]')!)
    streaming.unmount()

    const final = render(
      <ChatMessages
        messages={[prev, { id: 'a1', role: 'assistant', content: 'The answer.', timestamp: Date.now() }]}
        loading={false}
      />,
    )
    const finalSig = shellSignature(final.container.querySelector('[data-message-id="a1"]')!)

    expect(streamingSig).toBe(finalSig)
  })
})

describe('fold slack gate', () => {
  it('only anchors the live fold when scrollTop can absorb the shrink', () => {
    // QA-measured clamp case: slack 27, region ~331 (delta 299) → skip.
    expect(canAnchorFold(27, 331)).toBe(false)
    // Enough slack: 400 ≥ 331 - 32.
    expect(canAnchorFold(400, 331)).toBe(true)
    // Boundary: slack + 2 tolerance against delta.
    expect(canAnchorFold(297, 331)).toBe(true)
    expect(canAnchorFold(296, 331)).toBe(false)
    // A tiny region folds even at scrollTop 0 (delta ≤ summary height).
    expect(canAnchorFold(0, 32)).toBe(true)
  })
})

describe('rendered copy carries no em or en dashes', () => {
  const componentRoots = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../../ui'),
  ]

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
  }

  function strippedLines(file: string): Array<{ line: number; text: string }> {
    let source = fs.readFileSync(file, 'utf-8')
    source = source.replace(/\/\*[\s\S]*?\*\//g, '')
    return source.split('\n')
      .map((text, index) => ({ line: index + 1, text: text.replace(/(^|[^:])\/\/.*$/, '$1') }))
      // Regex literals legitimately MATCH dashes (e.g. tab-title parsing) —
      // they parse them, they don't render them.
      .filter(({ text }) => !text.includes('.match(') && !text.includes('RegExp'))
  }

  it('chat + ui component sources render no em/en dashes', () => {
    const offenders: string[] = []
    for (const dir of componentRoots) {
      for (const file of sourceFiles(dir)) {
        for (const { line, text } of strippedLines(file)) {
          if (/[—–]/.test(text)) offenders.push(`${path.basename(file)}:${line} ${text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
