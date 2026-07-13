import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire, WorkItemDetailWire, WorkItemListWire } from "@/lib/api"
import TodosPage from "../page"
import { todoPrivateRef } from "../todo-private-state"

/* Task 10 defect + hardening: opening an EXISTING Todo (off-page, past the
 * People/Needs caps, or terminal) from a chat activity card must resolve its real
 * detail sheet — never a false "Todo no longer exists" — via an EXHAUSTIVE,
 * healthy-verified private-ref search across ALL statuses, with a settlement-race-
 * proof gate, whole-pipeline resolving/error/retry UX, aborts, and no raw id in
 * the ref-resolve query keys, URL, history, storage, or DOM. */

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
const EMPTY: WorkItemListWire = { workItems: [], total: 0, offset: 0, limit: 100, nextOffset: null }

type ListParams = { status?: string; needsAttentionFor?: string; since?: string; offset?: number; limit?: number }

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

/** A server-contract-compliant page (store.ts): total present + stable, offset
 *  echoed, nextOffset = offset + rows.length or null. */
function page(rows: WorkItemCompactWire[], offset: number): WorkItemListWire {
  const slice = rows.slice(offset, offset + 100)
  const consumed = offset + slice.length
  return { workItems: slice, total: rows.length, offset, limit: 100, nextOffset: slice.length > 0 && consumed < rows.length ? consumed : null }
}

/** Resolver calls carry the AbortSignal (2nd arg); visible ledger/People/Needs
 *  calls never do. */
function isResolverCall(callArgs: unknown[]): boolean {
  return callArgs.length >= 2 && callArgs[1] !== undefined
}

interface MockConfig {
  bank?: Record<string, WorkItemCompactWire[]>
  visible?: (p: ListParams) => WorkItemListWire | Promise<WorkItemListWire>
  needs?: () => WorkItemListWire | Promise<WorkItemListWire>
}
function mock(cfg: MockConfig) {
  listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
    if (p?.needsAttentionFor) return Promise.resolve(cfg.needs ? cfg.needs() : EMPTY)
    if (signal === undefined) return Promise.resolve(cfg.visible ? cfg.visible(p ?? {}) : EMPTY)
    return Promise.resolve(page(cfg.bank?.[p?.status ?? ""] ?? [], p?.offset ?? 0))
  })
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

describe("Private-ref Todo resolution", () => {
  beforeEach(() => {
    sessionStorage.clear()
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
    getWorkItem.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    listWorkItemSessions.mockReset().mockResolvedValue([])
  })
  afterEach(() => vi.useRealTimers())

  it("opens an OLD done Todo excluded from the recent-window open lens", async () => {
    const c = compact("wi_old_done", "Shipped last quarter", "done")
    // Visible done query (with `since`) excludes it; the exhaustive resolver finds it.
    mock({ bank: { done: [c] }, visible: (p) => (p.status === "done" && p.since ? EMPTY : EMPTY) })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_old_done") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Shipped last quarter"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("opens a cancelled Todo and keeps the raw id out of URL, history, storage, DOM, and ref-resolve keys", async () => {
    const c = compact("wi_cancelled", "Archived release plan", "cancelled")
    mock({ bank: { cancelled: [c] } })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_cancelled") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Archived release plan"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    expect(currentSearch).not.toContain("wi_cancelled")
    expect(JSON.stringify(currentState)).not.toContain("wi_cancelled")
    expect(document.body.innerHTML).not.toContain("wi_cancelled")
    const storage = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "").join("\n")
    expect(storage).not.toContain("wi_cancelled")
    const resolveKeys = activeClient.getQueryCache().findAll({ queryKey: ["work-items", "ref-resolve"] })
    expect(resolveKeys.length).toBeGreaterThan(0)
    for (const q of resolveKeys) expect(JSON.stringify(q.queryKey)).not.toContain("wi_cancelled")
  })

  it("resolves the same Todo on a fresh remount carrying only the private ref", async () => {
    const c = compact("wi_reload", "Reloaded cancelled plan", "cancelled")
    mock({ bank: { cancelled: [c] } })
    getWorkItem.mockResolvedValue(detailOf(c))
    const ref = todoPrivateRef("wi_reload")
    const first = renderAt({ todoRef: ref })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Reloaded cancelled plan"))
    first.unmount()
    renderAt({ todoRef: ref }, "k2")
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Reloaded cancelled plan"))
  })

  it("resolves an OPEN target beyond the People 1000-row cap via the exhaustive resolver", async () => {
    const filler = Array.from({ length: 1500 }, (_, i) => compact(`wi_b_${i}`, `b${i}`, "backlog"))
    const target = compact("wi_deep_open", "Deep backlog item", "backlog")
    mock({ bank: { backlog: [...filler, target] } })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_deep_open") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Deep backlog item"), { timeout: 3000 })
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 1500, limit: 100 }), expect.anything())
  })

  it("resolves an EXHAUSTIVE match past 5000 rows with no arbitrary cap", async () => {
    const filler = Array.from({ length: 5100 }, (_, i) => compact(`wi_c_${i}`, `c${i}`, "cancelled"))
    const target = compact("wi_deep", "Deep terminal match", "cancelled")
    mock({ bank: { cancelled: [...filler, target] } })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_deep") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Deep terminal match"), { timeout: 4000 })
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", offset: 5100, limit: 100 }), expect.anything())
  })

  it("renders the missing dialog only after a healthy, exhaustive, empty search", async () => {
    mock({})
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
    renderAt({ todoRef: todoPrivateRef("wi_ghost") })
    expect((await screen.findAllByText("Todo no longer exists")).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  // ── Strict pagination invariants → retryable incomplete, never missing ──
  function anomalyResolver(status: string, response: WorkItemListWire) {
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status === status) return Promise.resolve(response)
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
  }
  const rows100 = (s: string) => Array.from({ length: 100 }, (_, i) => compact(`wi_${s}_${i}`, "r", s))

  it.each([
    ["omitted total", { workItems: rows100("done"), offset: 0, limit: 100, nextOffset: 100 } as unknown as WorkItemListWire],
    ["truncated (nextOffset null while total remains)", { workItems: rows100("done"), total: 500, offset: 0, limit: 100, nextOffset: null }],
    ["forward gap in nextOffset", { workItems: rows100("done"), total: 999, offset: 0, limit: 100, nextOffset: 250 }],
    ["repeated/cyclic nextOffset", { workItems: rows100("done"), total: 999, offset: 0, limit: 100, nextOffset: 0 }],
    ["decreasing nextOffset", { workItems: rows100("done"), total: 999, offset: 0, limit: 100, nextOffset: -1 as unknown as number }],
    ["offset metadata mismatch", { workItems: rows100("done"), total: 999, offset: 7, limit: 100, nextOffset: 100 }],
    ["malformed row", { workItems: [{ title: "no id" } as unknown as WorkItemCompactWire], total: 1, offset: 0, limit: 100, nextOffset: null }],
  ])("treats %s as retryable, never missing", async (_label, response) => {
    anomalyResolver("done", response)
    renderAt({ todoRef: todoPrivateRef("wi_anom") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("treats changing total mid-traversal as retryable, never missing", async () => {
    let call = 0
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "done") return Promise.resolve(EMPTY)
      call += 1
      const total = call === 1 ? 300 : 250 // total shifts between pages
      return Promise.resolve({ workItems: rows100("done"), total, offset: p?.offset ?? 0, limit: 100, nextOffset: (p?.offset ?? 0) + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "done")))
    renderAt({ todoRef: todoPrivateRef("wi_total") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("treats a duplicate id across pages as retryable, never missing", async () => {
    const dup = compact("wi_dup", "dup", "done")
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "done") return Promise.resolve(EMPTY)
      const offset = p?.offset ?? 0
      return Promise.resolve({ workItems: [dup, ...rows100("done").slice(0, 99)], total: 400, offset, limit: 100, nextOffset: offset + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(dup))
    renderAt({ todoRef: todoPrivateRef("wi_never") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("treats the runaway page budget as retryable incomplete, never missing", async () => {
    // A status that always yields a full non-matching page → exhausts the budget.
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "backlog") return Promise.resolve(EMPTY)
      const offset = p?.offset ?? 0
      const rows = Array.from({ length: 100 }, (_, i) => compact(`wi_bud_${offset}_${i}`, "b", "backlog"))
      return Promise.resolve({ workItems: rows, total: 10_000_000, offset, limit: 100, nextOffset: offset + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "backlog")))
    renderAt({ todoRef: todoPrivateRef("wi_budget") })
    expect(await screen.findByTestId("todo-resolve-retry", undefined, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  }, 10_000)

  // ── Whole-pipeline visible state + retry/abort ──
  it("shows 'Finding this Todo…' while a candidate source is still hung, never a premature missing", async () => {
    let releaseBase: (() => void) | null = null
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined && p?.status === "backlog") return new Promise((res) => { releaseBase = () => res(EMPTY) })
      return Promise.resolve(EMPTY)
    })
    renderAt({ todoRef: todoPrivateRef("wi_hung") })
    expect(await screen.findByTestId("todo-resolving")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    act(() => releaseBase?.())
  })

  it("shows the retry dialog when a candidate source fails, never missing", async () => {
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined && p?.status === "backlog") return Promise.reject(new Error("offline"))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
    renderAt({ todoRef: todoPrivateRef("wi_base_err") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("shows resolving then retry when the resolver errors, and resolves after Retry", async () => {
    let attempt = 0
    const c = compact("wi_retry", "Recovered on retry", "cancelled")
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status === "cancelled") {
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error("offline"))
        return Promise.resolve(page([c], p?.offset ?? 0))
      }
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_retry") })
    const retry = await screen.findByTestId("todo-resolve-retry")
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recovered on retry"))
  })

  it("lets an active-lens candidate win without consulting the resolver", async () => {
    const c = compact("wi_recent", "Recent open item", "backlog")
    mock({ visible: (p) => (p.status === "backlog" ? page([c], p.offset ?? 0) : EMPTY) })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_recent") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recent open item"))
    expect(listWorkItems.mock.calls.some(isResolverCall)).toBe(false)
  })

  it("runs zero resolver calls when no private ref is present", async () => {
    mock({})
    renderAt(null)
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    expect(listWorkItems.mock.calls.some(isResolverCall)).toBe(false)
  })

  it("aborts the resolver on unmount with no later resolver page calls", async () => {
    let release: (() => void) | null = null
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status === "backlog") return new Promise((res) => { release = () => res(page([], p?.offset ?? 0)) })
      return Promise.resolve(EMPTY)
    })
    const view = renderAt({ todoRef: todoPrivateRef("wi_abort") })
    await screen.findByTestId("todo-resolving")
    const before = listWorkItems.mock.calls.filter(isResolverCall).length
    view.unmount()
    act(() => release?.())
    await new Promise((r) => setTimeout(r, 30))
    expect(listWorkItems.mock.calls.filter(isResolverCall).length).toBe(before)
  })
})
