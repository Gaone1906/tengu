import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkflowRun = vi.fn()
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
    getWorkflowRun.mockResolvedValue(baseDetail({
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
    getWorkflowRun.mockResolvedValue(baseDetail({
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
    getWorkflowRun.mockResolvedValue(baseDetail({
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

  it("renders the run header without any editing affordances", async () => {
    getWorkflowRun.mockResolvedValue(baseDetail({
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
