import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Lock, X } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { StateLine } from '@/components/ui/state-line'
import { clockTime } from './comms-callout'
import { fetchFullReply, fullReplyCache } from './teammate-reply'

/**
 * The read-only report panel — peek-then-commit (Apple quick look):
 * clicking a comms ledger line slides this inspector over the right edge
 * (desktop) or up as a bottom sheet (mobile). It renders the teammate's
 * report read-only — no composer; reading and conversing are honestly
 * different gestures. "Open full chat" commits: the surface grows into the
 * full conversation, then navigation goes through the existing nav model so
 * history and the back chip stay correct.
 *
 * Body content: meta.fullMessage renders directly (zero fetches — survives
 * child-session deletion). Legacy callbacks without the contract lazy-fetch
 * the child's final message by provenance match, with the clipped preview as
 * the honest fallback.
 */

export interface CommsPeekData {
  kind: 'reply' | 'error' | 'relay'
  employee: string
  displayName: string
  /** Child session (callbacks) or sender session (relays); absent on legacy rows. */
  sessionId?: string
  messageId: string
  timestamp: number
  preview: string
  fullMessage?: string
}

const EXIT_MS = 260
const COMMIT_MS = 380

function usePeekBody(peek: CommsPeekData): string {
  const [fetched, setFetched] = useState<string | null>(() => fullReplyCache.get(peek.messageId) ?? null)

  useEffect(() => {
    // meta.fullMessage already carries the whole report — never fetch then.
    if (peek.fullMessage) return
    if (peek.kind !== 'reply' || !peek.sessionId || !peek.preview) return
    if (fullReplyCache.has(peek.messageId)) {
      setFetched(fullReplyCache.get(peek.messageId) ?? null)
      return
    }
    let cancelled = false
    fetchFullReply(peek.sessionId, peek.preview)
      .then((text) => {
        fullReplyCache.set(peek.messageId, text)
        if (!cancelled) setFetched(text)
      })
      .catch(() => { /* preview stays — the honest fallback */ })
    return () => { cancelled = true }
  }, [peek])

  return peek.fullMessage ?? fetched ?? peek.preview
}

interface ThreadPeekProps {
  peek: CommsPeekData
  onClose: () => void
  /** Commit: navigate to the session through the existing nav model. */
  onOpenFullChat?: (sessionId: string) => void
  renderContent: (text: string) => ReactNode
}

export function ThreadPeek({ peek, onClose, onOpenFullChat, renderContent }: ThreadPeekProps) {
  const [phase, setPhase] = useState<'open' | 'closing' | 'commit'>('open')
  const panelRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const body = usePeekBody(peek)
  const error = peek.kind === 'error'

  const close = () => {
    if (phaseRef.current !== 'open') return
    setPhase('closing')
    window.setTimeout(onClose, EXIT_MS)
  }

  const commit = () => {
    if (phaseRef.current !== 'open' || !peek.sessionId || !onOpenFullChat) return
    setPhase('commit')
    const sessionId = peek.sessionId
    window.setTimeout(() => onOpenFullChat(sessionId), COMMIT_MS)
  }

  // Focus in on open, restore on unmount; Esc closes.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreFocusRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bottom-sheet drag-to-dismiss (mobile): the grabber/header follows the
  // finger; past 100px the sheet commits to closing, otherwise springs back.
  const dragStartY = useRef<number | null>(null)
  const onDragStart = (event: React.TouchEvent) => {
    if (window.innerWidth > 640) return
    dragStartY.current = event.touches[0].clientY
    if (panelRef.current) panelRef.current.style.transition = 'none'
  }
  const onDragMove = (event: React.TouchEvent) => {
    if (dragStartY.current == null || !panelRef.current) return
    const dy = Math.max(0, event.touches[0].clientY - dragStartY.current)
    panelRef.current.style.transform = `translateY(${dy}px)`
  }
  const onDragEnd = (event: React.TouchEvent) => {
    if (dragStartY.current == null || !panelRef.current) return
    const dy = Math.max(0, event.changedTouches[0].clientY - dragStartY.current)
    dragStartY.current = null
    const panel = panelRef.current
    panel.style.transition = ''
    if (dy > 100) {
      close()
    } else {
      panel.style.transform = ''
    }
  }

  const stateLabel = error
    ? "Couldn't finish"
    : peek.kind === 'relay'
      ? `Messaged · ${clockTime(peek.timestamp)}`
      : `Replied · ${clockTime(peek.timestamp)}`

  return (
    <div className="absolute inset-0 z-50" data-peek-phase={phase}>
      <div
        aria-hidden="true"
        className="peek-scrim absolute inset-0 bg-[var(--scrim)]"
        onClick={close}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${peek.displayName} report`}
        className="peek-panel absolute flex flex-col bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-2xl"
        data-testid="thread-peek"
      >
        <div
          className="peek-grab mx-auto mt-2 hidden h-1 w-9 shrink-0 rounded-[2px] bg-[var(--fill-primary)]"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
        />
        <header
          className="peek-stag flex shrink-0 items-center gap-[var(--space-3)] px-[18px] pb-3 pt-[18px] [animation-delay:120ms]"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
        >
          <EmployeeChip employee={peek.employee} displayName={peek.displayName} size={36} showName={false} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {peek.displayName}
            </span>
            <StateLine
              state={error ? 'error' : 'replied'}
              label={stateLabel}
              className="mt-0.5"
            />
          </span>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={close}
            className="inline-flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <div className="peek-stag min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-1 [animation-delay:180ms]" data-scrollable>
          <div className="text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] text-[var(--text-primary)]">
            {renderContent(body)}
          </div>
        </div>
        <footer className="peek-stag flex shrink-0 items-center gap-[var(--space-3)] px-[18px] pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 [animation-delay:240ms]">
          <span className="inline-flex flex-1 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
            <Lock size={12} strokeWidth={2} aria-hidden="true" />
            Read-only
          </span>
          {peek.sessionId && onOpenFullChat && (
            <button
              type="button"
              onClick={commit}
              className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-[15px] py-[7px] text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)] transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96]"
            >
              Open full chat
              <ChevronRight size={12} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}
        </footer>
      </aside>
      <style>{PEEK_CSS}</style>
    </div>
  )
}

const PEEK_CSS = `
  .peek-scrim { animation: jinn-peek-scrim 220ms var(--ease-smooth) both; }
  [data-peek-phase="closing"] .peek-scrim { animation: jinn-peek-scrim 200ms var(--ease-smooth) both reverse; }
  @keyframes jinn-peek-scrim { from { opacity: 0; } to { opacity: 1; } }

  .peek-panel {
    top: 0; right: 0; bottom: 0;
    width: min(480px, 100%);
    border-radius: 18px 0 0 18px;
    animation: jinn-peek-in 380ms var(--ease-snappy) both;
    transition: width 360ms var(--ease-snappy), border-radius 360ms var(--ease-snappy), transform 260ms var(--ease-snappy);
  }
  [data-peek-phase="closing"] .peek-panel { animation: jinn-peek-out 260ms var(--ease-snappy) both; }
  [data-peek-phase="commit"] .peek-panel { width: 100%; border-radius: 0; }
  @keyframes jinn-peek-in { from { transform: translateX(calc(100% + 48px)); } to { transform: none; } }
  @keyframes jinn-peek-out { from { transform: none; } to { transform: translateX(calc(100% + 48px)); } }

  /* Content staggers in after the surface (header, body, foot at +60ms steps). */
  .peek-stag { opacity: 0; transform: translateY(10px); animation: jinn-peek-stag 240ms var(--ease-smooth) both; }
  @keyframes jinn-peek-stag { to { opacity: 1; transform: none; } }
  [data-peek-phase="closing"] .peek-stag { animation: none; opacity: 1; transform: none; }
  [data-peek-phase="commit"] .peek-stag { animation: none; opacity: 1; transform: none; }

  /* Mobile: bottom sheet — grabber, 92% height, swipe-down to dismiss. */
  @media (max-width: 640px) {
    .peek-panel {
      top: auto; left: 0; right: 0; bottom: 0;
      width: 100%; height: 92%;
      border-radius: 18px 18px 0 0;
      animation-name: jinn-sheet-in;
      transition: height 360ms var(--ease-snappy), border-radius 360ms var(--ease-snappy), transform 260ms var(--ease-snappy);
    }
    [data-peek-phase="closing"] .peek-panel { animation-name: jinn-sheet-out; }
    [data-peek-phase="commit"] .peek-panel { height: 100%; border-radius: 0; }
    .peek-grab { display: block; }
    @keyframes jinn-sheet-in { from { transform: translateY(calc(100% + 48px)); } to { transform: none; } }
    @keyframes jinn-sheet-out { from { transform: none; } to { transform: translateY(calc(100% + 48px)); } }
  }

  @media (prefers-reduced-motion: reduce) {
    .peek-panel, [data-peek-phase="closing"] .peek-panel {
      animation-name: jinn-peek-fade; animation-duration: 120ms; animation-timing-function: linear;
    }
    [data-peek-phase="closing"] .peek-panel { animation-direction: reverse; }
    @keyframes jinn-peek-fade { from { opacity: 0; transform: none; } to { opacity: 1; transform: none; } }
    .peek-stag { animation: none; opacity: 1; transform: none; }
  }
`
