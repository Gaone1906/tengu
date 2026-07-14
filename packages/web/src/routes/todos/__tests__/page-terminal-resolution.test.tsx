import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type OrgData, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemListWire } from "@/lib/api"
import TodosPage from "../page"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()
const getWorkItem = vi.fn()
const getOrg = vi.fn()
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
      updateWorkItem: vi.fn(),
      listWorkItemSessions: (...args: unknown[]) => listWorkItemSessions(...args),
      setWorkItemStatus: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

const org: OrgData = { departments: [], employees: [], hierarchy: { root: "coo", sorted: ["coo"], warnings: [] } }
const EMPTY: WorkItemListWire = { workItems: [], total: 0, offset: 0, limit: 100, nextOffset: null }

function compact(id: string, title: string, status: WorkItemCompactWire["status"]): WorkItemCompactWire {
  return {
    id, version: 2, title, status, assignee: null, department: null, source: "human", sourceRef: null,
    approvalState: null, approvalRequest: null, approvalRef: null, approvalTarget: null,
    approvalEscalatedAt: null, updatedAt: "2026-07-12T08:00:00.000Z",
  }
}

function detail(id: string, title = "Direct Todo", status: WorkItemCompactWire["status"] = "cancelled"): WorkItemDetailWire {
  const item = compact(id, title, status)
  return {
    workItem: {
      ...item, body: null, priority: 0, rank: null, acceptance: null, verifyPolicy: null, rounds: 0,
      budgetUsd: null, approvalDecidedBy: null, approvalDecidedAt: null,
      createdAt: "2026-07-12T08:00:00.000Z", closedAt: null,
    },
    spendUsd: 0,
    events: [],
  }
}

let navigate: ReturnType<typeof useNavigate>
let pathname = ""
let state: unknown = null
function RouterProbe() {
  navigate = useNavigate()
  const location = useLocation()
  pathname = location.pathname
  state = location.state
  return null
}

let client: QueryClient
function renderAt(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <RouterProbe />
        <Routes>
          <Route path="/todos" element={<TodosPage />} />
          <Route path="/todos/:todoId" element={<TodosPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("public JIN-N Todo routes", () => {
  beforeEach(() => {
    listWorkItems.mockReset().mockResolvedValue(EMPTY)
    searchWorkItems.mockReset().mockResolvedValue(EMPTY)
    getWorkItem.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    listWorkItemSessions.mockReset().mockResolvedValue([])
    sessionStorage.clear()
    localStorage.clear()
  })

  it("opens an off-page terminal Todo with one direct canonical lookup", async () => {
    getWorkItem.mockResolvedValue(detail("JIN-42", "Archived release"))
    renderAt("/todos/JIN-42")

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Archived release"))
    expect(getWorkItem).toHaveBeenCalledWith("JIN-42", expect.any(AbortSignal))
    expect(pathname).toBe("/todos/JIN-42")
    expect(state).toBeNull()
    expect(listWorkItems.mock.calls.every((args) => args.length < 2 || args[1] === undefined)).toBe(true)
    expect(client.getQueryCache().find({ queryKey: ["work-item", "JIN-42"], exact: true })).toBeTruthy()
  })

  it("keeps the same canonical URL and identity across a remount", async () => {
    getWorkItem.mockResolvedValue(detail("JIN-43", "Reloaded Todo"))
    const first = renderAt("/todos/JIN-43")
    await screen.findByText("Reloaded Todo")
    first.unmount()

    renderAt("/todos/JIN-43")
    await screen.findByText("Reloaded Todo")
    expect(pathname).toBe("/todos/JIN-43")
    expect(sessionStorage.getItem("jinn:todo-tab-salt:v1")).toBeNull()
  })

  it("rejects malformed route identifiers before any item lookup", async () => {
    renderAt("/todos/JIN-0")
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    expect(getWorkItem).not.toHaveBeenCalled()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("shows missing only for a canonical endpoint 404", async () => {
    getWorkItem.mockRejectedValue(new ApiError(404, "not found"))
    renderAt("/todos/JIN-44")

    expect((await screen.findAllByText("Todo no longer exists")).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("todo-resolve-retry")).toBeNull()
  })

  it("shows a visible retry for transport errors and resolves on retry", async () => {
    getWorkItem
      .mockRejectedValueOnce(new ApiError(503, "offline"))
      .mockResolvedValue(detail("JIN-45", "Recovered Todo"))
    renderAt("/todos/JIN-45")

    fireEvent.click(await screen.findByTestId("todo-resolve-retry"))
    await screen.findByText("Recovered Todo")
    expect(getWorkItem).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("renders an explicit resolving state while the direct lookup is pending", async () => {
    getWorkItem.mockImplementation(() => new Promise(() => {}))
    renderAt("/todos/JIN-46")
    expect((await screen.findByTestId("todo-resolving")).textContent).toContain("Finding this Todo")
  })

  it("aborts the previous lookup when the canonical route changes", async () => {
    let firstSignal: AbortSignal | undefined
    getWorkItem.mockImplementation((id: string, signal?: AbortSignal) => {
      if (id === "JIN-47") {
        firstSignal = signal
        return new Promise(() => {})
      }
      return Promise.resolve(detail("JIN-48", "Second Todo"))
    })
    renderAt("/todos/JIN-47")
    await screen.findByTestId("todo-resolving")

    act(() => navigate("/todos/JIN-48"))
    await screen.findByText("Second Todo")
    expect(firstSignal?.aborted).toBe(true)
    expect(pathname).toBe("/todos/JIN-48")
  })

  it("aborts an in-flight lookup on unmount", async () => {
    let signal: AbortSignal | undefined
    getWorkItem.mockImplementation((_id: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    const view = renderAt("/todos/JIN-49")
    await screen.findByTestId("todo-resolving")
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
