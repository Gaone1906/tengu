import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'

let featuresState = {
  notesEnabled: false,
  staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
}

const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(() => Promise.resolve({})),
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))

vi.mock('@/hooks/use-employees', () => ({
  useOrg: () => ({ data: { employees: [{ name: 'platform-lead', displayName: 'Platform Lead' }] } }),
}))

vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: featuresState, isPending: false }),
}))

interface LiveSessionMockState {
  messages: unknown[]
  streamingText: string
  loading: boolean
  hydrating: boolean
  session: Record<string, unknown> | null
  error: Error | null
  liveContextTokens: number | null
  backgroundActivity: unknown
  reload: ReturnType<typeof vi.fn>
  beginSend: ReturnType<typeof vi.fn>
  failSend: ReturnType<typeof vi.fn>
  appendLocal: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const liveSessionDefaults: LiveSessionMockState = {
  messages: [],
  streamingText: '',
  loading: false,
  hydrating: false,
  session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' },
  error: null,
  liveContextTokens: null,
  backgroundActivity: null,
  reload: vi.fn(),
  beginSend: vi.fn(),
  failSend: vi.fn(),
  appendLocal: vi.fn(),
  reset: vi.fn(),
}

let liveSessionState: LiveSessionMockState

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, statusSlot }: { selectorSlot?: React.ReactNode; statusSlot?: React.ReactNode }) => (
    <div data-testid="chat-input">{selectorSlot}{statusSlot}</div>
  ),
}))

vi.mock('@/components/chat/model-selector-row', () => ({
  ModelSelectorRow: ({ onChange }: { onChange: (next: { engine?: string; model?: string; effortLevel?: string }) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'medium' })}
    >
      selector switch engine
    </button>
  ),
}))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ footer }: { footer?: React.ReactNode }) => <div data-testid="messages">{footer}</div>,
}))

vi.mock('@/components/chat/chat-employee-picker', () => ({
  ChatEmployeePicker: () => <div data-testid="employee-picker" />,
}))

vi.mock('@/components/chat/queue-panel', () => ({
  QueuePanel: () => null,
}))

vi.mock('@/components/chat/background-activity-status', () => ({
  BackgroundActivityStatus: ({ delegatedActivity, employeeDisplayNames }: {
    delegatedActivity?: { activeSessions: number; employees: string[] } | null
    employeeDisplayNames?: Record<string, string>
  }) => (
    <div data-testid="background-status">
      {delegatedActivity?.activeSessions ?? 0}:{employeeDisplayNames?.['platform-lead'] ?? ''}
    </div>
  ),
}))

vi.mock('@/components/chat/cli-keybar', () => ({
  CliKeybar: () => null,
}))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      sessionId="s1"
      isActive
      onFocus={() => {}}
      subscribe={() => () => {}}
      events={[]}
      {...props}
    />,
  )
}

describe('ChatPane', () => {
  beforeEach(() => {
    liveSessionState = { ...liveSessionDefaults }
    featuresState = {
      notesEnabled: false,
      staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
    }
    apiMocks.updateSession.mockClear()
    localStorage.clear()
  })

  it('persists existing-chat engine switching on the same session', () => {
    const onNewChat = vi.fn()
    renderPane({ onNewChat })

    fireEvent.click(screen.getByRole('button', { name: /selector switch engine/i }))

    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', {
      engine: 'codex',
      model: 'gpt-5.5',
      effortLevel: 'medium',
    })
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('shows a lightweight loading status instead of an empty new-chat picker while a session hydrates', () => {
    liveSessionState = { ...liveSessionDefaults, hydrating: true, session: null }

    renderPane()

    expect(screen.getByRole('status', { name: /loading chat/i })).toBeTruthy()
    expect(screen.queryByTestId('employee-picker')).toBeNull()
  })

  it('passes parent delegated activity and employee display names to the composer status', () => {
    renderPane({
      delegatedActivity: { activeSessions: 1, employees: ['platform-lead'] },
    })

    expect(screen.getByTestId('background-status').textContent).toBe('1:Platform Lead')
  })

  it('does not lose destination readiness when a prefetched pane rerenders before paint', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const onContentReady = vi.fn()
    const props = {
      sessionId: 's1',
      isActive: true,
      onFocus: () => {},
      subscribe: () => () => {},
      events: [] as Array<{ event: string; payload: unknown }>,
      onContentReady,
    }
    const { rerender } = render(<ChatPane {...props} />)

    liveSessionState = {
      ...liveSessionState,
      session: { ...liveSessionState.session, title: 'Metadata landed before paint' },
    }
    rerender(<ChatPane {...props} />)
    expect(onContentReady).not.toHaveBeenCalled()

    act(() => {
      for (const callback of [...frames.values()]) callback(performance.now())
    })
    expect(onContentReady).toHaveBeenCalledOnce()
    expect(onContentReady).toHaveBeenCalledWith('s1')
    request.mockRestore()
    cancel.mockRestore()
  })

  it('never shows the notice when the policy is disabled', () => {
    featuresState = {
      notesEnabled: false,
      staleChat: { enabled: false, tokenThreshold: 1_000, staleAfterMinutes: 1 },
    }
    liveSessionState = {
      ...liveSessionDefaults,
      liveContextTokens: 900_000,
      session: {
        ...liveSessionDefaults.session,
        lastActivity: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      },
    }

    renderPane()

    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('shows only when both context and idle thresholds are met', async () => {
    liveSessionState = {
      ...liveSessionDefaults,
      liveContextTokens: 300_000,
      session: {
        ...liveSessionDefaults.session,
        lastActivity: new Date(Date.now() - 61 * 60_000).toISOString(),
      },
    }

    const eligible = renderPane()
    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()
    eligible.unmount()

    liveSessionState = {
      ...liveSessionDefaults,
      liveContextTokens: 299_999,
      session: {
        ...liveSessionDefaults.session,
        lastActivity: new Date(Date.now() - 61 * 60_000).toISOString(),
      },
    }
    const idleOnly = renderPane()
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    idleOnly.unmount()

    liveSessionState = {
      ...liveSessionDefaults,
      liveContextTokens: 300_000,
      session: {
        ...liveSessionDefaults.session,
        lastActivity: new Date().toISOString(),
      },
    }
    renderPane()
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('keeps a dismissal across a remount of the same session', async () => {
    liveSessionState = {
      ...liveSessionDefaults,
      liveContextTokens: 300_000,
      session: {
        ...liveSessionDefaults.session,
        lastActivity: new Date(Date.now() - 61 * 60_000).toISOString(),
      },
    }

    const first = renderPane()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    first.unmount()

    renderPane()
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })
})
