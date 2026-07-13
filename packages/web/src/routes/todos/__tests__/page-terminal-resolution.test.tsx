import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire, WorkItemDetailWire } from "@/lib/api"
import TodosPage from "../page"
import { todoPrivateRef } from "../todo-private-state"

/* Task 10 defect + reviewer correction: opening an EXISTING terminal
 * (done/cancelled/archived) Todo from a chat activity card must resolve its real
 * detail sheet — never a false "Todo no longer exists" — with EXHAUSTIVE healthy
 * resolution (no arbitrary page cap), a settlement-race-proof gate, visible
 * resolving/error/retry UX, aborts, and no raw id in URL/history/storage/DOM. */

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
      listWorkItems: (...a: unknown[]) => listWorkItems(...a),
      searchWorkItems: (...a: unknown[]) => searchWorkItems(...a),
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getOrg: (...a: unknown[]) => getOrg(...a),
      updateWorkItem: vi.fn(),
      listWorkItemSessions: (...a: unknown[]) => listWorkItemSessions(...a),
      setWorkItemStatus: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

const org: OrgData = { departments: [], employees: [], hierarchy: { root: "coo", sorted: ["coo"], warnings: [] } }
const empty = { workItems: [], total: 0, nextOffset: null }

type ListParams = { status?: string; needsAttentionFor?: string; since?: string; offset?: number; limit?: number }
/** A terminal-resolver call: a done/cancelled status page with no `since` window
 *  and the full page size (the recent-window ledger uses `since` + limit 20). */
function isTerminalCall(p?: ListParams): boolean {
  return (p?.status === "done" || p?.status === "cancelled") && p?.since === undefined && p?.limit === 100
}

function compact(id: string, title: string, status: string): WorkItemCompactWire {
  return {
    id, version: 2, title, status: status as WorkItemCompactWire["status"], assignee: null, department: null,
    source: "human", sourceRef: null, approvalState: null, approvalRequest: null, approvalRef: null,
    approvalTarget: null, approvalEscalatedAt: null, updatedAt: "2026-07-12T08:00:00.000Z",
  }
}
function detailOf(c: WorkItemCompactWire): WorkItemDetailWire {
  return {
    workItem: { ...c, version: c.version ?? 1, body: null, priority: 0, rank: c.rank ?? null, acceptance: null,
      verifyPolicy: null, rounds: 0, budgetUsd: null, approvalDecidedBy: null, approvalDecidedAt: null,
      createdAt: "2026-07-12T08:00:00.000Z", closedAt: null },
    spendUsd: 0, events: [],
  }
}

let currentSearch = ""
let currentState: unknown = null
function RouterProbe() {
  const location = useLocation()
  currentSearch = location.search
  currentState = location.state
  return null
}

let activeClient: QueryClient
function renderAt(state: unknown, key = "k1") {
  activeClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={activeClient}>
      <MemoryRouter initialEntries={[{ pathname: "/todos", state, key }]}>
        <RouterProbe />
        <TodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Open sources (ledger/needs/people) are empty; a single terminal row is served
 *  only to the exhaustive terminal-resolver call, exactly like the reported bug. */
function serveTerminal(status: "done" | "cancelled", row: WorkItemCompactWire) {
  listWorkItems.mockImplementation((p?: ListParams) => {
    if (p?.needsAttentionFor) return Promise.resolve(empty)
    if (isTerminalCall(p) && p?.status === status && (p?.offset ?? 0) === 0) {
      return Promise.resolve({ workItems: [row], total: 1, nextOffset: null })
    }
    return Promise.resolve(empty)
  })
}

describe("Terminal Todo resolution from a private ref", () => {
  beforeEach(() => {
    sessionStorage.clear()
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
    getWorkItem.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    listWorkItemSessions.mockReset().mockResolvedValue([])
  })
  afterEach(() => vi.useRealTimers())

  it("opens an OLD done Todo that is excluded from the recent-window open lens", async () => {
    const c = compact("wi_old_done", "Shipped last quarter", "done")
    // Recent-window ledger (since set) excludes it; exhaustive terminal finds it.
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done" && (p?.offset ?? 0) === 0) {
        return Promise.resolve({ workItems: [c], total: 1, nextOffset: null })
      }
      return Promise.resolve(empty) // ledger done (since set) → excluded
    })
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_old_done") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Shipped last quarter"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("opens an existing CANCELLED Todo and keeps the canonical id out of the URL and history", async () => {
    const c = compact("wi_cancelled", "Archived release plan", "cancelled")
    serveTerminal("cancelled", c)
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_cancelled") })

    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Archived release plan"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    expect(currentSearch).not.toContain("wi_cancelled")
    expect(JSON.stringify(currentState)).not.toContain("wi_cancelled")
    // Privacy: no raw id in the DOM, sessionStorage, or any React Query key.
    expect(document.body.innerHTML).not.toContain("wi_cancelled")
    const storage = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "").join("\n")
    expect(storage).not.toContain("wi_cancelled")
    const terminalKeys = activeClient.getQueryCache().findAll({ queryKey: ["work-items", "terminal-ref"] })
    expect(terminalKeys.length).toBeGreaterThan(0)
    for (const q of terminalKeys) expect(JSON.stringify(q.queryKey)).not.toContain("wi_cancelled")
  })

  it("resolves the same terminal Todo on a fresh remount carrying only the private ref", async () => {
    const c = compact("wi_reload", "Reloaded cancelled plan", "cancelled")
    serveTerminal("cancelled", c)
    getWorkItem.mockResolvedValue(detailOf(c))

    const ref = todoPrivateRef("wi_reload")
    const first = renderAt({ todoRef: ref })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Reloaded cancelled plan"))
    first.unmount()

    // A true reload keeps sessionStorage (salt) but drops in-memory caches.
    renderAt({ todoRef: ref }, "k2")
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Reloaded cancelled plan"))
    const storage = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "").join("\n")
    expect(storage).not.toContain("wi_reload")
  })

  it("resolves EXHAUSTIVELY without an arbitrary cap — a match past 5000 rows still opens", async () => {
    const target = compact("wi_deep", "Deep terminal match", "cancelled")
    const TARGET_OFFSET = 5100
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (!isTerminalCall(p) || p?.status !== "cancelled") return Promise.resolve(empty)
      const offset = p?.offset ?? 0
      if (offset >= TARGET_OFFSET) return Promise.resolve({ workItems: [target], total: TARGET_OFFSET + 1, nextOffset: null })
      const filler = Array.from({ length: 100 }, (_, i) => compact(`wi_f_${offset}_${i}`, "f", "cancelled"))
      return Promise.resolve({ workItems: filler, total: TARGET_OFFSET + 1, nextOffset: offset + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(target))

    renderAt({ todoRef: todoPrivateRef("wi_deep") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Deep terminal match"), { timeout: 3000 })
    // Every terminal page asked the server for the max page size, and paging went
    // well beyond the old 25-page (2500) cap.
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", offset: TARGET_OFFSET, limit: 100 }), expect.anything())
  })

  it("treats a truncated terminal stream (nextOffset gone while total remains) as retryable, not missing", async () => {
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done") {
        // Server claims 500 rows but stops paging after one page → truncated.
        return Promise.resolve({ workItems: Array.from({ length: 100 }, (_, i) => compact(`wi_t_${i}`, "t", "done")), total: 500, nextOffset: null })
      }
      return Promise.resolve(empty)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "done")))

    renderAt({ todoRef: todoPrivateRef("wi_truncated") })

    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("treats a non-monotonic (cyclic) terminal offset as retryable, not missing", async () => {
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done") {
        // nextOffset points back to 0 → cycle.
        return Promise.resolve({ workItems: Array.from({ length: 100 }, (_, i) => compact(`wi_c_${i}`, "c", "done")), total: 999, nextOffset: 0 })
      }
      return Promise.resolve(empty)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "done")))

    renderAt({ todoRef: todoPrivateRef("wi_cyclic") })

    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("shows a resolving indicator while the terminal lookup runs, never a premature missing", async () => {
    let release: (() => void) | null = null
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done") {
        return new Promise((resolve) => { release = () => resolve(empty) })
      }
      return Promise.resolve(empty)
    })

    renderAt({ todoRef: todoPrivateRef("wi_slow") })

    expect(await screen.findByTestId("todo-resolving")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    act(() => release?.())
  })

  it("shows a retry action on lookup error and re-runs the search on Retry, never missing", async () => {
    let attempt = 0
    const c = compact("wi_retry", "Recovered on retry", "cancelled")
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done") {
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error("offline"))
        return Promise.resolve(empty)
      }
      if (isTerminalCall(p) && p?.status === "cancelled" && attempt >= 2) return Promise.resolve({ workItems: [c], total: 1, nextOffset: null })
      return Promise.resolve(empty)
    })
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_retry") })

    const retry = await screen.findByTestId("todo-resolve-retry")
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recovered on retry"))
  })

  it("shows the explicit missing dialog only after an exhaustive, healthy, empty lookup", async () => {
    listWorkItems.mockImplementation((p?: ListParams) => Promise.resolve(p?.needsAttentionFor ? empty : empty))
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))

    renderAt({ todoRef: todoPrivateRef("wi_ghost") })

    expect((await screen.findAllByText("Todo no longer exists")).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  it("lets an active-lens candidate win without ever consulting the terminal resolver", async () => {
    // A recent done shows in the open lens (since-scoped) → resolved from lists.
    const c = compact("wi_recent_done", "Done this week", "done")
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (p?.status === "done" && p?.since !== undefined) return Promise.resolve({ workItems: [c], total: 1, nextOffset: null })
      return Promise.resolve(empty)
    })
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_recent_done") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Done this week"))
    // The terminal resolver was never needed.
    expect(listWorkItems.mock.calls.some(([p]) => isTerminalCall(p as ListParams))).toBe(false)
  })

  it("runs zero resolver calls when no private ref is present", async () => {
    listWorkItems.mockImplementation((p?: ListParams) => Promise.resolve(p?.needsAttentionFor ? empty : empty))

    renderAt(null)

    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    expect(listWorkItems.mock.calls.some(([p]) => isTerminalCall(p as ListParams))).toBe(false)
  })

  it("aborts the terminal traversal on unmount with no later terminal page calls", async () => {
    let release: (() => void) | null = null
    listWorkItems.mockImplementation((p?: ListParams) => {
      if (p?.needsAttentionFor) return Promise.resolve(empty)
      if (isTerminalCall(p) && p?.status === "done") {
        return new Promise((resolve) => { release = () => resolve({ workItems: [], total: 0, nextOffset: null }) })
      }
      return Promise.resolve(empty)
    })

    const view = renderAt({ todoRef: todoPrivateRef("wi_abort") })
    await screen.findByTestId("todo-resolving")
    const before = listWorkItems.mock.calls.filter(([p]) => isTerminalCall(p as ListParams)).length
    view.unmount()
    act(() => release?.())
    await new Promise((r) => setTimeout(r, 30))
    const after = listWorkItems.mock.calls.filter(([p]) => isTerminalCall(p as ListParams)).length
    expect(after).toBe(before) // no further terminal pages after unmount
  })
})
