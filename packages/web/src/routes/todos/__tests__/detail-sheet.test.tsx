import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire } from "@/lib/api"
import { DetailSheet, selectLinkedSession, sessionLinkLabel } from "../detail-sheet"

const authFetch = vi.fn()

const todoId: Record<WorkItemStatusWire, string> = {
  backlog: "wi_backlog",
  assigned: "wi_assigned",
  executing: "wi_executing",
  in_review: "wi_review",
  done: "wi_done",
  blocked: "wi_blocked",
  escalated: "wi_escalated",
  cancelled: "wi_cancelled",
}

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

function workItem(status: WorkItemStatusWire): WorkItemFullWire {
  return {
    id: todoId[status],
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
          id={todoId[status]}
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
      `/api/work-items/${todoId[status]}/status`,
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

  it("prefers live work over a newer-looking terminal session", async () => {
    authFetch.mockImplementation(async (path: unknown) => {
      if (String(path ?? "").endsWith("/sessions")) {
        return new Response(JSON.stringify([
          { id: "terminal", status: "idle", lastActivity: "2026-07-12T10:05:00.000Z" },
          { id: "live", status: "waiting", lastActivity: "2026-07-12T10:00:00.000Z" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(detail("executing")), { status: 200, headers: { "Content-Type": "application/json" } })
    })

    renderSheet("executing")

    expect(await screen.findByText("Running session")).toBeTruthy()
    expect(screen.queryByText("Completed session")).toBeNull()
    expect(screen.queryByText("In progress · no execution session")).toBeNull()
  })

  it("chooses a live session first, otherwise the newest defined terminal state", () => {
    const sessions = [
      { id: "older-terminal", status: "interrupted", lastActivity: "2026-07-12T08:00:00.000Z" },
      { id: "newer-terminal", status: "idle", lastActivity: "2026-07-12T09:00:00.000Z" },
      { id: "stale-unknown", status: "starting", lastActivity: "2026-07-12T11:00:00.000Z" },
    ]
    expect(selectLinkedSession(sessions)?.id).toBe("newer-terminal")
    expect(sessionLinkLabel(selectLinkedSession(sessions)!)).toBe("Completed session")
    expect(selectLinkedSession([{ id: "done", status: "idle" }, { id: "resumed", status: "running" }])?.id).toBe("resumed")
    expect(selectLinkedSession([])).toBeUndefined()
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
          <DetailSheet id={extreme.workItem.id} initial={extreme} byName={new Map()} resolving={false} onApprove={() => {}} onSendBack={() => {}} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("detail-overlay").className).toContain("md:bg-transparent")
    expect(screen.getByTestId("detail-sheet").className).toContain("overflow-x-hidden")
    expect(screen.getByTestId("sheet-title").className).toContain("break-words")
    expect(screen.getByTestId("sheet-body").className).toContain("break-words")
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toContain("border-t-[0.5px]")
  })

  it("keeps transport ids out of identity UI, technical disclosures, and test selectors", () => {
    const privateDetail = detail("backlog")
    privateDetail.workItem.id = "wi_private_detail_42"
    privateDetail.workItem.sourceRef = "workflow:wi_private_source:run"
    privateDetail.workItem.approvalState = "pending"
    privateDetail.workItem.approvalRequest = "Review the result"
    privateDetail.workItem.approvalRef = "wi_private_approval"
    renderSheetWithDetail(privateDetail)
    fireEvent.click(screen.getByTestId("tech-disclosure"))
    expect(screen.getByTestId("detail-sheet").textContent).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull()
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

  it("saves an edit made after close was requested before the sheet can close", async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const first = new Promise<void>((resolve) => { finishFirst = resolve })
    const second = new Promise<void>((resolve) => { finishSecond = resolve })
    const value = detail("backlog")
    const onClose = vi.fn()
    const patches: Array<Record<string, unknown>> = []
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>
        patches.push(patch)
        await (patches.length === 1 ? first : second)
        return new Response(JSON.stringify({ workItem: { ...value.workItem, ...patch } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value, onClose)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "First title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await waitFor(() => expect(patches).toEqual([{ title: "First title" }]))

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Latest title" } })
    expect(onClose).not.toHaveBeenCalled()

    finishFirst()
    await waitFor(() => expect(patches).toEqual([{ title: "First title" }, { title: "Latest title" }]))
    expect(onClose).not.toHaveBeenCalled()

    finishSecond()
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

  it("redacts opaque backend ids from a real escalated 403 error surface", async () => {
    const value = detail("escalated")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "Operator cannot cancel work item wi_private_forbidden while approval is pending" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Cancel Todo" }))
    const error = await screen.findByTestId("sheet-save-error")
    expect(error.textContent).toContain("Operator cannot cancel")
    expect(error.textContent).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
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
