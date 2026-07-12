import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire } from "@/lib/api"
import { DetailSheet, selectLinkedSession, sessionLinkLabel } from "../detail-sheet"
import { persistTodoJournal } from "../todo-private-state"

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
    version: 7,
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

function editResult(item: WorkItemFullWire, patch: Record<string, unknown>, version: number, replayed = false) {
  const editable = { ...patch }
  delete editable.expectedVersion
  delete editable.idempotencyKey
  return {
    workItem: { ...item, ...editable, version },
    replayed,
  }
}

function patchBodies(): Array<Record<string, unknown>> {
  return authFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
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
    sessionStorage.clear()
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
        return new Response(JSON.stringify(editResult(value.workItem, JSON.parse(String(init.body)), 8)), { status: 200, headers: { "Content-Type": "application/json" } })
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
        return new Response(JSON.stringify(editResult(value.workItem, patch, patches.length + 7)), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value, onClose)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "First title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await waitFor(() => expect(patches.map(({ title }) => ({ title }))).toEqual([{ title: "First title" }]))

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Latest title" } })
    expect(onClose).not.toHaveBeenCalled()

    finishFirst()
    await waitFor(() => expect(patches.map(({ title }) => ({ title }))).toEqual([{ title: "First title" }, { title: "Latest title" }]))
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

  it("blocks automatic close for a recovered same-field conflict and reloads the remote value explicitly", async () => {
    const value = detail("backlog")
    const remote = detail("backlog")
    remote.workItem.title = "Remote acknowledged title"
    remote.workItem.version = 8
    remote.workItem.updatedAt = "2026-07-12T12:00:00.000Z"
    persistTodoJournal(value.workItem.id, {
      revision: 1,
      patch: { title: "Recovered local title" },
      baseline: { title: value.workItem.title },
      baselineVersion: value.workItem.version,
    })
    const onClose = vi.fn()
    authFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      return new Response(JSON.stringify(remote), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(remote, onClose)

    expect(await screen.findByRole("status", { name: "Todo changed elsewhere" })).toBeTruthy()
    expect(screen.getByText("Recovered local title")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(authFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0)

    fireEvent.click(screen.getByRole("button", { name: "Reload remote" }))
    expect(await screen.findByText("Remote acknowledged title")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Todo changed elsewhere" })).toBeNull()
  })

  it("preflight-refetches before an explicit overwrite of a recovered same-field conflict", async () => {
    const value = detail("backlog")
    const remote = detail("backlog")
    remote.workItem.title = "Remote acknowledged title"
    remote.workItem.version = 8
    remote.workItem.updatedAt = "2026-07-12T12:00:00.000Z"
    persistTodoJournal(value.workItem.id, {
      revision: 1,
      patch: { title: "Recovered local title" },
      baseline: { title: value.workItem.title },
      baselineVersion: value.workItem.version,
    })
    const calls: string[] = []
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        calls.push("patch")
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>
        const result = editResult(remote.workItem, patch, 9)
        Object.assign(remote.workItem, result.workItem, { updatedAt: "2026-07-12T12:01:00.000Z" })
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      calls.push("get")
      return new Response(JSON.stringify(remote), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(remote)

    expect(await screen.findByRole("status", { name: "Todo changed elsewhere" })).toBeTruthy()
    calls.length = 0
    fireEvent.click(screen.getByRole("button", { name: "Overwrite remote" }))

    await waitFor(() => expect(calls).toEqual(expect.arrayContaining(["get", "patch"])))
    expect(calls.indexOf("get")).toBeLessThan(calls.indexOf("patch"))
    const body = JSON.parse(String((authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")?.[1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({ title: "Recovered local title", expectedVersion: 8 })
    expect(body.idempotencyKey).toEqual(expect.any(String))
  })

  it("sends the detail's numeric version and immutable key, never updatedAt", async () => {
    const value = detail("backlog")
    value.workItem.version = 41
    value.workItem.updatedAt = "2099-12-31T23:59:59.999Z"
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>
        return new Response(JSON.stringify(editResult(value.workItem, patch, 42)), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Conditional title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    await waitFor(() => expect(patchBodies()).toHaveLength(1))
    expect(patchBodies()[0]).toMatchObject({ title: "Conditional title", expectedVersion: 41 })
    expect(patchBodies()[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(JSON.stringify(patchBodies()[0])).not.toContain(value.workItem.updatedAt)
    const firstPatch = authFetch.mock.calls.findIndex(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    const firstDetailRead = authFetch.mock.calls.findIndex(([path, init]) =>
      String(path).endsWith(`/api/work-items/${value.workItem.id}`)
      && !(init as RequestInit | undefined)?.method)
    expect(firstPatch).toBeGreaterThanOrEqual(0)
    expect(firstDetailRead === -1 || firstDetailRead > firstPatch).toBe(true)
  })

  it("exact-replays one lost-response request without a blind transport retry", async () => {
    const value = detail("backlog")
    let attempts = 0
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        attempts += 1
        if (attempts === 1) throw new TypeError("network response was lost")
        return new Response(JSON.stringify(editResult(value.workItem, JSON.parse(String(init.body)), 8, true)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Replay me exactly" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    await screen.findByRole("button", { name: "Retry" })
    expect(patchBodies()).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(patchBodies()).toHaveLength(2))
    expect(patchBodies()[1]).toEqual(patchBodies()[0])
  })

  it("rebases unrelated edits on a freshly loaded version with a new request key", async () => {
    const value = detail("backlog")
    const remote = detail("backlog")
    remote.workItem.version = 8
    remote.workItem.priority = 3
    let patchAttempt = 0
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        patchAttempt += 1
        if (patchAttempt === 1) {
          return new Response(JSON.stringify({
            code: "todo_version_conflict",
            currentVersion: 8,
            error: "private conflict wi_never_render",
          }), { status: 409, headers: { "Content-Type": "application/json" } })
        }
        return new Response(JSON.stringify(editResult(remote.workItem, JSON.parse(String(init.body)), 9)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(remote), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Keep my title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByRole("status", { name: "Todo changed elsewhere" })

    const first = patchBodies()[0]
    fireEvent.click(screen.getByRole("button", { name: "Rebase edits" }))
    await waitFor(() => expect(patchBodies()).toHaveLength(2))
    const rebased = patchBodies()[1]
    expect(rebased).toMatchObject({ title: "Keep my title", expectedVersion: 8 })
    expect(rebased).not.toHaveProperty("priority")
    expect(rebased.idempotencyKey).not.toBe(first.idempotencyKey)
    await waitFor(() => expect(screen.queryByRole("status", { name: "Todo changed elsewhere" })).toBeNull())
  })

  it("keeps a same-field conflict blocked after Rebase and names the field", async () => {
    const value = detail("backlog")
    const remote = detail("backlog")
    remote.workItem.version = 8
    remote.workItem.title = "Remote title"
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ code: "todo_version_conflict", currentVersion: 8, error: "hidden" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(remote), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Local title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByRole("status", { name: "Todo changed elsewhere" })
    fireEvent.click(screen.getByRole("button", { name: "Rebase edits" }))

    expect(await screen.findByText("Title still conflicts")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Rebase edits" })).toBeNull()
    expect(patchBodies()).toHaveLength(1)
  })

  it("rejects an unversioned reconciliation read before it can replace the authoritative cache", async () => {
    const value = detail("backlog")
    const invalid = detail("backlog")
    delete invalid.workItem.version
    let conflicted = false
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH" && !conflicted) {
        conflicted = true
        return new Response(JSON.stringify({ code: "todo_version_conflict", currentVersion: 8, error: "hidden" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(invalid), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    const { client } = renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Local title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByRole("status", { name: "Todo changed elsewhere" })
    fireEvent.click(screen.getByRole("button", { name: "Rebase edits" }))

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't rebase these edits")
    expect((client.getQueryData<WorkItemDetailWire>(["work-item", value.workItem.id]))?.workItem.version).toBe(7)
    expect(patchBodies()).toHaveLength(1)
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
    expect(error.textContent).toContain("explicit operator authority")
    expect(error.textContent).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it.each([
    "SQLITE_BUSY /srv/private.db token=supersecret",
    "Error: connector slack failed at /opt/gateway/connectors.ts:42",
    "<pre>stack trace\nAuthorization: Bearer private-token</pre>",
  ])("never renders arbitrary backend diagnostics: %s", async (diagnostic) => {
    const value = detail("escalated")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: diagnostic }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Cancel Todo" }))
    const error = await screen.findByRole("alert")
    expect(error.textContent).toContain("Couldn't update status")
    expect(error.textContent).not.toContain(diagnostic)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toContain(diagnostic)
  })

  it.each([
    "SQLITE_BUSY /srv/private.db token=supersecret",
    "Error: connector failed at /opt/gateway/patch.ts:42",
    "<pre>stack trace\nAuthorization: Bearer private-token</pre>",
  ])("never renders arbitrary PATCH diagnostics in visible or accessible output: %s", async (diagnostic) => {
    const value = detail("backlog")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: diagnostic }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Rejected title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    const error = await screen.findByRole("alert")
    expect(error.textContent).toContain("Couldn't save")
    expect(error.textContent).not.toContain(diagnostic)
    expect(error.getAttribute("aria-label") ?? "").not.toContain(diagnostic)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toContain(diagnostic)
  })

  it("keeps a typed PATCH 403 actionable without rendering its diagnostic", async () => {
    const value = detail("backlog")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          code: "WORK_ITEM_APPROVAL_PENDING",
          error: "private approval payload wi_hidden_patch",
        }), { status: 403, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Rejected title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    const error = await screen.findByRole("alert")
    expect(error.textContent).toContain("awaiting approval")
    expect(error.textContent).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(error.textContent).not.toContain("private approval payload")
  })

  it.each([409, 412])("promotes a typed PATCH %s conflict to explicit conflict actions", async (status) => {
    const value = detail("backlog")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          code: status === 409 ? "todo_version_conflict" : "WORK_ITEM_VERSION_CONFLICT",
          currentVersion: 9,
          error: "private conflict payload wi_hidden_conflict",
        }), { status, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Conflicting title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    expect(await screen.findByRole("status", { name: "Todo changed elsewhere" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reload remote" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Rebase edits" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Overwrite remote" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toContain("private conflict payload")
  })

  it("preflights Overwrite, rotates the key, and keeps a second conflict mounted", async () => {
    const value = detail("backlog")
    const remote = detail("backlog")
    remote.workItem.version = 8
    remote.workItem.title = "Remote title"
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          code: "todo_version_conflict",
          currentVersion: Number(remote.workItem.version) + 1,
          error: "conflict wi_private_payload",
        }), { status: 409, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(remote), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Explicit local title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })
    await screen.findByRole("status", { name: "Todo changed elsewhere" })
    const original = patchBodies()[0]

    fireEvent.click(screen.getByRole("button", { name: "Overwrite remote" }))
    await waitFor(() => expect(patchBodies()).toHaveLength(2))
    expect(patchBodies()[1]).toMatchObject({ title: "Explicit local title", expectedVersion: 8 })
    expect(patchBodies()[1].idempotencyKey).not.toBe(original.idempotencyKey)
    expect(await screen.findByRole("status", { name: "Todo changed elsewhere" })).toBeTruthy()
    expect(screen.getByTestId("detail-sheet").innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it.each([
    [400, "todo_invalid_patch", "invalid"],
    [403, "work_item_approval_pending", "awaiting approval"],
    [428, "todo_precondition_required", "requires a current version"],
  ] as const)("maps typed PATCH %s errors to safe actionable copy", async (status, code, copy) => {
    const value = detail("backlog")
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          code,
          error: "SQLITE /private/path token=secret wi_hidden_error connector stack",
        }), { status, headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }))
    fireEvent.change(screen.getByTestId("sheet-title-edit"), { target: { value: "Rejected title" } })
    fireEvent.keyDown(screen.getByTestId("sheet-title-edit"), { key: "Enter" })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent?.toLowerCase()).toContain(copy)
    expect(alert.textContent).not.toMatch(/wi_[a-z0-9_-]+|SQLITE|private\/path|token=|connector|stack/i)
    expect(alert.getAttribute("aria-label") ?? "").not.toMatch(/wi_[a-z0-9_-]+|token=/i)
  })

  it("prioritizes recoverable journal cleanup over conflict actions", async () => {
    const value = detail("backlog")
    persistTodoJournal(value.workItem.id, {
      revision: 1,
      patch: { title: "Recovered title" },
      baseline: { title: value.workItem.title },
      baselineVersion: 7,
      conflictFields: ["title"],
      cleanupPending: true,
      cleanupIntentFields: ["title"],
    })
    authFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    renderSheetWithDetail(value)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Couldn't clear this recovered draft")
    expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Todo changed elsewhere" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Overwrite remote" })).toBeNull()
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
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DetailSheet id={value.workItem.id} initial={value} byName={new Map()} resolving={false} onApprove={() => {}} onSendBack={() => {}} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}
