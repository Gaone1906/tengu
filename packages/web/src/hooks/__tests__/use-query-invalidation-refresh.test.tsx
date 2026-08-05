import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
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

// Proves a MOUNTED surface (a useQuery on a workflow key) refetches when its
// `company:changed` event lands — the live refresh contract, no page reload.
describe('mounted surface refresh on company:changed', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.useRealTimers())

  it('refetches the workflow list when a definition changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryFn = vi.fn().mockResolvedValue({ ok: true })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    renderHook(() => {
      useQueryInvalidation()
      useQuery({ queryKey: queryKeys.workflows.all, queryFn })
    }, { wrapper })

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('company:changed', {
      entity: 'workflow-definition', id: 'release-review', revision: 5,
    }))

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
  })
})
