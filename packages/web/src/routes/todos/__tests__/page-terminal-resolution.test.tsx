import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire, WorkItemDetailWire, WorkItemListWire } from "@/lib/api"
import TodosPage from "../page"
import { todoPrivateRef } from "../todo-private-state"

/* Task 10 defect + final hardening: opening an EXISTING Todo (off-page, past the
 * People/Needs caps, or terminal) from a chat activity card must resolve its real
 * detail sheet — never a false "Todo no longer exists" — via an EXHAUSTIVE,
 * healthy-verified private-ref search across ALL statuses. Each page is fully
 * validated (offset + nextOffset present, contiguous progression, rows) BEFORE any
 * match is trusted; the resolver is aborted+removed on any disable; Retry refetches
 * only the exact candidate keys; and no raw id enters the ref-resolve query keys,
 * URL, history, storage, or DOM. */

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

/** Server-contract page (store.ts): total present + stable, offset echoed,
 *  nextOffset = offset + rows.length or null. */
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
function resolverCallCount(): number {
  return listWorkItems.mock.calls.filter(isResolverCall).length
}
function refResolveQueries(client: QueryClient, ref: string) {
  return client.getQueryCache().findAll({ queryKey: ["work-items", "ref-resolve", ref] })
}
/** A mounted disabled observer keeps an IDLE cache entry, so "no query" is the
 *  wrong bar — the real guarantee is that no STALE result/error is cached. */
function noStaleResolverResult(client: QueryClient, ref: string): boolean {
  return refResolveQueries(client, ref).every((q) => q.state.data == null && q.state.status !== "error")
}

interface MockConfig {
  bank?: Record<string, WorkItemCompactWire[]>
  visible?: (p: ListParams) => WorkItemListWire | Promise<WorkItemListWire>
}
function mock(cfg: MockConfig) {
  listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
    if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
    if (signal === undefined) return Promise.resolve(cfg.visible ? cfg.visible(p ?? {}) : EMPTY)
    return Promise.resolve(page(cfg.bank?.[p?.status ?? ""] ?? [], p?.offset ?? 0))
  })
}
/** Resolver returns a single anomalous page for `status`; everything else empty. */
function anomaly(status: string, response: WorkItemListWire) {
  listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
    if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
    if (signal === undefined) return Promise.resolve(EMPTY)
    if (p?.status === status) return Promise.resolve(response)
    return Promise.resolve(EMPTY)
  })
  getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
}
const rows100 = (s: string) => Array.from({ length: 100 }, (_, i) => compact(`wi_${s}_${i}`, "r", s))

let currentSearch = ""
let currentState: unknown = null
let navigateFn: ReturnType<typeof useNavigate>
function RouterProbe() {
  const location = useLocation()
  navigateFn = useNavigate()
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

const tick = () => new Promise((r) => setTimeout(r, 20))

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

  // ── Prior exhaustive/status/privacy behavior (retained) ──
  it("opens an OLD done Todo excluded from the recent-window open lens", async () => {
    const c = compact("wi_old_done", "Shipped last quarter", "done")
    mock({ bank: { done: [c] } })
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
    const keys = refResolveQueries(activeClient, todoPrivateRef("wi_cancelled"))
    expect(keys.length).toBeGreaterThan(0)
    for (const q of keys) expect(JSON.stringify(q.queryKey)).not.toContain("wi_cancelled")
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

  it("resolves an exhaustive match past 5000 rows with no arbitrary cap", async () => {
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

  // ── Fix 1: complete metadata + validate-before-match (dedicated cases) ──
  it("a healthy valid matching page resolves", async () => {
    const c = compact("wi_ok", "Healthy match", "cancelled")
    anomaly("cancelled", { workItems: [c], total: 1, offset: 0, limit: 100, nextOffset: null })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_ok") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Healthy match"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  // ── Fix 1b: enforce consumed rows against the stable total BEFORE any match ──
  it("total 0 with a matching row and a non-null continuation is retryable, never opens", async () => {
    // The server's own total says the status is empty, yet a row + continuation are
    // advertised. Consuming past the stable total is a broken stream — never a match.
    const c = compact("wi_zero_total", "Ghost row on an empty status", "cancelled")
    anomaly("cancelled", { workItems: [c], total: 0, offset: 0, limit: 100, nextOffset: 1 })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_zero_total") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("total 1 with a matching row and a continuation at exact exhaustion is retryable", async () => {
    // pageConsumed === total, yet a non-null nextOffset claims more rows. A
    // continuation advertised at exact exhaustion is a broken stream — retry.
    const c = compact("wi_exact_cont", "Continuation past the last row", "cancelled")
    anomaly("cancelled", { workItems: [c], total: 1, offset: 0, limit: 100, nextOffset: 1 })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_exact_cont") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a healthy match before exhaustion with a valid non-null continuation opens after full page validation", async () => {
    // Full page (100 rows), pageConsumed 100 < total 300, contiguous nextOffset →
    // the page is valid, so the match on it is trustworthy and opens.
    const target = compact("wi_midmatch", "Matched mid-stream", "cancelled")
    anomaly("cancelled", { workItems: [target, ...rows100("cancelled").slice(0, 99)], total: 300, offset: 0, limit: 100, nextOffset: 100 })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_midmatch") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Matched mid-stream"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a healthy match at exact exhaustion with a null continuation opens", async () => {
    // pageConsumed 100 === total 100, nextOffset null → provably exhausted; the
    // match on the final page opens.
    const target = compact("wi_lastmatch", "Matched at exhaustion", "cancelled")
    anomaly("cancelled", { workItems: [...rows100("cancelled").slice(0, 99), target], total: 100, offset: 0, limit: 100, nextOffset: null })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_lastmatch") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Matched at exhaustion"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("an omitted offset field is retryable, never missing", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, limit: 100, nextOffset: 100 } as unknown as WorkItemListWire)
    renderAt({ todoRef: todoPrivateRef("wi_no_offset") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("an omitted nextOffset field is retryable (never coerced to null exhaustion)", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, offset: 0, limit: 100 } as unknown as WorkItemListWire)
    renderAt({ todoRef: todoPrivateRef("wi_no_next") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("both offset and nextOffset omitted is retryable, never missing", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, limit: 100 } as unknown as WorkItemListWire)
    renderAt({ todoRef: todoPrivateRef("wi_no_both") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a MATCHING row on a forward-gap page does NOT open — it is retryable", async () => {
    const target = compact("wi_gapmatch", "Should not open on a bad page", "done")
    // Matching row present, but nextOffset jumps past offset+len → page invalid.
    anomaly("done", { workItems: [target, ...rows100("done").slice(0, 99)], total: 999, offset: 0, limit: 100, nextOffset: 250 })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_gapmatch") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a MATCHING row on a truncated (exhaustion-invalid) page does NOT open — it is retryable", async () => {
    const target = compact("wi_truncmatch", "Should not open on truncation", "done")
    anomaly("done", { workItems: [target], total: 500, offset: 0, limit: 100, nextOffset: null })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_truncmatch") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  it("a MATCHING row on a malformed page does NOT open — it is retryable", async () => {
    const target = compact("wi_malmatch", "Should not open on malformed", "done")
    anomaly("done", { workItems: [target, { title: "no id" } as unknown as WorkItemCompactWire], total: 2, offset: 0, limit: 100, nextOffset: null })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_malmatch") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  it("a forward gap (no match) is retryable, never missing", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, offset: 0, limit: 100, nextOffset: 250 })
    renderAt({ todoRef: todoPrivateRef("wi_gap") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a repeated/cyclic nextOffset is retryable, never missing", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, offset: 0, limit: 100, nextOffset: 0 })
    renderAt({ todoRef: todoPrivateRef("wi_cyc") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a genuine second-page decreasing nextOffset is retryable, never missing", async () => {
    // Page 1 is fully healthy (offset 0 → nextOffset 100); page 2 then advertises a
    // DECREASING nextOffset (100 → 50) — a broken continuation caught only AFTER the
    // first page validated and advanced. This is NOT an initial offset mismatch.
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "done") return Promise.resolve(EMPTY)
      const offset = p?.offset ?? 0
      // Unique ids per page (no duplicate-id trip); only the continuation breaks.
      const rows = Array.from({ length: 100 }, (_, i) => compact(`wi_dec_${offset}_${i}`, "d", "done"))
      return Promise.resolve({ workItems: rows, total: 300, offset, limit: 100, nextOffset: offset === 0 ? 100 : 50 })
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "done")))
    renderAt({ todoRef: todoPrivateRef("wi_dec") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("an offset-metadata mismatch is retryable, never missing", async () => {
    anomaly("done", { workItems: rows100("done"), total: 999, offset: 7, limit: 100, nextOffset: 100 })
    renderAt({ todoRef: todoPrivateRef("wi_offmm") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a changing total mid-traversal is retryable, never missing (isolated from duplicate detection)", async () => {
    let call = 0
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "done") return Promise.resolve(EMPTY)
      call += 1
      const offset = p?.offset ?? 0
      // Unique ids each page (no duplicates), only the TOTAL shifts.
      const rows = Array.from({ length: 100 }, (_, i) => compact(`wi_tot_${offset}_${i}`, "t", "done"))
      return Promise.resolve({ workItems: rows, total: call === 1 ? 300 : 250, offset, limit: 100, nextOffset: offset + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "done")))
    renderAt({ todoRef: todoPrivateRef("wi_total") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a duplicate id across pages is retryable, never missing (isolated from total change)", async () => {
    const dup = compact("wi_dup", "dup", "done")
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined) return Promise.resolve(EMPTY)
      if (p?.status !== "done") return Promise.resolve(EMPTY)
      const offset = p?.offset ?? 0
      // Same `dup` id on every page; total stays STABLE at 400.
      return Promise.resolve({ workItems: [dup, ...rows100("done").slice(0, 99)], total: 400, offset, limit: 100, nextOffset: offset + 100 })
    })
    getWorkItem.mockResolvedValue(detailOf(dup))
    renderAt({ todoRef: todoPrivateRef("wi_never") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("the runaway page budget is retryable incomplete, never missing", async () => {
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

  // ── Fix 2: disable → abort + remove, no later calls, no stale open/missing ──
  async function inFlightResolver(ref: string) {
    // Resolver hangs on `backlog`; capture its signal. People resolves initially.
    let lastSignal: AbortSignal | undefined
    let releaseBacklog: (() => void) | null = null
    let peopleHang = false
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal !== undefined) {
        lastSignal = signal
        if (p?.status === "backlog") return new Promise<WorkItemListWire>((res) => { releaseBacklog = () => res(page([], 0)) })
        return Promise.resolve(EMPTY)
      }
      if (p?.limit === 100 && peopleHang) return new Promise<WorkItemListWire>(() => {}) // People refetch hangs
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "backlog")))
    const view = renderAt({ todoRef: ref })
    // Wait until the resolver is genuinely IN-FLIGHT on backlog (signal captured),
    // not merely the candidate-settling "Finding…" state.
    await waitFor(() => expect(lastSignal).toBeDefined())
    return {
      view,
      signal: () => lastSignal,
      releaseBacklog: () => releaseBacklog?.(),
      hangPeople: () => { peopleHang = true },
    }
  }

  it("a People refetch abort+removes the in-flight resolver, with no later calls or stale open", async () => {
    const ref = todoPrivateRef("wi_people")
    const h = await inFlightResolver(ref)
    const before = resolverCallCount()
    act(() => h.hangPeople())
    await act(async () => { void activeClient.refetchQueries({ queryKey: ["work-items", "people-open"] }); await tick() })
    expect(h.signal()?.aborted).toBe(true)
    expect(noStaleResolverResult(activeClient, ref)).toBe(true)
    act(() => h.releaseBacklog())
    await tick()
    expect(resolverCallCount()).toBe(before)
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("a ledger refetch abort+removes the in-flight resolver", async () => {
    const ref = todoPrivateRef("wi_ledger")
    // Reuse the People harness but disable via the ledger key instead.
    let lastSignal: AbortSignal | undefined
    let releaseBacklog: (() => void) | null = null
    let ledgerHang = false
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal !== undefined) {
        lastSignal = signal
        if (p?.status === "backlog") return new Promise<WorkItemListWire>((res) => { releaseBacklog = () => res(page([], 0)) })
        return Promise.resolve(EMPTY)
      }
      if (p?.limit === 20 && ledgerHang) return new Promise<WorkItemListWire>(() => {})
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "backlog")))
    renderAt({ todoRef: ref })
    await waitFor(() => expect(lastSignal).toBeDefined())
    act(() => { ledgerHang = true })
    await act(async () => { void activeClient.refetchQueries({ queryKey: ["work-items", "ledger"] }); await tick() })
    expect(lastSignal?.aborted).toBe(true)
    expect(noStaleResolverResult(activeClient, ref)).toBe(true)
    act(() => releaseBacklog?.())
  })

  it("a late active candidate abort+removes the resolver and wins, with no missing", async () => {
    const ref = todoPrivateRef("wi_late")
    const target = compact("wi_late", "Late active winner", "backlog")
    let lastSignal: AbortSignal | undefined
    let releaseBacklog: (() => void) | null = null
    let candidateArrived = false
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal !== undefined) {
        lastSignal = signal
        if (p?.status === "backlog") return new Promise<WorkItemListWire>((res) => { releaseBacklog = () => res(page([], 0)) })
        return Promise.resolve(EMPTY)
      }
      // Ledger backlog (limit 20) initially empty; after refetch it holds the target.
      if (p?.limit === 20 && p?.status === "backlog" && candidateArrived) return Promise.resolve(page([target], p?.offset ?? 0))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: ref })
    await waitFor(() => expect(lastSignal).toBeDefined())
    act(() => { candidateArrived = true })
    await act(async () => { void activeClient.refetchQueries({ queryKey: ["work-items", "ledger"] }); await tick() })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Late active winner"))
    expect(lastSignal?.aborted).toBe(true)
    expect(noStaleResolverResult(activeClient, ref)).toBe(true)
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    act(() => releaseBacklog?.())
  })

  it("a ref change aborts + removes the OLD ref's resolver (no stale result)", async () => {
    const oldRef = todoPrivateRef("wi_oldref")
    const h = await inFlightResolver(oldRef)
    const oldSignal = h.signal() // capture BEFORE the new ref overwrites lastSignal
    act(() => navigateFn("/todos", { state: { todoRef: todoPrivateRef("wi_newref") } }))
    await tick()
    expect(oldSignal?.aborted).toBe(true)
    expect(noStaleResolverResult(activeClient, oldRef)).toBe(true)
    act(() => h.releaseBacklog())
  })

  it("aborts the resolver on unmount with no later resolver calls", async () => {
    const ref = todoPrivateRef("wi_unmount")
    const h = await inFlightResolver(ref)
    const before = resolverCallCount()
    act(() => h.view.unmount())
    await tick()
    expect(h.signal()?.aborted).toBe(true)
    act(() => h.releaseBacklog())
    await tick()
    expect(resolverCallCount()).toBe(before)
  })

  // ── Fix 3: candidate-first Retry ──
  it("Retry that finds an active candidate makes ZERO resolver calls", async () => {
    const target = compact("wi_retry_active", "Found by candidate", "backlog")
    let candidateReady = false
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal !== undefined) return Promise.reject(new Error("offline")) // resolver errors first
      if (p?.limit === 20 && p?.status === "backlog" && candidateReady) return Promise.resolve(page([target], p?.offset ?? 0))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(target))
    renderAt({ todoRef: todoPrivateRef("wi_retry_active") })
    const retry = await screen.findByTestId("todo-resolve-retry")
    const before = resolverCallCount()
    act(() => { candidateReady = true })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Found by candidate"))
    expect(resolverCallCount()).toBe(before) // no resolver request once a candidate resolves
  })

  it("Retry with empty healthy candidates runs one fresh traversal and resolves", async () => {
    let attempt = 0
    const c = compact("wi_retry_empty", "Recovered on retry", "cancelled")
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
    renderAt({ todoRef: todoPrivateRef("wi_retry_empty") })
    const retry = await screen.findByTestId("todo-resolve-retry")
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recovered on retry"))
  })

  it("Retry refetches ONLY the candidate keys, not unrelated work-item queries", async () => {
    mock({})
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
    // Force a candidate-source error so the retry dialog appears.
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined && p?.limit === 20 && p?.status === "backlog") return Promise.reject(new Error("offline"))
      if (signal === undefined) return Promise.resolve(EMPTY)
      return Promise.resolve(EMPTY)
    })
    renderAt({ todoRef: todoPrivateRef("wi_scope") })
    const unrelated = vi.fn().mockResolvedValue({ ok: true })
    activeClient.setQueryData(["work-items", "unrelated-widget"], { ok: true })
    activeClient.getQueryCache().build(activeClient, { queryKey: ["work-items", "unrelated-widget"], queryFn: unrelated })
    const retry = await screen.findByTestId("todo-resolve-retry")
    fireEvent.click(retry)
    await tick()
    expect(unrelated).not.toHaveBeenCalled()
  })

  // ── Fix 4: EXACT candidate-key retry scope (no broad needs-attention/ledger sweep) ──
  it("Retry does not refetch an unrelated active needs-attention query for another person", async () => {
    // Candidate sources healthy+empty; the resolver errors so the Retry dialog shows.
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor === "me") return Promise.resolve(EMPTY)
      if (signal !== undefined) return Promise.reject(new Error("offline"))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
    renderAt({ todoRef: todoPrivateRef("wi_scope_person") })
    // An unrelated, ACTIVE needs-attention query for a DIFFERENT person.
    const otherPerson = vi.fn().mockResolvedValue([])
    const observer = new QueryObserver(activeClient, {
      queryKey: ["work-items", "needs-attention", "someone-else"],
      queryFn: otherPerson,
      staleTime: 0,
    })
    const unsub = observer.subscribe(() => {})
    await waitFor(() => expect(otherPerson).toHaveBeenCalledTimes(1))
    otherPerson.mockClear()
    const retry = await screen.findByTestId("todo-resolve-retry")
    fireEvent.click(retry)
    await tick()
    expect(otherPerson).not.toHaveBeenCalled()
    unsub()
  })

  it("Retry refetches the exact candidate keys and runs exactly one fresh resolver traversal", async () => {
    let attempt = 0
    const c = compact("wi_scope_recover", "Recovered after scoped retry", "cancelled")
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
    renderAt({ todoRef: todoPrivateRef("wi_scope_recover") })
    const retry = await screen.findByTestId("todo-resolve-retry")

    const visible = (pred: (p: ListParams) => boolean) =>
      listWorkItems.mock.calls.filter(([p, sig]) => sig === undefined && pred((p ?? {}) as ListParams)).length
    // A traversal always begins with a resolver call for the FIRST status at offset 0.
    const traversals = () =>
      listWorkItems.mock.calls.filter(([p, sig]) => sig !== undefined && (p as ListParams)?.status === "backlog" && (((p as ListParams)?.offset ?? 0) === 0)).length
    const beforeMe = visible((p) => p?.needsAttentionFor === "me")
    const beforePeople = visible((p) => !p?.needsAttentionFor && p?.limit === 100)
    const beforeLedger = visible((p) => p?.limit === 20)
    const beforeTraversals = traversals()

    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recovered after scoped retry"))

    // Exact candidate keys refetched: needs-attention/me, people-open, mounted ledger.
    expect(visible((p) => p?.needsAttentionFor === "me")).toBeGreaterThan(beforeMe)
    expect(visible((p) => !p?.needsAttentionFor && p?.limit === 100)).toBeGreaterThan(beforePeople)
    expect(visible((p) => p?.limit === 20)).toBeGreaterThan(beforeLedger)
    // Exactly one fresh traversal, not two.
    expect(traversals()).toBe(beforeTraversals + 1)
  })

  it("dropping one ref's resolver leaves a sibling ref-resolve query untouched", async () => {
    const target = compact("wi_sibling_active", "Active candidate wins", "backlog")
    let lastSignal: AbortSignal | undefined
    let releaseBacklog: (() => void) | null = null
    let candidateArrived = false
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal !== undefined) {
        lastSignal = signal
        if (p?.status === "backlog") return new Promise<WorkItemListWire>((res) => { releaseBacklog = () => res(page([], 0)) })
        return Promise.resolve(EMPTY)
      }
      if (p?.limit === 20 && p?.status === "backlog" && candidateArrived) return Promise.resolve(page([target], p?.offset ?? 0))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(target))
    const siblingRef = todoPrivateRef("wi_sibling_other")
    renderAt({ todoRef: todoPrivateRef("wi_sibling_active") })
    await waitFor(() => expect(lastSignal).toBeDefined())
    // Seed an unrelated sibling ref-resolve cache entry that must survive the drop.
    activeClient.setQueryData(["work-items", "ref-resolve", siblingRef], "wi_sibling_other")
    // A candidate now resolves the CURRENT ref → its resolver is dropped (cancel+remove).
    act(() => { candidateArrived = true })
    await act(async () => { void activeClient.refetchQueries({ queryKey: ["work-items", "ledger"] }); await tick() })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Active candidate wins"))
    // The sibling ref's cached resolution must be left intact by the exact-scoped drop.
    expect(activeClient.getQueryData(["work-items", "ref-resolve", siblingRef])).toBe("wi_sibling_other")
    act(() => releaseBacklog?.())
  })

  // ── Whole-pipeline visible state ──
  it("shows 'Finding this Todo…' while a candidate source is still hung, never a premature missing", async () => {
    let releaseBase: (() => void) | null = null
    listWorkItems.mockImplementation((p?: ListParams, signal?: AbortSignal) => {
      if (p?.needsAttentionFor) return Promise.resolve(EMPTY)
      if (signal === undefined && p?.status === "backlog" && p?.limit === 20) return new Promise((res) => { releaseBase = () => res(EMPTY) })
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
      if (signal === undefined && p?.status === "backlog" && p?.limit === 20) return Promise.reject(new Error("offline"))
      return Promise.resolve(EMPTY)
    })
    getWorkItem.mockResolvedValue(detailOf(compact("x", "x", "cancelled")))
    renderAt({ todoRef: todoPrivateRef("wi_base_err") })
    expect(await screen.findByTestId("todo-resolve-retry")).toBeTruthy()
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("lets an active-lens candidate win without consulting the resolver", async () => {
    const c = compact("wi_recent", "Recent open item", "backlog")
    mock({ visible: (p) => (p.status === "backlog" && p.limit === 20 ? page([c], p.offset ?? 0) : EMPTY) })
    getWorkItem.mockResolvedValue(detailOf(c))
    renderAt({ todoRef: todoPrivateRef("wi_recent") })
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Recent open item"))
    expect(resolverCallCount()).toBe(0)
  })

  it("runs zero resolver calls when no private ref is present", async () => {
    mock({})
    renderAt(null)
    await waitFor(() => expect(listWorkItems).toHaveBeenCalled())
    expect(resolverCallCount()).toBe(0)
  })
})
