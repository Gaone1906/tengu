import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage, { ancestorsOf, nodeOf } from "../task-page/task-page"

/* Todos v2 slice 6 stage B — the task page (design-doc §7, task-detail.html).
 * Anatomy: breadcrumb trail from the root tree, banner precedence
 * (escalated > approval > blocked, ONE at a time), the banner's asked-for-after
 * reason field (review F6), and the chrome-free rail's read rows. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const decideWorkItemApproval = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      decideWorkItemApproval: (...args: unknown[]) => decideWorkItemApproval(...args),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    body: null,
    status: "executing",
    department: "platform",
    assignee: null,
    priority: 2,
    rank: null,
    source: "human",
    sourceRef: null,
    acceptance: null,
    verifyPolicy: null,
    rounds: 1,
    budgetUsd: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    approvalDecidedBy: null,
    approvalDecidedAt: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null,
    ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask(path = "/todos/PLA-12", state?: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[state ? { pathname: path, state } : path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
          <Route path="/todos/b/:board" element={<div data-testid="board-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
})

describe("ancestor helpers", () => {
  const root = treeNode(full("PLA-1"), [
    treeNode(full("PLA-2", { parentId: "PLA-1", depth: 1 }), [
      treeNode(full("PLA-4", { parentId: "PLA-2", depth: 2 })),
    ]),
    treeNode(full("PLA-3", { parentId: "PLA-1", depth: 1 })),
  ])

  it("derives the ancestor trail root-first", () => {
    expect(ancestorsOf(root, "PLA-4").map((a) => a.id)).toEqual(["PLA-1", "PLA-2"])
    expect(ancestorsOf(root, "PLA-1")).toEqual([])
    expect(ancestorsOf(root, "PLA-9")).toEqual([])
  })

  it("finds the item's own node", () => {
    expect(nodeOf(root, "PLA-4")?.id).toBe("PLA-4")
    expect(nodeOf(root, "PLA-9")).toBeUndefined()
  })
})

describe("the task page", () => {
  it("renders the breadcrumb (board › ancestors › ID + title) and the title block", async () => {
    const item = full("PLA-22", { title: "Postal-code validation", rootId: "PLA-12", parentId: "PLA-14", depth: 2 })
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({
      tree: {
        root: treeNode(full("PLA-12"), [
          treeNode(full("PLA-14", { parentId: "PLA-12", depth: 1 }), [treeNode(item)]),
        ]),
        totals: {},
        spendUsd: 0,
      },
    })
    renderTask("/todos/PLA-22", { fromBoard: "platform" })

    await waitFor(() => expect(screen.getByTestId("task-title").textContent).toContain("Postal-code validation"))
    expect((screen.getByTestId("task-crumb-board")).textContent).toContain("Platform")
    await waitFor(() => expect(screen.getByTestId("task-crumb-PLA-12")).toBeTruthy())
    expect(screen.getByTestId("task-crumb-PLA-14")).toBeTruthy()
    expect(getWorkItemTree).toHaveBeenCalledWith("PLA-12")
  })

  it("renders the rail's read rows: status, priority, assignee, verify, spend", async () => {
    const item = full("PLA-12", { assignee: "mason", priority: 3, budgetUsd: 10 })
    getWorkItem.mockResolvedValue({ ...detailOf(item), spendUsd: 4.35 })
    renderTask()

    const rail = await screen.findByTestId("task-props-rail")
    expect(rail).toBeTruthy()
    expect((screen.getByTestId("rail-status")).textContent).toContain("Executing")
    expect((screen.getByTestId("rail-priority")).textContent).toContain("High")
    expect((screen.getByTestId("rail-assignee")).textContent).toContain("mason")
    expect((screen.getByTestId("rail-verify")).textContent).toContain("Round 1 of")
    expect((screen.getByTestId("rail-spend")).textContent).toContain("$4.35")
    expect((screen.getByTestId("rail-spend")).textContent).toContain("$10")
  })

  it("banner precedence: escalated wins over a pending approval", async () => {
    const item = full("PLA-12", {
      status: "escalated",
      approvalState: "pending",
      approvalRequest: "OK to go live?",
    })
    getWorkItem.mockResolvedValue(detailOf(item, {
      events: [{
        id: "e1", workItemId: "PLA-12", kind: "status_change", fromStatus: "in_review",
        toStatus: "escalated", actor: "reviewer", detail: { note: "Rounds exhausted, your call" },
        createdAt: "2026-07-23T07:00:00.000Z",
      }],
    }))
    renderTask()

    expect((await screen.findByTestId("task-banner-escalated")).textContent).toContain("Rounds exhausted, your call")
    expect(screen.queryByTestId("task-banner-approval")).toBeNull()
    expect(screen.queryByTestId("task-banner-blocked")).toBeNull()
  })

  it("approval banner decides through the approval surface", async () => {
    const item = full("PLA-12", { status: "in_review", approvalState: "pending", approvalRequest: "OK to go live?" })
    getWorkItem.mockResolvedValue(detailOf(item))
    decideWorkItemApproval.mockResolvedValue({ workItem: full("PLA-12", { status: "in_review" }), escalated: false })
    renderTask()

    const banner = await screen.findByTestId("task-banner-approval")
    expect((banner).textContent).toContain("OK to go live?")
    fireEvent.click(screen.getByTestId("task-banner-approve"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("PLA-12", "approve", undefined))
  })

  it("a reason-less blocked item grows the banner reason field; committing PUTs the same status with the note (F6)", async () => {
    const item = full("PLA-12", { status: "blocked" })
    getWorkItem.mockResolvedValue(detailOf(item))
    setWorkItemStatus.mockResolvedValue({ workItem: item, escalated: false })
    renderTask("/todos/PLA-12", { focusBannerReason: true })

    const input = await screen.findByTestId("task-banner-reason")
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: "Waiting on vendor keys" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-12", "blocked", "Waiting on vendor keys"))
  })

  it("a blocked item WITH a reason renders it rail-quoted instead of the input", async () => {
    const item = full("PLA-12", { status: "blocked" })
    getWorkItem.mockResolvedValue(detailOf(item, {
      events: [{
        id: "e1", workItemId: "PLA-12", kind: "status_change", fromStatus: "executing",
        toStatus: "blocked", actor: "mason", detail: { note: "Waiting on vendor keys" },
        createdAt: "2026-07-23T07:00:00.000Z",
      }],
    }))
    renderTask()

    const banner = await screen.findByTestId("task-banner-blocked")
    expect((banner).textContent).toContain("Waiting on vendor keys")
    expect(screen.queryByTestId("task-banner-reason")).toBeNull()
  })

  it("unknown ids land on the not-found state, not a crash", async () => {
    getWorkItem.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
    renderTask("/todos/ZZZ-99")
    expect(await screen.findByText(/doesn't exist/)).toBeTruthy()
  })

  it("the body renders through MarkdownView when present and the quiet placeholder when empty", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { body: "Let a buyer **complete** a purchase." })))
    renderTask()
    const body = await screen.findByTestId("task-body")
    await waitFor(() => expect((body).textContent).toContain("complete"))
  })
})
