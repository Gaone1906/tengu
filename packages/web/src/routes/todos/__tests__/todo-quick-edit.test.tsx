import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api, TodoApiError, type WorkItemDetailWire, type WorkItemEditRequest } from "@/lib/api"
import { hasTodoQuickEditRecovery, useTodoQuickEdit } from "../use-todo-quick-edit"

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

    const before = result.current.rankResetRevision
    await act(() => result.current.edit(ID, { rank: 42 }))
    expect(result.current.error).toBe("This Todo requires a current version before it can be saved. Reload it and try again.")
    expect(result.current.rankResetRevision).toBeGreaterThan(before)
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
})
