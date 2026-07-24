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

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  renderHook(() => useQueryInvalidation(), { wrapper })
  return { client, invalidate }
}

function calledWithKey(invalidate: ReturnType<typeof vi.spyOn>, key: readonly unknown[]): boolean {
  return invalidate.mock.calls.some((callArgs: unknown[]) => {
    const arg = callArgs[0] as { queryKey?: unknown[] } | undefined
    return Array.isArray(arg?.queryKey) && JSON.stringify(arg.queryKey) === JSON.stringify(key)
  })
}

describe("Todo linked-session invalidation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(["session:started", "session:updated", "session:completed", "session:error", "session:deleted"])(
    "invalidates item-specific session queries on %s",
    async (event) => {
      const { invalidate } = setup()

      act(() => listener?.(event, { sessionId: "session-one" }))
      await act(async () => vi.advanceTimersByTimeAsync(1_000))

      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work-item-sessions"] })
    },
  )
})

describe("Todo live reconciliation (ICI-570)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("a todo event WITH a value still reconciles list membership after quiet", async () => {
    // The surgical merge cannot insert a created Todo or move one between the
    // board's per-status column queries — a full refetch pass must follow.
    const { invalidate } = setup()
    act(() => listener?.("company:changed", {
      entity: "todo", action: "created", id: "JIN-77", version: 1,
      value: { id: "JIN-77", version: 1, status: "backlog" },
    }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
    expect(calledWithKey(invalidate, ["work-item-tree"])).toBe(true)
    expect(calledWithKey(invalidate, ["departments"])).toBe(true)
    expect(calledWithKey(invalidate, ["work-item", "JIN-77"])).toBe(true)
  })

  it("a comment-lane todo event refreshes the open task page projections", async () => {
    const { invalidate } = setup()
    act(() => listener?.("company:changed", { entity: "todo", action: "commented", id: "JIN-9", version: 4 }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-item", "JIN-9"])).toBe(true)
    expect(calledWithKey(invalidate, ["work-item-comments", "JIN-9"])).toBe(true)
    expect(calledWithKey(invalidate, ["work-item-attachments", "JIN-9"])).toBe(true)
  })

  it("coalesces a burst of todo events into one reconciliation pass", async () => {
    const { invalidate } = setup()
    act(() => {
      listener?.("company:changed", { entity: "todo", action: "created", id: "JIN-1", version: 1 })
      listener?.("company:changed", { entity: "todo", action: "assigned", id: "JIN-1", version: 2 })
      listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "JIN-1", version: 3 })
    })
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    const listCalls = invalidate.mock.calls.filter((callArgs: unknown[]) => {
      const arg = callArgs[0] as { queryKey?: unknown[] } | undefined
      return JSON.stringify(arg?.queryKey) === JSON.stringify(["work-items"])
    })
    expect(listCalls).toHaveLength(1)
  })

  it("defers the todo refetch while a mutation is in flight, then reconciles", async () => {
    const { client, invalidate } = setup()
    let settle: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { settle = resolve })
    const mutation = client.getMutationCache().build(client, { mutationFn: () => gate })
    const running = mutation.execute(undefined)

    act(() => listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "JIN-3", version: 8 }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(false)

    settle?.()
    await act(async () => { await running })
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
  })

  it("a deferred todo flush never starves non-todo invalidations", async () => {
    const { client, invalidate } = setup()
    let settle: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { settle = resolve })
    const mutation = client.getMutationCache().build(client, { mutationFn: () => gate })
    const running = mutation.execute(undefined)

    act(() => {
      listener?.("company:changed", { entity: "todo", action: "created", id: "JIN-5", version: 1 })
      listener?.("skills:changed", {})
    })
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["skills"])).toBe(true)
    expect(calledWithKey(invalidate, ["work-items"])).toBe(false)

    settle?.()
    await act(async () => { await running })
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
  })
})
