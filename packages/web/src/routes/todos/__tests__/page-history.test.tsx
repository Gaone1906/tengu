import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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

describe("Todo detail navigation and draft recovery", () => {
  beforeEach(() => {
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
    updateWorkItem.mockReset().mockResolvedValue(detail)
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
    fireEvent.pointerDown(row.querySelector('button[aria-label="Todo actions"]')!, { pointerType: "mouse", button: 0 })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(currentState).toMatchObject({ todoQuickRef: expect.stringMatching(/^td_/), todoPageDepth: { backlog: 2 } }))
    expect(JSON.stringify(currentState)).not.toContain(rows[28].id)

    const reloadState = currentState
    const original = updateWorkItem.mock.calls[0][1]
    mounted.unmount()
    listWorkItems.mockClear()
    renderPage([{ pathname: "/todos", state: reloadState }])
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledTimes(2))
    expect(updateWorkItem.mock.calls[1][1]).toEqual(original)
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 }))
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
