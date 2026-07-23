import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* Slice 6 — drag legality applied to the DOM (states mock specimen 4): on
 * lift, illegal target columns recede to 38% and render no slot; a drop on a
 * live column commits the transition through the operator surface. Geometry is
 * stubbed per column (jsdom has no layout). */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      getWorkItemTree: vi.fn().mockRejectedValue(new Error("no tree")),
      getWorkItem: vi.fn().mockRejectedValue(Object.assign(new Error("nf"), { status: 404 })),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({ departments: [], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    status,
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
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z",
    rank: null,
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const items = rows[params.status!] ?? []
  return { workItems: items, total: items.length, nextOffset: null }
}

/** Column x-ranges the geometry stub serves: each visible column body gets a
 *  100px-wide band in registration order. */
function stubColumnGeometry() {
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-board-column]"))
  sections.forEach((section, i) => {
    const body = section.querySelector<HTMLElement>(":scope > div:nth-of-type(2)")
    if (!body) return
    const left = i * 100
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
      x: left, y: 0, left, top: 0, right: left + 100, bottom: 800, width: 100, height: 800,
      toJSON: () => ({}),
    } as DOMRect)
  })
  return sections.map((s) => s.dataset.boardColumn)
}

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  return event
}

function TaskProbe() {
  const { todoId } = useParams()
  const location = useLocation()
  return (
    <div data-testid="task-probe" data-todo={todoId} data-state={JSON.stringify(location.state ?? {})} />
  )
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<TaskProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  rows = {
    backlog: [compact("PLA-1", "backlog")],
    executing: [compact("PLA-3", "executing")],
    in_review: [compact("PLA-4", "in_review")],
  }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
})

describe("board drag legality", () => {
  it("dims illegal columns at 38% on lift and renders no slot in them", async () => {
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3") // executing
    stubColumnGeometry()

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 50)) // beyond threshold → lift
    })

    // From executing: backlog/assigned are illegal manual targets — they recede.
    expect(screen.getByTestId("board-column-backlog").style.opacity).toBe("0.38")
    expect(screen.getByTestId("board-column-assigned").style.opacity).toBe("0.38")
    // in_review stays live.
    expect(screen.getByTestId("board-column-in_review").style.opacity).toBe("")

    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 220, 50))
    })
  })

  it("renders the slot in a hovered legal column and commits the transition on drop", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("PLA-3", "in_review") }, escalated: false })
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    const order = stubColumnGeometry()
    const reviewIndex = order.indexOf("in_review")
    const reviewX = reviewIndex * 100 + 50

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", reviewX, 50))
    })
    expect(screen.getByTestId("board-drag-slot")).toBeTruthy()
    expect(screen.getByTestId("board-column-in_review").contains(screen.getByTestId("board-drag-slot"))).toBe(true)

    await act(async () => {
      window.dispatchEvent(pointer("pointerup", reviewX, 50))
    })
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-3", "in_review"))
  })

  it("writes the landing rank after an accepted cross-column drop (F3 — refetch never reorders it)", async () => {
    rows.in_review = [{ ...compact("PLA-4", "in_review"), rank: 2048 }]
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("PLA-3", "in_review"), version: 4 }, escalated: false })
    updateWorkItem.mockResolvedValue({ workItem: { ...compact("PLA-3", "in_review"), version: 5 } })
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    const order = stubColumnGeometry()
    const reviewX = order.indexOf("in_review") * 100 + 50

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", reviewX, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", reviewX, 50))
    })

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-3", "in_review"))
    // The rank PATCH uses the rankBetween neighbours at the landing slot
    // (below PLA-4 @2048 → 2048+1024) and the version the transition returned.
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-3", expect.objectContaining({
        patch: { rank: 3072 },
        expectedVersion: 4,
      })),
    )
  })

  it("a drop into Blocked opens the task page with the banner reason focused (F6 hand-off)", async () => {
    rows.blocked = [compact("PLA-9", "blocked")] // materialize the Blocked column
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("PLA-3", "blocked"), version: 4 }, escalated: false })
    updateWorkItem.mockResolvedValue({ workItem: { ...compact("PLA-3", "blocked"), version: 5 } })
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    const order = stubColumnGeometry()
    const blockedX = order.indexOf("blocked") * 100 + 50

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", blockedX, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", blockedX, 50))
    })

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-3", "blocked"))
    const probe = await screen.findByTestId("task-probe")
    expect(probe.dataset.todo).toBe("PLA-3")
    expect(JSON.parse(probe.dataset.state!)).toMatchObject({ focusBannerReason: true, fromBoard: "platform" })
  })

  it("does not commit anything when dropped over dead space", async () => {
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    stubColumnGeometry()

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 50))
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 5000, 50)) // outside every column
    })
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 5000, 50))
    })
    expect(setWorkItemStatus).not.toHaveBeenCalled()
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("a plain click never lifts — it opens the card", async () => {
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    stubColumnGeometry()
    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 210, 40))
    })
    expect(screen.queryByTestId("board-drag-slot")).toBeNull()
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })
})
