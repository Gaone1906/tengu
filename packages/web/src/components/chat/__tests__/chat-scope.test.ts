import { describe, expect, it } from 'vitest'
import {
  partitionSessionsForScope,
  chatScopeLabel,
  parseStoredChatScope,
  projectIdForSession,
  projectScopeOptions,
  sessionMatchesScope,
  sessionNeedsAttention,
  shouldShowContactableRoster,
} from '../chat-scope'

const employees = new Map([
  ['forge', { department: 'Platform' }],
  ['scout', { department: 'camera-app' }],
  ['counsel', { department: 'legal tools' }],
  ['unassigned', { department: '' }],
])

describe('chat project scopes', () => {
  it('maps employee chats to normalized runtime departments and direct chats to general', () => {
    expect(projectIdForSession({ source: 'web', employee: 'forge' }, employees, 'jinn')).toBe('platform')
    expect(projectIdForSession({ source: 'web', employee: 'scout' }, employees, 'jinn')).toBe('camera-app')
    expect(projectIdForSession({ source: 'web', employee: null }, employees, 'jinn')).toBe('general')
    expect(projectIdForSession({ source: 'web', employee: 'Jinn' }, employees, 'jinn')).toBe('general')
    expect(projectIdForSession({ source: 'web', employee: 'unassigned' }, employees, 'jinn')).toBe('general')
  })

  it('builds stable alphabetized project options with honest counts', () => {
    const options = projectScopeOptions([
      { id: 's1', source: 'web', employee: 'forge' },
      { id: 's2', source: 'slack', employee: 'forge' },
      { id: 's3', source: 'web', employee: 'scout' },
      { id: 's4', source: 'web', employee: 'counsel' },
      { id: 's5', source: 'web', employee: null },
    ], employees, 'jinn')

    expect(options).toEqual([
      { id: 'camera-app', label: 'Camera App', count: 1 },
      { id: 'general', label: 'General', count: 1 },
      { id: 'legal-tools', label: 'Legal Tools', count: 1 },
      { id: 'platform', label: 'Platform', count: 2 },
    ])
  })

  it('treats waiting and recent errors as needing attention without preserving stale errors', () => {
    const now = new Date('2026-07-13T12:00:00Z').getTime()
    expect(sessionNeedsAttention({ status: 'waiting' }, now)).toBe(true)
    expect(sessionNeedsAttention({ status: 'error', lastActivity: '2026-07-13T11:00:00Z' }, now)).toBe(true)
    expect(sessionNeedsAttention({ status: 'error', lastActivity: '2026-07-11T11:00:00Z' }, now)).toBe(false)
    expect(sessionNeedsAttention({ status: 'idle', lastActivity: '2026-07-13T11:00:00Z' }, now)).toBe(false)
  })

  it('matches all, needs-you, and project scopes independently', () => {
    const now = new Date('2026-07-13T12:00:00Z').getTime()
    const platform = { source: 'web', employee: 'forge', status: 'idle' }
    const waitingElsewhere = { source: 'web', employee: 'scout', status: 'waiting' }

    expect(sessionMatchesScope(platform, 'all', employees, 'jinn', now)).toBe(true)
    expect(sessionMatchesScope(platform, 'project:platform', employees, 'jinn', now)).toBe(true)
    expect(sessionMatchesScope(platform, 'project:camera-app', employees, 'jinn', now)).toBe(false)
    expect(sessionMatchesScope(platform, 'needs', employees, 'jinn', now)).toBe(false)
    expect(sessionMatchesScope(waitingElsewhere, 'needs', employees, 'jinn', now)).toBe(true)
  })

  it('falls back from stale stored scopes and preserves currently available scopes', () => {
    const options = [
      { id: 'platform', label: 'Platform', count: 2 },
      { id: 'camera-app', label: 'Camera App', count: 1 },
    ]
    expect(parseStoredChatScope('all', options)).toBe('all')
    expect(parseStoredChatScope('needs', options)).toBe('needs')
    expect(parseStoredChatScope('project:platform', options)).toBe('project:platform')
    expect(parseStoredChatScope('project:missing', options)).toBe('all')
    expect(parseStoredChatScope('nonsense', options)).toBe('all')
    expect(parseStoredChatScope(null, options)).toBe('all')
  })

  it('uses calm human labels for every scope', () => {
    const options = [{ id: 'camera-app', label: 'Camera App', count: 3 }]
    expect(chatScopeLabel('all', options)).toBe('All chats')
    expect(chatScopeLabel('needs', options)).toBe('Needs you')
    expect(chatScopeLabel('project:camera-app', options)).toBe('Camera App')
    expect(chatScopeLabel('project:missing', options)).toBe('All chats')
  })

  it('keeps attention global, project history flat, and execution noise suppressed', () => {
    const now = new Date('2026-07-13T12:00:00Z').getTime()
    const sessions = [
      { id: 'attention-legal', source: 'web', employee: 'counsel', status: 'waiting' },
      { id: 'platform-chat', source: 'web', employee: 'forge', status: 'idle' },
      { id: 'camera-chat', source: 'slack', employee: 'scout', status: 'idle' },
      { id: 'workflow-run', source: 'web', employee: 'forge', workflowProvenance: { kind: 'run' } },
      { id: 'cron-run', source: 'cron', employee: 'scout' },
      { id: 'delegated-child', source: 'web', employee: 'forge', parentSessionId: 'platform-chat' },
    ]

    const visibleInChat = (session: { source?: string }) => session.source === 'web' || session.source === 'cron'
    const platform = partitionSessionsForScope(sessions, 'project:platform', employees, 'jinn', now, visibleInChat)
    expect(platform.attention.map((session) => session.id)).toEqual(['attention-legal'])
    expect(platform.history.map((session) => session.id)).toEqual(['platform-chat'])
    expect(platform.hiddenAutomated).toBe(3)
    expect(platform.conversationCount).toBe(2)
    expect(platform.projects).toEqual([
      { id: 'legal-tools', label: 'Legal Tools', count: 1 },
      { id: 'platform', label: 'Platform', count: 1 },
    ])

    const all = partitionSessionsForScope(sessions, 'all', employees, 'jinn', now, visibleInChat)
    expect(all.attention.map((session) => session.id)).toEqual(['attention-legal'])
    expect(all.history.map((session) => session.id)).toEqual(['platform-chat'])

    const needs = partitionSessionsForScope(sessions, 'needs', employees, 'jinn', now, visibleInChat)
    expect(needs.attention.map((session) => session.id)).toEqual(['attention-legal'])
    expect(needs.history).toEqual([])
  })

  it('keeps unrelated roster suggestions out of focused scopes and search', () => {
    expect(shouldShowContactableRoster('all', false)).toBe(true)
    expect(shouldShowContactableRoster('project:platform', false)).toBe(false)
    expect(shouldShowContactableRoster('needs', false)).toBe(false)
    expect(shouldShowContactableRoster('all', true)).toBe(false)
  })
})
