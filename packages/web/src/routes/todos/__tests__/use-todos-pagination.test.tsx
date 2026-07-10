import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkItemCompactWire } from "@/lib/api"

/* QA 2026-07-10 — incremental pagination contract. Every ledger request is ONE
 * fixed-size page; "Show N more" appends the NEXT server page (offset=20, 40,
 * …) instead of refetching the already-loaded rows with a growing limit. A
 * date-filtered search carries since AND until AND the page offset, so a
 * >20-match window returns every page. */

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    listWorkItems: (...a: unknown[]) => listWorkItems(...a),
    searchWorkItems: (...a: unknown[]) => searchWorkItems(...a),
  },
}))

const { fetchStatusPage, useLedgerItems, LEDGER_PAGE_SIZE } = await import("../use-todos")

const NOW = Date.parse("2026-07-10T12:00:00.000Z")

function row(id: string, status = "backlog"): WorkItemCompactWire {
  return {
    id,
    title: id,
    status: status as WorkItemCompactWire["status"],
    assignee: null,
    department: null,
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    updatedAt: "2026-07-10T10:00:00.000Z",
    rank: null,
  }
}

/** A paging fixture: `count` rows of one status served in fixed-size pages. */
function servePages(ids: string[]) {
  return ({ offset = 0, limit }: { offset?: number; limit: number }) => {
    const slice = ids.slice(offset, offset + limit)
    const consumed = offset + slice.length
    return Promise.resolve({
      workItems: slice.map((id) => row(id)),
      total: ids.length,
      nextOffset: slice.length > 0 && consumed < ids.length ? consumed : null,
    })
  }
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe("fetchStatusPage (one fixed-size page per request)", () => {
  beforeEach(() => {
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
  })

  it("requests exactly one page at the given offset with the fixed page size", async () => {
    listWorkItems.mockImplementation(servePages(Array.from({ length: 27 }, (_, i) => `wi_${i}`)))
    const page = await fetchStatusPage("backlog", { status: "open" }, undefined, undefined, 20)
    expect(listWorkItems).toHaveBeenCalledTimes(1)
    expect(listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ status: "backlog", offset: 20, limit: LEDGER_PAGE_SIZE }),
    )
    expect(page.workItems).toHaveLength(7)
    expect(page.total).toBe(27)
    expect(page.nextOffset).toBeNull()
  })

  it("sends since AND until AND the offset on a date-filtered search", async () => {
    searchWorkItems.mockImplementation(servePages(["hit"]))
    await fetchStatusPage(
      "backlog",
      { status: "open", q: "digest", date: "week" },
      "2026-07-04T00:00:00.000Z",
      "2026-07-10T12:00:00.000Z",
      40,
    )
    expect(listWorkItems).not.toHaveBeenCalled()
    expect(searchWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "digest",
        status: "backlog",
        since: "2026-07-04T00:00:00.000Z",
        until: "2026-07-10T12:00:00.000Z",
        offset: 40,
        limit: LEDGER_PAGE_SIZE,
      }),
    )
  })
})

describe("useLedgerItems (Show-more appends the next page)", () => {
  beforeEach(() => {
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
  })

  it("loadMore fetches offset=20 with the fixed page size — never a refetch of page one", async () => {
    const ids = Array.from({ length: 27 }, (_, i) => `wi_${i}`)
    const backlogPages = servePages(ids)
    listWorkItems.mockImplementation((params: { status?: string; offset?: number; limit: number }) =>
      params.status === "backlog" ? backlogPages(params) : Promise.resolve({ workItems: [], total: 0, nextOffset: null }),
    )

    const { result } = renderHook(() => useLedgerItems({ status: "open" }, NOW), { wrapper })
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(result.current.data!.items).toHaveLength(20)
    expect(result.current.data!.totalsByStatus.backlog).toBe(27)

    const callsBefore = listWorkItems.mock.calls.length
    act(() => result.current.loadMore(["backlog"]))
    await waitFor(() => expect(result.current.data!.items).toHaveLength(27))

    // Exactly ONE new request, for the NEXT page — offset 20, fixed size.
    const newCalls = listWorkItems.mock.calls.slice(callsBefore)
    expect(newCalls).toHaveLength(1)
    expect(newCalls[0][0]).toEqual(expect.objectContaining({ status: "backlog", offset: 20, limit: LEDGER_PAGE_SIZE }))
    // No request in the whole session ever asked for more than one page.
    for (const [params] of listWorkItems.mock.calls) {
      expect((params as { limit: number }).limit).toBe(LEDGER_PAGE_SIZE)
    }
    expect(result.current.data!.totalsByStatus.backlog).toBe(27)
  })

  it("a >20-match date-filtered search pages through every match", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `hit_${i}`)
    const pages = servePages(ids)
    searchWorkItems.mockImplementation((params: { status?: string; offset?: number; limit: number }) =>
      params.status === "backlog" ? pages(params) : Promise.resolve({ workItems: [], total: 0, nextOffset: null }),
    )

    const { result } = renderHook(
      () => useLedgerItems({ status: "open", q: "digest", date: "week" }, NOW),
      { wrapper },
    )
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(result.current.data!.items).toHaveLength(20)

    act(() => result.current.loadMore(["backlog"]))
    await waitFor(() => expect(result.current.data!.items).toHaveLength(25))

    // Both pages were bounded on both sides and paged by offset.
    for (const [params] of searchWorkItems.mock.calls.filter(([p]) => (p as { status?: string }).status === "backlog")) {
      expect(params).toEqual(
        expect.objectContaining({ text: "digest", since: expect.any(String), until: expect.any(String) }),
      )
    }
    expect(searchWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 }))
  })
})
