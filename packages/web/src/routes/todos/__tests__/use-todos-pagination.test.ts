import { describe, it, expect, vi, beforeEach } from "vitest"
import type { WorkItemCompactWire } from "@/lib/api"

/* QA 2026-07-10 — the 20-cap fix. The ledger fetcher must walk the gateway's
 * nextOffset pages up to the requested `want`, report the TRUE total, and ride
 * the search endpoint (with the date window) when `q` is set. */

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    listWorkItems: (...a: unknown[]) => listWorkItems(...a),
    searchWorkItems: (...a: unknown[]) => searchWorkItems(...a),
  },
}))

const { fetchStatusRows } = await import("../use-todos")

function row(id: string): WorkItemCompactWire {
  return {
    id,
    title: id,
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
    updatedAt: "2026-07-10T10:00:00.000Z",
    rank: null,
  }
}

function page(ids: string[], total: number, nextOffset: number | null) {
  return { workItems: ids.map(row), total, nextOffset, totals: { backlog: total }, limit: ids.length, offset: 0 }
}

describe("fetchStatusRows (nextOffset pagination)", () => {
  beforeEach(() => {
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
  })

  it("walks nextOffset pages until `want` rows are gathered and keeps the true total", async () => {
    const ids = Array.from({ length: 27 }, (_, i) => `wi_${i}`)
    listWorkItems.mockImplementation(({ offset = 0, limit }: { offset?: number; limit: number }) => {
      const slice = ids.slice(offset, offset + Math.min(limit, 20))
      const consumed = offset + slice.length
      return Promise.resolve(page(slice, 27, consumed < 27 ? consumed : null))
    })

    const first = await fetchStatusRows("backlog", { status: "open" }, undefined, 20)
    expect(first.rows).toHaveLength(20)
    expect(first.total).toBe(27)

    const widened = await fetchStatusRows("backlog", { status: "open" }, undefined, 40)
    expect(widened.rows.map((r) => r.id)).toEqual(ids) // all 27 — no silent cap
    expect(widened.total).toBe(27)
    // Second call fetched the subsequent offset, not a re-slice of page one.
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: 20 }))
  })

  it("stops when the gateway reports no next page", async () => {
    listWorkItems.mockResolvedValue(page(["a", "b"], 2, null))
    const r = await fetchStatusRows("backlog", { status: "open" }, undefined, 40)
    expect(r.rows).toHaveLength(2)
    expect(listWorkItems).toHaveBeenCalledTimes(1)
  })

  it("rides the search endpoint with the date window when q is set (server owns title+body matching)", async () => {
    searchWorkItems.mockResolvedValue(page(["hit"], 1, null))
    const r = await fetchStatusRows("backlog", { status: "open", q: "digest", date: "week" }, "2026-07-04T00:00:00.000Z", 20)
    expect(r.rows.map((x) => x.id)).toEqual(["hit"])
    expect(listWorkItems).not.toHaveBeenCalled()
    expect(searchWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ text: "digest", status: "backlog", since: "2026-07-04T00:00:00.000Z", offset: 0 }),
    )
  })
})
