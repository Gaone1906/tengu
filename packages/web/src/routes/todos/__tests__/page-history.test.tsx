import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire, WorkItemDetailWire } from "@/lib/api"
import TodosPage from "../page"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()
const getWorkItem = vi.fn()
const getOrg = vi.fn()
const updateWorkItem = vi.fn()
const listWorkItemSessions = vi.fn()

vi.mock("@/lib/api", () => ({
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
}))

const PRIVATE_ID = "wi_private_history"
const compact: WorkItemCompactWire = {
  id: PRIVATE_ID,
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

function renderPage(initialEntries: Array<string | { pathname: string; state?: unknown }> = ["/todos"]) {
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
