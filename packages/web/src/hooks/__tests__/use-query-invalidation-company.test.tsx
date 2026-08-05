import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQueryInvalidation } from '../use-query-invalidation'
import { queryKeys } from '@/lib/query-keys'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'

let listener: ((event: string, payload: unknown) => void) | undefined

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    subscribe: (next: (event: string, payload: unknown) => void) => {
      const typedNext = next as unknown as GatewayEventListener
      listener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
      return () => { listener = undefined }
    },
  }),
}))

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  renderHook(() => useQueryInvalidation(), { wrapper })
  return { client, invalidate }
}

function calledWithKey(invalidate: ReturnType<typeof vi.spyOn>, key: readonly unknown[]): boolean {
  return invalidate.mock.calls.some((callArgs: unknown[]) => {
    const arg = callArgs[0] as { queryKey?: unknown[] } | undefined
    const queryKey = arg?.queryKey
    return Array.isArray(queryKey) && JSON.stringify(queryKey) === JSON.stringify(key)
  })
}

describe('company + session:created invalidation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('treats session:created like a new session for session + linked-Todo lists', async () => {
    const { invalidate } = setup()
    act(() => listener?.('session:created', { sessionId: 'session-new' }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, queryKeys.sessions.all)).toBe(true)
    expect(calledWithKey(invalidate, ['work-item-sessions'])).toBe(true)
  })

  it('refreshes pins immediately when another browser changes them', () => {
    const { invalidate } = setup()
    act(() => listener?.('pins:changed', {}))
    expect(calledWithKey(invalidate, queryKeys.pins)).toBe(true)
  })

  it('refreshes the experiment list and changed experiment immediately', () => {
    const { invalidate } = setup()
    act(() => listener?.('experiments:changed', { id: 'experiment-7', action: 'reading-recorded' }))
    expect(calledWithKey(invalidate, ['experiments'])).toBe(true)
    expect(calledWithKey(invalidate, ['experiments', 'experiment-7'])).toBe(true)
  })

  it('refreshes parent summaries when a delegated child changes runtime activity', async () => {
    const { client, invalidate } = setup()
    client.setQueryData(queryKeys.sessions.all, {
      sessions: [
        { id: 'parent', parentSessionId: null },
        { id: 'child', parentSessionId: 'parent' },
      ],
      counts: { __direct__: 1, developer: 1 },
      perGroup: 50,
    })

    act(() => listener?.('session:background', {
      sessionId: 'child',
      backgroundActivity: { activeStreams: 1, lastActivityAt: new Date().toISOString() },
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(calledWithKey(invalidate, queryKeys.sessions.all)).toBe(true)
  })

  it('keeps top-level runtime activity on the surgical cache-patch path', async () => {
    const { client, invalidate } = setup()
    client.setQueryData(queryKeys.sessions.all, {
      sessions: [{ id: 'parent', parentSessionId: null }],
      counts: { __direct__: 1 },
      perGroup: 50,
    })

    act(() => listener?.('session:background', {
      sessionId: 'parent',
      backgroundActivity: { activeStreams: 1, lastActivityAt: new Date().toISOString() },
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(calledWithKey(invalidate, queryKeys.sessions.all)).toBe(false)
  })

  it('patches a Todo cache by newer version and never regresses to an older one', async () => {
    const { client } = setup()
    client.setQueryData(['work-item', 'wi_release'], { id: 'wi_release', version: 5, status: 'executing' })

    act(() => listener?.('company:changed', {
      entity: 'todo', action: 'transitioned', id: 'wi_release', version: 6,
      value: { id: 'wi_release', version: 6, status: 'in_review' },
    }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect((client.getQueryData(['work-item', 'wi_release']) as { status: string }).status).toBe('in_review')

    act(() => listener?.('company:changed', {
      entity: 'todo', action: 'transitioned', id: 'wi_release', version: 4,
      value: { id: 'wi_release', version: 4, status: 'executing' },
    }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect((client.getQueryData(['work-item', 'wi_release']) as { status: string; version: number }).version).toBe(6)
  })

  it('invalidates Todo list + detail when a company todo event carries no value', async () => {
    const { invalidate } = setup()
    act(() => listener?.('company:changed', { entity: 'todo', action: 'archived', id: 'wi_gone', version: 9 }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ['work-items'])).toBe(true)
    expect(calledWithKey(invalidate, ['work-item', 'wi_gone'])).toBe(true)
  })

  it('invalidates workflow list + definition on a definition change', async () => {
    const { invalidate } = setup()
    act(() => listener?.('company:changed', {
      entity: 'workflow-definition', id: 'release-review', revision: 4,
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, queryKeys.workflows.all)).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.workflows.definition('release-review'))).toBe(true)
  })

  it('invalidates run list + detail on a run change', async () => {
    const { invalidate } = setup()
    act(() => listener?.('company:changed', {
      entity: 'workflow-run', workflowId: 'release-review', runId: 'run-1',
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, queryKeys.workflows.runs('release-review'))).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.workflows.run('release-review', 'run-1'))).toBe(true)
  })

  it('invalidates the invoking session detail + transcript when sessionId is present', async () => {
    const { invalidate } = setup()
    act(() => listener?.('company:changed', {
      entity: 'todo', action: 'delegated', id: 'wi_delegated', version: 3, sessionId: 'session-a',
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, queryKeys.sessions.detail('session-a'))).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.sessions.transcript('session-a'))).toBe(true)
  })

  it.each(['success', 'error'] as const)('invalidates cron run history and job keys on a %s run', async (status) => {
    const { invalidate } = setup()
    act(() => listener?.('cron:run-finished', { jobId: 'nightly', status }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ['cron-runs', 'nightly'])).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.cron.jobs)).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.cron.all)).toBe(true)
  })

  it('invalidates session list and detail when the shared stopped lifecycle event arrives', async () => {
    const { invalidate } = setup()
    act(() => listener?.('session:stopped', { sessionId: 'workflow-session' }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, queryKeys.sessions.all)).toBe(true)
    expect(calledWithKey(invalidate, queryKeys.sessions.detail('workflow-session'))).toBe(true)
  })
})
