import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Settings } from 'lucide-react'

/**
 * The post-turn fold: once a turn's final answer lands, the working evidence
 * between the user message and the answer (tool groups, callbacks, relays,
 * dispatch rows) files itself away into ONE ledger summary line —
 * "Worked for 7m · 6 tools · 3 teammates" — expandable at any time.
 * HandoffCards do NOT fold (durable objects with live state) and are never
 * passed in here.
 *
 * The premium detail: the fold happens ABOVE the answer the user is reading,
 * so a naive collapse would yank the answer up. The collapse is
 * scroll-anchored — each frame the scroll container compensates by the height
 * delta, so the answer stays pixel-fixed in the viewport while the evidence
 * folds away. `prefers-reduced-motion` swaps instantly with a single
 * compensation.
 */

export interface FoldSummaryData {
  durationMs: number
  tools: number
  teammates: number
}

export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function foldSummaryWords(summary: FoldSummaryData): string[] {
  const words = [`Worked for ${formatWorkDuration(summary.durationMs)}`]
  if (summary.tools > 0) words.push(`${summary.tools} tool${summary.tools === 1 ? '' : 's'}`)
  if (summary.teammates > 0) words.push(`${summary.teammates} teammate${summary.teammates === 1 ? '' : 's'}`)
  return words
}

const FOLD_MS = 420
const FOLD_BEAT_MS = 400
const ANCHOR_WINDOW_MS = 480

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Per-frame scroll compensation: keeps everything below `anchorEl` pixel-fixed
 *  while its height changes. Exported for tests. */
export function anchorScrollDuring(
  scroller: Element | null,
  anchorEl: Element,
  durationMs: number,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  now: () => number = () => performance.now(),
): void {
  if (!scroller) return
  const bottom0 = anchorEl.getBoundingClientRect().bottom
  const t0 = now()
  const step = () => {
    const delta = anchorEl.getBoundingClientRect().bottom - bottom0
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    if (now() - t0 < durationMs) raf(step)
  }
  raf(step)
}

interface FoldRegionProps {
  /** Whether the turn already produced its final answer (fold-eligible). */
  answered: boolean
  summary: FoldSummaryData
  children: ReactNode
}

export function FoldRegion({ answered, summary, children }: FoldRegionProps) {
  // Historical turns rest folded; the live turn folds with choreography when
  // its answer lands (answered flips false → true while mounted).
  const [folded, setFolded] = useState(answered)
  const [landed, setLanded] = useState(answered)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const regionRef = useRef<HTMLDivElement | null>(null)
  const answeredRef = useRef(answered)
  const foldedRef = useRef(folded)
  foldedRef.current = folded

  // Live fold: a beat after the answer registers, the evidence files away.
  useEffect(() => {
    const wasAnswered = answeredRef.current
    answeredRef.current = answered
    if (wasAnswered || !answered || foldedRef.current) return

    const region = regionRef.current
    const wrap = wrapRef.current
    if (!region || !wrap) {
      setFolded(true)
      setLanded(true)
      return
    }
    const scroller = wrap.closest('.chat-messages-scroll')

    if (prefersReducedMotion()) {
      const bottom0 = wrap.getBoundingClientRect().bottom
      setFolded(true)
      setLanded(true)
      requestAnimationFrame(() => {
        if (!scroller) return
        const delta = wrap.getBoundingClientRect().bottom - bottom0
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      })
      return
    }

    const beat = window.setTimeout(() => {
      region.style.height = `${region.offsetHeight}px`
      region.style.overflow = 'hidden'
      requestAnimationFrame(() => {
        region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
        region.style.height = '0px'
        region.style.opacity = '0'
        anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS)
        window.setTimeout(() => {
          setFolded(true)
          setLanded(true)
          region.style.transition = ''
        }, FOLD_MS + 10)
      })
    }, FOLD_BEAT_MS)
    return () => window.clearTimeout(beat)
  }, [answered])

  // Gear tick + inert bookkeeping happen via state; keep the region inert when folded.
  useLayoutEffect(() => {
    const region = regionRef.current
    if (!region) return
    if (folded) {
      region.style.height = '0px'
      region.style.opacity = '0'
      region.style.overflow = 'hidden'
    }
  }, [folded])

  const toggle = () => {
    const region = regionRef.current
    if (!region) return
    if (folded) {
      setFolded(false)
      region.style.overflow = 'hidden'
      region.style.height = '0px'
      region.style.opacity = '1'
      requestAnimationFrame(() => {
        region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
        region.style.height = `${region.scrollHeight}px`
        window.setTimeout(() => {
          // Guard: only unclamp if the user hasn't re-collapsed mid-animation.
          if (!foldedRef.current && region) {
            region.style.transition = ''
            region.style.height = 'auto'
            region.style.overflow = ''
          }
        }, FOLD_MS + 20)
      })
    } else {
      region.style.overflow = 'hidden'
      region.style.height = `${region.scrollHeight}px`
      requestAnimationFrame(() => {
        region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
        region.style.height = '0px'
        region.style.opacity = '0'
        window.setTimeout(() => {
          region.style.transition = ''
        }, FOLD_MS + 20)
      })
      setFolded(true)
    }
  }

  const words = foldSummaryWords(summary)

  return (
    <div ref={wrapRef} data-fold data-folded={folded || undefined}>
      <div ref={regionRef} data-fold-region inert={folded || undefined} aria-hidden={folded || undefined}>
        {children}
      </div>
      {answered && (
        <div className="assistant-msg-row min-w-0">
          <button
            type="button"
            data-fold-summary
            aria-expanded={!folded}
            aria-label={`${words.join(', ')}. ${folded ? 'Show the work' : 'Hide the work'}.`}
            onClick={toggle}
            className="-ml-1.5 flex min-h-8 w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[8px] border-none bg-transparent py-[3px] pl-1.5 pr-2 text-left font-[inherit] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
          >
            <Settings
              size={13}
              strokeWidth={2}
              aria-hidden="true"
              className={`shrink-0 text-[var(--text-quaternary)] transition-transform duration-[420ms] ease-[var(--ease-smooth)] ${landed ? 'rotate-90' : 'rotate-0'}`}
            />
            <span className="flex min-w-0 items-center gap-[7px]">
              {words.map((word, index) => (
                <Fragment key={index}>
                  {index > 0 && (
                    <span aria-hidden="true" className="size-[2.5px] shrink-0 rounded-full bg-[var(--text-quaternary)] opacity-45" />
                  )}
                  <span className="truncate [font-variant-numeric:tabular-nums]">{word}</span>
                </Fragment>
              ))}
            </span>
            <ChevronDown
              size={12}
              strokeWidth={2.5}
              aria-hidden="true"
              className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-200 ease-[var(--ease-smooth)] ${folded ? 'rotate-0' : 'rotate-180'}`}
            />
          </button>
        </div>
      )}
    </div>
  )
}
