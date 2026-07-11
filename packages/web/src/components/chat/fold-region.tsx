import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Settings } from 'lucide-react'

/**
 * The post-turn fold: once a turn's final answer lands, EVERYTHING between
 * the user message and that answer — tool groups, interim prose, callbacks,
 * relays, delegation and dispatch rows — files itself away into ONE ledger
 * summary line ("Worked for 7m · 6 tools · 3 teammates"), expandable at any
 * time. Only the final answer (and system banners) stay outside.
 *
 * The premium detail: the fold happens ABOVE the answer the user is reading,
 * so a naive collapse would yank the answer up. Both directions are
 * scroll-anchored — each frame the scroll container compensates by the height
 * delta, so the answer stays pixel-fixed in the viewport while the evidence
 * folds away or comes back. `prefers-reduced-motion` swaps instantly with a
 * single compensation.
 */

export interface FoldSummaryData {
  durationMs: number
  tools: number
  teammates: number
  /** Interim prose messages the model wrote on the way to the answer. */
  updates: number
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
  if (summary.updates > 0) words.push(`${summary.updates} update${summary.updates === 1 ? '' : 's'}`)
  return words
}

const FOLD_MS = 420
const FOLD_BEAT_MS = 400
const ANCHOR_WINDOW_MS = 480
/** Resting height of the summary ledger line (min-h-8). */
export const FOLD_SUMMARY_PX = 32

/**
 * The anchored live fold only plays when the scroller can absorb the shrink:
 * compensation scrolls UP by (region height - summary height), and scrollTop
 * cannot go below 0. Without that slack the clamp yanks the answer up by the
 * remainder — so the region stays open for this session instead, and rests
 * folded on the next mount. Pure; exported for tests.
 */
export function canAnchorFold(scrollSlack: number, regionHeight: number, summaryHeight = FOLD_SUMMARY_PX): boolean {
  return scrollSlack + 2 >= regionHeight - summaryHeight
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Per-frame scroll compensation: keeps everything below `anchorEl` pixel-fixed
 *  while its height changes. `referenceBottom` lets the caller anchor to a
 *  position captured BEFORE a same-frame insertion (the summary row), so the
 *  insertion itself gets compensated too. Returns a cancel function so an
 *  interrupted toggle can re-anchor from the current position instead of
 *  fighting the stale loop. Exported for tests. */
export function anchorScrollDuring(
  scroller: Element | null,
  anchorEl: Element,
  durationMs: number,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  now: () => number = () => performance.now(),
  referenceBottom?: number,
): () => void {
  if (!scroller) return () => {}
  let cancelled = false
  const bottom0 = referenceBottom ?? anchorEl.getBoundingClientRect().bottom
  const t0 = now()
  const step = () => {
    if (cancelled) return
    const delta = anchorEl.getBoundingClientRect().bottom - bottom0
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    if (now() - t0 < durationMs) raf(step)
  }
  raf(step)
  return () => {
    cancelled = true
  }
}

interface FoldRegionProps {
  /** Whether the turn already produced its final answer (fold-eligible). */
  answered: boolean
  summary: FoldSummaryData
  /** Whether this region plays the anchored live-fold choreography. False for
   *  the earlier siblings of a banner-split turn: they answer at the same
   *  instant, and two concurrent anchor loops would double-compensate the
   *  shared scroller — so siblings fold with the instant path. */
  animated?: boolean
  children: ReactNode
}

export function FoldRegion({ answered, summary, animated = true, children }: FoldRegionProps) {
  // Historical turns rest folded; the live turn folds with choreography when
  // its answer lands (answered flips false → true while mounted).
  const [folded, setFolded] = useState(answered)
  const [landed, setLanded] = useState(answered)
  // The summary line does NOT exist until the fold begins — mounting it at
  // answer time would push the answer down at the stream→final swap and break
  // the structural-parity guarantee. It appears at fold start (fading in) and
  // persists from then on.
  const [summaryVisible, setSummaryVisible] = useState(answered)
  const [landing, setLanding] = useState(false)
  // True while the manual collapse animation plays: the region is still
  // visually open (folded stays false until the animation lands) but the
  // control already reads as closed.
  const [closing, setClosing] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const regionRef = useRef<HTMLDivElement | null>(null)
  const answeredRef = useRef(answered)
  const foldedRef = useRef(folded)
  foldedRef.current = folded
  const animatedRef = useRef(animated)
  animatedRef.current = animated
  const closingRef = useRef(closing)
  closingRef.current = closing
  const manualTimerRef = useRef<number | undefined>(undefined)
  const anchorCancelRef = useRef<(() => void) | null>(null)

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
      setSummaryVisible(true)
      return
    }
    const scroller = wrap.closest('.chat-messages-scroll')

    if (prefersReducedMotion() || !animatedRef.current) {
      if (!canAnchorFold(scroller?.scrollTop ?? 0, region.offsetHeight)) return
      const bottom0 = wrap.getBoundingClientRect().bottom
      setFolded(true)
      setLanded(true)
      setSummaryVisible(true)
      requestAnimationFrame(() => {
        if (!scroller) return
        const delta = wrap.getBoundingClientRect().bottom - bottom0
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      })
      return
    }

    const beat = window.setTimeout(() => {
      // No auto-fold without scroll slack: on a short thread scrollTop cannot
      // absorb the shrink (it clamps at 0) and the answer would slide up by
      // the remainder. The evidence stays open for this session and rests
      // folded on the next mount.
      if (!canAnchorFold(scroller?.scrollTop ?? 0, region.offsetHeight)) return
      // Anchor reference captured BEFORE the summary mounts, so its insertion
      // is compensated along with the region collapse.
      const bottom0 = wrap.getBoundingClientRect().bottom
      setLanding(true)
      setSummaryVisible(true)
      requestAnimationFrame(() => {
        region.style.height = `${region.offsetHeight}px`
        region.style.overflow = 'hidden'
        requestAnimationFrame(() => {
          region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
          region.style.height = '0px'
          region.style.opacity = '0'
          anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS, undefined, undefined, bottom0)
          window.setTimeout(() => {
            setFolded(true)
            setLanded(true)
            setLanding(false)
            region.style.transition = ''
          }, FOLD_MS + 10)
        })
      })
    }, FOLD_BEAT_MS)
    return () => window.clearTimeout(beat)
  }, [answered])

  // A stale manual timer or anchor loop must not outlive the component.
  useEffect(() => () => {
    window.clearTimeout(manualTimerRef.current)
    anchorCancelRef.current?.()
  }, [])

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

  // Manual toggle: BOTH directions play the same 420ms height+opacity
  // choreography, scroll-anchored on the wrap so the summary row under the
  // pointer and the answer below stay pixel-fixed while the evidence grows or
  // folds above them. Interruptible: a click mid-animation cancels the
  // pending timer and stale anchor loop and re-targets from the current
  // height.
  const toggle = () => {
    const region = regionRef.current
    const wrap = wrapRef.current
    if (!region || !wrap) return
    const scroller = wrap.closest('.chat-messages-scroll')
    window.clearTimeout(manualTimerRef.current)
    anchorCancelRef.current?.()
    const isOpen = !folded && !closing

    if (prefersReducedMotion()) {
      const bottom0 = wrap.getBoundingClientRect().bottom
      if (isOpen) {
        setFolded(true)
      } else {
        setClosing(false)
        setFolded(false)
        region.style.height = 'auto'
        region.style.opacity = ''
        region.style.overflow = ''
      }
      requestAnimationFrame(() => {
        if (!scroller) return
        const delta = wrap.getBoundingClientRect().bottom - bottom0
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      })
      return
    }

    if (!isOpen) {
      // Expand — from the current height (0 at rest, mid-value when a
      // collapse gets interrupted) up to the content height.
      setClosing(false)
      setFolded(false)
      region.style.overflow = 'hidden'
      requestAnimationFrame(() => {
        region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
        region.style.height = `${region.scrollHeight}px`
        region.style.opacity = '1'
        anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS)
        manualTimerRef.current = window.setTimeout(() => {
          // Guard: only unclamp if the user hasn't re-collapsed mid-animation.
          if (!foldedRef.current && !closingRef.current && region) {
            region.style.transition = ''
            region.style.height = 'auto'
            region.style.opacity = ''
            region.style.overflow = ''
          }
        }, FOLD_MS + 20)
      })
    } else {
      // Collapse — the folded state commits AFTER the animation lands; the
      // folded layout-effect would snap the height to 0 on the same frame
      // otherwise. `closing` carries the control state in the meantime.
      setClosing(true)
      region.style.overflow = 'hidden'
      region.style.height = `${region.offsetHeight}px`
      requestAnimationFrame(() => {
        region.style.transition = `height ${FOLD_MS}ms var(--ease-smooth), opacity 260ms var(--ease-smooth)`
        region.style.height = '0px'
        region.style.opacity = '0'
        anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS)
        manualTimerRef.current = window.setTimeout(() => {
          setFolded(true)
          setClosing(false)
          region.style.transition = ''
        }, FOLD_MS + 10)
      })
    }
  }

  const words = foldSummaryWords(summary)
  const closed = folded || closing

  return (
    <div ref={wrapRef} data-fold data-folded={folded || undefined}>
      <div ref={regionRef} data-fold-region inert={folded || undefined} aria-hidden={folded || undefined}>
        {children}
      </div>
      {/* The summary carries its OWN after-user inset: an answered region
          rests directly under the user bubble (everything between the ask and
          the answer is inside it), and the items' role-switch spacers fold
          away with the evidence — without this the ledger line sits flush
          under the accent bubble. Constant in both states, so toggling and
          the item set changing mid-turn never shift layout through it. */}
      {summaryVisible && (
        <div data-fold-summary-inset aria-hidden="true" className="h-[var(--space-6)]" />
      )}
      {summaryVisible && (
        <div className="assistant-msg-row min-w-0">
          <button
            type="button"
            data-fold-summary
            style={landing ? { animation: 'jinn-comm-rise 260ms var(--ease-smooth) 140ms both' } : undefined}
            aria-expanded={!closed}
            aria-label={`${words.join(', ')}. ${closed ? 'Show the work' : 'Hide the work'}.`}
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
              className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-200 ease-[var(--ease-smooth)] ${closed ? 'rotate-0' : 'rotate-180'}`}
            />
          </button>
        </div>
      )}
    </div>
  )
}
