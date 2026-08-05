import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"
import TodoBoardPage from "../board/board-page"
import { boardColumnQueryKey, boardScopeParams } from "../board/use-board"
import { clearBoardScrollCache } from "../board/board-route"
import { useSetWorkItemStatus } from "../use-todos"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
const avatarRender = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => {
    avatarRender(name)
    return <span data-testid={`avatar-${name}`} />
  },
}))

const listWorkItems = vi.fn()
const getWorkItemTree = vi.fn()
const getWorkItemTrees = vi.fn()
const getWorkItem = vi.fn()
const getWorkItems = vi.fn()
const getDepartments = vi.fn()
const getOrg = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()
const createWorkItem = vi.fn()
const assignWorkItem = vi.fn()
let gatewayListener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connectionSeq: 1,
    subscribe: (next: (event: string, payload: unknown) => void) => {
      const typedNext = next as unknown as GatewayEventListener
      gatewayListener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
      return () => { gatewayListener = undefined }
    },
  }),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
      getDepartments: (...args: unknown[]) => getDepartments(...args),
      getOrg: (...args: unknown[]) => getOrg(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

function compact(partial: Partial<WorkItemCompactWire> & { id: string; status: WorkItemStatusWire }): WorkItemCompactWire {
  return {
    version: 3,
    title: `Item ${partial.id}`,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    createdBy: "operator",
    parentId: null,
    rootId: partial.id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z",
    rank: null,
    ...partial,
  }
}

/** Per-status fixture store the list mock serves from. */
let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}
let totals: Partial<Record<WorkItemStatusWire, number>> = {}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const status = params.status!
  const items = rows[status] ?? []
  return {
    workItems: items,
    total: totals[status] ?? items.length,
    totals: { [status]: totals[status] ?? items.length },
    nextOffset: null,
  }
}

function emptyTree(id: string, status: WorkItemStatusWire = "backlog", priority = 2): WorkItemTreeWire {
  return {
    root: {
      id,
      version: 3,
      title: `Item ${id}`,
      body: null,
      status,
      department: "platform",
      assignee: null,
      priority,
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
      createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z",
      closedAt: null,
      children: [],
    },
    totals: { [status]: 1 },
    spendUsd: 0,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location" data-state={JSON.stringify(location.state ?? {})}>{location.pathname}</span>
}

function LiveInvalidation() {
  useQueryInvalidation()
  return null
}

function BoardNavigationProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" data-testid="open-unloaded-todo" onClick={() => navigate("/todos/PLA-99", { state: { fromBoard: "my" } })}>
        Open unloaded Todo
      </button>
      <TodoBoardPage />
    </>
  )
}

function DetailNavigationProbe() {
  const { todoId } = useParams()
  const navigate = useNavigate()
  const setStatus = useSetWorkItemStatus()
  return (
    <>
      <button
        type="button"
        data-testid="detail-change-status"
        onClick={() => setStatus.mutate({ id: todoId!, status: "in_review" })}
      >
        Change status
      </button>
      <button type="button" data-testid="detail-browser-back" onClick={() => navigate(-1)}>Back</button>
      <button type="button" data-testid="detail-my-requests" onClick={() => navigate("/todos/b/my")}>My Requests</button>
    </>
  )
}

function renderBoardNavigation() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false },
      mutations: { retry: false },
    },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/my"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<BoardNavigationProbe />} />
          <Route path="/todos/:todoId" element={<DetailNavigationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

function boardStatusRequestCount(): number {
  return listWorkItems.mock.calls.filter(([params]) => params?.status).length
}

function expectColumnCountMatchesCards(status: WorkItemStatusWire): void {
  const column = screen.getByTestId(`board-column-${status}`)
  const count = Number(column.getAttribute("aria-label")?.match(/, (\d+) items$/)?.[1])
  expect(column.querySelectorAll("[data-board-card]")).toHaveLength(count)
}

function renderBoard(path: string, live = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      {live && <LiveInvalidation />}
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  rows = {}
  totals = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
  getWorkItemTree.mockImplementation((id: string) => Promise.resolve({ tree: emptyTree(id) }))
  getWorkItemTrees.mockImplementation((ids: string[]) =>
    Promise.resolve({ trees: Object.fromEntries(ids.map((id) => [id, emptyTree(id)])) }),
  )
  getWorkItem.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
  getWorkItems.mockResolvedValue({ workItems: [] })
  getDepartments.mockResolvedValue({ departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 3 }] })
  getOrg.mockResolvedValue({ departments: ["platform"], employees: [{ name: "scout", displayName: "Scout", department: "platform", rank: "senior" }] })
})

describe("boardScopeParams — the board data wiring", () => {
  it("My requests = createdBy operator + roots only", () => {
    expect(boardScopeParams({ kind: "my" })).toEqual({ createdBy: "operator", rootsOnly: true })
  })
  it("a department board = department scope + roots only", () => {
    expect(boardScopeParams({ kind: "department", slug: "platform" })).toEqual({ department: "platform", rootsOnly: true })
  })
  it("Everything = roots only, no board-scope filter", () => {
    expect(boardScopeParams({ kind: "everything" })).toEqual({ rootsOnly: true })
  })
})

describe("the board surface", () => {
  it.each([
    ["browser Back", "detail-browser-back"],
    ["My Requests link", "detail-my-requests"],
  ])("resyncs invalidated columns after a detail status write via %s, but skips a fresh no-write return", async (_label, returnControl) => {
    const todo = compact({ id: "PLA-1", status: "backlog", version: 4 })
    rows.backlog = [todo]
    totals.backlog = 1
    setWorkItemStatus.mockImplementation(async () => {
      rows.backlog = []
      rows.in_review = [{ ...todo, status: "in_review", version: 5 }]
      totals.backlog = 0
      totals.in_review = 1
      return undefined
    })
    const { client } = renderBoardNavigation()

    fireEvent.click(await screen.findByTestId("board-card-PLA-1"))
    await screen.findByTestId("detail-change-status")
    fireEvent.click(screen.getByTestId("detail-change-status"))
    await waitFor(() => {
      const key = boardColumnQueryKey({ kind: "my" }, "backlog", { status: "open" })
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    })
    expect(boardStatusRequestCount()).toBe(8)

    fireEvent.click(screen.getByTestId(returnControl))
    expect(screen.queryByTestId("board-skeleton")).toBeNull()
    await waitFor(() => expect(boardStatusRequestCount()).toBe(16))
    const moved = screen.getByTestId("board-card-PLA-1")
    expect(screen.getByTestId("board-column-backlog").contains(moved)).toBe(false)
    expect(screen.getByTestId("board-column-in_review").contains(moved)).toBe(true)
    expectColumnCountMatchesCards("backlog")
    expectColumnCountMatchesCards("in_review")

    fireEvent.click(moved)
    await screen.findByTestId("detail-browser-back")
    listWorkItems.mockClear()
    fireEvent.click(screen.getByTestId(returnControl))
    await screen.findByTestId("board-card-PLA-1")
    expect(boardStatusRequestCount()).toBe(0)
  })

  it("recovers a changed Todo that was outside every cached board page without flashing cached content", async () => {
    const cached = compact({ id: "PLA-1", status: "backlog" })
    const outsidePage = compact({ id: "PLA-99", status: "backlog", version: 4 })
    rows.backlog = [cached]
    totals.backlog = 2
    setWorkItemStatus.mockImplementation(async () => {
      rows.in_review = [{ ...outsidePage, status: "in_review", version: 5 }]
      totals.backlog = 1
      totals.in_review = 1
      return undefined
    })
    const { client } = renderBoardNavigation()

    await screen.findByTestId("board-card-PLA-1")
    fireEvent.click(screen.getByTestId("open-unloaded-todo"))
    fireEvent.click(await screen.findByTestId("detail-change-status"))
    await waitFor(() => {
      const key = boardColumnQueryKey({ kind: "my" }, "backlog", { status: "open" })
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    })

    const pending: Array<{ status: WorkItemStatusWire | undefined; release: () => void }> = []
    listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => new Promise((resolve) => {
      pending.push({ status: params.status, release: () => resolve(listResponse(params)) })
    }))
    fireEvent.click(screen.getByTestId("detail-browser-back"))

    expect(screen.getByTestId("board-card-PLA-1")).toBeTruthy()
    expect(screen.queryByTestId("board-card-PLA-99")).toBeNull()
    expect(screen.queryByTestId("board-skeleton")).toBeNull()
    expect(screen.queryByTestId("board-filtered-empty")).toBeNull()
    await waitFor(() => expect(pending.filter(({ status }) => status)).toHaveLength(8))
    await act(async () => pending.splice(0).forEach(({ release }) => release()))

    const moved = await screen.findByTestId("board-card-PLA-99")
    expect(screen.getByTestId("board-column-backlog").contains(moved)).toBe(false)
    expect(screen.getByTestId("board-column-in_review").contains(moved)).toBe(true)
    expectColumnCountMatchesCards("backlog")
    expectColumnCountMatchesCards("in_review")
  })

  it("loads enrichment for 60 cards in at most two batch requests", async () => {
    rows.executing = Array.from({ length: 20 }, (_, index) =>
      compact({ id: `PLA-${index + 1}`, status: "executing" }),
    )
    rows.blocked = Array.from({ length: 20 }, (_, index) =>
      compact({ id: `PLA-${index + 21}`, status: "blocked" }),
    )
    rows.escalated = Array.from({ length: 20 }, (_, index) =>
      compact({ id: `PLA-${index + 41}`, status: "escalated" }),
    )

    renderBoard("/todos/b/platform")

    await waitFor(() => expect(screen.getByTestId("board-card-PLA-60")).toBeTruthy())
    await waitFor(() => {
      const enrichmentRequests =
        getWorkItemTrees.mock.calls.length
        + getWorkItems.mock.calls.length
        + getWorkItemTree.mock.calls.length
        + getWorkItem.mock.calls.length
      expect(enrichmentRequests).toBeLessThanOrEqual(2)
    })
    expect(getWorkItemTrees).toHaveBeenCalledTimes(1)
    expect(getWorkItems).toHaveBeenCalledTimes(1)
    expect(getWorkItemTree).not.toHaveBeenCalled()
    expect(getWorkItem).not.toHaveBeenCalled()
  })

  it("renders the four pipeline columns always, exception columns only when non-empty", async () => {
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-card-PLA-1")).toBeTruthy())
    for (const status of ["backlog", "assigned", "executing", "in_review"]) {
      expect(screen.getByTestId(`board-column-${status}`)).toBeTruthy()
    }
    expect(screen.queryByTestId("board-column-blocked")).toBeNull()
    expect(screen.queryByTestId("board-column-escalated")).toBeNull()
  })

  it("materializes the Blocked column when non-empty and shows the true count", async () => {
    rows.blocked = [compact({ id: "PLA-9", status: "blocked" })]
    totals.blocked = 7
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-column-blocked")).toBeTruthy())
    expect(screen.getByTestId("board-column-blocked").textContent).toContain("7")
  })

  it("queries with the department scope + rootsOnly on a department board", async () => {
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    const statusCalls = listWorkItems.mock.calls.map(([params]) => params).filter((p) => p?.status)
    expect(statusCalls.length).toBeGreaterThan(0)
    for (const params of statusCalls) {
      expect(params.department).toBe("platform")
      expect(params.rootsOnly).toBe(true)
    }
  })

  it("passes the label filter to the wire and applies the due window client-side (review F1)", async () => {
    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString()
    rows.backlog = [
      compact({ id: "PLA-1", status: "backlog", dueAt: soon }),
      compact({ id: "PLA-2", status: "backlog", dueAt: null }),
    ]
    totals.backlog = 2
    renderBoard("/todos/b/platform?label=infra&due=week")
    await waitFor(() => expect(screen.getByTestId("board-card-PLA-1")).toBeTruthy())
    // Label rides the server query (the gateway owns it)…
    const statusCalls = listWorkItems.mock.calls.map(([params]) => params).filter((p) => p?.status)
    for (const params of statusCalls) expect(params.label).toBe("infra")
    // …the due window filters the loaded columns, and the column count
    // follows what's visible, not the server total.
    expect(screen.queryByTestId("board-card-PLA-2")).toBeNull()
    expect(screen.getByTestId("board-column-backlog").textContent).toContain("1")
  })

  it("queries with createdBy=operator on My requests", async () => {
    renderBoard("/todos/b/my")
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    const statusCalls = listWorkItems.mock.calls.map(([params]) => params).filter((p) => p?.status)
    for (const params of statusCalls) {
      expect(params.createdBy).toBe("operator")
      expect(params.rootsOnly).toBe(true)
    }
  })

  it("folds Done and Cancelled into the Closed rail with the combined true count", async () => {
    rows.done = [compact({ id: "PLA-2", status: "done" })]
    totals.done = 12
    totals.cancelled = 2
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-closed-rail").textContent).toContain("14"))
    expect(screen.queryByTestId("board-column-done")).toBeNull()
    // Expanding shows the Done group.
    fireEvent.click(screen.getByTestId("board-closed-rail"))
    await waitFor(() => expect(screen.getByTestId("board-closed-column")).toBeTruthy())
    expect(screen.getByTestId("board-closed-group-done").textContent).toContain("12")
  })

  it("shows the department prefix and open count in the sub-line", async () => {
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    totals.backlog = 4
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByText("PLA")).toBeTruthy())
    expect(screen.getByText("4 open")).toBeTruthy()
  })

  it("opens a card by navigating to its todo route (the board records scroll for POP return)", async () => {
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    renderBoard("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-1")
    fireEvent.click(card)
    const location = await screen.findByTestId("location")
    expect(location.textContent).toBe("/todos/PLA-1")
    expect(JSON.parse(location.dataset.state!)).toMatchObject({ bannerExpected: false })
  })

  it("tells the task route when a card will render a banner", async () => {
    rows.blocked = [compact({ id: "PLA-9", status: "blocked" })]
    renderBoard("/todos/b/platform")
    fireEvent.click(await screen.findByTestId("board-card-PLA-9"))

    const location = await screen.findByTestId("location")
    expect(JSON.parse(location.dataset.state!)).toMatchObject({ bannerExpected: true })
  })

  it("re-renders only the card whose board row changed", async () => {
    rows.backlog = [
      compact({ id: "PLA-1", status: "backlog", assignee: "scout" }),
      compact({ id: "PLA-2", status: "backlog", assignee: "scout" }),
    ]
    const { client } = renderBoard("/todos/b/platform")
    await screen.findByTestId("board-card-PLA-2")
    await waitFor(() => expect(getWorkItemTrees).toHaveBeenCalledTimes(1))
    avatarRender.mockClear()

    const key = boardColumnQueryKey(
      { kind: "department", slug: "platform" },
      "backlog",
      { status: "open" },
    )
    act(() => {
      client.setQueryData(key, (previous: {
        pages: Array<{ workItems: WorkItemCompactWire[] }>
        pageParams: number[]
      } | undefined) => {
        if (!previous) throw new Error("missing backlog query fixture")
        return {
          ...previous,
          pages: previous.pages.map((page, pageIndex) => pageIndex === 0
            ? {
                ...page,
                workItems: page.workItems.map((item) =>
                  item.id === "PLA-1" ? { ...item, title: "Changed title" } : item,
                ),
              }
            : page),
        }
      })
    })

    await waitFor(() => expect(screen.getByTestId("board-card-PLA-1").textContent).toContain("Changed title"))
    expect(avatarRender).toHaveBeenCalledTimes(1)
    expect(avatarRender).toHaveBeenCalledWith("scout")
  })

  it("relocates a live Todo payload once and updates both column counts before refetch", async () => {
    rows.executing = [compact({ id: "PLA-3", status: "executing", version: 4 })]
    totals.executing = 1
    totals.in_review = 0
    renderBoard("/todos/b/platform", true)

    await screen.findByTestId("board-card-PLA-3")
    await waitFor(() => {
      const boardCalls = listWorkItems.mock.calls.filter(([params]) => params?.status)
      expect(boardCalls).toHaveLength(8)
    })
    listWorkItems.mockImplementation(() => new Promise(() => {}))

    act(() => gatewayListener?.("company:changed", {
      entity: "todo",
      action: "status-transitioned",
      id: "PLA-3",
      version: 5,
      value: { id: "PLA-3", version: 5, status: "in_review" },
    }))

    await waitFor(() => {
      const cards = screen.getAllByTestId("board-card-PLA-3")
      expect(cards).toHaveLength(1)
      expect(screen.getByTestId("board-column-executing").contains(cards[0])).toBe(false)
      expect(screen.getByTestId("board-column-in_review").contains(cards[0])).toBe(true)
      expect(screen.getByTestId("board-column-executing").getAttribute("aria-label")).toBe("Executing column, 0 items")
      expect(screen.getByTestId("board-column-in_review").getAttribute("aria-label")).toBe("In review column, 1 items")
    })
  })

  it("moves a live completed Todo into Closed with updated counts before refetch", async () => {
    rows.in_review = [compact({ id: "PLA-4", status: "in_review", version: 4 })]
    totals.in_review = 1
    totals.done = 0
    renderBoard("/todos/b/platform", true)

    await screen.findByTestId("board-card-PLA-4")
    await waitFor(() => {
      const boardCalls = listWorkItems.mock.calls.filter(([params]) => params?.status)
      expect(boardCalls).toHaveLength(8)
    })
    listWorkItems.mockImplementation(() => new Promise(() => {}))

    act(() => gatewayListener?.("company:changed", {
      entity: "todo",
      action: "status-transitioned",
      id: "PLA-4",
      version: 5,
      value: { id: "PLA-4", version: 5, status: "done" },
    }))

    await waitFor(() => {
      expect(screen.queryByTestId("board-card-PLA-4")).toBeNull()
      expect(screen.getByTestId("board-column-in_review").getAttribute("aria-label")).toBe("In review column, 0 items")
      expect(screen.getByTestId("board-closed-rail").getAttribute("aria-label")).toBe("Closed, 1 items — expand")
    })

    fireEvent.click(screen.getByTestId("board-closed-rail"))

    await waitFor(() => {
      const cards = screen.getAllByTestId("board-card-PLA-4")
      expect(cards).toHaveLength(1)
      expect(screen.getByTestId("board-closed-group-done").contains(cards[0])).toBe(true)
      expect(screen.getByTestId("board-closed-group-done").textContent).toContain("Done1")
      expect(screen.getByTestId("board-closed-collapse").textContent).toContain("Closed1")
    })
  })
})

describe("card anatomy", () => {
  it("never repeats the status as text on the card — the column says it", async () => {
    rows.executing = [compact({ id: "PLA-3", status: "executing" })]
    renderBoard("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-3")
    expect(card.textContent).not.toMatch(/Executing/)
  })

  it("renders label chips and the overdue due date", async () => {
    rows.backlog = [
      compact({
        id: "PLA-4",
        status: "backlog",
        dueAt: "2026-07-01T00:00:00.000Z",
        labels: [{ id: "lbl_1", name: "infra", color: "#5B9BD5", department: null, createdAt: "2026-07-01" }],
      }),
    ]
    renderBoard("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-4")
    expect(card.textContent).toContain("infra")
    expect(card.textContent).toContain("Jul 1")
    expect((card as HTMLElement).style.contentVisibility).toBe("auto")
    expect((card as HTMLElement).style.containIntrinsicSize).toBe("auto 160px")
  })

  it("shows the approval bell in accent when an approval is pending", async () => {
    rows.in_review = [compact({ id: "PLA-5", status: "in_review", approvalState: "pending" })]
    renderBoard("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-5")
    expect(card.textContent).toContain("Approval")
  })

  it("adds a markdown-free preview line from the Todo body", async () => {
    rows.backlog = [compact({ id: "PLA-15", status: "backlog" })]
    const tree = emptyTree("PLA-15")
    tree.root.body = "## Plan\n\nShip the **quiet** card preview with `one renderer`."
    getWorkItemTrees.mockResolvedValue({ trees: { "PLA-15": tree } })
    renderBoard("/todos/b/platform")

    const card = await screen.findByTestId("board-card-PLA-15")
    expect(card.textContent).toContain("Ship the quiet card preview with one renderer.")
    expect(card.textContent).not.toContain("##")
    expect(card.textContent).not.toContain("**")
    expect(card.textContent).not.toContain("`")
  })

  it("FLIPs cards below an item when delayed enrichment grows its card", async () => {
    rows.backlog = [
      compact({ id: "PLA-15", status: "backlog" }),
      compact({ id: "PLA-16", status: "backlog" }),
    ]
    let release!: () => void
    let enriched = false
    getWorkItemTrees.mockImplementation(
      (ids: string[]) =>
        new Promise((resolve) => {
          release = () => {
            const trees = Object.fromEntries(ids.map((id) => {
              const tree = emptyTree(id)
              if (id === "PLA-15") tree.root.body = "Delayed body preview"
              return [id, tree]
            }))
            resolve({ trees })
          }
        }),
    )
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.boardCard
      const top = id === "PLA-16" ? (enriched ? 112 : 80) : 0
      return {
        x: 0, y: top, left: 0, top, right: 240, bottom: top + 72, width: 240, height: 72,
        toJSON: () => ({}),
      } as DOMRect
    })
    const animate = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    })

    renderBoard("/todos/b/platform")
    const lowerCard = await screen.findByTestId("board-card-PLA-16")
    await waitFor(() => expect(release).toBeTypeOf("function"))
    enriched = true
    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.getByTestId("board-card-PLA-15").textContent).toContain("Delayed body preview"))
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateY(-32px)" }, { transform: "translateY(0)" }],
      { duration: 200, easing: "cubic-bezier(.34,1.3,.64,1)" },
    )
    expect(animate.mock.instances).toContain(lowerCard)

    rect.mockRestore()
    delete (HTMLElement.prototype as { animate?: unknown }).animate
  })

  it("renders the roll-up pill from the tree and expands the in-place tray", async () => {
    rows.executing = [compact({ id: "PLA-6", status: "executing" })]
    const tree = emptyTree("PLA-6", "executing")
    tree.root.children = [
      { ...emptyTree("PLA-7", "done").root, children: [] },
      {
        ...emptyTree("PLA-8", "executing").root,
        children: [{ ...emptyTree("PLA-10", "backlog").root, children: [] }],
      },
    ]
    tree.totals = { executing: 2, done: 1, backlog: 1 }
    getWorkItemTrees.mockImplementation((ids: string[]) =>
      Promise.resolve({
        trees: Object.fromEntries(ids.map((id) => [id, id === "PLA-6" ? tree : emptyTree(id)])),
      }),
    )
    renderBoard("/todos/b/platform")
    const pill = await screen.findByTestId("board-rollup-PLA-6")
    expect(pill.textContent).toContain("1/3")
    fireEvent.click(pill)
    await waitFor(() => expect(screen.getByTestId("board-card-tree")).toBeTruthy())
    expect(screen.getByTestId("tree-row-PLA-7")).toBeTruthy()
    // Depth-2 children indent under their parent row.
    expect((screen.getByTestId("tree-row-PLA-10") as HTMLElement).style.marginLeft).toBe("22px")
    expect(screen.getByTestId("tree-add-subtask")).toBeTruthy()
  })

  it("adds a sub-task through the tray quick add", async () => {
    rows.executing = [compact({ id: "PLA-6", status: "executing" })]
    const tree = emptyTree("PLA-6", "executing")
    tree.root.children = [{ ...emptyTree("PLA-7", "backlog").root, children: [] }]
    tree.totals = { executing: 1, backlog: 1 }
    getWorkItemTrees.mockImplementation((ids: string[]) =>
      Promise.resolve({
        trees: Object.fromEntries(ids.map((id) => [id, id === "PLA-6" ? tree : emptyTree(id)])),
      }),
    )
    createWorkItem.mockResolvedValue({ workItem: emptyTree("PLA-11").root })
    renderBoard("/todos/b/platform")
    fireEvent.click(await screen.findByTestId("board-rollup-PLA-6"))
    fireEvent.click(await screen.findByTestId("tree-add-subtask"))
    const input = screen.getByLabelText("New sub-task title")
    fireEvent.change(input, { target: { value: "Postal-code validation" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(createWorkItem).toHaveBeenCalledWith({ title: "Postal-code validation", parentId: "PLA-6" }),
    )
  })

  it("shows the blocked reason from the latest transition note", async () => {
    rows.blocked = [compact({ id: "PLA-9", status: "blocked" })]
    getWorkItems.mockImplementation((ids: string[]) =>
      Promise.resolve({
        workItems: ids.map((id) => ({
          workItem: { ...emptyTree(id, "blocked").root },
          events: [
            {
              id: "wie_1",
              workItemId: id,
              kind: "status_change",
              fromStatus: "executing",
              toStatus: "blocked",
              actor: "operator",
              detail: { note: "Waiting on vendor keys" },
              createdAt: "2026-07-23T09:00:00.000Z",
            },
          ],
        })),
      }),
    )
    renderBoard("/todos/b/platform")
    await waitFor(() =>
      expect(screen.getByTestId("board-card-PLA-9").textContent).toContain("Waiting on vendor keys"),
    )
  })
})

describe("the switcher-in-title", () => {
  it("renders the board title as the menu trigger and lists home, attention, departments, everything", async () => {
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    renderBoard("/todos/b/platform")
    const trigger = await screen.findByTestId("board-switcher")
    expect(trigger.textContent).toContain("Platform")
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByTestId("board-menu-my")).toBeTruthy())
    expect(screen.getByTestId("board-menu-attention")).toBeTruthy()
    expect(screen.getByTestId("board-menu-platform").textContent).toContain("PLA")
    expect(screen.getByTestId("board-menu-everything")).toBeTruthy()
  })

  it("switches boards through the menu", async () => {
    renderBoard("/todos/b/platform")
    const trigger = await screen.findByTestId("board-switcher")
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    const everything = await screen.findByTestId("board-menu-everything")
    fireEvent.click(everything)
    await waitFor(() => expect(screen.getByTestId("board-switcher").textContent).toContain("Everything"))
  })
})

describe("quick add", () => {
  it("offers + on Backlog and Assigned only", async () => {
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    rows.blocked = [compact({ id: "PLA-9", status: "blocked" })]
    renderBoard("/todos/b/platform")
    await screen.findByTestId("board-card-PLA-1")
    expect(screen.getByTestId("board-quick-add-backlog")).toBeTruthy()
    expect(screen.getByTestId("board-quick-add-assigned")).toBeTruthy()
    expect(screen.queryByTestId("board-quick-add-executing")).toBeNull()
    expect(screen.queryByTestId("board-quick-add-in_review")).toBeNull()
    expect(screen.queryByTestId("board-quick-add-blocked")).toBeNull()
  })

  it("creates in the board's department and assigns for the Assigned column", async () => {
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-quick-add-assigned")).toBeTruthy())
    createWorkItem.mockResolvedValue({ workItem: { ...emptyTree("PLA-20").root } })
    assignWorkItem.mockResolvedValue({ workItem: { ...emptyTree("PLA-20").root } })
    fireEvent.click(screen.getByTestId("board-quick-add-assigned"))
    fireEvent.change(screen.getByTestId("todo-new-title"), { target: { value: "Draft the launch note" } })
    fireEvent.change(screen.getByTestId("todo-new-assignee"), { target: { value: "scout" } })
    fireEvent.click(screen.getByTestId("todo-new-create"))
    await waitFor(() =>
      expect(createWorkItem).toHaveBeenCalledWith({ title: "Draft the launch note", department: "platform" }),
    )
    await waitFor(() => expect(assignWorkItem).toHaveBeenCalledWith("PLA-20", "scout"))
  })
})

describe("the mobile board (§8 — stage C)", () => {
  /** jsdom has no matchMedia; the board's ONE mobile breakpoint is 700px. */
  function stubMobileViewport() {
    const mql = (matches: boolean) => ({
      matches,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })
    window.matchMedia = ((query: string) => mql(query === "(max-width: 700px)")) as unknown as typeof window.matchMedia
  }

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  it("the Active pill carries the filter glyph and re-tapping it opens the filter sheet (review F5)", async () => {
    stubMobileViewport()
    rows.backlog = [compact({ id: "PLA-1", status: "backlog" })]
    renderBoard("/todos/b/platform")
    const active = await screen.findByTestId("board-segment-active")
    expect(active.querySelector("svg")).toBeTruthy()
    // First tap on the already-selected pill opens the sheet.
    fireEvent.click(active)
    await waitFor(() => expect(screen.getByTestId("todo-filter-sheet")).toBeTruthy())
    // Board scoping: columns/segments own status; a department board owns its
    // department — neither dimension appears in the sheet.
    expect(screen.queryByLabelText("Status")).toBeNull()
    expect(screen.queryByLabelText("Department")).toBeNull()
    expect(screen.getByLabelText("Person")).toBeTruthy()
  })

  it("selecting another segment does NOT open the sheet; it switches the segment", async () => {
    stubMobileViewport()
    rows.done = [compact({ id: "PLA-2", status: "done" })]
    renderBoard("/todos/b/platform")
    const closed = await screen.findByTestId("board-segment-closed")
    fireEvent.click(closed)
    expect(screen.queryByTestId("todo-filter-sheet")).toBeNull()
    await waitFor(() => expect(screen.getByTestId("board-card-PLA-2")).toBeTruthy())
  })

  it("the Closed segment groups done/cancelled by DATE, not by status (§8)", async () => {
    stubMobileViewport()
    const today = new Date().toISOString()
    rows.done = [compact({ id: "PLA-2", status: "done", updatedAt: today })]
    rows.cancelled = [compact({ id: "PLA-3", status: "cancelled", updatedAt: "2026-01-01T08:00:00.000Z" })]
    renderBoard("/todos/b/platform")
    fireEvent.click(await screen.findByTestId("board-segment-closed"))
    await waitFor(() => expect(screen.getByTestId("board-closed-today")).toBeTruthy())
    expect(screen.getByTestId("board-closed-today").textContent).toContain("Today")
    expect(screen.getByTestId("board-closed-earlier").textContent).toContain("Earlier")
    // Status groups don't exist on mobile — the rows' own discs carry which.
    expect(screen.queryByTestId("board-closed-group-done")).toBeNull()
  })

  it("the Attention segment lists this board's blocked/escalated/approval items", async () => {
    stubMobileViewport()
    rows.blocked = [compact({ id: "PLA-9", status: "blocked" })]
    rows.in_review = [compact({ id: "PLA-5", status: "in_review", approvalState: "pending" })]
    renderBoard("/todos/b/platform")
    fireEvent.click(await screen.findByTestId("board-segment-attention"))
    await waitFor(() => expect(screen.getByTestId("board-card-PLA-9")).toBeTruthy())
    expect(screen.getByTestId("board-card-PLA-5")).toBeTruthy()
  })
})

describe("board states (states mock §6 — stage C)", () => {
  it("filtered-empty offers the way back: No todos match + Clear filters", async () => {
    rows = {}
    renderBoard("/todos/b/platform?assignee=scout&due=week")
    const empty = await screen.findByTestId("board-filtered-empty")
    expect(empty.textContent).toContain("No todos match.")
    expect(empty.textContent).toContain("Two filters are set on this board.")
    fireEvent.click(screen.getByTestId("board-clear-filters"))
    await waitFor(() => expect(screen.queryByTestId("board-filtered-empty")).toBeNull())
    expect(screen.getByTestId("board-column-backlog")).toBeTruthy()
  })

  it("an unfiltered empty board celebrates quietly — the columns and quick-adds ARE the empty state", async () => {
    rows = {}
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-column-backlog")).toBeTruthy())
    expect(screen.queryByTestId("board-filtered-empty")).toBeNull()
  })

  it("loading keeps exact card geometry (the skeleton board)", async () => {
    listWorkItems.mockImplementation(() => new Promise(() => {}))
    renderBoard("/todos/b/platform")
    await waitFor(() => expect(screen.getByTestId("board-skeleton")).toBeTruthy())
    expect(screen.getByTestId("board-skeleton-closed-rail")).toBeTruthy()
    expect(screen.getByTestId("board-skeleton").children).toHaveLength(6)
  })

  it("a board load failure surfaces the calm error card, not a blank surface", async () => {
    listWorkItems.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }))
    renderBoard("/todos/b/platform")
    const error = await screen.findByTestId("board-error")
    expect(error.textContent).toBeTruthy()
  })
})
