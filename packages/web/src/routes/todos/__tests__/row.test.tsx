import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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
    id: "w1",
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
    id: "w1",
    title: "Publish the weekly digest",
    body: null,
    status,
    department: "platform",
    assignee: "jinn-designer",
    priority: 2,
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
  it("shows the run StateLine on an executing workflow Todo", () => {
    const run = { workflowId: "wf-digest", runId: "run-2026-07-06-abcdef123" }
    renderRow(compact({ status: "executing" }), detailFor("executing", run))

    expect(screen.getByTestId("todo-exec-w1")).toBeTruthy()
    expect(screen.getByText(/^Working/)).toBeTruthy()
    // The long runId is shortened to a calm `prefix…`.
    expect(screen.getByText("Run · run-2026-07-06…")).toBeTruthy()
    expect(screen.getByTestId("todo-exec-open-w1")).toBeTruthy()
  })

  it("keeps the ref line but drops the Working segment on a blocked Todo", () => {
    const run = { workflowId: "wf-digest", runId: "run-abc" }
    renderRow(compact({ status: "blocked" }), detailFor("blocked", run))

    expect(screen.getByTestId("todo-exec-w1")).toBeTruthy()
    expect(screen.queryByText(/^Working/)).toBeNull()
    expect(screen.getByText("Blocked")).toBeTruthy() // attention badge in place
  })

  it("shows nothing extra on a plain (non-active) Todo with no run", () => {
    renderRow(compact({ status: "assigned" }), detailFor("assigned", null))

    expect(screen.queryByTestId("todo-exec-w1")).toBeNull()
    expect(screen.queryByTestId("todo-exec-open-w1")).toBeNull()
  })

  it("opens the sheet from the whole row", () => {
    const onOpen = vi.fn()
    renderRow(compact({ status: "assigned" }), undefined, { onOpen })
    fireEvent.click(screen.getByTestId("todo-row-w1"))
    expect(onOpen).toHaveBeenCalledWith("w1")
  })
})

describe("TodoRow inline rename", () => {
  it("commits on Enter with the trimmed title", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.doubleClick(screen.getByText("Publish the weekly digest"))
    const input = screen.getByTestId("todo-rename-w1")
    fireEvent.change(input, { target: { value: "  Publish the monthly digest " } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onRename).toHaveBeenCalledWith("w1", "Publish the monthly digest")
  })

  it("reverts on Escape without calling onRename", () => {
    const onRename = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.doubleClick(screen.getByText("Publish the weekly digest"))
    const input = screen.getByTestId("todo-rename-w1")
    fireEvent.change(input, { target: { value: "Different" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText("Publish the weekly digest")).toBeTruthy()
  })

  it("does not call onRename for an unchanged title", () => {
    const onRename = vi.fn()
    renderRow(compact({ status: "backlog" }), undefined, { onRename })

    fireEvent.doubleClick(screen.getByText("Publish the weekly digest"))
    fireEvent.keyDown(screen.getByTestId("todo-rename-w1"), { key: "Enter" })

    expect(onRename).not.toHaveBeenCalled()
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
