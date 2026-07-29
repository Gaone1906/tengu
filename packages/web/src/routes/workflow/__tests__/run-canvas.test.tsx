import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkflowRun = vi.fn()
const getWorkflowRunFull = vi.fn()
const decideWorkflowApproval = vi.fn()
const getSession = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  return {
    ApiError,
    api: {
      getWorkflowRunV2: (...args: unknown[]) => getWorkflowRun(...args),
      getWorkflowRunFullV2: (...args: unknown[]) => getWorkflowRunFull(...args),
      decideWorkflowApprovalV2: (...args: unknown[]) => decideWorkflowApproval(...args),
      getSession: (...args: unknown[]) => getSession(...args),
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import WorkflowRunPage from "../run"

const nodes = [
  { id: "trigger", type: "trigger", name: "Kickoff", config: { kind: "manual" } },
  { id: "writer", type: "employee", name: "Writer", config: { employee: { source: "fixed", value: "blog-writer" }, prompt: "Write it." } },
  { id: "route", type: "condition", name: "Quality gate", config: { cases: [{ port: "case-1", label: "Good", all: [] }], defaultPort: "else" } },
  { id: "gate", type: "approval", name: "Publish gate", config: { description: "" } },
  { id: "finish", type: "end", name: "Done", config: { result: "success" } },
]

const edges = [
  { id: "e1", from: { nodeId: "trigger", port: "success" }, to: { nodeId: "writer", port: "input" } },
  { id: "e2", from: { nodeId: "writer", port: "success" }, to: { nodeId: "route", port: "input" } },
  { id: "e3", from: { nodeId: "route", port: "case-1" }, to: { nodeId: "gate", port: "input" } },
  { id: "e4", from: { nodeId: "gate", port: "approved" }, to: { nodeId: "finish", port: "input" } },
]

const positions = {
  trigger: { x: 0, y: 0 }, writer: { x: 300, y: 0 }, route: { x: 600, y: 0 },
  gate: { x: 900, y: 0 }, finish: { x: 1200, y: 0 },
}

function nodeRun(nodeId: string, status: string, extra: Record<string, unknown> = {}) {
  const nodeType = nodes.find((node) => node.id === nodeId)!.type
  return { runId: "run-1", nodeId, nodeType, status, activated: true, startedAt: "2026-07-23T08:00:00.000Z", ...extra }
}

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1", workflowId: "morning-digest", workflowTitle: "Morning Digest",
    definitionRevision: 3, revision: 7,
    definition: { nodes, edges, ui: { positions } },
    status: "running",
    trigger: { nodeId: "trigger", kind: "manual" },
    startedAt: "2026-07-23T08:00:00.000Z",
    nodeRuns: [], attempts: [], approvals: [],
    ...overrides,
  }
}

/** Serve the route's two shapes from one fixture: the fat payload the page
 *  fetches once, and the lean one it polls, which drops the definition snapshot
 *  and every attempt prompt. Serving both is what catches a panel that renders
 *  only because of a field the poll does not carry. */
function serveRun(detail: Record<string, unknown>) {
  getWorkflowRunFull.mockResolvedValue(detail)
  const lean = { ...detail }
  delete lean.definition
  lean.attempts = (detail.attempts as Array<Record<string, unknown>>).map((attempt) => {
    const polled = { ...attempt }
    delete polled.promptText
    delete polled.input
    return polled
  })
  getWorkflowRun.mockResolvedValue(lean)
}

function renderRun() {
  const router = createMemoryRouter(
    [{ path: "/workflow/:id/runs/:runId", element: <WorkflowRunPage /> }],
    { initialEntries: ["/workflow/morning-digest/runs/run-1"] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

function statusOf(name: string): string | null {
  const card = screen.getByText(name).closest("[data-node-status]")
  return card?.getAttribute("data-node-status") ?? null
}

beforeEach(() => {
  vi.clearAllMocks()
  getSession.mockResolvedValue({ status: "idle" })
})

describe("workflow run canvas", () => {
  it("paints per-node statuses, including the derived waiting-submit state", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed", { endedAt: "2026-07-23T08:00:01.000Z" }),
        nodeRun("writer", "running"),
      ],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 1, nextReminderAt: "2026-07-23T08:20:00.000Z",
        extensions: 0,
      }],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Kickoff")).toBe("completed")
    expect(statusOf("Writer")).toBe("waiting-submit")
    expect(statusOf("Quality gate")).toBe("pending")
    expect(statusOf("Done")).toBe("pending")
  })

  it("keeps a running attempt without ladder activity as plain running", async () => {
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      }],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Writer")).toBe("running")
  })

  it("marks failed nodes and dims skipped ones", async () => {
    serveRun(baseDetail({
      status: "failed",
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("writer", "failed", { error: { code: "workflow-no-output", message: "No output.", retryable: true } }),
        nodeRun("route", "skipped", { activated: false }),
      ],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Writer")).toBe("failed")
    expect(statusOf("Quality gate")).toBe("skipped")
  })

  it("opens the run inspector with output fields, attempts, and the session link", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("writer", "completed", {
          endedAt: "2026-07-23T08:03:00.000Z",
          input: {},
          output: { text: "Digest **drafted**.", fields: { summary: "Looks good", count: 2 }, sessionId: "sess-1" },
        }),
      ],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "completed",
        resolvedConfig: { employeeId: "blog-writer", engine: "claude", model: "opus", effort: "high" },
        promptText: "Write the digest.\n\n---\nContract block.",
        output: { text: "Digest **drafted**.", fields: { summary: "Looks good", count: 2 } },
        startedAt: "2026-07-23T08:00:01.000Z", endedAt: "2026-07-23T08:03:00.000Z",
        remindersSent: 2, extensions: 1, lastExtensionReason: "Waiting on a child session.",
      }],
    }))
    renderRun()

    // fireEvent.click, not userEvent: userEvent also dispatches mousedown into
    // the canvas pane, which trips d3-zoom on jsdom (event.view is null there).
    fireEvent.click(await screen.findByText("Writer"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByText("summary")).toBeTruthy()
    expect(inspector.getByText("Looks good")).toBeTruthy()
    expect(inspector.getByText("drafted")).toBeTruthy()
    expect(inspector.getByText("blog-writer")).toBeTruthy()
    expect(inspector.getByText("Effort")).toBeTruthy()
    expect(inspector.getByText("high")).toBeTruthy()
    expect(inspector.getByText(/Write the digest\./)).toBeTruthy()
    expect(inspector.getByText("No input")).toBeTruthy()
    expect(inspector.getByText(/2 reminders sent/)).toBeTruthy()
    expect(inspector.getByText(/1 extension/)).toBeTruthy()
    expect(inspector.getByText(/Waiting on a child session/)).toBeTruthy()
    const link = inspector.getByRole("link", { name: /open chat session/i })
    expect(link.getAttribute("href")).toBe("/?session=sess-1")
  })

  it("collapses a long prompt behind a disclosure", async () => {
    const longPrompt = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        resolvedConfig: { employeeId: "blog-writer", engine: "claude" },
        promptText: longPrompt,
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      }],
    }))
    renderRun()

    fireEvent.click(await screen.findByText("Writer"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.queryByText(/line 30/)).toBeNull()
    await userEvent.click(inspector.getByRole("button", { name: /show prompt · 30 lines/i }))
    expect(inspector.getByText(/line 30/)).toBeTruthy()
  })

  it("shows an approval node's decision in the inspector", async () => {
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("gate", "completed", { output: { text: "", fields: { port: "approved" } } })],
      approvals: [{
        runId: "run-1", nodeId: "gate", status: "approved", requestedAt: "2026-07-23T08:01:00.000Z",
        decidedAt: "2026-07-23T08:02:00.000Z", decidedBy: "operator", decision: "approve",
      }],
    }))
    renderRun()

    fireEvent.click(await screen.findByText("Publish gate"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByText(/Approved by operator/)).toBeTruthy()
  })

  it("approves a pending approval from the inspector with the run's revision", async () => {
    const pending = baseDetail({
      status: "waiting",
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("gate", "waiting")],
      approvals: [{ runId: "run-1", nodeId: "gate", status: "pending", requestedAt: "2026-07-23T08:01:00.000Z" }],
    })
    serveRun(pending)
    const approved = {
      ...pending,
      status: "running",
      approvals: [{ ...pending.approvals[0] as object, status: "approved", decidedBy: "operator", decidedAt: "2026-07-23T08:05:00.000Z" }],
    }
    decideWorkflowApproval.mockImplementation(() => {
      serveRun(approved)
      return Promise.resolve(approved)
    })
    renderRun()

    fireEvent.click(await screen.findByText("Publish gate"))
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "gate", { decision: "approve", expectedRevision: 7 },
    ))
    expect(await screen.findByText(/Approved by operator/)).toBeTruthy()
  })

  it("fetches the snapshot once and keeps the canvas painted off lean polls", async () => {
    serveRun(baseDetail({ nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")] }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    // The 2s poll loop must not pay for the definition snapshot again.
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalled(), { timeout: 4000 })
    expect(getWorkflowRunFull).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Quality gate")).toBeTruthy()
  }, 10000)

  it("re-fetches the snapshot when a node is opened whose prompt it predates", async () => {
    const attempt = (number: number, promptText?: string) => ({
      runId: "run-1", nodeId: "writer", attempt: number, sessionId: "sess-1", status: "running",
      resolvedConfig: { employeeId: "blog-writer", engine: "claude" },
      startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      ...(promptText === undefined ? {} : { promptText }),
    })
    const nodeRuns = [nodeRun("trigger", "completed"), nodeRun("writer", "running")]
    // The page loaded before a retry, so its snapshot only knows attempt 1.
    getWorkflowRunFull
      .mockResolvedValueOnce(baseDetail({ nodeRuns, attempts: [attempt(1, "First prompt.")] }))
      .mockResolvedValue(baseDetail({ nodeRuns, attempts: [attempt(1, "First prompt."), attempt(2, "Retried prompt.")] }))
    const lean = baseDetail({ nodeRuns, attempts: [attempt(1), attempt(2)] }) as Record<string, unknown>
    delete lean.definition
    getWorkflowRun.mockResolvedValue(lean)
    renderRun()

    fireEvent.click(await screen.findByText("Writer"))

    // The retry surfaces on the next lean poll; opening the node then pulls the
    // prompt the snapshot predates, instead of dropping the section silently.
    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(await inspector.findByText(/Retried prompt\./, {}, { timeout: 6000 })).toBeTruthy()
    expect(getWorkflowRunFull).toHaveBeenCalledTimes(2)
  }, 10000)

  it("renders the run header without any editing affordances", async () => {
    serveRun(baseDetail({
      status: "completed", endedAt: "2026-07-23T08:05:00.000Z",
      nodeRuns: nodes.map((node) => nodeRun(node.id, "completed")),
    }))
    renderRun()

    expect(await screen.findByText("Manual run")).toBeTruthy()
    expect(screen.getByText("Kickoff")).toBeTruthy()
    // Editor-only chrome must be absent from the run view.
    expect(screen.queryByText("Add step")).toBeNull()
    expect(screen.queryByLabelText(/Insert node on connection/)).toBeNull()
    expect(screen.queryByLabelText(/Add node after/)).toBeNull()
  })
})
