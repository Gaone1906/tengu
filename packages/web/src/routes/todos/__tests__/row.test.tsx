import { describe, it, expect, vi, afterEach } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type {
  WorkItemCompactWire,
  WorkItemDetailWire,
  WorkItemFullWire,
  WorkItemStatusWire,
  LinkedSessionWire,
} from "@/lib/api"
import { TodoRow, executionContext } from "../row"

/* design-todos §4.1 — the flat ledger row. An executing item speaks the
 * StateLine grammar with its run/session ref; a plain Todo shows one line.
 * Titles rename inline: Enter commits, Esc reverts. */

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

function compact(over: Partial<WorkItemCompactWire> = {}): WorkItemCompactWire {
  return {
    id: "wi_private_row_1",
    title: "Publish the weekly digest",
    status: "executing",
    assignee: "jinn-designer",
    department: "platform",
    source: "cron",
    updatedAt: "2026-07-06T11:00:00.000Z",
    ...over,
    sourceRef: over.sourceRef ?? null,
    approvalState: over.approvalState ?? null,
    approvalRequest: over.approvalRequest ?? null,
    approvalRef: over.approvalRef ?? null,
    approvalTarget: over.approvalTarget ?? null,
    approvalEscalatedAt: over.approvalEscalatedAt ?? null,
  }
}

function detailFor(
  status: WorkItemStatusWire,
  workflowRun: { workflowId: string; runId: string } | null,
): WorkItemDetailWire {
  const workItem: WorkItemFullWire = {
    id: "wi_private_row_1",
    title: "Publish the weekly digest",
    body: null,
    status,
    department: "platform",
    assignee: "jinn-designer",
    priority: 2,
    rank: null,
    source: "cron",
    sourceRef: "cron:job:2026",
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
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T11:00:00.000Z",
    closedAt: null,
  }
  return { workItem, spendUsd: 0, workflowRun, events: [] }
}

function renderRow(
  item: WorkItemCompactWire,
  detail?: WorkItemDetailWire,
  handlers: { onOpen?: (id: string) => void; onRename?: (id: string, title: string) => Promise<void> } = {},
) {
  const onOpen = handlers.onOpen ?? vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TodoRow
          item={item}
          detail={detail}
          byName={new Map()}
          onOpen={onOpen}
          onRename={handlers.onRename}
          now={Date.parse("2026-07-06T11:05:00.000Z")}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("TodoRow execution context (render)", () => {
  it("shows changing execution state without run metadata at rest", () => {
    const run = { workflowId: "wf-digest", runId: "run-2026-07-06-abcdef123" }
    renderRow(compact({ status: "executing" }), detailFor("executing", run))

    expect(screen.getByTestId("todo-exec")).toBeTruthy()
    expect(screen.getByText(/^Working/)).toBeTruthy()
    expect(screen.queryByText(/run-2026/i)).toBeNull()
    expect(screen.getByRole("button", { name: "Open workflow run" })).toBeTruthy()
  })

  it("lets the group carry blocked state instead of repeating a row badge", () => {
    const run = { workflowId: "wf-digest", runId: "run-abc" }
    renderRow(compact({ status: "blocked" }), detailFor("blocked", run))

    expect(screen.queryByTestId("todo-exec")).toBeNull()
    expect(screen.queryByText(/^Working/)).toBeNull()
    expect(screen.queryByText("Blocked")).toBeNull()
  })

  it("shows nothing extra on a plain (non-active) Todo with no run", () => {
    renderRow(compact({ status: "assigned" }), detailFor("assigned", null))

    expect(screen.queryByTestId("todo-exec")).toBeNull()
    expect(screen.queryByRole("button", { name: "Open workflow run" })).toBeNull()
  })

  it("opens the sheet from the whole row", () => {
    const onOpen = vi.fn()
    renderRow(compact({ status: "assigned" }), undefined, { onOpen })
    fireEvent.click(screen.getByRole("button", { name: "Open Publish the weekly digest" }))
    expect(onOpen).toHaveBeenCalledWith("wi_private_row_1")
  })

  it("wraps a dominant title and omits source metadata at rest", () => {
    renderRow(compact({ status: "backlog", assignee: null, title: "A deliberately long title that needs another line" }))
    const title = screen.getByText("A deliberately long title that needs another line")
    expect(title.className).toContain("break-words")
    expect(title.className).not.toContain("truncate")
    expect(screen.queryByText("Cron")).toBeNull()
  })

  it("defers canonical key UI until the wire contract owns a dedicated key", () => {
    const item = compact({ id: "future-key-142", status: "backlog" })
    renderRow(item, undefined, { onRename: vi.fn() })
    expect(screen.queryByText("future-key-142")).toBeNull()
    fireEvent.pointerDown(screen.getByRole("button", { name: "Todo actions" }), { button: 0, pointerType: "mouse" })
    expect(screen.queryByRole("menuitem", { name: /Copy/ })).toBeNull()
  })

  it("does not leak opaque work-item ids into rendered row markup", () => {
    const { container } = renderRow(compact({ id: "wi_private_dom_42", status: "backlog" }))
    expect(container.innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("does not open the parent row when %s semantically activates row actions", async (_label, key) => {
    const onOpen = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onOpen, onRename: vi.fn() })
    const user = userEvent.setup()
    const actions = screen.getByRole("button", { name: "Todo actions" })
    actions.focus()
    await user.keyboard(key)
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("opens only the actions surface for a pointer click", async () => {
    const onOpen = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onOpen, onRename: vi.fn() })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Todo actions" }))

    expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe("TodoRow inline rename", () => {
  afterEach(() => vi.useRealTimers())

  it("starts a semantic rename from F2 and commits on Enter", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.keyDown(screen.getByRole("button", { name: "Open Publish the weekly digest" }), { key: "F2" })
    const input = screen.getByTestId("todo-rename")
    fireEvent.change(input, { target: { value: "  Publish the monthly digest " } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onRename).toHaveBeenCalledWith("wi_private_row_1", "Publish the monthly digest")
  })

  it("reverts on Escape without calling onRename", () => {
    const onRename = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.keyDown(screen.getByRole("button", { name: "Open Publish the weekly digest" }), { key: "F2" })
    const input = screen.getByTestId("todo-rename")
    fireEvent.change(input, { target: { value: "Different" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText("Publish the weekly digest")).toBeTruthy()
  })

  it("does not call onRename for an unchanged title", () => {
    const onRename = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.keyDown(screen.getByRole("button", { name: "Open Publish the weekly digest" }), { key: "F2" })
    fireEvent.keyDown(screen.getByTestId("todo-rename"), { key: "Enter" })

    expect(onRename).not.toHaveBeenCalled()
  })

  it("opens an explicit actions menu with Open and Rename", () => {
    renderRow(compact({ status: "backlog" }), undefined, { onRename: vi.fn() })
    fireEvent.pointerDown(screen.getByRole("button", { name: "Todo actions" }), { button: 0, pointerType: "mouse" })
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy()
  })

  it("opens Open, Rename, and Move from a touch long press instead of dragging", async () => {
    vi.useFakeTimers()
    const onOpen = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onOpen, onRename: vi.fn() })
    fireEvent.pointerDown(screen.getByTestId("todo-row"), { pointerType: "touch", clientY: 24 })
    await act(async () => vi.advanceTimersByTimeAsync(450))
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /Move/ })).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe("executionContext (pure)", () => {
  const sessions: LinkedSessionWire[] = [{ id: "sess-123456789", title: "Digest run", status: "running" }]

  it("prefers the workflow run for an active item", () => {
    const ctx = executionContext(compact({ status: "executing" }), detailFor("executing", { workflowId: "wf-x", runId: "run-abc" }))
    expect(ctx).toEqual({ kind: "run", label: "Workflow run", value: "run-abc", href: "/workflow/wf-x" })
  })

  it("falls back to the linked session when there is no run", () => {
    const ctx = executionContext(compact({ status: "executing" }), detailFor("executing", null), sessions)
    expect(ctx).toEqual({ kind: "session", label: "Session", value: "Digest run", href: "/?session=sess-123456789" })
  })

  it("returns null for a non-active status even if a run exists", () => {
    expect(executionContext(compact({ status: "in_review" }), detailFor("in_review", { workflowId: "wf", runId: "run-1" }))).toBeNull()
  })

  it("returns null when detail has not loaded yet (no layout jump)", () => {
    expect(executionContext(compact({ status: "executing" }), undefined)).toBeNull()
  })

  it("returns null for an active item with neither a run nor a session", () => {
    expect(executionContext(compact({ status: "blocked" }), detailFor("blocked", null), [])).toBeNull()
  })
})
