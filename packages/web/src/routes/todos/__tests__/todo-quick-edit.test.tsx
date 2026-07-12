import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api, TodoApiError, type WorkItemDetailWire, type WorkItemEditRequest } from "@/lib/api"
import { hasTodoQuickEditRecovery, useTodoQuickEdit } from "../use-todo-quick-edit"
import { todoPrivateRef } from "../todo-private-state"

const ID = "wi_private_quick_edit"

function detail(version: number, changes: Partial<WorkItemDetailWire["workItem"]> = {}): WorkItemDetailWire {
  return {
    workItem: {
      id: ID,
      version,
      title: "Remote title",
      body: null,
      status: "backlog",
      department: null,
      assignee: null,
      priority: 0,
      rank: null,
      source: "human",
      sourceRef: null,
      acceptance: null,
      verifyPolicy: null,
      rounds: 0,
      budgetUsd: null,
      approvalState: null,
      approvalRequest: null,
      approvalRef: null,
      approvalTarget: null,
      approvalEscalatedAt: null,
      approvalDecidedBy: null,
      approvalDecidedAt: null,
      createdAt: "2026-07-12T08:00:00.000Z",
      updatedAt: "2026-07-12T08:00:00.000Z",
      closedAt: null,
      ...changes,
    },
    spendUsd: 0,
    workflowRun: null,
    events: [],
  }
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, ...renderHook(() => useTodoQuickEdit(), { wrapper }) }
}

function quickStorage(): Record<string, any> {
  return JSON.parse(sessionStorage.getItem("jinn:todo-quick-edit:v1") ?? "{}")
}

function onlyStored(): any {
  return Object.values(quickStorage())[0]
}

describe("useTodoQuickEdit", () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("preflights full detail and uses the maximum authoritative cached version", async () => {
    const { client, result } = setup()
    client.setQueryData(["work-items", "newer"], { workItems: [{ id: ID, version: 12 }] })
    client.setQueryData(["work-items", "older"], { workItems: [{ id: ID, version: 4 }] })
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(12))
    const update = vi.spyOn(api, "updateWorkItem").mockResolvedValue({ workItem: detail(13, { title: "Desired" }).workItem as never, replayed: false })

    await act(() => result.current.edit(ID, { title: "Desired" }))

    expect(api.getWorkItem).toHaveBeenCalledWith(ID)
    expect(update).toHaveBeenCalledWith(ID, expect.objectContaining({ patch: { title: "Desired" }, expectedVersion: 12 }))
    expect((update.mock.calls[0][1] as WorkItemEditRequest).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it("serializes rapid ranks, coalesces the latest value, and rotates the key after acknowledgement", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    let resolveFirst!: (value: Awaited<ReturnType<typeof api.updateWorkItem>>) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ workItem: detail(9, { rank: 300 }).workItem as never, replayed: false })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => { first = result.current.edit(ID, { rank: 100 }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    act(() => { second = result.current.edit(ID, { rank: 300 }) })
    resolveFirst({ workItem: detail(8, { rank: 100 }).workItem as never, replayed: false })
    await act(() => Promise.all([first, second]))

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls.map((call) => call[1].patch)).toEqual([{ rank: 100 }, { rank: 300 }])
    expect(update.mock.calls[1][1].expectedVersion).toBe(8)
    expect(update.mock.calls[1][1].idempotencyKey).not.toBe(update.mock.calls[0][1].idempotencyKey)
  })

  it("persists and exact-replays an ambiguous request after remount", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem")
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce({ workItem: detail(8, { title: "Desired" }).workItem as never, replayed: true })
    const first = setup()
    await act(() => first.result.current.edit(ID, { title: "Desired" }))
    const original = update.mock.calls[0][1]
    first.unmount()

    const recovered = setup()
    await act(() => recovered.result.current.recover(ID))

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1]).toEqual(original)
    expect(api.getWorkItem).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("blocks same-field conflicts and overwrites only after a fresh preflight with a new key", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(8, { title: "Remote changed" }))
      .mockResolvedValueOnce(detail(8, { title: "Remote changed" }))
    const update = vi.spyOn(api, "updateWorkItem")
      .mockRejectedValueOnce(new TodoApiError(409, "private diagnostic", "TODO_VERSION_CONFLICT", 8))
      .mockResolvedValueOnce({ workItem: detail(9, { title: "Desired" }).workItem as never, replayed: false })

    await act(() => result.current.edit(ID, { title: "Desired" }))
    expect(result.current.recovery?.sameFieldConflict).toBe(true)
    expect(result.current.recovery?.fields).toEqual(["title"])
    expect(result.current.recovery?.error).not.toContain("private diagnostic")
    const originalKey = update.mock.calls[0][1].idempotencyKey

    await act(() => result.current.overwrite())
    expect(update.mock.calls[1][1]).toMatchObject({ patch: { title: "Desired" }, expectedVersion: 8 })
    expect(update.mock.calls[1][1].idempotencyKey).not.toBe(originalKey)
    expect(result.current.recovery).toBeNull()
  })

  it("rebases unrelated fields but clears rank optimism on Reload and definitive failure", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(8, { priority: 3 }))
      .mockResolvedValueOnce(detail(8, { priority: 3 }))
      .mockResolvedValueOnce(detail(9))
    const update = vi.spyOn(api, "updateWorkItem")
      .mockRejectedValueOnce(new TodoApiError(412, "raw", "TODO_VERSION_CONFLICT", 8))
      .mockResolvedValueOnce({ workItem: detail(9, { title: "Desired", priority: 3 }).workItem as never, replayed: false })
      .mockRejectedValueOnce(new TodoApiError(428, "raw", "TODO_PRECONDITION_REQUIRED"))

    await act(() => result.current.edit(ID, { title: "Desired" }))
    expect(result.current.recovery?.sameFieldConflict).toBe(false)
    await act(() => result.current.rebase())
    expect(update.mock.calls[1][1]).toMatchObject({ patch: { title: "Desired" }, expectedVersion: 8 })

    const before = result.current.rankResetRevisions[ID] ?? 0
    await act(() => result.current.edit(ID, { rank: 42 }))
    expect(result.current.error).toBe("This Todo requires a current version before it can be saved. Reload it and try again.")
    expect(result.current.rankResetRevisions[ID]).toBeGreaterThan(before)
  })

  it("stores no raw Todo identifier and keeps only the immutable minimal request", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    vi.spyOn(api, "updateWorkItem").mockRejectedValueOnce(new TypeError("offline"))
    await act(() => result.current.edit(ID, { title: "Offline desired" }))

    const stored = sessionStorage.getItem("jinn:todo-quick-edit:v1") ?? ""
    expect(stored).not.toContain(ID)
    expect(stored).toContain("Offline desired")
    expect(stored).not.toContain("createdAt")
    expect(stored).not.toContain("approvalState")
  })

  it("blocks when compact cache outruns two full-detail preflights", async () => {
    const { client, result } = setup()
    client.setQueryData(["work-items", "newer"], { workItems: [{ id: ID, version: 12 }] })
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(8))
    const update = vi.spyOn(api, "updateWorkItem")

    await act(() => result.current.edit(ID, { title: "Must not write" }))

    expect(api.getWorkItem).toHaveBeenCalledTimes(4)
    expect(update).not.toHaveBeenCalled()
    expect(result.current.recovery?.sameFieldConflict).toBe(true)
  })

  it("makes an idempotency conflict Reload-only and never blindly retries", async () => {
    const first = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem").mockRejectedValueOnce(
      new TodoApiError(409, "raw reused payload", "TODO_IDEMPOTENCY_CONFLICT", 7),
    )

    await act(() => first.result.current.edit(ID, { title: "Desired" }))

    expect(update).toHaveBeenCalledTimes(1)
    expect(first.result.current.recovery?.reloadOnly).toBe(true)
    expect(first.result.current.recovery?.error).not.toContain("raw reused payload")
    await act(() => first.result.current.rebase())
    await act(() => first.result.current.overwrite())
    expect(update).toHaveBeenCalledTimes(1)

    first.unmount()
    const recovered = setup()
    await act(() => recovered.result.current.recover(ID))
    expect(recovered.result.current.recovery?.reloadOnly).toBe(true)
  })

  it("fences a response when a newer cache revision arrives during transport", async () => {
    const { client, result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    let resolveUpdate!: (value: Awaited<ReturnType<typeof api.updateWorkItem>>) => void
    const update = vi.spyOn(api, "updateWorkItem").mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    let editing!: Promise<void>
    act(() => { editing = result.current.edit(ID, { title: "Desired" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    client.setQueryData(["work-items", "live"], { workItems: [{ id: ID, version: 12, title: "Newer" }] })
    resolveUpdate({ workItem: detail(8, { title: "Desired" }).workItem as never, replayed: false })
    await act(() => editing)

    expect(result.current.recovery).not.toBeNull()
    expect(hasTodoQuickEditRecovery(ID)).toBe(true)
    expect(client.getQueryData<{ workItems: Array<{ version: number }> }>(["work-items", "live"])?.workItems[0].version).toBe(12)
  })

  it("rechecks authority after invalidation before acknowledging the response", async () => {
    const { client, result } = setup()
    client.setQueryData(["work-items", "live"], { workItems: [{ id: ID, version: 7, title: "Old" }] })
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    vi.spyOn(api, "updateWorkItem").mockResolvedValue({ workItem: detail(8, { title: "Desired" }).workItem as never, replayed: false })
    vi.spyOn(client, "invalidateQueries").mockImplementation(async (options) => {
      if (JSON.stringify(options?.queryKey) === JSON.stringify(["work-items"])) {
        client.setQueryData(["work-items", "live"], { workItems: [{ id: ID, version: 12, title: "Live" }] })
      }
    })

    await act(() => result.current.edit(ID, { title: "Desired" }))

    expect(result.current.recovery).not.toBeNull()
    expect(hasTodoQuickEditRecovery(ID)).toBe(true)
  })

  it("caps journals at 50, cleans TTL expiry, and never stores generated ids", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockImplementation((id: string) => Promise.resolve(detail(7, { id })))
    vi.spyOn(api, "updateWorkItem").mockRejectedValue(new TypeError("offline"))
    for (let index = 0; index < 51; index += 1) {
      await act(() => result.current.edit(`wi_private_cap_${index}`, { title: `Authored ${index}` }))
    }
    const raw = sessionStorage.getItem("jinn:todo-quick-edit:v1") ?? "{}"
    expect(Object.keys(JSON.parse(raw))).toHaveLength(50)
    expect(raw).not.toMatch(/wi_private_cap_/)

    const expired = Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, Record<string, unknown>>)
      .map(([key, value]) => [key, { ...value, expiresAt: 1 }]))
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify(expired))
    expect(hasTodoQuickEditRecovery("wi_private_cap_50")).toBe(false)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("persists queued desired intent separately and exact-replays the active request after remount", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    let rejectFirst!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ workItem: detail(8, { title: "First" }).workItem as never, replayed: true })
      .mockResolvedValueOnce({ workItem: detail(9, { title: "Latest", rank: 44 }).workItem as never, replayed: false })
    const first = setup()
    let initial!: Promise<void>
    act(() => { initial = first.result.current.edit(ID, { title: "First" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    act(() => { void first.result.current.edit(ID, { title: "Latest", rank: 44 }) })

    expect(onlyStored()).toMatchObject({
      desired: { title: "Latest", rank: 44 },
      active: { request: update.mock.calls[0][1] },
    })
    rejectFirst(new TypeError("lost response"))
    await act(() => initial)
    const active = update.mock.calls[0][1]
    first.unmount()

    const recovered = setup()
    await act(() => recovered.result.current.recover(ID))
    expect(update.mock.calls[1][1]).toEqual(active)
    expect(update.mock.calls[2][1]).toMatchObject({ patch: { title: "Latest", rank: 44 }, expectedVersion: 8 })
    expect(update.mock.calls[2][1].idempotencyKey).not.toBe(active.idempotencyKey)
  })

  it("durably coalesces edits made while the full-detail preflight is pending", async () => {
    let resolveDetail!: (value: WorkItemDetailWire) => void
    vi.spyOn(api, "getWorkItem").mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve }))
    const update = vi.spyOn(api, "updateWorkItem").mockResolvedValue({
      workItem: detail(8, { title: "Latest", rank: 22 }).workItem as never,
      replayed: false,
    })
    const { result } = setup()
    let first!: Promise<void>
    act(() => { first = result.current.edit(ID, { title: "First" }) })
    act(() => { void result.current.edit(ID, { title: "Latest", rank: 22 }) })

    expect(onlyStored()).toMatchObject({ desired: { title: "Latest", rank: 22 } })
    expect(onlyStored().active).toBeUndefined()
    resolveDetail(detail(7))
    await act(() => first)
    expect(update).toHaveBeenCalledWith(ID, expect.objectContaining({ patch: { title: "Latest", rank: 22 }, expectedVersion: 7 }))
  })

  it("keeps queued fields in conflict detection and rebase intent", async () => {
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(8, { priority: 3 }))
      .mockResolvedValueOnce(detail(8, { priority: 3 }))
    let rejectFirst!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ workItem: detail(9, { title: "Latest", rank: 55, priority: 3 }).workItem as never, replayed: false })
    const { result } = setup()
    act(() => { void result.current.edit(ID, { title: "First" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    act(() => { void result.current.edit(ID, { title: "Latest", rank: 55 }) })
    rejectFirst(new TodoApiError(409, "conflict", "TODO_VERSION_CONFLICT", 8))
    await waitFor(() => expect(result.current.recovery).not.toBeNull())

    expect(result.current.recovery?.fields).toEqual(["title", "rank"])
    expect(result.current.recovery?.sameFieldConflict).toBe(false)
    await act(() => result.current.rebase())
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1]).toMatchObject({ patch: { title: "Latest", rank: 55 }, expectedVersion: 8 })
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("exact-replays an ambiguous request before dispatching intent added afterward", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem")
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce({ workItem: detail(8, { title: "First" }).workItem as never, replayed: true })
      .mockResolvedValueOnce({ workItem: detail(9, { title: "First", rank: 33 }).workItem as never, replayed: false })
    const { result } = setup()

    await act(() => result.current.edit(ID, { title: "First" }))
    const firstRequest = update.mock.calls[0][1]
    await act(() => result.current.edit(ID, { rank: 33 }))

    expect(update).toHaveBeenCalledTimes(3)
    expect(update.mock.calls[1][1]).toEqual(firstRequest)
    expect(update.mock.calls[2][1]).toMatchObject({ patch: { rank: 33 }, expectedVersion: 8 })
    expect(onlyStored()).toBeUndefined()
  })

  it("durably adds conflict-time intent but never dispatches before an explicit action", async () => {
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(8, { priority: 2 }))
      .mockResolvedValueOnce(detail(8, { priority: 2 }))
    const update = vi.spyOn(api, "updateWorkItem")
      .mockRejectedValueOnce(new TodoApiError(409, "conflict", "TODO_VERSION_CONFLICT", 8))
      .mockResolvedValueOnce({ workItem: detail(9, { title: "Desired", rank: 48, priority: 2 }).workItem as never, replayed: false })
    const { result } = setup()

    await act(() => result.current.edit(ID, { title: "Desired" }))
    act(() => { void result.current.edit(ID, { rank: 48 }) })
    await Promise.resolve()

    expect(update).toHaveBeenCalledTimes(1)
    expect(onlyStored()).toMatchObject({ desired: { title: "Desired", rank: 48 }, queuedFields: ["rank"], queuedPatch: { rank: 48 } })
    await act(() => result.current.rebase())
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1].patch).toEqual({ title: "Desired", rank: 48 })
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("retains a new field after a recovered conflict even while remote detail is unavailable", async () => {
    const first = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem").mockRejectedValueOnce(
      new TodoApiError(409, "conflict", "TODO_VERSION_CONFLICT", 8),
    )
    await act(() => first.result.current.edit(ID, { title: "Recovered desired" }))
    first.unmount()

    vi.mocked(api.getWorkItem).mockRejectedValue(new TypeError("offline"))
    const recovered = setup()
    await act(() => recovered.result.current.recover(ID))
    act(() => { void recovered.result.current.edit(ID, { rank: 64 }) })
    await Promise.resolve()

    expect(update).toHaveBeenCalledTimes(1)
    expect(onlyStored()).toMatchObject({
      desired: { title: "Recovered desired", rank: 64 },
      queuedFields: ["rank"],
      queuedPatch: { rank: 64 },
    })
    expect(recovered.result.current.error).toBeNull()
  })

  it("rejects an intent that cannot be durably admitted while preserving the active request", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    let resolveFirst!: (value: Awaited<ReturnType<typeof api.updateWorkItem>>) => void
    const update = vi.spyOn(api, "updateWorkItem").mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const { result } = setup()
    act(() => { void result.current.edit(ID, { title: "Durable first" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const durableBefore = sessionStorage.getItem("jinn:todo-quick-edit:v1")
    const nativeSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-quick-edit:v1" && value.includes('"rank":88')) return
      nativeSetItem.call(this, key, value)
    })

    let rejectedIntent!: Promise<void>
    act(() => { rejectedIntent = result.current.edit(ID, { rank: 88 }) })
    expect(result.current.error).toBe("This edit couldn't be stored safely. Reload the Todo and try again.")
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBe(durableBefore)
    expect(result.current.rankResetRevisions[ID]).toBe(1)
    resolveFirst({ workItem: detail(8, { title: "Durable first" }).workItem as never, replayed: false })
    await act(() => rejectedIntent)
    await waitFor(() => expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull())
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("clears an authoritative no-op without PATCHing or leaving a gate", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7, { title: "Already current" }))
    const update = vi.spyOn(api, "updateWorkItem")
    const { result } = setup()

    await act(() => result.current.edit(ID, { title: "Already current" }))

    expect(update).not.toHaveBeenCalled()
    expect(result.current.hasOutstanding(ID)).toBe(false)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("queues reset revisions for every failed rank independently", async () => {
    vi.spyOn(api, "getWorkItem").mockImplementation((id: string) => Promise.resolve(detail(7, { id })))
    vi.spyOn(api, "updateWorkItem").mockRejectedValue(new TodoApiError(428, "raw", "TODO_PRECONDITION_REQUIRED"))
    const { result } = setup()
    await act(() => Promise.all([
      result.current.edit("wi_rank_a", { rank: 1 }),
      result.current.edit("wi_rank_b", { rank: 2 }),
    ]))
    expect(result.current.rankResetRevisions).toMatchObject({ wi_rank_a: 1, wi_rank_b: 1 })
  })

  it("resets a queued rank when the active same-item request definitively fails", async () => {
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    let rejectActive!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectActive = reject }))
    const { result } = setup()
    act(() => { void result.current.edit(ID, { title: "Active" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    let queued!: Promise<void>
    act(() => { queued = result.current.edit(ID, { rank: 200 }) })
    rejectActive(new TodoApiError(400, "unsafe", "TODO_INVALID_PATCH"))
    await act(() => queued)
    expect(result.current.rankResetRevisions[ID]).toBe(1)
  })

  it("keeps multiple conflicts ordered and promotes the next recovery after resolving one", async () => {
    const firstId = "wi_conflict_a"
    const secondId = "wi_conflict_b"
    vi.spyOn(api, "getWorkItem").mockImplementation((id: string) => Promise.resolve(detail(8, { id })))
    vi.spyOn(api, "updateWorkItem").mockRejectedValue(new TodoApiError(409, "raw", "TODO_VERSION_CONFLICT", 8))
    const { result } = setup()
    await act(() => result.current.edit(firstId, { title: "First desired" }))
    await act(() => result.current.edit(secondId, { rank: 12 }))

    expect(result.current.recoveryRef).toBe(todoPrivateRef(firstId))
    expect(result.current.recovery?.fields).toEqual(["title"])
    await act(() => result.current.reload())
    expect(result.current.recoveryRef).toBe(todoPrivateRef(secondId))
    expect(result.current.recovery?.fields).toEqual(["rank"])
  })

  it("rejects unknown envelope, active, request, and impossible state keys without dispatching", async () => {
    const seed = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    vi.spyOn(api, "updateWorkItem").mockRejectedValueOnce(new TypeError("offline"))
    await act(() => seed.result.current.edit(ID, { title: "Desired" }))
    seed.unmount()
    const [ref, stored] = Object.entries(quickStorage())[0]
    vi.restoreAllMocks()
    const update = vi.spyOn(api, "updateWorkItem")
    const variants = [
      { ...stored, diagnostic: "raw /private/path" },
      { ...stored, active: { ...stored.active, diagnostic: "stack" } },
      { ...stored, active: { ...stored.active, request: { ...stored.active.request, todoId: ID } } },
      { ...stored, blocked: "version" },
      { ...stored, active: { ...stored.active, state: "uncertain", failureCode: "idempotency" } },
      {
        ...stored,
        desired: { ...stored.desired, rank: 91 },
        baseline: { ...stored.baseline, rank: null },
      },
      {
        ...stored,
        desired: { ...stored.desired, rank: 91 },
        baseline: { ...stored.baseline, rank: null },
        queuedFields: ["rank"],
      },
    ]
    for (const variant of variants) {
      sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify({ [ref]: variant }))
      const recovered = setup()
      await act(() => recovered.result.current.recover(ID))
      recovered.unmount()
      expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
    }
    expect(update).not.toHaveBeenCalled()
  })

  it("retains operator-authored text that happens to resemble an opaque identifier", async () => {
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    vi.spyOn(api, "updateWorkItem").mockRejectedValueOnce(new TypeError("offline"))
    await act(() => result.current.edit(ID, { title: "Authored wi_example remains recoverable" }))
    expect(onlyStored().desired.title).toBe("Authored wi_example remains recoverable")
  })

  it("clears definitive preflight failure so detail is no longer gated", async () => {
    vi.spyOn(api, "getWorkItem").mockRejectedValueOnce(new TodoApiError(404, "raw path", "WORK_ITEM_NOT_FOUND"))
    const { result } = setup()
    await act(() => result.current.edit(ID, { rank: 9 }))
    expect(result.current.error).toBe("This Todo no longer exists.")
    expect(result.current.hasOutstanding(ID)).toBe(false)
    expect(result.current.rankResetRevisions).toMatchObject({ [ID]: 1 })
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it.each(["prepared", "dispatched"] as const)(
    "refuses to PATCH when the %s journal transition cannot be read back durably",
    async (blockedState) => {
      const nativeSetItem = Storage.prototype.setItem
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === "jinn:todo-quick-edit:v1" && value.includes(`\"state\":\"${blockedState}\"`)) return
        nativeSetItem.call(this, key, value)
      })
      const { result } = setup()
      vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
      const update = vi.spyOn(api, "updateWorkItem")

      await act(() => result.current.edit(ID, { title: "Must remain local" }))

      expect(update).not.toHaveBeenCalled()
      expect(result.current.error).toBe("This edit couldn't be stored safely. Reload the Todo and try again.")
      expect(result.current.hasOutstanding(ID)).toBe(false)
      expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
    },
  )

  it("refuses to PATCH a tampered dispatched journal and leaves no permanent detail gate", async () => {
    const nativeSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-quick-edit:v1" && value.includes('"state":"dispatched"')) {
        nativeSetItem.call(this, key, value.replace('"state":"dispatched"', '"state":"uncertain"'))
        return
      }
      nativeSetItem.call(this, key, value)
    })
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem")

    await act(() => result.current.edit(ID, { rank: 91 }))

    expect(update).not.toHaveBeenCalled()
    expect(result.current.hasOutstanding(ID)).toBe(false)
    expect(result.current.rankResetRevisions[ID]).toBe(1)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("refuses to PATCH when sessionStorage quota throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota diagnostic", "QuotaExceededError")
    })
    const { result } = setup()
    vi.spyOn(api, "getWorkItem").mockResolvedValue(detail(7))
    const update = vi.spyOn(api, "updateWorkItem")

    await act(() => result.current.edit(ID, { title: "Quota-held edit" }))

    expect(update).not.toHaveBeenCalled()
    expect(result.current.error).toBe("This edit couldn't be stored safely. Reload the Todo and try again.")
    expect(result.current.hasOutstanding(ID)).toBe(false)
  })

  it("retires a definitively failed request but sends a newer different-field intent with a fresh key", async () => {
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(7))
    let rejectFirst!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ workItem: detail(8, { rank: 72 }).workItem as never, replayed: false })
    const { result } = setup()
    act(() => { void result.current.edit(ID, { title: "Rejected title" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const firstKey = update.mock.calls[0][1].idempotencyKey
    let queued!: Promise<void>
    act(() => { queued = result.current.edit(ID, { rank: 72 }) })

    rejectFirst(new TodoApiError(403, "private diagnostic", "TODO_FORBIDDEN"))
    await act(() => queued)

    expect(api.getWorkItem).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1]).toMatchObject({ patch: { rank: 72 }, expectedVersion: 7 })
    expect(update.mock.calls[1][1].idempotencyKey).not.toBe(firstKey)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("keeps a newer same-field intent through definitive failure and reload-interrupted replay", async () => {
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(7))
    let rejectFirst!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockRejectedValueOnce(new TypeError("lost second response"))
      .mockResolvedValueOnce({ workItem: detail(8, { title: "Latest title" }).workItem as never, replayed: true })
    const first = setup()
    act(() => { void first.result.current.edit(ID, { title: "Rejected title" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    act(() => { void first.result.current.edit(ID, { title: "Latest title" }) })

    rejectFirst(new TodoApiError(428, "private precondition", "TODO_PRECONDITION_REQUIRED"))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    const secondRequest = update.mock.calls[1][1]
    expect(secondRequest.patch).toEqual({ title: "Latest title" })
    expect(secondRequest.idempotencyKey).not.toBe(update.mock.calls[0][1].idempotencyKey)
    await waitFor(() => expect(onlyStored().active.state).toBe("uncertain"))
    first.unmount()

    const recovered = setup()
    await act(() => recovered.result.current.recover(ID))
    expect(update.mock.calls[2][1]).toEqual(secondRequest)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull()
  })

  it("treats a repeated same-value activation after dispatch as a newer logical edit", async () => {
    vi.spyOn(api, "getWorkItem")
      .mockResolvedValueOnce(detail(7))
      .mockResolvedValueOnce(detail(7))
    let rejectFirst!: (error: unknown) => void
    const update = vi.spyOn(api, "updateWorkItem")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ workItem: detail(8, { title: "Repeated intent" }).workItem as never, replayed: false })
    const { result } = setup()
    act(() => { void result.current.edit(ID, { title: "Repeated intent" }) })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    let repeated!: Promise<void>
    act(() => { repeated = result.current.edit(ID, { title: "Repeated intent" }) })

    rejectFirst(new TodoApiError(403, "private rejection", "TODO_FORBIDDEN"))
    await act(() => repeated)

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1].patch).toEqual({ title: "Repeated intent" })
    expect(update.mock.calls[1][1].idempotencyKey).not.toBe(update.mock.calls[0][1].idempotencyKey)
  })
})
