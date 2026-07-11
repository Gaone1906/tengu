import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire } from "@/lib/api"
import { DetailSheet } from "../detail-sheet"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

function workItem(status: WorkItemStatusWire): WorkItemFullWire {
  return {
    id: `wi_${status}`,
    title: `Todo ${status}`,
    body: null,
    status,
    department: null,
    assignee: null,
    priority: 0,
    source: "human",
    sourceRef: null,
    acceptance: null,
    verifyPolicy: null,
    rounds: 0,
    budgetUsd: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    approvalDecidedBy: null,
    approvalDecidedAt: null,
    createdAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
    closedAt: status === "done" || status === "cancelled" ? "2026-07-11T09:00:00.000Z" : null,
  }
}

function detail(status: WorkItemStatusWire): WorkItemDetailWire {
  return { workItem: workItem(status), spendUsd: 0, workflowRun: null, events: [] }
}

function renderSheet(status: WorkItemStatusWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DetailSheet
          id={`wi_${status}`}
          initial={detail(status)}
          byName={new Map()}
          resolving={false}
          onApprove={() => {}}
          onSendBack={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("Todo detail transition footer", () => {
  beforeEach(() => {
    authFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      const status = JSON.parse(String(init?.body)).status as WorkItemStatusWire
      return new Response(JSON.stringify({ workItem: workItem(status), escalated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  })

  it.each(["backlog", "assigned"] as const)("renders Mark in progress for %s and round-trips executing via PUT", async (status) => {
    renderSheet(status)

    fireEvent.click(screen.getByRole("button", { name: "Mark in progress" }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      `/api/work-items/wi_${status}/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "executing" }),
      },
    ))
  })

  it.each(["executing", "blocked", "in_review", "escalated", "done", "cancelled"] as const)(
    "does not render Mark in progress for %s",
    (status) => {
      renderSheet(status)
      expect(screen.queryByRole("button", { name: "Mark in progress" })).toBeNull()
    },
  )

  it("persists manual progress without implying that a session was dispatched", async () => {
    let persisted: WorkItemStatusWire = "backlog"
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PUT") {
        persisted = JSON.parse(String(init.body)).status as WorkItemStatusWire
        return new Response(JSON.stringify({ workItem: workItem(persisted), escalated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(detail(persisted)), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheet("backlog")

    fireEvent.click(screen.getByRole("button", { name: "Mark in progress" }))

    expect(await screen.findByText("In progress · no execution session")).toBeTruthy()
    expect(persisted).toBe("executing")
    expect(screen.queryByText(/working/i)).toBeNull()
  })
})

describe("Todo detail session link copy", () => {
  beforeEach(() => authFetch.mockReset())

  it.each([
    ["done", "idle", "Completed session"],
    ["cancelled", "interrupted", "Interrupted session"],
    ["executing", "running", "Running session"],
  ] as const)("labels a %s Todo's %s link as %s", async (todoStatus, sessionStatus, expected) => {
    authFetch.mockImplementation(async (path: unknown) => {
      if (String(path ?? "").endsWith("/sessions")) {
        return new Response(JSON.stringify([{ id: `session-${sessionStatus}`, status: sessionStatus }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(detail(todoStatus)), { status: 200, headers: { "Content-Type": "application/json" } })
    })

    renderSheet(todoStatus)

    expect(await screen.findByText(expected)).toBeTruthy()
    expect(screen.queryByText("Executing session")).toBeNull()
  })
})

describe("Todo detail editing and dialog behavior", () => {
  beforeEach(() => {
    authFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      return new Response(JSON.stringify({ workItem: workItem("backlog") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  })

  it("uses a mobile-only scrim, contains long prose, and has no resting property hairlines", () => {
    const extreme = detail("backlog")
    extreme.workItem.title = "A".repeat(500)
    extreme.workItem.body = "B".repeat(1200)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DetailSheet id="wi_backlog" initial={extreme} byName={new Map()} resolving={false} onApprove={() => {}} onSendBack={() => {}} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("detail-overlay").className).toContain("md:bg-transparent")
    expect(screen.getByTestId("detail-sheet").className).toContain("overflow-x-hidden")
    expect(screen.getByTestId("sheet-title").className).toContain("break-words")
    expect(screen.getByTestId("sheet-body").className).toContain("break-words")
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toContain("border-t-[0.5px]")
  })

  it("shows the optional canonical key quietly, supports copy, and never reveals the opaque id", () => {
    const keyed = detail("backlog")
    ;(keyed.workItem as WorkItemFullWire & { key?: string }).key = "JIN-142"
    renderSheetWithDetail(keyed)
    expect(screen.getByText("JIN-142")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy JIN-142" })).toBeTruthy()
    fireEvent.click(screen.getByTestId("tech-disclosure"))
    expect(screen.queryByText(/wi_backlog/)).toBeNull()
  })

  it("keeps a pending title draft mounted until the serialized save completes", async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const value = detail("backlog")
    const onClose = vi.fn()
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        await pending
        return new Response(JSON.stringify({ workItem: { ...value.workItem, title: "Durable title" } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value, onClose)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Durable title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByText("Saving…")
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText("Durable title")).toBeTruthy()

    finish()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("preserves a failed draft behind Retry and requires explicit discard to lose it", async () => {
    const value = detail("backlog")
    const onClose = vi.fn()
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") return new Response(JSON.stringify({ error: "Save failed" }), { status: 500, headers: { "Content-Type": "application/json" } })
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value, onClose)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Still here" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByRole("button", { name: "Retry" })
    expect(screen.getByText("Still here")).toBeTruthy()

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Todo details" }), { key: "Escape" })
    expect(await screen.findByText("Your draft is still here. Retry saving or discard it before closing.")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("uses Escape to cancel a field edit before Escape can close the sheet", () => {
    const onClose = vi.fn()
    renderSheetWithDetail(detail("backlog"), onClose)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    const title = screen.getByTestId("sheet-title-edit")
    fireEvent.change(title, { target: { value: "Temporary title" } })
    fireEvent.keyDown(title, { key: "Escape" })

    expect(screen.queryByTestId("sheet-title-edit")).toBeNull()
    expect(screen.getByText("Todo backlog")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

function renderSheetWithDetail(value: WorkItemDetailWire, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DetailSheet id={value.workItem.id} initial={value} byName={new Map()} resolving={false} onApprove={() => {}} onSendBack={() => {}} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
