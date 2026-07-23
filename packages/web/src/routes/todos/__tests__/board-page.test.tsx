import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { boardScopeParams } from "../board/use-board"
import { clearBoardScrollCache } from "../board/board-route"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const getWorkItemTree = vi.fn()
const getWorkItem = vi.fn()
const getDepartments = vi.fn()
const getOrg = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()
const createWorkItem = vi.fn()
const assignWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
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
  return <span data-testid="location">{location.pathname}</span>
}

function renderBoard(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  rows = {}
  totals = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
  getWorkItemTree.mockImplementation((id: string) => Promise.resolve({ tree: emptyTree(id) }))
  getWorkItem.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
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
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/todos/PLA-1"))
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
  })

  it("shows the approval bell in accent when an approval is pending", async () => {
    rows.in_review = [compact({ id: "PLA-5", status: "in_review", approvalState: "pending" })]
    renderBoard("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-5")
    expect(card.textContent).toContain("Approval")
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
    getWorkItemTree.mockImplementation((id: string) =>
      Promise.resolve({ tree: id === "PLA-6" ? tree : emptyTree(id) }),
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
    getWorkItemTree.mockImplementation((id: string) =>
      Promise.resolve({ tree: id === "PLA-6" ? tree : emptyTree(id) }),
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
    getWorkItem.mockImplementation((id: string) =>
      Promise.resolve({
        workItem: { ...emptyTree(id, "blocked").root },
        spendUsd: 0,
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
