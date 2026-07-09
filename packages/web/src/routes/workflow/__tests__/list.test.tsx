import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

/* GRS-019 — the Workflows list landing: cards, empty state, + New Workflow. */

const listWorkflowDefinitions = vi.fn()
const getWorkflowDefinition = vi.fn()
const listWorkflowRuns = vi.fn()
const createWorkflowDefinition = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    listWorkflowDefinitions: (...a: unknown[]) => listWorkflowDefinitions(...a),
    getWorkflowDefinition: (...a: unknown[]) => getWorkflowDefinition(...a),
    listWorkflowRuns: (...a: unknown[]) => listWorkflowRuns(...a),
    createWorkflowDefinition: (...a: unknown[]) => createWorkflowDefinition(...a),
  },
}))

const navigate = vi.fn()
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}))

// The page shell pulls lazy widgets (search, live stream) — irrelevant here.
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToolbarActions: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))

import WorkflowListPage, { slugifyWorkflowId } from "../list"

function summary(id: string, over: Record<string, unknown> = {}) {
  return { id, title: id, status: "active", version: 1, nodeCount: 2, edgeCount: 1, ...over }
}

function definition(id: string, cron?: string) {
  return {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: "active",
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Trigger",
        position: { x: 0, y: 0 },
        trigger: cron ? { kind: "schedule", cron } : { kind: "manual" },
      },
    ],
    edges: [],
  }
}

beforeEach(() => {
  listWorkflowDefinitions.mockReset()
  getWorkflowDefinition.mockReset()
  listWorkflowRuns.mockReset()
  createWorkflowDefinition.mockReset()
  navigate.mockReset()
})

describe("slugifyWorkflowId", () => {
  it("kebab-cases a human name", () => {
    expect(slugifyWorkflowId("Morning Digest")).toBe("morning-digest")
    expect(slugifyWorkflowId("  Weird!! Name (v2) ")).toBe("weird-name-v2")
  })
})

describe("WorkflowListPage", () => {
  it("renders one card per definition with trigger + last-run lines, and opens on tap", async () => {
    listWorkflowDefinitions.mockResolvedValue({
      evidenceConfigured: true,
      definitions: [summary("sample-autonomy", { title: "Sample Autonomy" }), summary("digest", { title: "Morning Digest", status: "paused" })],
    })
    getWorkflowDefinition.mockImplementation((id: string) =>
      Promise.resolve(id === "sample-autonomy" ? definition(id, "0 */2 * * *") : definition(id)),
    )
    listWorkflowRuns.mockImplementation((id: string) =>
      Promise.resolve({
        evidenceConfigured: true,
        runs: id === "sample-autonomy"
          ? [{ runId: "r1", workflowId: id, status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-05T10:00:00Z", endedAt: null, stepCount: 2, parked: true }]
          : [],
      }),
    )

    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-card-sample-autonomy")).toBeTruthy())

    const card = screen.getByTestId("wf-card-sample-autonomy")
    expect(card.textContent).toContain("Sample Autonomy")
    expect(card.textContent).toContain("Every 2 hours")
    expect(card.textContent).toContain("Waiting for you")
    expect(card.textContent).toContain("Active")

    const paused = screen.getByTestId("wf-card-digest")
    expect(paused.textContent).toContain("Paused")
    expect(paused.textContent).toContain("Manual")
    expect(paused.textContent).toContain("No runs yet")

    fireEvent.click(card)
    expect(navigate).toHaveBeenCalledWith("/workflow/sample-autonomy")
  })

  it("filters retired definitions out of the list", async () => {
    listWorkflowDefinitions.mockResolvedValue({
      evidenceConfigured: true,
      definitions: [summary("dead", { status: "retired" }), summary("alive")],
    })
    getWorkflowDefinition.mockResolvedValue(definition("alive"))
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })

    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-card-alive")).toBeTruthy())
    expect(screen.queryByTestId("wf-card-dead")).toBeNull()
    expect(getWorkflowDefinition).not.toHaveBeenCalledWith("dead")
  })

  it("shows the empty state with a create CTA when there are no workflows", async () => {
    listWorkflowDefinitions.mockResolvedValue({ evidenceConfigured: true, definitions: [] })
    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-empty")).toBeTruthy())
    expect(screen.getByText(/No workflows yet/)).toBeTruthy()
  })

  it("creates a workflow from the dialog and opens it in Edit", async () => {
    listWorkflowDefinitions.mockResolvedValue({ evidenceConfigured: true, definitions: [] })
    createWorkflowDefinition.mockResolvedValue({ ok: true, definition: { id: "morning-digest" } })

    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-empty")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-new"))
    fireEvent.change(screen.getByTestId("wf-new-name"), { target: { value: "Morning Digest" } })
    fireEvent.click(screen.getByTestId("wf-new-create"))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/workflow/morning-digest?mode=edit"))
    // The minimal valid definition: one manual trigger node, no edges.
    const body = createWorkflowDefinition.mock.calls[0][0] as { id: string; nodes: { type: string }[]; edges: unknown[] }
    expect(body.id).toBe("morning-digest")
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].type).toBe("trigger")
    expect(body.edges).toEqual([])
  })

  it("surfaces a create error inline (e.g. duplicate id) without navigating", async () => {
    listWorkflowDefinitions.mockResolvedValue({ evidenceConfigured: true, definitions: [] })
    createWorkflowDefinition.mockResolvedValue({ ok: false, status: 409, message: "definition already exists" })

    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-new"))
    fireEvent.change(screen.getByTestId("wf-new-name"), { target: { value: "Dup" } })
    fireEvent.click(screen.getByTestId("wf-new-create"))

    await waitFor(() => expect(screen.getByTestId("wf-new-error").textContent).toContain("already exists"))
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows a misconfiguration banner (with reason) when evidence is not configured", async () => {
    listWorkflowDefinitions.mockResolvedValue({
      evidenceConfigured: false,
      definitions: [],
      evidenceReason: 'JINN_WORKFLOW_EVIDENCE_ROOT is set to "/nope" but no such directory exists.',
    })
    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-evidence-error")).toBeTruthy())
    expect(screen.getByText(/misconfigured/i)).toBeTruthy()
    expect(screen.getByText(/no such directory exists/i)).toBeTruthy()
  })

  it("a failed detail fetch degrades that card, not the list", async () => {
    listWorkflowDefinitions.mockResolvedValue({ evidenceConfigured: true, definitions: [summary("flaky")] })
    getWorkflowDefinition.mockRejectedValue(new Error("boom"))
    listWorkflowRuns.mockRejectedValue(new Error("boom"))
    render(<WorkflowListPage />)
    await waitFor(() => expect(screen.getByTestId("wf-card-flaky")).toBeTruthy())
    expect(screen.getByTestId("wf-card-flaky").textContent).toContain("No runs yet")
  })
})
