import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useQueryInvalidation } from "../use-query-invalidation"

let listener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    subscribe: (next: (event: string, payload: unknown) => void) => {
      listener = next
      return () => { listener = undefined }
    },
  }),
}))

describe("Todo linked-session invalidation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(["session:started", "session:updated", "session:completed", "session:error", "session:deleted"])(
    "invalidates item-specific session queries on %s",
    async (event) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const invalidate = vi.spyOn(client, "invalidateQueries")
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
      renderHook(() => useQueryInvalidation(), { wrapper })

      act(() => listener?.(event, { sessionId: "session-one" }))
      await act(async () => vi.advanceTimersByTimeAsync(1_000))

      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work-item-sessions"] })
    },
  )
})
