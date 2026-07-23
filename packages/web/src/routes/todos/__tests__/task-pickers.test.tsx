import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type WorkItemDetailWire, type WorkItemFullWire, type WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Todos v2 slice 6 — the property pickers (design-doc §7.3, polish laws 1–3,
 * 20): ONE legality truth (legalTargets) in the status picker — illegal edges
 * ABSENT, gated targets disabled at 50% with the inline reason and a quiet
 * omission footnote; NSMenu superimposition (the current value's row sits over
 * the anchor); optimistic commits that snap back with the gateway's words. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()
const setWorkItemLabels = vi.fn()
const listLabels = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      setWorkItemLabels: (...args: unknown[]) => setWorkItemLabels(...args),
      listLabels: (...args: unknown[]) => listLabels(...args),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [
          { slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 },
          { slug: "marketing", prefix: "MKT", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 2 },
        ],
      }),
      getOrg: vi.fn().mockResolvedValue({
        departments: ["platform"],
        employees: [
          { name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
          { name: "scout", displayName: "Scout", department: "marketing", rank: "employee", engine: "codex", model: "m", persona: "p" },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
    verifyPolicy: null, rounds: 1, budgetUsd: null, approvalState: null, approvalRequest: null,
    approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, approvalDecidedBy: null,
    approvalDecidedAt: null, createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask(path = "/todos/PLA-12") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listLabels.mockResolvedValue({ labels: [
    { id: "lab_1", name: "store", color: "#7DBE6A", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "lab_2", name: "infra", color: "#5B9BD5", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
  ] })
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
})

describe("the status picker", () => {
  it("offers ONLY the legal manual targets from executing — illegal edges are absent, with the omission footnote", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))

    const picker = await screen.findByTestId("picker-status")
    // Current first (checked), then the design's presentation order (F2):
    // In review · Done · Blocked · Escalated · Cancelled.
    const rows = [...picker.querySelectorAll<HTMLElement>('[data-testid^="status-option-"]')]
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "status-option-executing",
      "status-option-in_review",
      "status-option-done",
      "status-option-blocked",
      "status-option-escalated",
      "status-option-cancelled",
    ])
    expect(screen.queryByTestId("status-option-backlog")).toBeNull()
    expect(screen.queryByTestId("status-option-assigned")).toBeNull()
    expect(picker.textContent).toContain("Only legal moves are listed")
    expect(picker.textContent).toContain("Backlog and Assigned aren't reachable from Executing")
  })

  it("renders a gated Done disabled with the inline reason when children are open, and refuses the click", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({
      tree: {
        root: treeNode(item, [
          treeNode(full("PLA-13", { status: "executing", parentId: "PLA-12", depth: 1 })),
          treeNode(full("PLA-14", { status: "done", parentId: "PLA-12", depth: 1 })),
        ]),
        totals: {},
        spendUsd: 0,
      },
    })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))

    const done = await screen.findByTestId("status-option-done")
    expect(done.getAttribute("aria-disabled")).toBe("true")
    expect(done.textContent).toContain("1 sub-task still open")
    fireEvent.click(done)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("commits optimistically and snaps back with the gateway's words on refusal", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    setWorkItemStatus.mockRejectedValue(new ApiError(403, "3 sub-tasks still open"))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))
    fireEvent.click(await screen.findByTestId("status-option-in_review"))

    // Optimistic: the rail row reads the new value before the server answers.
    await waitFor(() => expect(screen.getByTestId("rail-status").textContent).toContain("In review"))
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-12", "in_review", undefined))
    await waitFor(() => expect(screen.getByTestId("task-callout").textContent).toContain("3 sub-tasks still open"))
  })

  it("superimposes the anchor NSMenu-style: current row first, menu offset -7px, width 314", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))
    const picker = await screen.findByTestId("picker-status")
    expect(picker.style.top).toBe("-7px")
    expect(picker.style.left).toBe("-6px")
    expect(picker.className).toContain("w-[314px]")
  })
})

describe("the other pickers", () => {
  it("priority superimposes the CURRENT row over the anchor (Medium = index 1 → -43px) and commits a PATCH", async () => {
    const item = full("PLA-12", { priority: 2 })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, priority: 3, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-priority"))

    const picker = await screen.findByTestId("picker-priority")
    expect(picker.style.top).toBe("-43px")
    fireEvent.click(screen.getByTestId("priority-option-3"))
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { priority: 3 },
        expectedVersion: 3,
      })),
    )
  })

  it("assignee search filters the roster; Unassign commits null", async () => {
    const item = full("PLA-12", { assignee: "mason" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, assignee: null, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))

    const search = await screen.findByTestId("assignee-search")
    fireEvent.change(search, { target: { value: "sco" } })
    expect(screen.queryByTestId("assignee-option-mason")).toBeNull()
    expect(screen.getByTestId("assignee-option-scout")).toBeTruthy()

    fireEvent.click(screen.getByTestId("assignee-option-unassign"))
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { assignee: null },
        expectedVersion: 3,
      })),
    )
  })

  it("labels multi-select PUTs the replaced set", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item, { labels: [
      { id: "lab_1", name: "store", color: "#7DBE6A", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
    ] }))
    setWorkItemLabels.mockResolvedValue({ labels: [] })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-labels-add"))

    const infra = await screen.findByTestId("label-option-lab_2")
    fireEvent.click(infra)
    await waitFor(() =>
      expect(setWorkItemLabels).toHaveBeenCalledWith("PLA-12", expect.arrayContaining(["lab_1", "lab_2"])),
    )
  })

  it("the verify picker PATCHes an explicit policy and can clear back to the default", async () => {
    const item = full("PLA-12", { verifyPolicy: { mode: "verify", maxRounds: 2 } })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-verify"))

    fireEvent.click(await screen.findByTestId("verify-option-thorough"))
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { verifyPolicy: { mode: "thorough", maxRounds: 2 } },
      })),
    )

    fireEvent.click(screen.getByTestId("verify-clear"))
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { verifyPolicy: null },
      })),
    )
  })

  it("the due picker commits an ISO day and can clear", async () => {
    const item = full("PLA-12", { dueAt: "2026-08-08T12:00:00.000Z" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-due"))

    fireEvent.click(await screen.findByTestId("due-day-9"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalled())
    const [, request] = updateWorkItem.mock.calls[0]
    expect(request.patch.dueAt).toContain("2026-08-09")
  })

  it("department rows carry the mono prefix and the birth-prefix footnote", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-department"))

    const picker = await screen.findByTestId("picker-department")
    expect(picker.textContent).toContain("PLA")
    expect(picker.textContent).toContain("MKT")
    expect(picker.textContent).toContain("keeps its birth prefix")
  })

  it("Esc closes the picker and returns focus to the rail row", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    const row = await screen.findByTestId("rail-status")
    fireEvent.click(row)
    const picker = await screen.findByTestId("picker-status")
    fireEvent.keyDown(picker, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("picker-status")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("rail-status")))
  })
})
