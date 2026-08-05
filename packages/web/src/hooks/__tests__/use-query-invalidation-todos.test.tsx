import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys, TODO_WRITE_KEY } from "@/lib/query-keys"
import { useQueryInvalidation } from "../use-query-invalidation"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"

let listener: ((event: string, payload: unknown) => void) | undefined
let connectionSeq = 1

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connectionSeq,
    subscribe: (next: (event: string, payload: unknown) => void) => {
      const typedNext = next as unknown as GatewayEventListener
      listener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
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
  const hook = renderHook(() => useQueryInvalidation(), { wrapper })
  return { client, invalidate, rerender: hook.rerender }
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

  it.each(["session:started", "session:updated", "session:completed", "session:deleted"])(
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
  beforeEach(() => {
    connectionSeq = 1
    vi.useFakeTimers()
  })
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

  it("flushes a continuous event stream within the maximum wait", async () => {
    const { invalidate } = setup()

    for (let elapsed = 0; elapsed < 3_000; elapsed += 200) {
      act(() => listener?.("company:changed", {
        entity: "todo", action: "status-transitioned", id: "JIN-2", version: elapsed / 200 + 1,
      }))
      await act(async () => vi.advanceTimersByTimeAsync(200))
    }

    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
  })

  it("defers only for keyed todo writes, not unrelated mutations", async () => {
    const { client, invalidate } = setup()
    let settleUnrelated: (() => void) | undefined
    const unrelatedGate = new Promise<void>((resolve) => { settleUnrelated = resolve })
    const unrelated = client.getMutationCache().build(client, { mutationFn: () => unrelatedGate })
    const unrelatedRunning = unrelated.execute(undefined)

    act(() => listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "JIN-3", version: 8 }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)

    settleUnrelated?.()
    await act(async () => { await unrelatedRunning })
    invalidate.mockClear()

    let settleTodo: (() => void) | undefined
    const todoGate = new Promise<void>((resolve) => { settleTodo = resolve })
    const todoWrite = client.getMutationCache().build(client, {
      mutationKey: TODO_WRITE_KEY,
      mutationFn: () => todoGate,
    })
    const todoRunning = todoWrite.execute(undefined)

    act(() => listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "JIN-3", version: 9 }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(false)

    settleTodo?.()
    await act(async () => { await todoRunning })
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
  })

  it("a deferred todo flush never starves non-todo invalidations", async () => {
    const { client, invalidate } = setup()
    let settle: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { settle = resolve })
    const mutation = client.getMutationCache().build(client, {
      mutationKey: TODO_WRITE_KEY,
      mutationFn: () => gate,
    })
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

  it("reconciles todos after a connection sequence bump, but not on mount", async () => {
    const { invalidate, rerender } = setup()

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(false)

    connectionSeq = 2
    rerender()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(calledWithKey(invalidate, ["work-items"])).toBe(true)
  })

  it("invalidates Workflow list/detail/run and session detail caches after reconnect", async () => {
    const { client, rerender } = setup()
    const workflowId = "release-review"
    const runId = "run-7"
    const sessionId = "session-workflow-7"
    const keys = [
      queryKeys.workflows.all,
      queryKeys.workflows.definition(workflowId),
      queryKeys.workflows.runs(workflowId),
      queryKeys.workflows.run(workflowId, runId),
      queryKeys.sessions.detail(sessionId),
    ] as const
    for (const key of keys) client.setQueryData(key, { cached: true })

    connectionSeq = 2
    rerender()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true)
    }
  })
})
