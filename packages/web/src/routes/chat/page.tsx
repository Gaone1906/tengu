import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { resolveDeepLink } from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { NavRibbon } from '@/components/pill-nav'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import { ChatPane } from '@/components/chat/chat-pane'
// Lazy so the file viewer's syntax-highlighter grammars + react-markdown are
// fetched only when a file tab is actually opened — not on the landing route.
const FileView = lazy(() =>
  import('@/components/chat/file-view').then((m) => ({ default: m.FileView })),
)
import { FileOpenContext } from '@/components/chat/file-open-context'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { useChatTabs } from '@/hooks/use-chat-tabs'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { useDeleteSession, useDuplicateSession, useSessions } from '@/hooks/use-sessions'
import { clearIntermediateMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import { Check, Copy, MoreHorizontal, Search, Share2, Trash2 } from 'lucide-react'
import { writeViewMode, type ViewMode } from '@/lib/view-mode'
import { shareDebugLog, clearDebugLog } from '@/lib/debug-log'

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
  const portalName = settings.portalName ?? 'Jinn'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  // sessionMeta carries the sessionId it belongs to so the tab-label effect
  // can ignore stale meta from a previous session mid-switch (title flash fix).
  const [sessionMeta, setSessionMeta] = useState<{ sessionId: string; engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
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
  const chatTabs = useChatTabs()
  const deleteSessionMutation = useDeleteSession()
  const duplicateSessionMutation = useDuplicateSession()
  const sessionsQuery = useSessions()
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
          break
        case 'session:error':
          updateTabStatus(sid, { status: 'error' })
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          break
      }
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

  const handleSelect = useCallback(
    (id: string, opts?: { navigateMobile?: boolean }) => {
      newChatIntentRef.current = false
      setSelectedId(id)
      // On mobile, opening a session pushes from the list into the thread. The
      // one exception is the background auto-select of the most-recent session
      // (see handleSessionsLoaded): it primes selectedId for the desktop thread
      // but must NOT drop a phone user into a chat when they tapped the Chat tab
      // — that tab should always land on the LIST (GRS-023).
      if (opts?.navigateMobile !== false) setMobileView('chat')
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
    },
    [chatTabs]
  )

  // Auto-focus the input on any session change (sidebar click, tab switch,
  // keyboard nav, "+ New"). Effect runs after ChatPane (key=selectedId)
  // remounts, so the bumped focusTrigger reaches the fresh ChatInput.
  useEffect(() => {
    setFocusTrigger(prev => prev + 1)
  }, [selectedId])

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setPendingEmployee(null)
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
  }, [chatTabs])

  // Start a new chat with a specific employee preselected — used when contacting
  // a session-less employee from the sidebar roster or via an ?employee= deep-link.
  // The actual session is created on first send (ChatPane → buildNewSessionParams).
  const contactEmployee = useCallback((name: string) => {
    newChatIntentRef.current = true
    setPendingEmployee(name)
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
  }, [chatTabs])

  // Deep-links: ?session=<id> focuses/opens that session's tab; ?employee=<name>
  // opens a new chat with that employee preselected. The param is consumed once
  // (cleared from the URL) so it doesn't re-fire on unrelated re-renders or stick
  // across navigation. Mirrors routes/file/page.tsx's useSearchParams usage.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const link = resolveDeepLink(searchParams)
    if (!link) return
    if (link.kind === 'session') handleSelect(link.id)
    else contactEmployee(link.name)
    const next = new URLSearchParams(searchParams)
    next.delete('session')
    next.delete('employee')
    setSearchParams(next, { replace: true })
  }, [searchParams, handleSelect, contactEmployee, setSearchParams])

  // Back target for the mobile file-view "back" button: the session that was
  // active when a file link was clicked. selectedIdRef (declared below) is read
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
        // so tapping the Chat tab opens the list to pick/start a chat.
        handleSelect(sessions[0].id, { navigateMobile: false })
      }
    },
    [selectedId, handleSelect]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await deleteSessionMutation.mutateAsync(id)
    } catch { /* sidebar may have already deleted it */ }
    if (selectedId === id) {
      setSelectedId(null)
      setSessionMeta(null)
    }
    clearIntermediateMessages(id)
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.kind === 'session' && t.sessionId === id))
    setShowMoreMenu(false)
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [selectedId, chatTabs, deleteSessionMutation, qc])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        setSelectedId(result.id)
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || 'Unknown error'}`)
    }
  }, [chatTabs, duplicateSessionMutation, qc])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message) => {
    if (pending) setPendingUserMessage({ sessionId: newId, message: pending })
    setSelectedId(newId)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // Clear pendingUserMessage when selectedId moves away from the session it was created for
  useEffect(() => {
    if (pendingUserMessage && pendingUserMessage.sessionId !== selectedId) {
      setPendingUserMessage(null)
    }
  }, [selectedId, pendingUserMessage])

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref so this callback stays stable.
  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  const handleSessionMetaChange = useCallback((meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => {
    const sid = selectedIdRef.current
    if (!sid) return
    setSessionMeta({ sessionId: sid, ...meta })
  }, [])

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

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
    { key: '[', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Previous tab', action: () => chatTabs.prevTab() },
    { key: ']', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Next tab', action: () => chatTabs.nextTab() },
    // Fold/unfold the chat list. ⌥⌘S is the macOS-native sidebar toggle; ⌘\ is
    // the web-friendly alias (Linear/VS Code class).
    { key: 's', modifiers: ['meta', 'alt'], category: 'Navigation', description: 'Toggle chat list', action: toggleList },
    { key: '\\', modifiers: ['meta'], category: 'Navigation', description: 'Toggle chat list', action: toggleList },
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      modifiers: ['meta' as const, 'alt' as const],
      category: 'Navigation' as const,
      description: `Tab ${i + 1}`,
      action: () => chatTabs.switchTab(i),
    })),
  ], [handleNewChat, navigateSession, cycleEmployee, copyChat, selectedId, showShortcutOverlay, showMoreMenu, chatTabs, toggleList])

  useKeyboardShortcuts(shortcuts)

  // When active tab changes, sync selectedId
  useEffect(() => {
    const at = chatTabs.activeTab
    if (at && at.kind === 'session' && at.sessionId !== selectedId) {
      setSelectedId(at.sessionId)
      return
    }

    if (!at && selectedId && !newChatIntentRef.current) {
      setSelectedId(null)
      setSessionMeta(null)
      setEmployeeSessions([])
    }
    // When at.kind === 'file', leave selectedId untouched — we render FileView
    // instead of ChatPane, but the underlying session selection is preserved.
  }, [chatTabs.activeTab, selectedId])

  const cliModeAvailable = !sessionMeta?.engine || ['claude', 'codex', 'antigravity', 'grok'].includes(sessionMeta.engine)
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
              />
            )}
          </div>
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
    </FileOpenContext.Provider>
  )
}
