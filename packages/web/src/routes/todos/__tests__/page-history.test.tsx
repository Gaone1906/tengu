import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TodoApiError, type OrgData, type WorkItemCompactWire, type WorkItemDetailWire } from "@/lib/api"
import TodosPage from "../page"
import { persistTodoJournal, todoPrivateRef } from "../todo-private-state"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()
const getWorkItem = vi.fn()
const getOrg = vi.fn()
const updateWorkItem = vi.fn()
const listWorkItemSessions = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      searchWorkItems: (...args: unknown[]) => searchWorkItems(...args),
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getOrg: (...args: unknown[]) => getOrg(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      listWorkItemSessions: (...args: unknown[]) => listWorkItemSessions(...args),
      setWorkItemStatus: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

const PRIVATE_ID = "wi_private_history"
const compact: WorkItemCompactWire = {
  id: PRIVATE_ID,
  version: 7,
  title: "Recoverable todo",
  status: "backlog",
  assignee: null,
  department: null,
  source: "human",
  sourceRef: null,
  approvalState: null,
  approvalRequest: null,
  approvalRef: null,
  approvalTarget: null,
  approvalEscalatedAt: null,
  updatedAt: "2026-07-11T08:00:00.000Z",
}
const detail: WorkItemDetailWire = {
  workItem: {
    ...compact,
    version: compact.version ?? 1,
    body: null,
    priority: 0,
    rank: compact.rank ?? null,
    acceptance: null,
    verifyPolicy: null,
    rounds: 0,
    budgetUsd: null,
    approvalDecidedBy: null,
    approvalDecidedAt: null,
    createdAt: "2026-07-11T08:00:00.000Z",
    closedAt: null,
  },
  spendUsd: 0,
  workflowRun: null,
  events: [],
}
const org: OrgData = {
  departments: [],
  employees: [],
  hierarchy: { root: "coo", sorted: ["coo"], warnings: [] },
}

let navigate: ReturnType<typeof useNavigate>
let hideTodoPage: (() => void) | null = null
let currentSearch = ""
let currentState: unknown = null
const originalMatchMedia = window.matchMedia
function RouterProbe() {
  navigate = useNavigate()
  const location = useLocation()
  currentSearch = location.search
  currentState = location.state
  return null
}

function renderPage(initialEntries: Array<string | { pathname: string; search?: string; state?: unknown }> = ["/todos"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <RouterProbe />
        <TodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderTogglePage(initialEntries: Array<string | { pathname: string; search?: string; state?: unknown }> = ["/todos"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function TogglePage() {
    const [visible, setVisible] = useState(true)
    hideTodoPage = () => setVisible(false)
    return visible ? <TodosPage /> : null
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <RouterProbe />
        <TogglePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("Todo detail navigation and draft recovery", () => {
  beforeEach(() => {
    hideTodoPage = null
    sessionStorage.clear()
    listWorkItems.mockReset().mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      return Promise.resolve({
        workItems: params?.status === "backlog" ? [compact] : [],
        total: params?.status === "backlog" ? 1 : 0,
        nextOffset: null,
      })
    })
    searchWorkItems.mockReset()
    getWorkItem.mockReset().mockResolvedValue(detail)
    getOrg.mockReset().mockResolvedValue(org)
    updateWorkItem.mockReset().mockResolvedValue({ workItem: detail.workItem, replayed: false })
    listWorkItemSessions.mockReset().mockResolvedValue([])
  })
  afterEach(() => Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }))

  it("uses Back/Forward without exposing the private id and restores an uncommitted draft and focus", async () => {
    renderPage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    opener.focus()
    fireEvent.click(opener)
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(currentSearch).not.toContain(PRIVATE_ID)
    expect(JSON.stringify(currentState)).not.toContain(PRIVATE_ID)

    fireEvent.click(screen.getByTestId("sheet-title"))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Recovered after Back" } })
    const unload = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    act(() => navigate(-1))
    await waitFor(() => expect(screen.queryByTestId("detail-sheet")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))

    act(() => navigate(1))
    expect(await screen.findByText("Recovered after Back")).toBeTruthy()
    expect(updateWorkItem).not.toHaveBeenCalled()
    expect(document.body.innerHTML).not.toContain(PRIVATE_ID)
    const persisted = Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index) ?? ""
      return `${key}\n${sessionStorage.getItem(key) ?? ""}`
    }).join("\n")
    expect(persisted).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it("does not resurrect or retry a definitively failed title after it is reverted", async () => {
    updateWorkItem.mockRejectedValueOnce(new Error("definitive server rejection"))
    const mounted = renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "Open Recoverable todo" }))
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Rejected title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: compact.title } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull())
    expect(sessionStorage.getItem("jinn:todo-draft-journal:v2")).toBeNull()
    expect(updateWorkItem).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByTestId("detail-sheet")).toBeNull())
    act(() => navigate(1))
    expect((await screen.findByTestId("sheet-title")).textContent).toBe(compact.title)
    expect(screen.queryByText("Rejected title")).toBeNull()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()

    const reloadState = currentState
    mounted.unmount()
    renderPage([{ pathname: "/todos", state: reloadState }])
    expect((await screen.findByTestId("sheet-title")).textContent).toBe(compact.title)
    expect(screen.queryByText("Rejected title")).toBeNull()
    expect(updateWorkItem).toHaveBeenCalledTimes(1)
  })

  it("routes inline rename through the canonical conditional request and safe conflict surface", async () => {
    updateWorkItem.mockRejectedValueOnce(new TodoApiError(409, "SQL token /private/path wi_secret", "TODO_VERSION_CONFLICT", 8))
    renderPage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    fireEvent.keyDown(opener, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Desired title" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })

    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    expect(updateWorkItem.mock.calls[0][1]).toEqual(expect.objectContaining({
      patch: { title: "Desired title" },
      expectedVersion: 7,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }))
    expect(await screen.findByText("Todo changed elsewhere")).toBeTruthy()
    expect(document.body.textContent).not.toContain("SQL token")
    expect(document.body.innerHTML).not.toContain("wi_secret")
  })

  it("waits for a same-item quick edit before opening detail", async () => {
    let resolveUpdate!: (value: unknown) => void
    updateWorkItem.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    renderPage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    fireEvent.keyDown(opener, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Confirmed before open" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: "Open Recoverable todo" }))
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
    resolveUpdate({
      workItem: { ...detail.workItem, version: 8, title: "Confirmed before open" },
      replayed: false,
    })
    await waitFor(() => expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Open Confirmed before open" }))
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
  })

  it("keeps the live filter URL when an older quick-edit operation completes", async () => {
    let resolveUpdate!: (value: unknown) => void
    updateWorkItem.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    renderPage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    fireEvent.keyDown(opener, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Saved after search" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByRole("searchbox", { name: "Search todos" }), { target: { value: "still-current" } })
    await waitFor(() => expect(currentSearch).toBe("?q=still-current"))
    resolveUpdate({
      workItem: { ...detail.workItem, version: 8, title: "Saved after search" },
      replayed: false,
    })

    await waitFor(() => expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull())
    expect(currentSearch).toBe("?q=still-current")
  })

  it("does not navigate or retire recovery after the Todo page unmounts", async () => {
    let resolveUpdate!: (value: unknown) => void
    updateWorkItem.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    renderTogglePage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    fireEvent.keyDown(opener, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Complete after unmount" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(currentState).toMatchObject({
      todoQuickRecoveries: [expect.objectContaining({ ref: todoPrivateRef(PRIVATE_ID) })],
    }))
    const stateBeforeUnmount = currentState

    act(() => hideTodoPage?.())
    resolveUpdate({
      workItem: { ...detail.workItem, version: 8, title: "Complete after unmount" },
      replayed: false,
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(currentState).toEqual(stateBeforeUnmount)
  })

  it("preserves sanitized quick recovery metadata when another Todo opens", async () => {
    const other = { ...compact, id: "wi_other_history", title: "Other todo" }
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      return Promise.resolve({
        workItems: params?.status === "backlog" ? [compact, other] : [],
        total: params?.status === "backlog" ? 2 : 0,
        nextOffset: null,
      })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({ ...detail, workItem: { ...detail.workItem, id } }))
    let rejectUpdate!: (error: unknown) => void
    updateWorkItem.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
    renderPage()
    const first = await screen.findByRole("button", { name: "Open Recoverable todo" })
    fireEvent.keyDown(first, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Recover this" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(currentState).toMatchObject({
      todoQuickRecoveries: [expect.objectContaining({ ref: expect.stringMatching(/^td_/) })],
      todoQuickRecoveryEpoch: expect.stringMatching(/^qe_[a-f0-9]{32}$/),
    }))

    fireEvent.click(screen.getByRole("button", { name: "Open Other todo" }))
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(currentState).toMatchObject({
      todoRef: todoPrivateRef(other.id),
      todoQuickRecoveries: [expect.objectContaining({ ref: todoPrivateRef(compact.id) })],
      todoQuickRecoveryEpoch: expect.stringMatching(/^qe_[a-f0-9]{32}$/),
    })
    expect(JSON.stringify(currentState)).not.toContain(compact.id)
    expect(JSON.stringify(currentState)).not.toContain(other.id)
    rejectUpdate(new TypeError("lost response"))
  })

  it("sanitizes the complete Todo history schema instead of spreading private top-level state", async () => {
    const safeRef = todoPrivateRef("wi_hidden_history_state")
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify({
      [safeRef]: {
        expiresAt: Date.now() + 60_000,
        desired: { title: "Hidden authored recovery" },
        baseline: { title: "Hidden remote" },
        active: {
          request: {
            patch: { title: "Hidden authored recovery" },
            expectedVersion: 7,
            idempotencyKey: "4996e28f-30f0-4f2a-bbf9-1d6ae02dd787",
          },
          state: "uncertain",
        },
      },
    }))
    renderPage([{ pathname: "/todos", state: {
      todoRef: PRIVATE_ID,
      todoScroll: -10,
      todoAnchorRef: "wi_raw_anchor",
      todoAnchorOffset: Number.POSITIVE_INFINITY,
      todoPageDepth: { backlog: 2, diagnostic: "wi_depth_secret" },
      todoQuickRecoveries: [{ ref: safeRef, anchorRef: safeRef, anchorOffset: 2, scroll: 4, pageDepth: { backlog: 1 } }],
      todoQuickRecoveryEpoch: "qe_0123456789abcdef0123456789abcdef",
      arbitrary: "wi_top_level_secret",
      diagnostic: "/private/path",
    } }])

    await waitFor(() => expect(currentState).toEqual({
      todoQuickRecoveries: [{ ref: safeRef, anchorRef: safeRef, anchorOffset: 2, scroll: 4, pageDepth: { backlog: 1 } }],
      todoQuickRecoveryEpoch: "qe_0123456789abcdef0123456789abcdef",
    }))
    expect(JSON.stringify(currentState)).not.toMatch(/wi_|private\/path/)
  })

  it("restores second-page quick-edit depth and exact-replays without raw ids in history", async () => {
    const rows = Array.from({ length: 29 }, (_, index): WorkItemCompactWire => ({
      ...compact,
      id: `wi_quick_page_${index + 1}`,
      title: `Quick todo ${index + 1}`,
      rank: index * 1024,
    }))
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string; offset?: number }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status !== "backlog") return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      const offset = params.offset ?? 0
      const page = rows.slice(offset, offset + 20)
      return Promise.resolve({ workItems: page, total: rows.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({
      ...detail,
      workItem: { ...detail.workItem, id, version: 7, title: rows.find((row) => row.id === id)?.title ?? "Todo", rank: rows.find((row) => row.id === id)?.rank ?? null },
    }))
    updateWorkItem
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce({
        workItem: { ...detail.workItem, id: rows[28].id, version: 8, title: rows[28].title, rank: rows[27].rank! - 512 },
        replayed: true,
      })
    const mounted = renderPage()
    await screen.findByRole("button", { name: "Open Quick todo 20" })
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more" }))
    const row = (await screen.findByRole("button", { name: "Open Quick todo 29" })).closest('[data-testid="todo-row"]')!
    const initialScroller = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(initialScroller, "scrollTop", { configurable: true, writable: true, value: 650 })
    fireEvent.pointerDown(row.querySelector('button[aria-label="Todo actions"]')!, { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(currentState).toMatchObject({
      todoQuickRecoveries: [expect.objectContaining({
        ref: expect.stringMatching(/^td_/),
        anchorRef: expect.stringMatching(/^td_/),
        pageDepth: expect.objectContaining({ backlog: 2 }),
      })],
    }))
    expect(JSON.stringify(currentState)).not.toContain(rows[28].id)

    const reloadState = currentState
    const original = updateWorkItem.mock.calls[0][1]
    mounted.unmount()
    listWorkItems.mockClear()
    renderPage([{ pathname: "/todos", state: reloadState }])
    const restoredScroller = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(restoredScroller, "scrollTop", { configurable: true, writable: true, value: 0 })
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(2))
    expect(updateWorkItem.mock.calls[1][1]).toEqual(original)
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 }))
    await waitFor(() => expect(restoredScroller.scrollTop).toBe(650))
  })

  it("keeps multiple ambiguous quick edits ordered and stale completion removes only its own recovery", async () => {
    const rows = [
      { ...compact, id: "wi_multi_a", title: "Multi A", rank: 0 },
      { ...compact, id: "wi_multi_b", title: "Multi B", rank: 1024 },
    ]
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      return Promise.resolve({ workItems: params?.status === "backlog" ? rows : [], total: params?.status === "backlog" ? 2 : 0, nextOffset: null })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({
      ...detail,
      workItem: { ...detail.workItem, ...rows.find((row) => row.id === id), version: 7 },
    }))
    let resolveFirst!: (value: unknown) => void
    updateWorkItem
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockRejectedValueOnce(new TypeError("lost second response"))
      .mockResolvedValueOnce({
        workItem: { ...detail.workItem, ...rows[1], version: 8, title: "Multi B edited" },
        replayed: true,
      })
    const mounted = renderPage()
    const first = await screen.findByRole("button", { name: "Open Multi A" })
    fireEvent.keyDown(first, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Multi A edited" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))

    const second = screen.getByRole("button", { name: "Open Multi B" })
    fireEvent.keyDown(second, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Multi B edited" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(2))
    await waitFor(() => expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toHaveLength(2))
    const secondRequest = updateWorkItem.mock.calls[1][1]

    resolveFirst({
      workItem: { ...detail.workItem, ...rows[0], version: 8, title: "Multi A edited" },
      replayed: false,
    })
    await waitFor(() => expect((currentState as { todoQuickRecoveries: Array<{ ref: string }> }).todoQuickRecoveries)
      .toEqual([expect.objectContaining({ ref: todoPrivateRef(rows[1].id) })]))
    expect(JSON.stringify(currentState)).not.toContain(rows[0].id)
    expect(JSON.stringify(currentState)).not.toContain(rows[1].id)

    const reloadState = currentState
    mounted.unmount()
    renderPage([{ pathname: "/todos", state: reloadState }])
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(3))
    expect(updateWorkItem.mock.calls[2][1]).toEqual(secondRequest)
  })

  it("retains an unresolved safe recovery ref while its unexpired journal still exists", async () => {
    const hiddenId = "wi_filtered_recovery"
    const ref = todoPrivateRef(hiddenId)
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify({
      [ref]: {
        expiresAt: Date.now() + 60_000,
        desired: { title: "Recover after filter changes" },
        baseline: { title: "Remote" },
        active: {
          request: {
            patch: { title: "Recover after filter changes" },
            expectedVersion: 7,
            idempotencyKey: "8e89ea43-98cb-4b1f-9d53-8cc1bc1c0651",
          },
          state: "uncertain",
        },
      },
    }))
    listWorkItems.mockResolvedValue({ workItems: [], total: 0, nextOffset: null })
    const state = {
      todoQuickRecoveries: [{ ref, anchorRef: ref, anchorOffset: 18, scroll: 580, pageDepth: { backlog: 1 } }],
    }
    renderPage([{ pathname: "/todos", search: "?status=assigned", state }])
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    expect(currentState).toMatchObject(state)
    expect((currentState as { todoQuickRecoveryEpoch: string }).todoQuickRecoveryEpoch).toMatch(/^qe_[a-f0-9]{32}$/)
    expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toContain("Recover after filter changes")
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("cancels pending quick-recovery scroll restoration on user input", async () => {
    const ref = todoPrivateRef(PRIVATE_ID)
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify({
      [ref]: {
        expiresAt: Date.now() + 60_000,
        desired: { title: "Recovered title" },
        baseline: { title: compact.title },
        active: {
          request: {
            patch: { title: "Recovered title" },
            expectedVersion: 7,
            idempotencyKey: "a31ecfa3-ad8f-4f28-b4cf-ccf266365dc8",
          },
          state: "uncertain",
        },
      },
    }))
    let resolveBacklog!: (value: { workItems: WorkItemCompactWire[]; total: number; nextOffset: null }) => void
    const backlog = new Promise<{ workItems: WorkItemCompactWire[]; total: number; nextOffset: null }>((resolve) => {
      resolveBacklog = resolve
    })
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status === "backlog") return backlog
      return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
    })
    updateWorkItem.mockResolvedValue({
      workItem: { ...detail.workItem, version: 8, title: "Recovered title" },
      replayed: true,
    })
    renderPage([{
      pathname: "/todos",
      state: { todoQuickRecoveries: [{ ref, anchorRef: ref, anchorOffset: 12, scroll: 500, pageDepth: { backlog: 1 } }] },
    }])
    const scroller = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 })
    fireEvent.pointerDown(scroller, { pointerType: "touch" })
    await act(async () => resolveBacklog({ workItems: [compact], total: 1, nextOffset: null }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    expect(scroller.scrollTop).toBe(0)
  })

  it("preserves the latest ordered quick recoveries through pushed filters and replaced search", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const refs = [todoPrivateRef("wi_hidden_order_a"), todoPrivateRef("wi_hidden_order_b")]
    const records = refs.map((ref, index) => ({
      ref,
      anchorRef: ref,
      anchorOffset: 12 + index,
      scroll: 480 + index,
      pageDepth: { backlog: 1 },
    }))
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify(Object.fromEntries(refs.map((ref, index) => [ref, {
      expiresAt: Date.now() + 60_000,
      desired: { title: `Hidden ${index}` },
      baseline: { title: `Remote ${index}` },
      active: {
        request: {
          patch: { title: `Hidden ${index}` },
          expectedVersion: 7,
          idempotencyKey: index === 0
            ? "e2da2848-e8d2-49c9-bc28-b49b129d4c0f"
            : "ce38a954-4cc4-4f00-b591-b68db3fd1f21",
        },
        state: "uncertain",
      },
    }]))))
    listWorkItems.mockResolvedValue({ workItems: [], total: 0, nextOffset: null })
    renderPage([{ pathname: "/todos", state: {
      todoQuickRecoveries: records,
      todoQuickRecoveryEpoch: "qe_0123456789abcdef0123456789abcdef",
    } }])
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())

    fireEvent.change(screen.getByRole("searchbox", { name: "Search todos" }), { target: { value: "queued" } })
    await waitFor(() => expect(currentSearch).toBe("?q=queued"), { timeout: 1_000 })
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)

    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    fireEvent.click(screen.getByRole("button", { name: "Status" }))
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked&q=queued"))
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)

    act(() => navigate(-1))
    await waitFor(() => expect(currentSearch).toBe("?q=queued"))
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)
    act(() => navigate(1))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked&q=queued"))
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)

    fireEvent.click(screen.getByRole("button", { name: "View by person" }))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked&q=queued&view=people"))
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)
    act(() => navigate(-1))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked&q=queued"))
    expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toEqual(records)
  })

  it("keeps user-cancelled quick scroll recovery cancelled while the ordered collection mutates", async () => {
    const rows = [
      { ...compact, id: "wi_scroll_epoch_a", title: "Epoch A" },
      { ...compact, id: "wi_scroll_epoch_b", title: "Epoch B" },
    ]
    const refs = rows.map((row) => todoPrivateRef(row.id))
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify(Object.fromEntries(refs.map((ref, index) => [ref, {
      expiresAt: Date.now() + 60_000,
      desired: { title: `Epoch ${index} edited` },
      baseline: { title: rows[index].title },
      active: {
        request: {
          patch: { title: `Epoch ${index} edited` },
          expectedVersion: 7,
          idempotencyKey: index === 0
            ? "17e78a37-8143-4270-8e77-5e3d02a0ac36"
            : "2421f678-7ad7-4d7e-b3d0-aa6d32b9ea4b",
        },
        state: "uncertain",
      },
    }]))))
    let resolveBacklog!: (value: { workItems: WorkItemCompactWire[]; total: number; nextOffset: null }) => void
    const backlog = new Promise<{ workItems: WorkItemCompactWire[]; total: number; nextOffset: null }>((resolve) => { resolveBacklog = resolve })
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status === "backlog") return backlog
      return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
    })
    updateWorkItem
      .mockResolvedValueOnce({ workItem: { ...detail.workItem, ...rows[0], version: 8, title: "Epoch 0 edited" }, replayed: true })
      .mockRejectedValueOnce(new TypeError("lost second response"))
    renderPage([{ pathname: "/todos", state: {
      todoQuickRecoveries: refs.map((ref) => ({ ref, anchorRef: ref, anchorOffset: 12, scroll: 500, pageDepth: { backlog: 1 } })),
      todoQuickRecoveryEpoch: "qe_abcdef0123456789abcdef0123456789",
    } }])
    const scroller = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 })
    fireEvent.pointerDown(scroller, { pointerType: "touch" })
    await act(async () => resolveBacklog({ workItems: rows, total: 2, nextOffset: null }))

    await waitFor(() => expect((currentState as { todoQuickRecoveries: unknown[] }).todoQuickRecoveries).toHaveLength(1))
    expect(scroller.scrollTop).toBe(0)
  })

  it("retires a completed quick recovery epoch and creates a fresh epoch for a later session", async () => {
    const ref = todoPrivateRef(PRIVATE_ID)
    const oldEpoch = "qe_11111111111111111111111111111111"
    sessionStorage.setItem("jinn:todo-quick-edit:v1", JSON.stringify({
      [ref]: {
        expiresAt: Date.now() + 60_000,
        desired: { title: "Recovered once" },
        baseline: { title: compact.title },
        active: {
          request: {
            patch: { title: "Recovered once" },
            expectedVersion: 7,
            idempotencyKey: "07ec3351-0b99-4206-ad5f-1ed9cb6854a5",
          },
          state: "uncertain",
        },
      },
    }))
    updateWorkItem
      .mockResolvedValueOnce({ workItem: { ...detail.workItem, version: 8, title: "Recovered once" }, replayed: true })
      .mockRejectedValueOnce(new TypeError("new session offline"))
    renderPage([{ pathname: "/todos", state: {
      todoQuickRecoveries: [{ ref, anchorRef: ref, anchorOffset: 0, scroll: 0, pageDepth: { backlog: 1 } }],
      todoQuickRecoveryEpoch: oldEpoch,
    } }])
    await waitFor(() => expect((currentState as { todoQuickRecoveries?: unknown[] } | null)?.todoQuickRecoveries).toBeUndefined())
    expect((currentState as { todoQuickRecoveryEpoch?: string } | null)?.todoQuickRecoveryEpoch).toBeUndefined()

    const opener = await screen.findByRole("button", { name: "Open Recovered once" })
    fireEvent.keyDown(opener, { key: "F2" })
    fireEvent.change(screen.getByTestId("todo-rename"), { target: { value: "Later offline edit" } })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })
    await waitFor(() => expect((currentState as { todoQuickRecoveryEpoch?: string }).todoQuickRecoveryEpoch).toMatch(/^qe_[a-f0-9]{32}$/))
    expect((currentState as { todoQuickRecoveryEpoch?: string }).todoQuickRecoveryEpoch).not.toBe(oldEpoch)
  })

  it("drops malformed quick history metadata instead of retaining raw identifiers or diagnostics", async () => {
    renderPage([{
      pathname: "/todos",
      state: {
        todoQuickRecoveries: [{
          ref: PRIVATE_ID,
          anchorRef: PRIVATE_ID,
          anchorOffset: 0,
          scroll: 0,
          pageDepth: { backlog: 1 },
          diagnostic: "/private/path",
        }],
      },
    }])
    await waitFor(() => expect(currentState).toBeNull())
    expect(JSON.stringify(currentState)).not.toContain(PRIVATE_ID)
  })

  it("removes only the failed row's optimistic rank instead of leaving a false saved order", async () => {
    const rows = [0, 1, 2].map((rank): WorkItemCompactWire => ({
      ...compact,
      id: `wi_rank_${rank}`,
      title: `Rank todo ${rank + 1}`,
      rank: rank * 1024,
    }))
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      return Promise.resolve({ workItems: params?.status === "backlog" ? rows : [], total: params?.status === "backlog" ? 3 : 0, nextOffset: null })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({
      ...detail,
      workItem: { ...detail.workItem, id, title: rows.find((row) => row.id === id)?.title ?? "Todo", rank: rows.find((row) => row.id === id)?.rank ?? null },
    }))
    let rejectUpdate!: (error: unknown) => void
    updateWorkItem.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
    renderPage()
    const third = await screen.findByRole("button", { name: "Open Rank todo 3" })
    const row = third.closest('[data-testid="todo-row"]')!
    fireEvent.pointerDown(row.querySelector('button[aria-label="Todo actions"]')!, { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    const second = screen.getByRole("button", { name: "Open Rank todo 2" })
    expect(third.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    rejectUpdate(new TodoApiError(428, "raw precondition", "TODO_PRECONDITION_REQUIRED"))
    await waitFor(() => expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy())
    expect(screen.getByTestId("todos-edit-error").textContent).not.toContain("raw precondition")
  })

  it("does not let a later row reset erase another row's newer pending reorder", async () => {
    const rows = [0, 1, 2, 3].map((rank): WorkItemCompactWire => ({
      ...compact,
      id: `wi_rank_queue_${rank}`,
      title: `Queued rank ${rank + 1}`,
      rank: rank * 1024,
    }))
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      return Promise.resolve({ workItems: params?.status === "backlog" ? rows : [], total: params?.status === "backlog" ? 4 : 0, nextOffset: null })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({
      ...detail,
      workItem: { ...detail.workItem, ...rows.find((row) => row.id === id), version: 7 },
    }))
    let resolvePending!: (value: unknown) => void
    updateWorkItem
      .mockRejectedValueOnce(new TodoApiError(428, "first reset", "TODO_PRECONDITION_REQUIRED"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePending = resolve }))
      .mockRejectedValueOnce(new TodoApiError(428, "other reset", "TODO_PRECONDITION_REQUIRED"))
    renderPage()
    const fourth = await screen.findByRole("button", { name: "Open Queued rank 4" })
    const third = screen.getByRole("button", { name: "Open Queued rank 3" })
    const actionsFor = (button: HTMLElement) => button.closest('[data-testid="todo-row"]')!
      .querySelector('button[aria-label="Todo actions"]')!

    fireEvent.pointerDown(actionsFor(fourth), { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(third.compareDocumentPosition(fourth) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy())

    fireEvent.pointerDown(actionsFor(fourth), { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(2))
    expect(fourth.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const first = screen.getByRole("button", { name: "Open Queued rank 1" })
    fireEvent.pointerDown(actionsFor(first), { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(3))
    expect(fourth.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const pendingRequest = updateWorkItem.mock.calls[1][1]
    resolvePending({
      workItem: { ...detail.workItem, ...rows[3], version: 8, rank: pendingRequest.patch.rank },
      replayed: false,
    })
    await waitFor(() => expect(sessionStorage.getItem("jinn:todo-quick-edit:v1")).toBeNull())
  })

  it("restores the nested ledger scroll after detail Back and Forward", async () => {
    const mounted = renderPage()
    const opener = await screen.findByRole("button", { name: "Open Recoverable todo" })
    const ledgerScroll = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(ledgerScroll, "scrollTop", { configurable: true, writable: true, value: 417 })

    fireEvent.click(opener)
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(currentState).toMatchObject({ todoScroll: 417 })

    ledgerScroll.scrollTop = 0
    act(() => navigate(-1))
    await waitFor(() => expect(screen.queryByTestId("detail-sheet")).toBeNull())
    await waitFor(() => expect(ledgerScroll.scrollTop).toBe(417))

    act(() => navigate(1))
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(ledgerScroll.scrollTop).toBe(417)

    const reloadState = currentState
    mounted.unmount()
    renderPage([{ pathname: "/todos", state: reloadState }])
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("todo-ledger-scroll").scrollTop).toBe(417))
  })

  it("reloads enough pages to resolve and restore a second-page detail anchor", async () => {
    const rows = Array.from({ length: 29 }, (_, index): WorkItemCompactWire => ({
      ...compact,
      id: `wi_page_${index + 1}`,
      title: `Paged todo ${index + 1}`,
    }))
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string; offset?: number; limit?: number }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status !== "backlog") return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      const offset = params.offset ?? 0
      const page = rows.slice(offset, offset + 20)
      return Promise.resolve({ workItems: page, total: rows.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null })
    })
    getWorkItem.mockImplementation((id: string) => Promise.resolve({
      ...detail,
      workItem: { ...detail.workItem, ...rows.find((row) => row.id === id), body: null, priority: 0 },
    }))
    const mounted = renderPage()
    await screen.findByRole("button", { name: "Open Paged todo 20" })
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more" }))
    const opener = await screen.findByRole("button", { name: "Open Paged todo 29" })
    const ledgerScroll = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(ledgerScroll, "scrollTop", { configurable: true, writable: true, value: 1279 })
    fireEvent.click(opener)
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(currentState).toMatchObject({
      todoAnchorRef: expect.stringMatching(/^td_/),
      todoAnchorOffset: expect.any(Number),
      todoPageDepth: { backlog: 2 },
    })

    const reloadState = currentState
    mounted.unmount()
    listWorkItems.mockClear()
    renderPage([{ pathname: "/todos", state: reloadState }])

    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 }))
    expect(currentState).toEqual(reloadState)
  })

  it("falls back to the clamped numeric scroll when a restored second-page anchor left the filter", async () => {
    const backlogRows = Array.from({ length: 29 }, (_, index): WorkItemCompactWire => ({
      ...compact,
      id: `wi_backlog_${index + 1}`,
      title: `Backlog todo ${index + 1}`,
    }))
    const moved = { ...compact, id: "wi_moved_anchor", title: "Moved todo", status: "executing" as const }
    let resolveSecondPage!: (value: { workItems: WorkItemCompactWire[]; total: number; nextOffset: number | null }) => void
    const secondPage = new Promise<{ workItems: WorkItemCompactWire[]; total: number; nextOffset: number | null }>((resolve) => {
      resolveSecondPage = resolve
    })
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string; offset?: number; limit?: number }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      const source = params?.status === "backlog" ? backlogRows : params?.status === "executing" ? [moved] : []
      const offset = params?.offset ?? 0
      const page = source.slice(offset, offset + 20)
      if (params?.status === "backlog" && offset === 20) return secondPage
      return Promise.resolve({ workItems: page, total: source.length, nextOffset: offset + page.length < source.length ? offset + page.length : null })
    })
    getWorkItem.mockResolvedValue({ ...detail, workItem: { ...detail.workItem, ...moved } })
    const ref = todoPrivateRef(moved.id)

    renderPage([{
      pathname: "/todos",
      search: "?status=backlog",
      state: {
        todoRef: ref,
        todoScroll: 702,
        todoAnchorRef: ref,
        todoAnchorOffset: 24,
        todoPageDepth: { backlog: 2 },
      },
    }])
    const ledgerScroll = screen.getByTestId("todo-ledger-scroll")
    Object.defineProperty(ledgerScroll, "scrollHeight", { configurable: true, value: 1800 })
    Object.defineProperty(ledgerScroll, "clientHeight", { configurable: true, value: 844 })
    Object.defineProperty(ledgerScroll, "scrollTop", { configurable: true, writable: true, value: 0 })

    await waitFor(() => expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 })))
    expect(ledgerScroll.querySelector(`[data-todo-anchor="${ref}"]`)).toBeNull()
    expect(ledgerScroll.scrollTop).toBe(0)
    await act(async () => resolveSecondPage({ workItems: backlogRows.slice(20), total: backlogRows.length, nextOffset: null }))
    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    await waitFor(() => expect(ledgerScroll.scrollTop).toBe(702))
    expect(currentState).toMatchObject({ todoRef: ref, todoScroll: 702, todoPageDepth: { backlog: 2 } })
  })

  it("offers explicit cleanup when a recovered Todo no longer exists", async () => {
    const ref = todoPrivateRef(PRIVATE_ID)
    persistTodoJournal(PRIVATE_ID, {
      revision: 1,
      patch: { title: "Unreachable recovered title" },
      baseline: { title: compact.title },
      baselineVersion: compact.updatedAt,
    })
    listWorkItems.mockResolvedValue({ workItems: [], total: 0, nextOffset: null })

    renderPage([{ pathname: "/todos", state: { todoRef: ref, todoScroll: 20 } }])

    expect(await screen.findByRole("dialog", { name: "Todo no longer exists" })).toBeTruthy()
    expect(sessionStorage.getItem("jinn:todo-draft-journal:v2")).toContain("Unreachable recovered title")
    fireEvent.click(screen.getByRole("button", { name: "Discard recovered draft" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Todo no longer exists" })).toBeNull())
    expect(JSON.stringify(currentState)).not.toContain(ref)
    expect(sessionStorage.getItem("jinn:todo-draft-journal:v2")).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Todos" })))
    expect(document.activeElement).not.toBe(document.body)
  })

  it("pushes filter history so Back and Forward restore the exact filter state", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    renderPage()
    await screen.findByRole("button", { name: "Open Recoverable todo" })

    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    fireEvent.click(screen.getByRole("button", { name: "Status" }))
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked"))

    act(() => navigate(-1))
    await waitFor(() => expect(currentSearch).toBe(""))
    act(() => navigate(1))
    await waitFor(() => expect(currentSearch).toBe("?status=blocked"))
  })
})
