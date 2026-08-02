import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import {
  initialMobileView,
  parseSelectedSession,
  parseThreadOrigin,
  resolveDeepLink,
  selectedDelegatedActivityFromList,
  sessionPath,
  threadOriginLabel,
  type ThreadOrigin,
} from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { useModelRegistry } from '@/hooks/use-model-registry'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, pickDeleteFallbackId, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { NavRibbon } from '@/components/pill-nav'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import { ChatPane, type FreshChatSourceSession } from '@/components/chat/chat-pane'
import { ThreadPeek, type CommsPeekData } from '@/components/chat/thread-peek'
import { formatMessage } from '@/components/chat/chat-messages'
// Lazy so the file viewer's syntax-highlighter grammars + react-markdown are
// fetched only when a file tab is actually opened — not on the landing route.
const FileView = lazy(() =>
  import('@/components/chat/file-view').then((m) => ({ default: m.FileView })),
)
import { FileOpenContext } from '@/components/chat/file-open-context'
import { TodoPrefixContext } from '@/components/chat/todo-prefix-context'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { useChatTabs, type ChatTab } from '@/hooks/use-chat-tabs'
import { invalidateLiveSessionSnapshot, prefetchLiveSessionSnapshot } from '@/hooks/use-live-session'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { useTodoPrefixes } from '@/hooks/use-todo-prefixes'
import { useArchiveSession, useDeleteSession, useDuplicateSession, useSessions, useUnarchiveSession } from '@/hooks/use-sessions'
import { clearIntermediateMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import { Archive, ArchiveRestore, Check, Copy, MoreHorizontal, Search, Share2, Trash2 } from 'lucide-react'
import { writeViewMode, type ViewMode } from '@/lib/view-mode'
import { shareDebugLog, clearDebugLog } from '@/lib/debug-log'
import { buildNewSessionParams } from '@/components/chat/new-chat-helpers'
import { buildContinuationPrompt } from '@/lib/stale-chat'

class ChatErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ChatErrorBoundary]', error.message, '\nComponent stack:', info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <PageLayout>
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-lg font-semibold text-[var(--system-red)]">Chat crashed</p>
            <pre className="max-w-lg overflow-auto rounded-lg bg-[var(--bg-tertiary)] p-4 text-left text-xs text-muted-foreground">
              {this.state.error.message}{'\n'}{this.state.error.stack?.split('\n').slice(0, 5).join('\n')}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload() }}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </PageLayout>
      )
    }
    return this.props.children
  }
}

function parseHistoryPreview(value: unknown): CommsPeekData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = (value as { threadPreview?: unknown }).threadPreview
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const peek = candidate as Partial<CommsPeekData>
  if (
    typeof peek.kind !== 'string'
    || typeof peek.employee !== 'string'
    || typeof peek.displayName !== 'string'
    || typeof peek.messageId !== 'string'
    || typeof peek.timestamp !== 'number'
    || typeof peek.preview !== 'string'
  ) return null
  return peek as CommsPeekData
}

function historyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const todoPrefixes = useTodoPrefixes()
  const portalName = settings.portalName ?? 'Jinn'
  // The URL is the single source of truth for the selected session
  // (`/?session=<id>`) — selecting is a navigation, so browser back/forward
  // walk the session trail, refresh restores the thread, and links carry it.
  // A thread drill-in's history entry also carries its origin (the back chip);
  // Jinn ships in chrome-less Tauri shells, so every drill-in needs an in-app
  // way back while browser back keeps working on the web.
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const selectedId = useMemo(() => parseSelectedSession(location.search), [location.search])
  const threadOrigin = useMemo(() => parseThreadOrigin(location.state), [location.state])
  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  // Router location updates are React TRANSITIONS (react-router wraps them in
  // startTransition), so our own urgent state (openTab, closeTab) can commit a
  // frame BEFORE the URL. While one of our navigations is in flight, the
  // tab→URL reconciler must stand down or it re-navigates against the stale
  // URL and clobbers the entry (state included). undefined = nothing pending.
  const pendingNavRef = useRef<string | null | undefined>(undefined)
  // Mobile opens on the THREAD when the URL already selects a session
  // (refresh / deep link / direct open) and on the LIST for bare `/` — the
  // pane derives from the URL at mount, not only from tap events.
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>(
    () => initialMobileView(location.search),
  )
  // sessionMeta carries the sessionId it belongs to so the tab-label effect
  // can ignore stale meta from a previous session mid-switch (title flash fix).
  const [sessionMeta, setSessionMeta] = useState<{ sessionId: string; engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string; archivedAt?: string | null } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  // Employee to preselect for a brand-new chat (contacting a session-less
  // employee from the sidebar, or via an ?employee= deep-link). Null = none.
  const [pendingEmployee, setPendingEmployee] = useState<string | null>(null)
  // Show-both: the slim nav ribbon is always mounted (desktop); only the 280px
  // chat list folds. The ribbon's top toggle drives listOpen (persisted), so nav
  // never leaves the rail. There is no list⇄nav swap any more.
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('jinn-chat-list-open') !== 'false' } catch { return true }
  })
  const toggleList = useCallback(() => {
    setListOpen((prev) => {
      const next = !prev
      try { localStorage.setItem('jinn-chat-list-open', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  // Mobile: pop from the thread back to the chat list (the tab bar's Chat screen).
  const backToList = useCallback(() => setMobileView('sidebar'), [])
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  // Pending user message from new-chat send — passed to the new ChatPane so the user bubble appears before loadSession resolves
  const [pendingUserMessage, setPendingUserMessage] = useState<{ sessionId: string; message: Message } | null>(null)
  const [threadPreview, setThreadPreview] = useState<CommsPeekData | null>(() => parseHistoryPreview(location.state))
  const previewHandoffTargetRef = useRef<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewSourceRef = useRef<{ sessionId: string | null; messageId: string; element: HTMLElement | null } | null>(null)
  const sessionScrollRef = useRef(new Map<string, number>())
  const returnFocusPendingRef = useRef(false)
  const destinationFocusPendingRef = useRef(false)

  // Persist view mode per session
  const setAndPersistViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (selectedId) writeViewMode(selectedId, mode)
  }, [selectedId])

  // When the active session changes, sync viewMode with the per-session persisted value.
  // - Switching to an EXISTING session → load its stored mode.
  // - Switching to a FRESHLY CREATED session (nothing stored yet) → inherit the current
  //   local viewMode, so picking "CLI" on New Chat before sending opens the new session in CLI.
  // - Going back to New Chat (selectedId = null) → keep viewMode as-is (don't force chat).
  const viewModeRef = useRef(viewMode)
  useEffect(() => { viewModeRef.current = viewMode }, [viewMode])
  useEffect(() => {
    if (!selectedId) return
    const raw = typeof window !== 'undefined'
      ? window.localStorage.getItem(`jinn-view-mode-${selectedId}`)
      : null
    if (raw === 'cli' || raw === 'chat') {
      setViewMode(raw)
    } else {
      writeViewMode(selectedId, viewModeRef.current)
    }
  }, [selectedId])
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [focusTrigger, setFocusTrigger] = useState(0)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const { data: engineRegistry } = useModelRegistry() // PTY capability per engine — drives the CLI view toggle
  const chatTabs = useChatTabs()
  const deleteSessionMutation = useDeleteSession()
  const archiveSessionMutation = useArchiveSession()
  const unarchiveSessionMutation = useUnarchiveSession()
  const duplicateSessionMutation = useDuplicateSession()
  const sessionsQuery = useSessions()
  const selectedDelegatedActivity = useMemo(
    () => selectedDelegatedActivityFromList(sessionsQuery.data, selectedId),
    [selectedId, sessionsQuery.data],
  )
  const qc = useQueryClient()
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])


  // Close more menu on outside click. The moreMenu JSX is shared between the
  // desktop tab bar and the mobile header (rendered twice in the DOM, one
  // hidden via CSS), so a single ref points to only one copy — mobile taps
  // would be seen as "outside" and close the menu. Use a data-attribute
  // ancestor check instead so both copies count as "inside".
  useEffect(() => {
    if (!showMoreMenu && !showSessionPicker) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (showMoreMenu && target && !target.closest('[data-more-menu]')) {
        setShowMoreMenu(false)
      }
      if (showSessionPicker && sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu, showSessionPicker])

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setShowMoreMenu(false)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  // D4: open the existing global search (⌘K). GlobalSearch listens for a
  // meta/ctrl+K keydown on window, so synthesize one — same mechanism the old
  // header search button used. Desktop lost its only visible search entry when
  // the header became pills; this restores it inside the ⋯ menu.
  const openGlobalSearch = useCallback(() => {
    setShowMoreMenu(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
  }, [])

  // Update tab label/status when session meta changes.
  // Guarded by `sessionMeta.sessionId === selectedId` so we never cross-write
  // the previous session's meta onto the newly active tab during a switch
  // (ChatPane is `key={selectedId}` — it remounts and re-emits meta).
  const { updateTabStatus, closeTabBySessionId, reconcileTabs } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    if (sessionMeta.sessionId !== selectedId) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  // Clear sessionMeta synchronously when the active session changes — the new
  // ChatPane will repopulate it via onSessionMetaChange once it loads. This
  // prevents the title-flash where the effect above would otherwise stamp the
  // OLD session's title onto the NEW tab between switch and ChatPane mount.
  useEffect(() => {
    setSessionMeta((current) => (current && current.sessionId !== selectedId ? null : current))
  }, [selectedId])

  // Subscribe to session lifecycle events so chat tabs reflect real-time
  // running/idle/error status, get their label updated on rename, and close
  // automatically when the underlying session is deleted (e.g. from sidebar
  // bulk-delete or another client). Without this, `status: 'running'` set by
  // handleSessionCreated never flips back, leaving a stale blue dot.
  useEffect(() => {
    const unsub = subscribe((event: string, payload: unknown) => {
      const p = (payload || {}) as { sessionId?: string; title?: string }
      const sid = p.sessionId
      if (!sid) return
      switch (event) {
        case 'session:started':
          updateTabStatus(sid, { status: 'running' })
          break
        case 'session:completed':
        case 'session:stopped':
          updateTabStatus(sid, { status: 'idle' })
          invalidateLiveSessionSnapshot(sid)
          break
        case 'session:error':
          updateTabStatus(sid, { status: 'error' })
          invalidateLiveSessionSnapshot(sid)
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          invalidateLiveSessionSnapshot(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          invalidateLiveSessionSnapshot(sid)
          break
      }
      // The invalidations above keep the resting-snapshot revisit path honest:
      // a session that changed while no pane for it was mounted takes a cold
      // fetch on the next visit instead of trusting its stale snapshot. The
      // MOUNTED pane is unaffected — it heard the same event and rewrites its
      // snapshot on the next state change.
    })
    return unsub
  }, [subscribe, updateTabStatus, closeTabBySessionId])

  // Reconcile persisted tabs against the authoritative sessions list:
  //   - drop orphan tabs whose sessions were deleted while the app was closed
  //     (or by another client before our WS reconnected)
  //   - normalize stale `status: 'running'` (persists across reloads otherwise)
  //   - pick up renames the WS event didn't carry a title for
  useEffect(() => {
    const sessions = sessionsQuery.data as
      | Array<{ id: string; title?: string; status?: string; employee?: string }>
      | undefined
    if (!sessions) return
    reconcileTabs(sessions)
  }, [sessionsQuery.data, reconcileTabs])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  // The single session-navigation helper — every selection funnels here
  // (sidebar, open-thread jumps, keyboard nav, tab shortcuts). User-initiated
  // selections PUSH a history entry; system-initiated callers (auto-select,
  // tab restore) pass `replace`. `from` is a drill-in's origin, carried in
  // history state for the back chip.
  const handleSelect = useCallback(
    (id: string, opts?: { navigateMobile?: boolean; replace?: boolean; from?: ThreadOrigin }) => {
      const currentId = selectedIdRef.current
      const currentScroller = document.querySelector<HTMLElement>('.chat-messages-scroll')
      if (currentId && currentScroller) sessionScrollRef.current.set(currentId, currentScroller.scrollTop)
      newChatIntentRef.current = false
      // On mobile, opening a session pushes from the list into the thread. The
      // one exception is the background auto-select of the most-recent session
      // (see handleSessionsLoaded): it primes selectedId for the desktop thread
      // but must NOT drop a phone user into a chat when they tapped the Chat tab
      // — that tab should always land on the LIST (GRS-023).
      if (opts?.navigateMobile !== false) setMobileView('chat')
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
      // Skip when already selected — and dedupe PUSH re-fires while the same
      // navigation is still in flight (double-click, repeated auto-select).
      // REPLACE navigations pass through: they are idempotent, and the delete
      // routine pre-claims the sentinel before issuing its replace.
      if (id !== selectedIdRef.current && (opts?.replace || pendingNavRef.current !== id)) {
        pendingNavRef.current = id
        navigate(sessionPath(id), {
          replace: opts?.replace,
          state: opts?.from ? { from: opts.from } : undefined,
        })
      }
    },
    [chatTabs, navigate]
  )

  // URL → tab/intent sync: covers selections that did NOT come through
  // handleSelect — back/forward (POP), deep links, manual URL edits. openTab
  // dedupes and bails when already active, so re-running after a handleSelect
  // push is a no-op.
  const didMountRef = useRef(false)
  useEffect(() => {
    // A selectedId change means a navigation landed — any in-flight sentinel
    // is done (ours just arrived; a competing user navigation obsoletes it).
    pendingNavRef.current = undefined
    if (selectedId) {
      newChatIntentRef.current = false
      chatTabs.openTab({ sessionId: selectedId, label: 'Loading...', status: 'idle', unread: false })
    } else if (didMountRef.current) {
      // Landed on bare `/` mid-session. On history traversal, arm the new-chat
      // intent so the auto-select can't hijack the back button — and on mobile,
      // "before any selection" means the chat LIST, so land there.
      if (navigationType === 'POP') {
        newChatIntentRef.current = true
        setMobileView('sidebar')
      }
      chatTabs.clearActiveTab()
    }
    didMountRef.current = true
    // openTab/clearActiveTab are stable; depending on the whole chatTabs memo
    // would re-fire this on every tab mutation.
  }, [selectedId, navigationType, chatTabs.openTab, chatTabs.clearActiveTab])

  // Auto-focus the input on any session change (sidebar click, tab switch,
  // keyboard nav, "+ New"). Effect runs after ChatPane (key=selectedId)
  // remounts, so the bumped focusTrigger reaches the fresh ChatInput.
  useEffect(() => {
    if (previewHandoffTargetRef.current === selectedId) return
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return
    setFocusTrigger(prev => prev + 1)
  }, [selectedId])

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setPendingEmployee(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Leaving a session for the composer is a navigation — push, so back
    // returns to the thread you left. (sessionMeta clears via the sync effect.)
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate])

  // Start a new chat with a specific employee preselected — used when contacting
  // a session-less employee from the sidebar roster or via an ?employee= deep-link.
  // The actual session is created on first send (ChatPane → buildNewSessionParams).
  const contactEmployee = useCallback((name: string) => {
    newChatIntentRef.current = true
    setPendingEmployee(name)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Contacting from within a session is a navigation to the composer — push.
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate])

  // ?employee=<name> deep-link: an INTENT (compose to that employee), not a
  // location — consumed once so it doesn't re-fire or stick. ?session= is NOT
  // consumed any more: it IS the selection (see the URL model above);
  // resolveDeepLink's session-first precedence keeps a stray employee param
  // inert next to a session link.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const link = resolveDeepLink(searchParams)
    if (link?.kind !== 'employee') return
    contactEmployee(link.name)
    const next = new URLSearchParams(searchParams)
    next.delete('employee')
    setSearchParams(next, { replace: true })
  }, [searchParams, contactEmployee, setSearchParams])

  // Back target for the mobile file-view "back" button: the session that was
  // active when a file link was clicked. selectedIdRef (declared above) is read
  // at call time so the callback stays stable.
  const fileBackTargetRef = useRef<string | null>(null)

  // Open a file in an in-app tab (used by message path-links via FileOpenContext).
  const openFile = useCallback((path: string) => {
    fileBackTargetRef.current = selectedIdRef.current
    chatTabs.openFileTab(path)
    setMobileView('chat')
  }, [chatTabs])

  // Mobile-only: return from a file tab to the chat it was opened from. Switch
  // to that session's tab if it still exists; otherwise fall back to the sidebar.
  const handleFileBack = useCallback(() => {
    const backId = fileBackTargetRef.current
    if (backId) {
      const idx = chatTabs.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === backId)
      if (idx >= 0) {
        chatTabs.switchTab(idx)
        setMobileView('chat')
        return
      }
    }
    setMobileView('sidebar')
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !newChatIntentRef.current && sessions.length > 0) {
        // Background auto-select of the most-recent session: primes the desktop
        // thread, but stays on the chat LIST on mobile (navigateMobile: false),
        // so tapping the Chat tab opens the list to pick/start a chat. REPLACE —
        // a system pick must not create a history entry.
        handleSelect(sessions[0].id, { navigateMobile: false, replace: true })
      }
    },
    [selectedId, handleSelect]
  )

  // THE post-delete routine — every delete entry point (sidebar row menu,
  // page ⋯ menu, Backspace) resolves here and performs ONE atomic history
  // REPLACE straight to the fallback session ('/' only when no sessions
  // remain). Never a clear-to-'/' first: the WS deleted event and the
  // sessions refetch race the router transition, and any intermediate write
  // desyncs the URL from the pane (F5 would then lose the fallback).
  const handleDeleteSession = useCallback(async (id: string) => {
    const wasActive = selectedIdRef.current === id
    // Decide the fallback UP FRONT and pre-claim the navigation sentinel so
    // the tab→URL reconciler stands down for the whole delete window (the WS
    // session:deleted event can close tabs before the mutation resolves).
    const allByRecency = (sessionsQuery.data ?? []).map((s) => String((s as { id?: unknown }).id ?? ''))
    const fallback = wasActive
      ? pickDeleteFallbackId(sidebarOrderRef.current.sessionIds, allByRecency, id)
      : null
    if (wasActive) pendingNavRef.current = fallback
    try {
      await deleteSessionMutation.mutateAsync(id)
    } catch { /* sidebar may have already deleted it */ }
    clearIntermediateMessages(id)
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.kind === 'session' && t.sessionId === id))
    setShowMoreMenu(false)
    if (wasActive) {
      if (fallback) {
        handleSelect(fallback, { replace: true, navigateMobile: false })
      } else {
        pendingNavRef.current = null
        navigate('/', { replace: true })
      }
    }
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, deleteSessionMutation, qc, navigate, handleSelect, sessionsQuery.data])

  // Archive follows the same one-step fallback as delete, but keeps the full
  // transcript durable for search and an explicit future restore.
  const handleArchiveSession = useCallback(async (id: string) => {
    const wasActive = selectedIdRef.current === id
    const allByRecency = (sessionsQuery.data ?? []).map((s) => String((s as { id?: unknown }).id ?? ''))
    const fallback = wasActive
      ? pickDeleteFallbackId(sidebarOrderRef.current.sessionIds, allByRecency, id)
      : null
    if (wasActive) pendingNavRef.current = fallback
    try {
      await archiveSessionMutation.mutateAsync(id)
    } catch {
      if (wasActive) pendingNavRef.current = undefined
      return
    }
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.kind === 'session' && t.sessionId === id))
    setShowMoreMenu(false)
    if (wasActive) {
      if (fallback) handleSelect(fallback, { replace: true, navigateMobile: false })
      else {
        pendingNavRef.current = null
        navigate('/', { replace: true })
      }
    }
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [archiveSessionMutation, chatTabs, qc, navigate, handleSelect, sessionsQuery.data])

  const handleUnarchiveSession = useCallback(async (id: string) => {
    try {
      await unarchiveSessionMutation.mutateAsync(id)
      setShowMoreMenu(false)
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    } catch { /* retain the archived state until the gateway confirms restoration */ }
  }, [unarchiveSessionMutation, qc])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        // Opening the duplicate is a user navigation — push.
        pendingNavRef.current = result.id
        navigate(sessionPath(result.id))
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || 'Unknown error'}`)
    }
  }, [chatTabs, duplicateSessionMutation, qc, navigate])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  const handleStartFreshChat = useCallback(async (previous: FreshChatSourceSession) => {
    const prompt = buildContinuationPrompt(previous.id)
    const result = await api.createSession(buildNewSessionParams({
      message: prompt,
      selectedEmployee: previous.employee ?? null,
      engine: previous.engine,
      model: previous.model,
      effortLevel: previous.effortLevel,
    }))
    const newSessionId = typeof result.id === 'string' ? result.id : ''
    if (!newSessionId) throw new Error('The gateway did not return a new session id')

    chatTabs.openTab({
      sessionId: newSessionId,
      label: typeof result.title === 'string' && result.title ? result.title : 'Continued Chat',
      status: 'running',
      unread: false,
      pinned: true,
      employeeName: previous.employee,
    })
    pendingNavRef.current = newSessionId
    navigate(sessionPath(newSessionId))
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, navigate, qc])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message) => {
    if (pending) setPendingUserMessage({ sessionId: newId, message: pending })
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    // REPLACE — the composer entry BECOMES the created session (same
    // conversation); back should skip the empty composer, not revisit it.
    pendingNavRef.current = newId
    navigate(sessionPath(newId), { replace: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc, navigate])

  // Clear pendingUserMessage when selectedId moves away from the session it was created for
  useEffect(() => {
    if (pendingUserMessage && pendingUserMessage.sessionId !== selectedId) {
      setPendingUserMessage(null)
    }
  }, [selectedId, pendingUserMessage])

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref (declared with the URL model above) so this
  // callback stays stable.
  const handleSessionMetaChange = useCallback((meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string; archivedAt?: string | null }) => {
    const sid = selectedIdRef.current
    if (!sid) return
    setSessionMeta({ sessionId: sid, ...meta })
  }, [])

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  // Inline child affordances all request this one page-owned preview. The
  // same-URL history entry makes browser Back an honest close gesture; direct
  // sidebar/session selections continue through handleSelect without a preview.
  const sessionMetaRef = useRef(sessionMeta)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])
  const requestThreadPreview = useCallback((peek: CommsPeekData) => {
    const currentId = selectedIdRef.current
    const scroller = document.querySelector<HTMLElement>('.chat-messages-scroll')
    if (currentId && scroller) sessionScrollRef.current.set(currentId, scroller.scrollTop)
    previewSourceRef.current = {
      sessionId: currentId,
      messageId: peek.messageId,
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(peek)
    const existing = parseHistoryPreview(location.state)
    navigate(`${location.pathname}${location.search}`, {
      replace: Boolean(existing),
      state: { ...historyRecord(location.state), threadPreview: peek },
    })
  }, [location.pathname, location.search, location.state, navigate])

  const closeThreadPreview = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    if (parseHistoryPreview(location.state)) navigate(-1)
    else setThreadPreview(null)
  }, [location.state, navigate])

  const openPreviewFullChat = useCallback(async (childId: string) => {
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    try {
      await prefetchLiveSessionSnapshot(childId, controller.signal)
      if (controller.signal.aborted) return
      previewHandoffTargetRef.current = childId
      returnFocusPendingRef.current = true
      const parentId = selectedIdRef.current
      handleSelect(childId, {
        replace: true,
        from: parentId
          ? { id: parentId, label: threadOriginLabel(sessionMetaRef.current?.employee, portalName) }
          : undefined,
      })
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      throw error
    }
  }, [handleSelect, portalName])

  // Location state owns open/Back cancellation. A route committed by the
  // handoff is the one exception: keep the shell until that exact child paints.
  useEffect(() => {
    const historyPreview = parseHistoryPreview(location.state)
    if (historyPreview) {
      setThreadPreview(historyPreview)
      return
    }
    const target = previewHandoffTargetRef.current
    if (target && selectedId === target) return
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(null)
  }, [location.state, selectedId])

  const handlePaneContentReady = useCallback((readyId: string) => {
    const scrollTop = sessionScrollRef.current.get(readyId)
    if (scrollTop !== undefined) requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>('.chat-messages-scroll')
      if (selectedIdRef.current === readyId && scroller) scroller.scrollTop = scrollTop
    })

    if (previewHandoffTargetRef.current === readyId) {
      previewAbortRef.current = null
      previewHandoffTargetRef.current = null
      destinationFocusPendingRef.current = true
      setThreadPreview(null)
      return
    }

    const source = previewSourceRef.current
    if (returnFocusPendingRef.current && source?.sessionId === readyId) {
      returnFocusPendingRef.current = false
      requestAnimationFrame(() => {
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(source.messageId)
          : source.messageId.replace(/["\\]/g, '\\$&')
        const target = source.element?.isConnected
          ? source.element
          : document.querySelector<HTMLElement>(`[data-source-message-id="${escaped}"] button, [data-block-id="${escaped}"]`)
        target?.focus({ preventScroll: true })
      })
    }
  }, [])

  const handlePreviewExited = useCallback(() => {
    if (!destinationFocusPendingRef.current) return
    destinationFocusPendingRef.current = false
    requestAnimationFrame(() => {
      if (window.innerWidth >= 1024) setFocusTrigger((value) => value + 1)
      else document.querySelector<HTMLElement>('button[aria-label^="Back"]')?.focus({ preventScroll: true })
    })
  }, [])

  // The in-app way back for a drill-in: POP the entry the jump pushed (never
  // push a new one) — browser back and the chip walk the same trail.
  const goBackToOrigin = useCallback(() => navigate(-1), [navigate])
  const backTo = useMemo(
    () => (threadOrigin && selectedId ? { label: threadOrigin.label, onClick: goBackToOrigin } : undefined),
    [threadOrigin, selectedId, goBackToOrigin],
  )

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const { sessionIds } = sidebarOrderRef.current
    if (sessionIds.length === 0) return
    if (!selectedId) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const idx = sessionIds.indexOf(selectedId)
    if (idx === -1) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const next = (idx + direction + sessionIds.length) % sessionIds.length
    handleSelect(sessionIds[next])
  }, [selectedId, handleSelect])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  const copyChat = useCallback(async () => {
    if (!selectedId) return
    try {
      const session = await api.getSession(selectedId) as { messages?: Array<{ role: string; content: string }> }
      const messages = session.messages ?? []
      const text = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n')
      await navigator.clipboard.writeText(text)
      setCopiedField('chat')
      setTimeout(() => setCopiedField(null), 1500)
    } catch { /* silently fail */ }
  }, [selectedId])

  // Tab activation = session selection (pushes a history entry) for session
  // tabs; file tabs stay a pure tab-model switch (they live outside the URL).
  const activateTab = useCallback((index: number) => {
    const target = chatTabs.tabs[index]
    if (!target) return
    if (target.kind === 'session') handleSelect(target.sessionId)
    else chatTabs.switchTab(index)
  }, [chatTabs, handleSelect])

  const cycleTab = useCallback((direction: 1 | -1) => {
    const count = chatTabs.tabs.length
    if (count === 0) return
    activateTab((chatTabs.activeIndex + direction + count) % count)
  }, [chatTabs, activateTab])

  // Centralized keyboard shortcut registry
  const shortcuts = useMemo<ShortcutDef[]>(() => [
    { key: 'n', category: 'Actions', description: 'New chat', action: handleNewChat },
    { key: 'j', category: 'Navigation', description: 'Next session', action: () => navigateSession(1) },
    { key: 'k', category: 'Navigation', description: 'Previous session', action: () => navigateSession(-1) },
    { key: 'e', category: 'Navigation', description: 'Next employee', action: cycleEmployee },
    { key: 'Backspace', category: 'Actions', description: 'Delete session', action: () => { if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }, enabled: !!selectedId },
    { key: 'Delete', category: 'Actions', description: 'Delete session', action: () => { if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }, enabled: !!selectedId },
    { key: 'c', category: 'Actions', description: 'Copy chat', action: copyChat, enabled: !!selectedId },
    { key: 'Escape', category: 'Navigation', description: 'Close overlay', action: () => {
      if (showShortcutOverlay) setShowShortcutOverlay(false)
      else if (showMoreMenu) setShowMoreMenu(false)
    }},
    { key: '/', category: 'Actions', description: 'Focus chat', action: () => {
      const el = document.getElementById('chat-textarea')
      if (el) el.focus()
    }},
    { key: '?', category: 'Help', description: 'Keyboard shortcuts', action: () => setShowShortcutOverlay(v => !v) },
    { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: () => {
      if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
    }},
    { key: '[', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Previous tab', action: () => cycleTab(-1) },
    { key: ']', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Next tab', action: () => cycleTab(1) },
    // Fold/unfold the chat list. ⌥⌘S is the macOS-native sidebar toggle; ⌘\ is
    // the web-friendly alias (Linear/VS Code class).
    { key: 's', modifiers: ['meta', 'alt'], category: 'Navigation', description: 'Toggle chat list', action: toggleList },
    { key: '\\', modifiers: ['meta'], category: 'Navigation', description: 'Toggle chat list', action: toggleList },
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      modifiers: ['meta' as const, 'alt' as const],
      category: 'Navigation' as const,
      description: `Tab ${i + 1}`,
      action: () => activateTab(i),
    })),
  ], [handleNewChat, navigateSession, cycleEmployee, copyChat, selectedId, showShortcutOverlay, showMoreMenu, chatTabs, toggleList, activateTab, cycleTab])

  useKeyboardShortcuts(shortcuts)

  // Tab → URL reconciliation: tab restore on mount, ⌘W close fallout, and
  // orphan-tab drops land on the tab model first — reflect them into the URL
  // with REPLACE (system-initiated, not user navigation). Gated on hydration
  // so the pre-load empty tab list can't clobber a deep link, and on the
  // active tab OBJECT actually changing: when only the URL moved (back/
  // forward, deep link), the stale active tab must not drag the URL backwards
  // — the URL wins and the openTab sync above brings the tabs along.
  const prevActiveTabRef = useRef<ChatTab | null | undefined>(undefined)
  const prevSelectedForTabSyncRef = useRef(selectedId)
  useEffect(() => {
    if (!chatTabs.hydrated) return
    // One of our navigations is still in flight (location commits are lower-
    // priority transitions) — the URL is stale; reconciling now would drag it
    // backwards. The effect re-runs when the navigation lands (selectedId dep).
    if (pendingNavRef.current !== undefined) return
    const at = chatTabs.activeTab
    const tabChanged = prevActiveTabRef.current === undefined || prevActiveTabRef.current !== at
    const urlMoved = prevSelectedForTabSyncRef.current !== selectedId
    prevActiveTabRef.current = at
    prevSelectedForTabSyncRef.current = selectedId
    // On the run where the URL itself moved, tabs FOLLOW the URL (the openTab
    // sync above lands next flush) — never the other way. Without this, a
    // fresh selection landing while its tab is still being opened (e.g. the
    // post-delete neighbour fallback, whose old tab was just closed) would be
    // bounced to '/' by the no-active-tab branch below.
    if (!tabChanged || urlMoved) return

    if (at && at.kind === 'session' && at.sessionId !== selectedId) {
      handleSelect(at.sessionId, { replace: true, navigateMobile: false })
      return
    }

    if (!at && selectedId && !newChatIntentRef.current) {
      setEmployeeSessions([])
      pendingNavRef.current = null
      navigate('/', { replace: true })
    }
    // When at.kind === 'file', leave selectedId untouched — we render FileView
    // instead of ChatPane, but the underlying session selection is preserved.
  }, [chatTabs.hydrated, chatTabs.activeTab, selectedId, handleSelect, navigate])

  const cliModeAvailable = !sessionMeta?.engine || engineRegistry?.engines?.[sessionMeta.engine]?.supportsPty === true
  const activeSessionTab = chatTabs.activeTab?.kind === 'session' ? chatTabs.activeTab : null
  const viewSwitchLocked = sessionMeta?.engine === 'codex' && activeSessionTab?.sessionId === selectedId && activeSessionTab.status === 'running'
  const cliTitle = viewSwitchLocked
    ? 'Codex view switching is locked while a turn is running'
    : cliModeAvailable ? undefined : 'CLI view is not available for this engine'
  const effectiveViewMode: ViewMode = cliModeAvailable ? viewMode : 'chat'

  // More (…) menu — rendered as the last control inside the right header pill.
  // D7: ALWAYS rendered (even on a new chat, where it carries Search + the view
  // toggle) so the right pill is consistent. When a session is selected the items
  // are grouped: primary (Search · view toggle · Duplicate) → Developer cluster →
  // destructive Delete, each separated.
  const moreMenu = (
    <div data-more-menu className="relative">
      <button
        onClick={() => setShowMoreMenu((v) => !v)}
        aria-label="More options"
        className="inline-flex size-9 lg:size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
      >
        <MoreHorizontal className="size-[18px]" />
      </button>

      {showMoreMenu && (
        <div className="absolute right-0 top-full z-[200] mt-2 min-w-[220px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          {/* PRIMARY group — Search (⌘K), then the Chat/CLI view toggle, then
              Duplicate (only when a session is selected). */}
          {/* D4: Search lives at the very top — the only visible ⌘K entry point on desktop. */}
          <button
            onClick={openGlobalSearch}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Search className="size-3.5" />
            <span className="flex-1">Search…</span>
            <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌘K</kbd>
          </button>
          {/* Chat/CLI view toggle (moved here from the old tab bar so it stays
              reachable now that the header is a pill). */}
          <div className="flex items-center gap-1 px-3 py-2">
            <button
              onClick={() => { if (!viewSwitchLocked) { setAndPersistViewMode('chat'); setShowMoreMenu(false) } }}
              disabled={viewSwitchLocked}
              title={viewSwitchLocked ? cliTitle : undefined}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                effectiveViewMode === 'chat' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
                viewSwitchLocked && "opacity-60 cursor-not-allowed"
              )}
            >
              Chat
            </button>
            <button
              onClick={() => { if (cliModeAvailable && !viewSwitchLocked) { setAndPersistViewMode('cli'); setShowMoreMenu(false) } }}
              disabled={!cliModeAvailable || viewSwitchLocked}
              title={cliTitle}
              className={cn(
                "flex-1 rounded-md px-2 py-1 font-mono text-xs font-medium transition-colors",
                effectiveViewMode === 'cli' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
                (!cliModeAvailable || viewSwitchLocked) && "opacity-45 cursor-not-allowed"
              )}
            >
              CLI
            </button>
          </div>
          {selectedId && (
            <button
              onClick={() => { if (selectedId) handleDuplicate(selectedId) }}
              disabled={duplicateSessionMutation.isPending}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Copy className="size-3.5" />
              <span className="flex-1">{duplicateSessionMutation.isPending ? 'Duplicating...' : 'Duplicate...'}</span>
            </button>
          )}

          {selectedId && (
            <>
              <div className="my-0.5 border-t border-border" />
              <button
                onClick={() => {
                  if (!selectedId) return
                  if (sessionMeta?.archivedAt) handleUnarchiveSession(selectedId)
                  else handleArchiveSession(selectedId)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                {sessionMeta?.archivedAt ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                <span className="flex-1">{sessionMeta?.archivedAt ? 'Unarchive chat' : 'Archive chat'}</span>
              </button>
              {/* DEVELOPER cluster */}
              <div className="my-0.5 border-t border-border" />
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                Developer
              </div>
              <button
                onClick={() => copyToClipboard(selectedId, 'id')}
                className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                Copy Session ID
              </button>
              {sessionMeta?.engineSessionId && (
                <button
                  onClick={() => {
                    const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                    copyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                >
                  Copy CLI Resume Command
                </button>
              )}
              <button
                onClick={() => { setShowMoreMenu(false); shareDebugLog() }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Share2 className="size-3.5" />
                <span className="flex-1">Share debug log</span>
              </button>
              <button
                onClick={() => { setShowMoreMenu(false); clearDebugLog() }}
                className="block w-full px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent"
              >
                Clear debug log
              </button>

              {/* DESTRUCTIVE */}
              <div className="my-0.5 border-t border-border" />
              <button
                onClick={() => { setShowMoreMenu(false); if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--system-red)] transition-colors hover:bg-accent"
              >
                <Trash2 className="size-3.5" />
                <span className="flex-1">Delete Session</span>
                <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )

  // The conversation title — slim inline title (desktop) / centered nav-bar title
  // (mobile thread). "New chat" on a fresh composer, else nothing until meta loads.
  const headerTitle = sessionMeta?.title?.trim() || (selectedId ? '' : 'New chat')

  const onMobileList = mobileView === 'sidebar'

  return (
    <FileOpenContext.Provider value={openFile}>
    <TodoPrefixContext.Provider value={todoPrefixes}>
    <PageLayout chromeless>
      <div className="flex overflow-hidden h-full">
        {/* Left region (desktop): the permanent slim nav ribbon + the foldable
            280px chat list. The ribbon's top toggle folds the list to 0; the
            ribbon persists and the thread reflows wider. No overflow-hidden here
            so the ribbon's per-icon label pills can escape to the right over the
            list/thread (the list column clips its own fold). `group/sidebar`
            scopes the ribbon-logo→toggle morph to this whole region (rail + list)
            — hovering the thread (a sibling outside this div) never triggers it. */}
        <div className="group/sidebar hidden h-full shrink-0 lg:flex">
          <NavRibbon listOpen={listOpen} onToggleList={toggleList} />
          {/* Fold the list by animating its width; the inner column keeps a fixed
              280px so its contents don't reflow mid-fold. */}
          <div
            className={cn(
              "h-full overflow-hidden transition-[width] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              listOpen ? "w-[280px]" : "w-0",
            )}
            aria-hidden={!listOpen}
          >
            <div className="h-full w-[280px]">
              <ChatSidebar
                selectedId={selectedId}
                onSelect={handleSelect}
                onNewChat={handleNewChat}
                onDelete={handleDeleteSession}
                onArchive={handleArchiveSession}
                onUnarchive={handleUnarchiveSession}
                onDuplicate={handleDuplicateFromSidebar}
                onSessionsLoaded={handleSessionsLoaded}
                onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
                onOrderComputed={handleOrderComputed}
                onContactEmployee={contactEmployee}
              />
            </div>
          </div>
        </div>

        <div className="chat-pills-layout relative min-w-0 flex-1 flex-col overflow-hidden bg-background flex">
          {/* Soft top scrim (gradient, not a border) — content scrolls under it.
              Hold a real cloud behind the floating header, then fade before the
              message list's top padding ends. Theme-aware via var(--bg). */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-[5] h-[88px]",
              onMobileList && "hidden lg:block",
            )}
            style={{ background: 'linear-gradient(to bottom, var(--bg) 0, var(--bg) 52px, color-mix(in srgb, var(--bg) 68%, transparent) 68px, transparent 100%)' }}
          />

          {/* Frosted corner pills replace the solid header. Hidden over the mobile
              chat-list view (the sidebar has its own header); shown on desktop + thread. */}
          <ChatHeaderPills
            hideOnMobile={onMobileList}
            title={headerTitle}
            backTo={backTo}
            onBack={backToList}
            onNew={handleNewChat}
            moreMenu={moreMenu}
          />

          {copiedField && (
            <div className="absolute right-4 top-[58px] z-10 flex items-center gap-1 rounded-full bg-[var(--material-thick)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] shadow-[var(--shadow-overlay)]">
              <Check className="size-3" /> Copied!
            </div>
          )}

          <div
            className={mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}
          >
            {/* Mobile: the chat list is the full-width body; the bottom tab bar
                (rendered below) is the persistent nav. */}
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onArchive={handleArchiveSession}
              onUnarchive={handleUnarchiveSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
              onContactEmployee={contactEmployee}
            />
          </div>

          <div className={cn(
            "flex-1 overflow-hidden flex flex-col",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}>
            {/* File tab → render the in-app file viewer inside the same bounded
                wrapper (so scrolling is contained). Otherwise the single ChatPane:
                handles new-chat (sessionId=null) and the selected session. Keyed by
                selectedId so switching sessions remounts cleanly — no hidden
                keep-alive panes (they caused stacked WS subscriptions + races). */}
            {chatTabs.activeTab?.kind === 'file' ? (
              <Suspense fallback={<div className="flex-1" />}>
                <FileView path={chatTabs.activeTab.path} embedded onBack={handleFileBack} />
              </Suspense>
            ) : (
              <ChatPane
                key={selectedId ?? `__new__:${pendingEmployee ?? ''}`}
                sessionId={selectedId}
                initialEmployee={selectedId ? undefined : pendingEmployee}
                isActive={true}
                onFocus={() => {}}
                onSessionCreated={handleSessionCreated}
                onNewChat={handleNewChat}
                onSessionMetaChange={handleSessionMetaChange}
                onRefresh={handleRefresh}
                portalName={portalName}
                subscribe={subscribe}
                engineRegistry={engineRegistry}
                connectionSeq={connectionSeq}
                skillsVersion={skillsVersion}
                events={events}
                viewMode={effectiveViewMode}
                focusTrigger={focusTrigger}
                onShortcutsClick={() => setShowShortcutOverlay(true)}
                pendingUserMessage={
                  pendingUserMessage && pendingUserMessage.sessionId === selectedId
                    ? pendingUserMessage.message
                    : undefined
                }
                onPeek={requestThreadPreview}
                onContentReady={handlePaneContentReady}
                delegatedActivity={selectedDelegatedActivity}
                onStartFreshChat={handleStartFreshChat}
              />
            )}
          </div>

          {/* Stable above the session-keyed ChatPane: it survives route remount
              and releases only after the destination reports meaningful paint. */}
          <ThreadPeek
            peek={threadPreview}
            onClose={closeThreadPreview}
            onOpenFullChat={threadPreview?.sessionId ? openPreviewFullChat : undefined}
            onExited={handlePreviewExited}
            renderContent={formatMessage}
          />
        </div>
      </div>

      {/* Mobile bottom tab bar — persistent nav on the chat-list screen; hidden on
          the thread (Apple hidesBottomBarWhenPushed: the composer owns the bottom). */}
      {onMobileList && <MobileTabBar />}

      {showShortcutOverlay && (
        <ShortcutOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutOverlay(false)}
        />
      )}

      {/* D8: clear the floating pills/scrim by padding the scroll container itself
          and aligning scroll anchoring to the same offset. Driven by the shared
          token (pill height + gap + safe-area) so it auto-tracks notched devices —
          no fragile `:first-child` coupling or magic number. Content still scrolls
          beneath the translucent scrim. */}
      <style>{`
        .chat-pills-layout .chat-messages-scroll {
          padding-top: var(--chat-top-clearance);
          scroll-padding-top: var(--chat-top-clearance);
        }
      `}</style>
    </PageLayout>
    </TodoPrefixContext.Provider>
    </FileOpenContext.Provider>
  )
}
