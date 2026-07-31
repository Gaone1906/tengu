import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }],
      }),
      getOrg: vi.fn().mockResolvedValue({
        departments: ["platform"],
        employees: [{ name: "builder", displayName: "Builder", department: "platform", rank: "senior" }],
      }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: "builder",
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
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: status === "blocked",
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank: null,
  }
}

function tree(item: WorkItemCompactWire): WorkItemTreeWire {
  return {
    root: {
      ...item,
      rank: item.rank ?? null,
      body: null,
      priority: 2,
      acceptance: null,
      verifyPolicy: null,
      rounds: 0,
      budgetUsd: null,
      approvalDecidedBy: null,
      approvalDecidedAt: null,
      createdAt: item.updatedAt,
      closedAt: null,
      children: [],
    },
    totals: { [item.status]: 1 },
    spendUsd: 0,
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function response(params: { status?: WorkItemStatusWire; needsAttentionFor?: string }): WorkItemListWire {
  if (params.needsAttentionFor) return { workItems: [], total: 0, nextOffset: null }
  const items = rows[params.status!] ?? []
  return { workItems: items, total: items.length, nextOffset: null, totals: { [params.status!]: items.length } }
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location-probe">{location.pathname}</span>
}

function DetailProbe() {
  const navigate = useNavigate()
  return <button type="button" data-testid="detail-back" onClick={() => navigate(-1)}>Back</button>
}

function renderTodos(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<><TodoBoardPage /><LocationProbe /></>} />
          <Route path="/todos/:todoId" element={<DetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  rows = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(response(params)),
  )
  getWorkItemTrees.mockImplementation((ids: string[]) => {
    const items = Object.values(rows).flat().filter((item): item is WorkItemCompactWire => !!item)
    return Promise.resolve({
      trees: Object.fromEntries(ids.map((id) => {
        const found = items.find((item) => item.id === id)!
        return [id, tree(found)]
      })),
    })
  })
})

describe("the list-first Todos surface", () => {
  it("shows the grouped list by default and keeps Closed collapsed", async () => {
    rows.executing = [compact("PLA-1", "executing")]
    rows.done = [compact("PLA-2", "done")]
    renderTodos("/todos/b/platform")

    await screen.findByTestId("todo-list-row-PLA-1")
    expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(false)
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(true)
    expect(screen.getByTestId("todo-list-group-needs-you")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-executing")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-in-review")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-assigned")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-backlog")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-closed")).toBeTruthy()
    expect(screen.queryByTestId("todo-list-row-PLA-2")).toBeNull()
  })

  it("switches without changing the route and reuses the stored Board choice on another board", async () => {
    const first = renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-group-backlog")
    fireEvent.click(screen.getByTestId("todos-view-board"))

    expect(screen.getByTestId("location-probe").textContent).toBe("/todos/b/platform")
    expect(localStorage.getItem("jinn-todos-view")).toBe("board")
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(false)

    first.unmount()
    renderTodos("/todos/b/everything")
    await waitFor(() => expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(false))
    expect((screen.getByTestId("todos-view-board") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true")
  })

  it("returns from a row to the list at its previous scroll position", async () => {
    rows.backlog = [compact("PLA-3", "backlog")]
    renderTodos("/todos/b/platform")
    const row = await screen.findByTestId("todo-list-row-PLA-3")
    const scroll = screen.getByTestId("todo-list-scroll") as HTMLDivElement
    scroll.scrollTop = 320
    fireEvent.scroll(scroll)
    fireEvent.click(row)
    await screen.findByTestId("detail-back")
    fireEvent.click(screen.getByTestId("detail-back"))
    await waitFor(() => expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).scrollTop).toBe(320))
  })

  it("loads the next page through the status column's existing loadMore", async () => {
    const first = compact("PLA-4", "backlog")
    const second = compact("PLA-5", "backlog")
    listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string; offset?: number }) => {
      if (params.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params.status !== "backlog") return Promise.resolve(response(params))
      return Promise.resolve(params.offset
        ? { workItems: [second], total: 2, nextOffset: null }
        : { workItems: [first], total: 2, nextOffset: 1 })
    })
    rows.backlog = [first, second]
    renderTodos("/todos/b/platform")

    await screen.findByTestId("todo-list-row-PLA-4")
    fireEvent.click(screen.getByTestId("todo-list-show-more-backlog"))
    await screen.findByTestId("todo-list-row-PLA-5")
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 1 }))
  })
})
