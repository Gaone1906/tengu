import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { WorkflowRunWire, WorkflowRunSummaryWire } from "@/lib/api"
import { WorkflowApiError } from "@/lib/api"

// Mock the api module — the pure mapper/inspector don't touch it; DefinitionRunView does.
const listWorkflowRuns = vi.fn()
const getWorkflowRun = vi.fn()
const startWorkflowRun = vi.fn()
const cancelWorkflowRun = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listWorkflowRuns: (...a: unknown[]) => listWorkflowRuns(...a),
      getWorkflowRun: (...a: unknown[]) => getWorkflowRun(...a),
      startWorkflowRun: (...a: unknown[]) => startWorkflowRun(...a),
      cancelWorkflowRun: (...a: unknown[]) => cancelWorkflowRun(...a),
    },
  }
})

import {
  nodesForDefinitionRun,
  stepNodeStatus,
  sessionHref,
  RunNodeInspector,
  RunStatusPill,
  DefinitionRunSelector,
  DefinitionRunView,
} from "../run-view"
import { nodeStatusColor, type CanvasNode } from "../canvas"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

function renderView(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function runWire(overrides: Partial<WorkflowRunWire> = {}): WorkflowRunWire {
  return {
    runId: "run-20260704090000-abcd1234",
    workflowId: "sample-autonomy",
    definitionVersion: 3,
    title: "Sample Autonomy",
    trigger: { kind: "manual" },
    status: "parked",
    startedAt: "2026-07-04T09:00:00.000Z",
    endedAt: "2026-07-04T09:00:01.000Z",
    steps: [
      { nodeId: "orchestrate", label: "Orchestrate", actor: { kind: "employee", ref: "jimbo" }, status: "spawned", sessionId: "sess-abc", detail: "spawned", at: "2026-07-04T09:00:00.100Z" },
      { nodeId: "qa", label: "Isolated QA", actor: null, status: "inline", detail: "inline step (no actor)", at: "2026-07-04T09:00:00.200Z" },
    ],
    parked: { scope: "gateNode", nodeId: "merge-gate", kind: "approval", evaluator: "human-approval", ref: "merge", description: "Await human sign-off before merge" },
    ...overrides,
  }
}

function approvalRun(capability: {
  canDecide: boolean
  target: string | null
  needsYou: boolean
  escalated: boolean
}): WorkflowRunWire {
  return {
    ...runWire(),
    approvalCapability: capability,
  } as WorkflowRunWire
}

describe("stepNodeStatus — spawn ≠ done", () => {
  it("maps spawned → running (never passed)", () => {
    expect(stepNodeStatus({ nodeId: "x", label: "x", actor: null, status: "spawned", at: "" })).toBe("running")
  })
  it("maps inline and checkpoint → passed", () => {
    expect(stepNodeStatus({ nodeId: "x", label: "x", actor: null, status: "inline", at: "" })).toBe("passed")
    expect(stepNodeStatus({ nodeId: "x", label: "x", actor: null, status: "checkpoint", at: "" })).toBe("passed")
  })
  it("maps error → blocked", () => {
    expect(stepNodeStatus({ nodeId: "x", label: "x", actor: null, status: "error", at: "" })).toBe("blocked")
  })
})

describe("nodesForDefinitionRun", () => {
  it("prepends a synthetic trigger and preserves step order", () => {
    const nodes = nodesForDefinitionRun(runWire())
    expect(nodes[0].kind).toBe("trigger")
    expect(nodes.slice(1, 3).map((n) => n.id)).toEqual(["orchestrate", "qa"])
  })

  it("renders a spawned step as running, NOT a green passed", () => {
    const orch = nodesForDefinitionRun(runWire()).find((n) => n.id === "orchestrate")!
    expect(orch.status).toBe("running")
    expect(orch.status).not.toBe("passed")
    expect(orch.who).toBe("jimbo")
  })

  it("appends a parked gate node (status parked) for a parked run", () => {
    const nodes = nodesForDefinitionRun(runWire())
    const parked = nodes[nodes.length - 1]
    expect(parked.status).toBe("parked")
    expect(parked.kind).toBe("gate")
    expect(parked.id).toBe("merge-gate")
  })

  it("uses __rungate__ id for a runGate-scoped park", () => {
    const nodes = nodesForDefinitionRun(runWire({ parked: { scope: "runGate", nodeId: null, kind: "approval", evaluator: "human-approval", description: "final sign-off" } }))
    expect(nodes[nodes.length - 1].id).toBe("__rungate__")
  })

  it("does NOT append a parked node for a non-parked (dispatched) run", () => {
    const nodes = nodesForDefinitionRun(runWire({ status: "dispatched", parked: null }))
    expect(nodes.some((n) => n.status === "parked")).toBe(false)
  })

  it("labels inline (no-actor) steps as orchestrator", () => {
    const qa = nodesForDefinitionRun(runWire()).find((n) => n.id === "qa")!
    expect(qa.who).toBe("orchestrator (inline)")
    expect(qa.status).toBe("passed")
  })

  it("GRS-014b: promotes the gate's OWN receipt node to the parked doorbell (no duplicate synthetic node)", () => {
    // A v2 sequential run materializes a pending receipt for the parking gate node.
    const run = runWire({
      status: "parked",
      parked: { scope: "gateNode", nodeId: "gate", kind: "approval", evaluator: "human-approval", description: "operator approves", at: "2026-07-04T18:00:00.000Z" },
      steps: [
        { nodeId: "a", label: "Step A", actor: { kind: "engine", ref: "codex" }, status: "done", attempt: 1, sessionId: "sess-a", at: "" },
        { nodeId: "gate", label: "Approve", actor: null, status: "pending", attempt: 0, at: "" },
        { nodeId: "b", label: "Step B", actor: { kind: "engine", ref: "codex" }, status: "pending", attempt: 0, at: "" },
      ],
    })
    const nodes = nodesForDefinitionRun(run)
    const parkedNodes = nodes.filter((n) => n.status === "parked")
    expect(parkedNodes).toHaveLength(1)
    expect(parkedNodes[0].id).toBe("gate") // the receipt node itself, not a synthetic copy
    expect(parkedNodes[0].kind).toBe("gate")
    expect(parkedNodes[0].who).toBe("awaiting human approval")
    expect(nodes.filter((n) => n.id.startsWith("gate"))).toHaveLength(1) // no gate-2 duplicate
    // Downstream stays honestly pending.
    expect(nodes.find((n) => n.id === "b")?.status).toBe("pending")
  })

  it("uniquifies synthetic ids that collide with a real step id (no duplicate keys)", () => {
    // A malformed/hand-edited run with a step literally named "__trigger__" and a
    // runGate park (which wants "__rungate__", also present as a step).
    const run = runWire({
      status: "parked",
      parked: { scope: "runGate", nodeId: null, kind: "approval", evaluator: "human-approval", description: "final sign-off" },
      steps: [
        { nodeId: "__trigger__", label: "Sneaky step", actor: { kind: "engine", ref: "codex" }, status: "spawned", sessionId: "s1", at: "" },
        { nodeId: "__rungate__", label: "Another", actor: null, status: "inline", at: "" },
      ],
    })
    const nodes = nodesForDefinitionRun(run)
    const ids = nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
    // The real spawned step keeps its id + running status; the synthetic trigger routed around it.
    expect(nodes.find((n) => n.id === "__trigger__")?.status).toBe("running")
    expect(nodes.find((n) => n.kind === "trigger")?.id).not.toBe("__trigger__")
  })
})

describe("nodeStatusColor — new run states", () => {
  it("colours running blue and parked yellow", () => {
    expect(nodeStatusColor("running")).toBe("var(--system-blue)")
    expect(nodeStatusColor("parked")).toBe("var(--system-yellow)")
  })

  it("GRS-014a: completed earns green; dispatched and cancelled stay grey (never green)", () => {
    expect(nodeStatusColor("completed")).toBe("var(--system-green)")
    expect(nodeStatusColor("dispatched")).toBe("var(--text-tertiary)")
    expect(nodeStatusColor("dispatched")).not.toBe("var(--system-green)")
    expect(nodeStatusColor("cancelled")).toBe("var(--text-tertiary)")
  })
})

describe("stepNodeStatus — reserved GRS-014b step-machine states (display vocabulary)", () => {
  const receipt = (status: string) =>
    ({ nodeId: "x", label: "x", actor: null, status, at: "" }) as Parameters<typeof stepNodeStatus>[0]
  it("maps done → passed, running/dispatching → running, failed → blocked, pending/skipped → pending", () => {
    expect(stepNodeStatus(receipt("done"))).toBe("passed")
    expect(stepNodeStatus(receipt("running"))).toBe("running")
    expect(stepNodeStatus(receipt("dispatching"))).toBe("running")
    expect(stepNodeStatus(receipt("failed"))).toBe("blocked")
    expect(stepNodeStatus(receipt("pending"))).toBe("pending")
    expect(stepNodeStatus(receipt("skipped"))).toBe("pending")
  })
})

describe("RunStatusPill — honest status rendering (GRS-014a)", () => {
  it("renders dispatched with the completion-unknown tooltip", () => {
    render(<RunStatusPill status="dispatched" />)
    const pill = screen.getByText("dispatched")
    expect(pill.closest("span[title]")?.getAttribute("title")).toMatch(/completion unknown/i)
  })
  it("renders completed and cancelled without the dispatched tooltip", () => {
    render(<RunStatusPill status="completed" />)
    render(<RunStatusPill status="cancelled" />)
    expect(screen.getByText("completed")).toBeTruthy()
    expect(screen.getByText("cancelled")).toBeTruthy()
    expect(screen.getByText("completed").closest("span")?.getAttribute("title")).toBeNull()
  })
})

describe("sessionHref", () => {
  it("points at the chat root deep-link", () => {
    expect(sessionHref("sess-abc")).toBe("/?session=sess-abc")
  })
})

function parkedNode(): CanvasNode {
  return { id: "merge-gate", kind: "gate", title: "Approval gate", role: "gate", who: "awaiting human approval", status: "parked", isCurrent: false, gates: [], detail: "Await human sign-off before merge" }
}
function spawnedNode(): CanvasNode {
  return { id: "orchestrate", kind: "step", title: "Orchestrate", role: "implement", who: "jimbo", status: "running", isCurrent: false, gates: [] }
}

describe("RunNodeInspector", () => {
  it("shows the parked gate as awaiting human approval, without leaking a personal name", () => {
    render(<RunNodeInspector run={runWire()} node={parkedNode()} onClose={() => {}} />)
    expect(screen.getAllByText(/awaiting/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/human approval/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/Await human sign-off before merge/)).toBeTruthy()
    // No approve/reject action this sprint.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("renders a spawned step with an honest spawn-state and a real session link", () => {
    render(<RunNodeInspector run={runWire()} node={spawnedNode()} onClose={() => {}} />)
    expect(screen.getByText(/not yet confirmed complete/i)).toBeTruthy()
    const link = screen.getByTestId("wf-run-session-link") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/?session=sess-abc")
  })
})

describe("DefinitionRunSelector", () => {
  it("renders one button per run and marks parked runs", () => {
    const runs: WorkflowRunSummaryWire[] = [
      { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: true },
    ]
    render(<DefinitionRunSelector runs={runs} selected={null} onSelect={() => {}} />)
    expect(screen.getByTestId("wf-run-run-20260704090000-abcd1234")).toBeTruthy()
    expect(screen.getByLabelText("parked")).toBeTruthy()
  })
})

describe("DefinitionRunView (container)", () => {
  beforeEach(() => {
    listWorkflowRuns.mockReset()
    getWorkflowRun.mockReset()
    startWorkflowRun.mockReset()
    cancelWorkflowRun.mockReset()
  })

  it("lists runs, auto-selects the newest, and renders the parked run on the canvas", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: true },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire())

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)

    await waitFor(() => expect(screen.getByTestId("wf-canvas")).toBeTruthy())
    expect(getWorkflowRun).toHaveBeenCalledWith("sample-autonomy", "run-20260704090000-abcd1234")
    // The parked gate node is on the canvas (spawn-honest run rendered).
    expect(screen.getByTestId("wf-node-merge-gate")).toBeTruthy()
    // Tapping it opens the run inspector with the awaited approval.
    // (Both the desktop rail and mobile bottom-sheet render in jsdom → getAll.)
    fireEvent.click(screen.getByTestId("wf-node-merge-gate"))
    expect(screen.getAllByTestId("wf-run-inspector").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Await human sign-off before merge/).length).toBeGreaterThan(0)
  })

  it("shows an empty state when there are no runs", async () => {
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })
    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByText(/No runs yet/i)).toBeTruthy())
    expect(getWorkflowRun).not.toHaveBeenCalled()
  })

  it("selects the URL-named run even when it is off the first page and shows its chip", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-newest", workflowId: "sample-autonomy", status: "completed", trigger: { kind: "manual" }, startedAt: "2026-07-06T09:00:00Z", endedAt: "2026-07-06T09:05:00Z", stepCount: 2, parked: false },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ runId: "run-deep", status: "parked" }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" initialRunId="run-deep" />)

    // The deep-linked run is fetched directly (not the newest) and surfaced as a chip.
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledWith("sample-autonomy", "run-deep"))
    await waitFor(() => expect(screen.getByTestId("wf-run-run-deep")).toBeTruthy())
  })

  it("reports a run selection to onSelectRun so the page can update the URL", async () => {
    const onSelectRun = vi.fn()
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-a", workflowId: "sample-autonomy", status: "completed", trigger: { kind: "manual" }, startedAt: "2026-07-06T09:00:00Z", endedAt: "2026-07-06T09:05:00Z", stepCount: 2, parked: false },
        { runId: "run-b", workflowId: "sample-autonomy", status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-05T09:00:00Z", endedAt: null, stepCount: 2, parked: true },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ runId: "run-a" }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" onSelectRun={onSelectRun} />)
    await waitFor(() => expect(screen.getByTestId("wf-run-run-b")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-run-run-b"))
    expect(onSelectRun).toHaveBeenCalledWith("run-b")
  })

  it("reports a freshly started run id to onSelectRun", async () => {
    const onSelectRun = vi.fn()
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })
    startWorkflowRun.mockResolvedValue(runWire({ runId: "run-fresh", status: "running", parked: null, endedAt: null }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" onSelectRun={onSelectRun} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.change(screen.getByLabelText("Run input"), { target: { value: "{}" } })
    fireEvent.click(screen.getByRole("button", { name: "Start run" }))

    await waitFor(() => expect(onSelectRun).toHaveBeenCalledWith("run-fresh"))
  })

  it("starts a run from JSON input with a generated idempotency key and no raw REST instruction", async () => {
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })
    startWorkflowRun.mockResolvedValue(runWire({
      status: "running",
      parked: null,
      endedAt: null,
    }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false))
    expect(screen.queryByText(/POST \/api\/workflow-definitions/)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.change(screen.getByLabelText("Run input"), { target: { value: '{"ticket":"A-1"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Start run" }))

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledWith(
      "sample-autonomy",
      { ticket: "A-1" },
      expect.stringMatching(/\S/),
    ))
  })

  it("reuses the same idempotency key when the operator retries a failed transport", async () => {
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })
    startWorkflowRun
      .mockRejectedValueOnce(new Error("network blink"))
      .mockResolvedValueOnce(runWire({ status: "running", parked: null, endedAt: null }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.change(screen.getByLabelText("Run input"), { target: { value: '{"ticket":"A-1"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Start run" }))
    await waitFor(() => expect(screen.getByText(/network blink/i)).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Start run" }))
    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledTimes(2))
    expect(startWorkflowRun.mock.calls[1][2]).toBe(startWorkflowRun.mock.calls[0][2])
  })

  it("keeps changed intent intact on 409 and starts with a new key only after explicit operator intent", async () => {
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: true, runs: [] })
    startWorkflowRun
      .mockRejectedValueOnce(new WorkflowApiError(
        "This idempotency key is already bound to a different workflow run request.",
        409,
        "workflow-run-idempotency-conflict",
        "run-existing",
      ))
      .mockResolvedValueOnce(runWire({ status: "running", parked: null, endedAt: null }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.change(screen.getByLabelText("Run input"), { target: { value: '{"ticket":"CHANGED"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Start run" }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Start as new run" })).toBeTruthy())
    expect((screen.getByLabelText("Run input") as HTMLTextAreaElement).value).toBe('{"ticket":"CHANGED"}')
    expect(getWorkflowRun).not.toHaveBeenCalledWith("sample-autonomy", "run-existing")

    const conflictedKey = startWorkflowRun.mock.calls[0][2]
    fireEvent.click(screen.getByRole("button", { name: "Start as new run" }))
    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledTimes(2))
    expect(startWorkflowRun.mock.calls[1][1]).toEqual({ ticket: "CHANGED" })
    expect(startWorkflowRun.mock.calls[1][2]).not.toBe(conflictedKey)
  })

  it("selects and renders a durable failed run returned by Start instead of losing its evidence", async () => {
    const failed = runWire({
      status: "failed",
      parked: null,
      errors: [{ code: "spawn-failed", message: "worker session failed", ref: "orchestrate" }],
      steps: runWire().steps.map((step) => step.nodeId === "orchestrate" ? { ...step, status: "failed" } : step),
    })
    const summary: WorkflowRunSummaryWire = {
      runId: failed.runId,
      workflowId: failed.workflowId,
      status: "failed",
      trigger: failed.trigger,
      startedAt: failed.startedAt,
      endedAt: failed.endedAt,
      stepCount: failed.steps.length,
      parked: false,
    }
    listWorkflowRuns
      .mockResolvedValueOnce({ evidenceConfigured: true, runs: [] })
      .mockResolvedValue({ evidenceConfigured: true, runs: [summary] })
    startWorkflowRun.mockResolvedValue(failed)
    getWorkflowRun.mockResolvedValue(failed)

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.click(screen.getByRole("button", { name: "Start run" }))

    await waitFor(() => expect(screen.getByText(/Run failed: worker session failed/i)).toBeTruthy())
    expect(screen.getByTestId("wf-node-orchestrate")).toBeTruthy()
  })

  it("notes when workflow storage is misconfigured", async () => {
    listWorkflowRuns.mockResolvedValue({ evidenceConfigured: false, runs: [] })
    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByText(/misconfigured/i)).toBeTruthy())
  })

  it("surfaces a load error without wedging", async () => {
    listWorkflowRuns.mockRejectedValue(new Error("boom"))
    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy())
  })

  it("retries the selected run when its chip is clicked after a transient run-fetch failure", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: true },
      ],
    })
    getWorkflowRun
      .mockRejectedValueOnce(new Error("network blink"))
      .mockResolvedValueOnce(runWire())

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)

    await waitFor(() => expect(screen.getByTestId("wf-run-fetch-error").textContent).toContain("network blink"))
    expect(screen.getByText(/No run selected/i)).toBeTruthy()

    fireEvent.click(screen.getByTestId("wf-run-run-20260704090000-abcd1234"))

    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId("wf-run-fetch-error")).toBeNull())
    expect(screen.getByTestId("wf-canvas")).toBeTruthy()
  })

  it("shows the GRS-014a order-warning banner loudly when the run carries one", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "dispatched", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: false },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({
      status: "dispatched",
      parked: null,
      orderWarning: {
        code: "order-warning",
        message: "workflow edges imply an execution order different from declaration order; this run walked declaration order (edge-following execution lands in GRS-014b)",
        impliedOrder: ["__trigger", "qa", "orchestrate"],
      },
    }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-run-order-warning")).toBeTruthy())
    expect(screen.getByTestId("wf-run-order-warning").textContent).toMatch(/declaration order/)
    expect(screen.getByTestId("wf-run-order-warning").textContent).toMatch(/qa → orchestrate/)
  })

  it.each(["running", "dispatched", "parked"] as const)("offers accessible cancellation for a %s run", async (status) => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status, trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: status === "parked" },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ status, parked: status === "parked" ? runWire().parked : null }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    const opener = await screen.findByRole("button", { name: "Cancel run" })
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole("dialog", { name: /cancel run run-20260704090000-abcd1234/i })
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy()
    expect(within(dialog).getByText(/run-20260704090000-abcd1234/)).toBeTruthy()
    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it.each(["completed", "failed", "cancelled"] as const)("does not offer cancellation for a %s run", async (status) => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status, trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: "2026-07-04T09:01:00Z", stepCount: 2, parked: false },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ status, parked: null }))
    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByText(status)).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull()
  })

  it("disables cancellation while pending, avoids double submit, and renders the cancelled result truthfully", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "running", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: false },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ status: "running", parked: null, endedAt: null }))
    let resolveCancel!: (value: WorkflowRunWire) => void
    cancelWorkflowRun.mockReturnValue(new Promise<WorkflowRunWire>((resolve) => { resolveCancel = resolve }))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }))
    const dialog = await screen.findByRole("dialog")
    const confirm = within(dialog).getByRole("button", { name: "Cancel run" }) as HTMLButtonElement
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancelling…" }).hasAttribute("disabled")).toBe(true))
    expect(cancelWorkflowRun).toHaveBeenCalledTimes(1)
    expect(cancelWorkflowRun).toHaveBeenCalledWith("sample-autonomy", "run-20260704090000-abcd1234")

    await act(async () => {
      resolveCancel(runWire({
        status: "cancelled",
        parked: null,
        endedAt: "2026-07-04T09:01:00Z",
        cancellation: { requestedAt: "2026-07-04T09:01:00Z", requestedBy: "operator", reason: null },
      }))
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByText("cancelled")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull()
  })

  it("keeps the dialog open and announces a cancellation error", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "running", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: false },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire({ status: "running", parked: null }))
    cancelWorkflowRun.mockRejectedValue(new Error("run was already completed"))

    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }))

    expect((await within(dialog).findByRole("alert")).textContent).toContain("run was already completed")
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("does NOT render the order-warning banner for a clean run", async () => {
    listWorkflowRuns.mockResolvedValue({
      evidenceConfigured: true,
      runs: [
        { runId: "run-20260704090000-abcd1234", workflowId: "sample-autonomy", status: "parked", trigger: { kind: "manual" }, startedAt: "2026-07-04T09:00:00Z", endedAt: null, stepCount: 2, parked: true },
      ],
    })
    getWorkflowRun.mockResolvedValue(runWire())
    renderView(<DefinitionRunView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-canvas")).toBeTruthy())
    expect(screen.queryByTestId("wf-run-order-warning")).toBeNull()
  })
})

describe("RunNodeInspector — persisted handoff outcome (GRS-014c)", () => {
  it("renders the declared outcome: summary, artifact paths, notes", () => {
    const run = runWire({
      steps: [
        {
          nodeId: "orchestrate", label: "Orchestrate", actor: { kind: "engine", ref: "codex" },
          status: "done", attempt: 1, sessionId: "sess-abc", at: "",
          outcome: {
            sessionId: "sess-abc",
            summary: "widget implemented with tests",
            artifacts: ["src/widget.ts"],
            notes: "cache is warm",
            finalMessage: "raw tail",
            extractedFrom: "handoff-block",
          },
        },
      ],
    })
    render(<RunNodeInspector run={run} node={{ ...spawnedNode(), status: "passed" }} onClose={() => {}} />)
    const section = screen.getByTestId("wf-run-outcome")
    expect(section.textContent).toContain("Handoff (declared)")
    expect(section.textContent).toContain("widget implemented with tests")
    expect(section.textContent).toContain("src/widget.ts")
    expect(section.textContent).toContain("cache is warm")
  })

  it("renders no outcome section when the receipt has none", () => {
    render(<RunNodeInspector run={runWire()} node={spawnedNode()} onClose={() => {}} />)
    expect(screen.queryByTestId("wf-run-outcome")).toBeNull()
  })
})

describe("RunNodeInspector — reserved v2 step states render honest rows", () => {
  it("renders a 'done' receipt as settled-green and a 'skipped' receipt as neutral", () => {
    const run = runWire({
      steps: [
        { nodeId: "orchestrate", label: "Orchestrate", actor: { kind: "employee", ref: "jimbo" }, status: "done", sessionId: "sess-abc", at: "2026-07-04T09:00:00.100Z" },
      ],
    })
    render(<RunNodeInspector run={run} node={{ ...spawnedNode(), status: "passed" }} onClose={() => {}} />)
    expect(screen.getByText(/Completed — session settled/)).toBeTruthy()
  })
})

describe("gate resolution UI (GRS-014e)", () => {
  it("renders active Approve/Reject only when the projected principal can decide", async () => {
    const decisions: string[] = []
    const onResolveGate = async (d: "approve" | "reject") => {
      decisions.push(d)
    }
    render(<RunNodeInspector run={approvalRun({ canDecide: true, target: "coo", needsYou: true, escalated: false })} node={parkedNode()} onClose={() => {}} onResolveGate={onResolveGate} />)

    fireEvent.click(screen.getByTestId("wf-gate-approve"))
    await waitFor(() => expect(decisions).toEqual(["approve"]))
    fireEvent.click(screen.getByTestId("wf-gate-reject"))
    await waitFor(() => expect(decisions).toEqual(["approve", "reject"]))
  })

  it("surfaces a resolve failure inline (e.g. 409 not parked) instead of swallowing it", async () => {
    render(
      <RunNodeInspector
        run={approvalRun({ canDecide: true, target: "coo", needsYou: true, escalated: false })}
        node={parkedNode()}
        onClose={() => {}}
        onResolveGate={async () => {
          throw new Error("run is completed, not parked")
        }}
      />,
    )
    fireEvent.click(screen.getByTestId("wf-gate-approve"))
    await waitFor(() => expect(screen.getByTestId("wf-gate-resolve-error").textContent).toContain("not parked"))
  })

  it("keeps an unauthorized principal read-only and names the routed approver with escalation guidance", () => {
    const onResolveGate = vi.fn(async () => {})
    render(
      <RunNodeInspector
        run={approvalRun({ canDecide: false, target: "platform-manager", needsYou: false, escalated: false })}
        node={parkedNode()}
        onClose={() => {}}
        onResolveGate={onResolveGate}
      />,
    )

    expect(screen.queryByTestId("wf-gate-approve")).toBeNull()
    expect(screen.queryByTestId("wf-gate-reject")).toBeNull()
    expect(screen.getByText(/waiting on platform-manager/i)).toBeTruthy()
    expect(screen.getByText(/escalat/i)).toBeTruthy()
    expect(onResolveGate).not.toHaveBeenCalled()
  })

  it("shows an escalated approval as waiting for its routed target without inventing decision authority", () => {
    render(
      <RunNodeInspector
        run={approvalRun({ canDecide: false, target: "coo", needsYou: false, escalated: true })}
        node={parkedNode()}
        onClose={() => {}}
        onResolveGate={async () => {}}
      />,
    )

    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull()
    expect(screen.getByText(/waiting on coo/i)).toBeTruthy()
    expect(screen.getByText(/escalated/i)).toBeTruthy()
  })

  it("stays read-only (API hint, no buttons) without onResolveGate", () => {
    render(<RunNodeInspector run={runWire()} node={parkedNode()} onClose={() => {}} />)
    expect(screen.queryByTestId("wf-gate-approve")).toBeNull()
    expect(screen.queryByTestId("wf-gate-reject")).toBeNull()
    expect(screen.queryByText(/POST .*resolve-gate/i)).toBeNull()
    expect(screen.getByText(/open this execution.*approve or reject/i)).toBeTruthy()
  })
})

describe("loop rounds on the canvas (GRS-014e)", () => {
  it("collapses per-round receipts to ONE node per nodeId showing the latest round", () => {
    const run = runWire({
      status: "running",
      parked: null,
      rounds: 2,
      steps: [
        { nodeId: "a", label: "A", actor: { kind: "engine", ref: "codex" }, status: "done", detail: "session settled", at: "" },
        { nodeId: "b", label: "B", actor: { kind: "engine", ref: "codex" }, status: "done", detail: "session settled", at: "" },
        { nodeId: "a", label: "A", actor: { kind: "engine", ref: "codex" }, status: "running", round: 2, detail: "dispatching", at: "" },
        { nodeId: "b", label: "B", actor: { kind: "engine", ref: "codex" }, status: "pending", round: 2, at: "" },
      ],
    })
    const nodes = nodesForDefinitionRun(run)
    const aNodes = nodes.filter((n) => n.id === "a")
    expect(aNodes).toHaveLength(1) // no duplicate canvas ids / React keys
    expect(aNodes[0].status).toBe("running") // the LATEST round's state
    expect(aNodes[0].detail).toContain("round 2")
    const bNodes = nodes.filter((n) => n.id === "b")
    expect(bNodes).toHaveLength(1)
    expect(bNodes[0].status).toBe("pending")
  })
})
