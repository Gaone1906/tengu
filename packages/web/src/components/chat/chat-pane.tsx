
import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useOrg } from '@/hooks/use-employees'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { ChatEmployeePicker } from '@/components/chat/chat-employee-picker'
import { QueuePanel } from '@/components/chat/queue-panel'

const CliTerminal = lazy(() => import('@/components/cli-terminal').then(m => ({ default: m.CliTerminal })))
import { buildNewSessionParams } from '@/components/chat/new-chat-helpers'
import type { Employee } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { saveIntermediateMessages, loadIntermediateMessages, clearIntermediateMessages, reconcileMessages } from '@/lib/conversations'

type Listener = (event: string, payload: unknown) => void

interface ChatPaneProps {
  sessionId: string | null
  isActive: boolean
  onFocus: () => void
  /** Notify parent when a new session is created (e.g. first message in new chat) */
  onSessionCreated?: (sessionId: string, pendingUserMessage?: Message) => void
  /** If set on mount, used as the initial user message before loadSession resolves — for the just-created-from-new-chat case. */
  pendingUserMessage?: Message
  /** Notify parent when session meta changes */
  onSessionMetaChange?: (meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => void
  /** Notify parent to refresh sidebar */
  onRefresh?: () => void
  /** Portal name from settings */
  portalName?: string
  /** Gateway subscribe function for WS events */
  subscribe: (fn: Listener) => () => void
  /** Gateway connection seq number - triggers reload on reconnect */
  connectionSeq?: number
  /** Gateway skills version */
  skillsVersion?: number
  /** Gateway events array */
  events: Array<{ event: string; payload: unknown }>
  /** View mode: chat or cli transcript */
  viewMode?: 'chat' | 'cli'
  /** Incrementing counter that triggers input focus */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
}

export function ChatPane({
  sessionId,
  isActive,
  onFocus,
  onSessionCreated,
  onSessionMetaChange,
  onRefresh,
  portalName = 'Jinn',
  subscribe,
  connectionSeq,
  skillsVersion,
  events,
  viewMode = 'chat',
  focusTrigger,
  onShortcutsClick,
  pendingUserMessage,
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>(() => {
    const seed = pendingUserMessage ? [pendingUserMessage] : []
    return seed
  })
  // Seed loading=true when mounting with a pendingUserMessage (just-created new chat
  // where the OLD pane's setLoading(true) was lost in the remount). Otherwise the
  // thinking indicator wouldn't show until the first WS delta arrives.
  const [loading, setLoading] = useState<boolean>(() => !!pendingUserMessage)
  const streamingTextRef = useRef('')
  const [streamingText, setStreamingText] = useState('')
  const intermediateStartRef = useRef<number>(-1)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(null)
  const sessionIdRef = useRef(sessionId)
  const onMetaRef = useRef(onSessionMetaChange)
  useEffect(() => { onMetaRef.current = onSessionMetaChange }, [onSessionMetaChange])
  const justCompletedAtRef = useRef<number>(0)
  const loadTokenRef = useRef(0)

  // Employee picker state for new chat
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null)
  const { data: orgData } = useOrg()
  const pickerEmployees = Array.isArray(orgData?.employees)
    ? orgData.employees.map((emp) => ({
        name: emp.name,
        displayName: emp.displayName,
        department: emp.department,
        rank: emp.rank,
      }))
    : []
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Helper: persist intermediate messages to localStorage
  const persistIntermediate = useCallback((msgs: Message[], sid: string | null) => {
    if (!sid) return
    const start = intermediateStartRef.current
    if (start < 0) return
    const intermediate = msgs.slice(start)
    if (intermediate.length > 0) {
      saveIntermediateMessages(sid, intermediate)
    }
  }, [])

  // Listen for session events via subscribe
  useEffect(() => {
    return subscribe((event, payload) => {
      const p = payload as Record<string, unknown>
      const sid = sessionIdRef.current
      if (!sid || p.sessionId !== sid) return

      if (event === 'session:delta') {
        const deltaType = String(p.type || 'text')

        if (deltaType === 'text') {
          const chunk = String(p.content || '')
          streamingTextRef.current += chunk
          setStreamingText(streamingTextRef.current)
        } else if (deltaType === 'text_snapshot') {
          const snapshot = String(p.content || '')
          if (snapshot.length >= streamingTextRef.current.length) {
            streamingTextRef.current = snapshot
            setStreamingText(snapshot)
          }
        } else if (deltaType === 'tool_use') {
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              const updated = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
              persistIntermediate(updated, sid)
              return updated
            })
          }
          const toolName = String(p.toolName || 'tool')
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            const updated = [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Using ${toolName}`,
                timestamp: Date.now(),
                toolCall: toolName,
              },
            ]
            persistIntermediate(updated, sid)
            return updated
          })
        } else if (deltaType === 'tool_result') {
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.role === 'assistant' && last.toolCall) {
              updated[updated.length - 1] = { ...last, content: `Used ${last.toolCall}` }
            }
            persistIntermediate(updated, sid)
            return updated
          })
        }
      }

      if (event === 'session:notification') {
        const notifMessage = String(p.message || '')
        if (notifMessage) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'notification' as const,
              content: notifMessage,
              timestamp: Date.now(),
            },
          ])
        }
      }

      if (event === 'session:attachment') {
        const media = Array.isArray(p.media) ? (p.media as MediaAttachment[]) : []
        // Use the server's canonical message id so the next history fetch merges
        // (not duplicates) this message. Guard against re-append if the event fires twice.
        const attachmentId = typeof p.id === 'string' ? p.id : crypto.randomUUID()
        if (media.length > 0) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === attachmentId)) return prev
            return [
              ...prev,
              {
                id: attachmentId,
                role: 'assistant' as const,
                content: String(p.content || ''),
                timestamp: p.timestamp ? Number(p.timestamp) : Date.now(),
                media,
              },
            ]
          })
        }
      }

      if (event === 'session:interrupted') {
        streamingTextRef.current = ''
        setStreamingText('')
      }

      if (event === 'session:stopped') {
        setLoading(false)
        setStreamingText('')
      }

      if (event === 'session:completed') {
        streamingTextRef.current = ''
        setStreamingText('')
        setLoading(false)
        intermediateStartRef.current = -1
        justCompletedAtRef.current = Date.now()

        const completedSessionId = sid || (p.sessionId ? String(p.sessionId) : null)
        if (completedSessionId) {
          clearIntermediateMessages(completedSessionId)
        }

        if (p.result) {
          setMessages((prev) => {
            const cleaned = [...prev]
            const last = cleaned[cleaned.length - 1]
            // Pop the optimistic streaming-text bubble so the canonical result replaces it,
            // but NEVER pop an attachment (media) message — it's already persisted and would
            // otherwise vanish until reload.
            if (last && last.role === 'assistant' && !last.toolCall && !(last.media && last.media.length > 0)) {
              cleaned.pop()
            }
            return [
              ...cleaned,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: String(p.result),
                timestamp: Date.now(),
              },
            ]
          })
        }
        if (p.error && !p.result) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `Error: ${p.error}`,
              timestamp: Date.now(),
            },
          ])
        }
        onRefresh?.()
      }
    })
  }, [subscribe, persistIntermediate, onRefresh])

  // Load session data
  const loadSession = useCallback(async (id: string) => {
    const myToken = ++loadTokenRef.current
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      if (myToken !== loadTokenRef.current) {
        return
      }
      setCurrentSession(session)
      const meta = {
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      }
      onMetaRef.current?.(meta)

      const history = session.messages || session.history || []
      const backendMessages: Message[] = Array.isArray(history)
        ? history.map((m: Record<string, unknown>) => ({
            // Preserve the server's stable message id so live-pushed messages
            // (e.g. attachments) merge/dedupe by id instead of duplicating.
            id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
            role: (m.role as 'user' | 'assistant' | 'notification') || 'assistant',
            content: String(m.content || m.text || ''),
            timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
            ...(Array.isArray(m.media) && m.media.length > 0
              ? { media: m.media as MediaAttachment[] }
              : {}),
          }))
        : []
      if (session.status === 'error' && session.lastError) {
        const lastMessage = backendMessages[backendMessages.length - 1]
        const errorText = `Error: ${String(session.lastError)}`
        if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content !== errorText) {
          backendMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorText,
            timestamp: Date.now(),
          })
        }
      }

      const isRunning = session.status === 'running'

      if (isRunning) {
        const cached = loadIntermediateMessages(id)
        if (cached.length > 0) {
          intermediateStartRef.current = backendMessages.length
          // Reconcile so a live-pushed attachment not yet in the snapshot survives.
          setMessages((current) => reconcileMessages(current, [...backendMessages, ...cached]))
        } else {
          intermediateStartRef.current = backendMessages.length
          setMessages((current) => {
            // If backend has FEWER messages than local, the backend snapshot is stale —
            // local already contains streaming-completed messages not yet persisted (or
            // a stale-snapshot race during slow GET). Keep current.
            if (backendMessages.length < current.length) {
              return current
            }
            const next = backendMessages.length > 0 ? backendMessages : current
            return reconcileMessages(current, next)
          })
        }
        // Loading state is owned by handleSend (sets true) + WS session:completed/stopped (sets false).
        // loadSession must NEVER set loading=true — a stale GET arriving after completion would
        // re-arm the spinner and stick (the WS completion event has already passed).
      } else {
        clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages((current) => {
          // If backend has FEWER messages than local, the backend snapshot is stale —
          // local already contains streaming-completed messages not yet persisted (or
          // a stale-snapshot race during slow GET). Keep current.
          if (backendMessages.length < current.length) {
            return current
          }
          const next = backendMessages.length > 0 ? backendMessages : current
          return reconcileMessages(current, next)
        })
      }
    } catch {
      setMessages([])
      setCurrentSession(null)
      intermediateStartRef.current = -1
    }
  }, [])

  // Load on session change
  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      setCurrentSession(null)
      streamingTextRef.current = ''
      setStreamingText('')
      intermediateStartRef.current = -1
      setSelectedEmployee(null)
      return
    }
    // Clear streaming state immediately to avoid stale content flash
    streamingTextRef.current = ''
    setStreamingText('')
    // NOTE: do NOT setLoading(false) here. Loading is owned by handleSend (true) and
    // WS session:completed/stopped (false). Clearing here would clobber the lazy-init
    // loading=true set by useState() when this pane mounted with pendingUserMessage.
    loadSession(sessionId)
  }, [sessionId]) // loadSession is stable (useCallback with [] deps)

  // Reload on reconnect — only fires when WS genuinely reconnects (connectionSeq changes)
  // Only reloads running sessions; completed sessions don't need a refetch on every WS hiccup.
  // Debounced 300ms so a burst of connectionSeq bumps collapses into a single loadSession.
  useEffect(() => {
    if (!connectionSeq || !sessionIdRef.current) return
    if (currentSession?.status !== 'running') return
    const handle = setTimeout(() => {
      loadSession(sessionIdRef.current!)
    }, 300)
    return () => clearTimeout(handle)
  }, [connectionSeq, currentSession?.status]) // loadSession is stable; sessionIdRef.current is read at call time


  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stopSession(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      setMessages((prev) => {
        intermediateStartRef.current = prev.length + 1
        return [...prev, userMsg]
      })
      setLoading(true)

      try {
        // Upload any attached files to the server in parallel and collect file IDs
        let attachmentIds: string[] | undefined
        if (media && media.length > 0) {
          const uploadPromises = media
            .filter((att) => att.file)
            .map((att) => api.uploadFile(att.file!, sessionIdRef.current || undefined))
          if (uploadPromises.length > 0) {
            const uploaded = await Promise.all(uploadPromises)
            attachmentIds = uploaded.map((u) => u.id)
          }
        }

        let sid = sessionId

        if (!sid) {
          const params = buildNewSessionParams({
            message,
            selectedEmployee,
            attachmentIds,
          })
          if (viewMode === 'cli') (params as Record<string, unknown>).mode = 'interactive'
          const session = (await api.createSession(params)) as Record<string, unknown>
          sid = String(session.id)
          onSessionCreated?.(sid, userMsg)
          onRefresh?.()
        } else {
          // CLI view → route to the interactive PTY engine so the user sees the prompt
          // get injected into the live xterm + claude's streaming response.
          const mode = viewMode === 'cli' ? 'interactive' : undefined
          await api.sendMessage(sid, { message, interrupt: interrupt || undefined, attachments: attachmentIds, mode })
          onRefresh?.()
        }
      } catch (err) {
        setLoading(false)
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Error: ${err instanceof Error ? err.message : 'Failed to send message'}`,
            timestamp: Date.now(),
          },
        ])
      }
    },
    // viewMode MUST be in deps — without it, toggling chat↔CLI keeps the stale
    // closure value and routes CLI sends to the headless engine, which is
    // exactly what made "the xterm shows stale content" reproducible.
    [sessionId, selectedEmployee, onSessionCreated, onRefresh, viewMode, loading]
  )

  const handleStatusRequest = useCallback(async () => {
    if (!sessionId) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'No active session. Send a message to start one.',
          timestamp: Date.now(),
        },
      ])
      return
    }

    try {
      const session = (await api.getSession(sessionId)) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: info,
          timestamp: Date.now(),
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'Failed to fetch session status.',
          timestamp: Date.now(),
        },
      ])
    }
  }, [sessionId])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    setMessages([])
    setLoading(false)
    setCurrentSession(null)
    streamingTextRef.current = ''
    setStreamingText('')
    intermediateStartRef.current = -1
  }, [])

  // Drag & drop state
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
    }
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
        position: 'relative',
      }}
      onClick={onFocus}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
            backdropFilter: 'blur(4px)',
            transition: 'opacity 150ms ease-in-out',
          }}
        >
          <div
            style={{
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-lg)',
              padding: '48px 64px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
              Drop files here
            </span>
          </div>
        </div>
      )}
      {/* Employee picker for new chat (any view mode — the CLI terminal mounts after first message creates the session) */}
      {!sessionId && messages.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <ChatEmployeePicker
            employees={pickerEmployees}
            selectedEmployee={selectedEmployee}
            onSelect={setSelectedEmployee}
            portalName={portalName}
          />
        </div>
      )}

      {/* Messages / CLI transcript — CliTerminal is display-only; ChatInput below sends. */}
      {viewMode === 'cli' && sessionId ? (
        // Reserve flex space during lazy-chunk load so the ChatInput below stays
        // pinned to the bottom instead of flashing to the top for a frame.
        <Suspense fallback={<div style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }} />}>
          <CliTerminal sessionId={sessionId} />
        </Suspense>
      ) : (sessionId || messages.length > 0) ? (
        <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
      ) : null}

      {/* Queue panel — hidden in the live xterm view (noise on top of the PTY). */}
      {!(viewMode === 'cli' && sessionId) && (
        <QueuePanel
          sessionId={sessionId}
          events={events}
          paused={currentSession?.paused as boolean ?? false}
        />
      )}

      {/* Input — chat-style composer for every view, including CLI (the PTY engine
          accepts attachments + the prompt is injected into xterm via bracketed-paste). */}
      <ChatInput
        disabled={false}
        loading={loading}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onNewSession={handleNewSession}
        onStatusRequest={handleStatusRequest}
        skillsVersion={skillsVersion}
        events={events}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles(undefined)}
        focusTrigger={focusTrigger}
        onShortcutsClick={onShortcutsClick}
      />
    </div>
  )
}
