import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Lock, X } from 'lucide-react'
import { EmployeeChip } from '@/components/ui/employee-chip'
import { StateLine } from '@/components/ui/state-line'
import {
  prefetchLiveSessionSnapshot,
  readPrefetchedLiveSessionSnapshot,
} from '@/hooks/use-live-session'
import { clockTime } from './comms-callout'
import { cleanLikeGateway, fullReplyCache } from './teammate-reply'

export interface CommsPeekData {
  kind: 'reply' | 'error' | 'relay' | 'delegation' | 'dispatch'
  employee: string
  displayName: string
  sessionId?: string
  messageId: string
  timestamp: number
  preview: string
  fullMessage?: string
}

type PeekPhase = 'entering' | 'open' | 'handoff' | 'closing' | 'revealing'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>([
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
}

async function fetchChildPreview(
  sessionId: string,
  kind: CommsPeekData['kind'],
  preview: string,
): Promise<string | null> {
  await prefetchLiveSessionSnapshot(sessionId)
  const messages = readPrefetchedLiveSessionSnapshot(sessionId)?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue
    const content = message.content.trim()
    if (!content) continue
    if (kind === 'reply') {
      if (cleanLikeGateway(content) === preview) return content
      continue
    }
    return content
  }
  return null
}

function usePeekBody(peek: CommsPeekData): string {
  const [fetched, setFetched] = useState<string | null>(() => fullReplyCache.get(peek.messageId) ?? null)

  useEffect(() => {
    const cached = fullReplyCache.get(peek.messageId) ?? null
    setFetched(cached)
    if (peek.fullMessage || cached) return
    if (!peek.sessionId) return
    let cancelled = false
    const request = peek.kind === 'reply' && peek.preview
      ? fetchChildPreview(peek.sessionId, peek.kind, peek.preview)
      : peek.kind === 'delegation' || peek.kind === 'dispatch'
        ? fetchChildPreview(peek.sessionId, peek.kind, peek.preview)
        : Promise.resolve(null)
    request
      .then((text) => {
        fullReplyCache.set(peek.messageId, text)
        if (!cancelled) setFetched(text)
      })
      .catch(() => { /* The source preview remains the honest fallback. */ })
    return () => { cancelled = true }
  }, [peek])

  return peek.fullMessage ?? fetched ?? peek.preview
}

interface ThreadPeekProps {
  /** Null closes the stable shell; the last content remains mounted through exit. */
  peek: CommsPeekData | null
  onClose: () => void
  /** Starts prefetch/navigation through the page-owned cancellable controller. */
  onOpenFullChat?: (sessionId: string) => void | Promise<void>
  renderContent: (text: string) => ReactNode
  onExited?: () => void
}

export function ThreadPeek({ peek, onClose, onOpenFullChat, renderContent, onExited }: ThreadPeekProps) {
  const [displayPeek, setDisplayPeek] = useState<CommsPeekData | null>(peek)
  const [phase, setPhase] = useState<PeekPhase>(peek ? 'entering' : 'closing')
  const panelRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )
  const frameRef = useRef<number | null>(null)
  const enteredRef = useRef(false)
  const closeBeforeOpenRef = useRef(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const body = usePeekBody(displayPeek ?? peek ?? EMPTY_PEEK)
  const error = displayPeek?.kind === 'error'

  const finishExit = useCallback(() => {
    setDisplayPeek(null)
    onExited?.()
    const target = restoreFocusRef.current
    if (target?.isConnected) target.focus({ preventScroll: true })
  }, [onExited])

  useLayoutEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    if (peek) {
      if (!displayPeek) {
        restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
      setDisplayPeek(peek)
      setPhase('entering')
      enteredRef.current = false
      closeBeforeOpenRef.current = false
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => {
          enteredRef.current = true
          setPhase('open')
        })
      })
      return
    }
    if (!displayPeek) return
    setPhase((current) => current === 'handoff' ? 'revealing' : 'closing')
    // An Escape before the double-rAF enter begins has no visible motion to
    // reverse, and entering/closing share the same offscreen transform. Release
    // immediately instead of waiting for a transitionend that cannot fire.
    if (!enteredRef.current || closeBeforeOpenRef.current || prefersReducedMotion()) finishExit()
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
    // displayPeek is intentionally read as the retained shell, not an open trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek, finishExit])

  const requestClose = useCallback(() => {
    if (!displayPeek || phaseRef.current === 'closing' || phaseRef.current === 'revealing') return
    const bounds = panelRef.current?.getBoundingClientRect()
    const fullyOffscreen = Boolean(bounds && (
      bounds.left >= window.innerWidth
      || bounds.right <= 0
      || bounds.top >= window.innerHeight
      || bounds.bottom <= 0
    ))
    closeBeforeOpenRef.current = phaseRef.current === 'entering'
    setPhase('closing')
    onClose()
    // CSS cannot emit transitionend when entering and closing resolve to the
    // same fully-offscreen transform. Nothing is visible, so release now.
    if (fullyOffscreen || prefersReducedMotion()) finishExit()
  }, [displayPeek, finishExit, onClose])

  const requestFullChat = useCallback(() => {
    if (!displayPeek?.sessionId || !onOpenFullChat) return
    if (phaseRef.current === 'handoff' || phaseRef.current === 'closing' || phaseRef.current === 'revealing') return
    setPhase('handoff')
    Promise.resolve(onOpenFullChat(displayPeek.sessionId)).catch(() => setPhase('open'))
  }, [displayPeek, onOpenFullChat])

  useEffect(() => {
    if (!displayPeek) return
    closeRef.current?.focus({ preventScroll: true })
    const appRoot = document.getElementById('root')
    const priorInert = appRoot?.inert
    const priorAriaHidden = appRoot?.getAttribute('aria-hidden')
    const priorOverflow = document.body.style.overflow
    if (appRoot) {
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = focusableWithin(panelRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = priorOverflow
      if (appRoot) {
        appRoot.inert = priorInert ?? false
        if (priorAriaHidden == null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', priorAriaHidden)
      }
    }
  }, [displayPeek, requestClose])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    const target = restoreFocusRef.current
    if (target?.isConnected) target.focus({ preventScroll: true })
  }, [])

  if (!displayPeek) return null

  const stateLabel = error
    ? "Couldn't finish"
    : displayPeek.kind === 'relay'
      ? `Messaged · ${clockTime(displayPeek.timestamp)}`
      : displayPeek.kind === 'delegation'
        ? `Delegated · ${clockTime(displayPeek.timestamp)}`
        : displayPeek.kind === 'dispatch'
          ? `Followed up · ${clockTime(displayPeek.timestamp)}`
          : `Replied · ${clockTime(displayPeek.timestamp)}`

  const view = (
    <div
      className="thread-peek-root fixed inset-0 z-[100]"
      data-peek-phase={phase}
      onWheel={(event) => {
        if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) event.preventDefault()
      }}
    >
      <button
        type="button"
        aria-label="Close preview"
        tabIndex={-1}
        className="peek-scrim absolute inset-0 cursor-default border-none bg-[var(--scrim)] p-0"
        onClick={requestClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${displayPeek.displayName} report`}
        aria-hidden={phase === 'revealing' ? true : undefined}
        tabIndex={-1}
        className="peek-panel absolute flex flex-col bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-2xl"
        data-testid="thread-peek"
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
          if (phaseRef.current === 'closing' || phaseRef.current === 'revealing') finishExit()
        }}
      >
        <div className="peek-grab mx-auto mt-2 hidden h-1 w-9 shrink-0 rounded-[2px] bg-[var(--fill-primary)]" />
        <header className="flex shrink-0 items-center gap-[var(--space-3)] px-[18px] pb-3 pt-[calc(18px+env(safe-area-inset-top))]">
          <EmployeeChip employee={displayPeek.employee} displayName={displayPeek.displayName} size={36} showName={false} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {displayPeek.displayName}
            </span>
            <StateLine state={error ? 'error' : 'replied'} label={stateLabel} className="mt-0.5" />
          </span>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:scale-[0.96]"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-1" data-scrollable>
          <div className="text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] text-[var(--text-primary)]">
            {renderContent(body)}
          </div>
        </div>
        <footer className="flex shrink-0 items-center gap-[var(--space-3)] px-[18px] pb-[calc(16px+env(safe-area-inset-bottom))] pt-3">
          <span className="inline-flex flex-1 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
            <Lock size={12} strokeWidth={2} aria-hidden="true" />
            Read-only
          </span>
          {displayPeek.sessionId && onOpenFullChat && (
            <button
              type="button"
              onClick={requestFullChat}
              aria-disabled={phase === 'handoff'}
              aria-busy={phase === 'handoff'}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-[15px] py-[7px] text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)] transition-[background-color,scale,opacity] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] aria-disabled:cursor-wait aria-disabled:opacity-60"
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

  return createPortal(view, document.body)
}

const EMPTY_PEEK: CommsPeekData = {
  kind: 'reply',
  employee: '',
  displayName: '',
  messageId: '',
  timestamp: 0,
  preview: '',
}

const PEEK_CSS = `
  .peek-scrim {
    opacity: 1;
    transition-property: opacity;
    transition-duration: 160ms;
    transition-timing-function: var(--ease-smooth);
  }
  [data-peek-phase="entering"] .peek-scrim,
  [data-peek-phase="closing"] .peek-scrim,
  [data-peek-phase="revealing"] .peek-scrim { opacity: 0; }
  [data-peek-phase="revealing"] .peek-scrim { transition: none; }

  .peek-panel {
    top: 0; right: 0; bottom: 0;
    width: min(480px, 100%);
    border-radius: var(--radius-xl) 0 0 var(--radius-xl);
    opacity: 1;
    transform: none;
    transition-property: transform, opacity;
    transition-duration: 260ms, 180ms;
    transition-timing-function: var(--ease-snappy), var(--ease-snappy);
  }
  [data-peek-phase="entering"] .peek-panel { transform: translateX(calc(100% + 24px)); }
  [data-peek-phase="closing"] .peek-panel {
    transform: translateX(calc(100% + 24px));
    transition-duration: 200ms, 160ms;
  }
  [data-peek-phase="revealing"] .peek-panel {
    opacity: 0;
    transform: translateX(16px);
    transition-duration: 180ms, 180ms;
  }
  [data-peek-phase="revealing"] .peek-panel [data-scrollable] {
    opacity: 0;
  }

  @media (max-width: 640px) {
    .peek-panel {
      top: auto; left: 0; right: 0; bottom: 0;
      width: 100%;
      height: min(92dvh, calc(100dvh - env(safe-area-inset-top)));
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
      transition-duration: 280ms, 180ms;
    }
    [data-peek-phase="entering"] .peek-panel { transform: translateY(calc(100% + 24px)); }
    [data-peek-phase="closing"] .peek-panel {
      transform: translateY(calc(100% + 24px));
      transition-duration: 220ms, 160ms;
    }
    [data-peek-phase="revealing"] .peek-panel {
      opacity: 0;
      transform: translateY(12px);
      transition-duration: 180ms, 180ms;
    }
    .peek-grab { display: block; }
  }

  @media (prefers-reduced-motion: reduce) {
    .peek-scrim, .peek-panel { transition: none; }
    [data-peek-phase="entering"] .peek-panel,
    [data-peek-phase="closing"] .peek-panel,
    [data-peek-phase="revealing"] .peek-panel { transform: none; }
  }
`
