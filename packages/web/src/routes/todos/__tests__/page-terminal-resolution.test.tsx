import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire, WorkItemDetailWire } from "@/lib/api"
import TodosPage from "../page"
import { todoPrivateRef } from "../todo-private-state"

/* Task 10 defect: opening an EXISTING terminal (cancelled/done/archived) Todo
 * from a chat activity card false-positived as "Todo no longer exists" because
 * the private-ref resolver only searched the OPEN candidate lists. These pin the
 * bounded terminal resolver without leaking raw ids or broadening the ledger. */

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

function renderAt(state: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: "/todos", state }]}>
        <RouterProbe />
        <TodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Open lists (open statuses + needs + people) are always empty here — the target
// lives only in a terminal status, exactly like the reported defect.
function mockTerminal(items: Record<string, WorkItemCompactWire[]>) {
  listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string; offset?: number }) => {
    if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
    const rows = (params?.status && items[params.status]) || []
    return Promise.resolve({ workItems: rows, total: rows.length, nextOffset: null })
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

  it("opens an existing CANCELLED Todo's real detail sheet, not a missing dialog", async () => {
    const c = compact("wi_cancelled", "Archived release plan", "cancelled")
    mockTerminal({ cancelled: [c] })
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_cancelled") })

    expect(await screen.findByTestId("detail-sheet")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Archived release plan"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
    // The canonical id never enters the URL or history state.
    expect(currentSearch).not.toContain("wi_cancelled")
    expect(JSON.stringify(currentState)).not.toContain("wi_cancelled")
  })

  it("opens an existing DONE terminal Todo excluded from open lists", async () => {
    const c = compact("wi_done", "Shipped the thing", "done")
    mockTerminal({ done: [c] })
    getWorkItem.mockResolvedValue(detailOf(c))

    renderAt({ todoRef: todoPrivateRef("wi_done") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Shipped the thing"))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })

  it("resolves the same terminal Todo on a fresh reload carrying only the private ref", async () => {
    const c = compact("wi_reload", "Reloaded cancelled plan", "cancelled")
    mockTerminal({ cancelled: [c] })
    getWorkItem.mockResolvedValue(detailOf(c))

    // Fresh mount with only the private ref in history state — no stored raw id.
    renderAt({ todoRef: todoPrivateRef("wi_reload") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Reloaded cancelled plan"))
    const persisted = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "").join("\n")
    expect(persisted).not.toMatch(/wi_reload/)
  })

  it("searches terminal pages and resolves a match beyond the first page", async () => {
    const target = compact("wi_page2", "Second page cancelled", "cancelled")
    const filler = Array.from({ length: 100 }, (_, i) => compact(`wi_filler_${i}`, `Filler ${i}`, "cancelled"))
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string; offset?: number }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status !== "cancelled") return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if ((params.offset ?? 0) === 0) return Promise.resolve({ workItems: filler, total: 101, nextOffset: 100 })
      return Promise.resolve({ workItems: [target], total: 101, nextOffset: null })
    })
    getWorkItem.mockResolvedValue(detailOf(target))

    renderAt({ todoRef: todoPrivateRef("wi_page2") })

    await waitFor(() => expect(screen.getByTestId("sheet-title").textContent).toBe("Second page cancelled"))
    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", offset: 100 }))
  })

  it("shows the explicit missing dialog only after the terminal lookup settles empty", async () => {
    mockTerminal({}) // nothing anywhere
    getWorkItem.mockResolvedValue(detailOf(compact("wi_x", "x", "cancelled")))

    renderAt({ todoRef: todoPrivateRef("wi_ghost") })

    expect((await screen.findAllByText("Todo no longer exists")).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  it("does not misreport a terminal-lookup error as missing", async () => {
    listWorkItems.mockImplementation((params?: { status?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      if (params?.status === "done" || params?.status === "cancelled") return Promise.reject(new Error("offline"))
      return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
    })
    getWorkItem.mockResolvedValue(detailOf(compact("wi_x", "x", "cancelled")))

    renderAt({ todoRef: todoPrivateRef("wi_err") })

    // The terminal lookup hits the first terminal status ("done") and rejects;
    // that error must keep the safe state, never the missing dialog.
    await waitFor(() => expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "done" })))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText("Todo no longer exists")).toBeNull()
  })
})
