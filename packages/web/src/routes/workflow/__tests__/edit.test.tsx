import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { EditableWorkflowDefinitionWire, SaveDefinitionResult } from "@/lib/api"

// Mock the api module: the pure helpers don't touch it, WorkflowEditView does.
const getWorkflowDefinition = vi.fn()
const updateWorkflowDefinition = vi.fn()
const listWorkflowTriggers = vi.fn()
const createWorkflowTrigger = vi.fn()
const deleteWorkflowTrigger = vi.fn()
const decideWorkflowTriggerActivationApproval = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: (...a: unknown[]) => getWorkflowDefinition(...a),
    updateWorkflowDefinition: (...a: unknown[]) => updateWorkflowDefinition(...a),
    listWorkflowTriggers: (...a: unknown[]) => listWorkflowTriggers(...a),
    createWorkflowTrigger: (...a: unknown[]) => createWorkflowTrigger(...a),
    deleteWorkflowTrigger: (...a: unknown[]) => deleteWorkflowTrigger(...a),
    decideWorkflowTriggerActivationApproval: (...a: unknown[]) => decideWorkflowTriggerActivationApproval(...a),
  },
}))

import {
  orderDefinitionNodes,
  nodesForDefinition,
  draftsFromDefinition,
  isDirty,
  buildNodesPatch,
  EditableNodeInspector,
  WorkflowEditView,
  type NodeDraft,
} from "../edit"
import type { CanvasNode } from "../canvas"

function def(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "sample-autonomy",
    title: "Sample Autonomy",
    version: 3,
    status: "active",
    orchestrator: "jimbo",
    nodes: [
      { id: "trigger", type: "trigger", label: "Every 2h", position: { x: 0, y: 0 }, role: "trigger" },
      { id: "orchestrate", type: "step", label: "Orchestrate", position: { x: 1, y: 0 }, role: "orchestrate", actor: { kind: "employee", ref: "jimbo" }, cadence: "every 2h" },
      { id: "verify", type: "step", label: "Verify", position: { x: 2, y: 0 }, role: "verify", actor: { kind: "engine", ref: "codex" } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "orchestrate" },
      { id: "e2", from: "orchestrate", to: "verify" },
    ],
    ...overrides,
  }
}

describe("orderDefinitionNodes", () => {
  it("renders nodes in declaration order with the trigger first", () => {
    const ordered = orderDefinitionNodes(def())
    expect(ordered.map((n) => n.id)).toEqual(["trigger", "orchestrate", "verify"])
  })

  it("hoists a trigger declared out of position to the front, keeping the rest in order", () => {
    const d = def({
      nodes: [
        { id: "a", type: "step", label: "A", position: { x: 1, y: 0 } },
        { id: "trigger", type: "trigger", label: "T", position: { x: 0, y: 0 } },
        { id: "b", type: "step", label: "B", position: { x: 2, y: 0 } },
      ],
      edges: [],
    })
    expect(orderDefinitionNodes(d).map((n) => n.id)).toEqual(["trigger", "a", "b"])
  })

  it("does NOT reorder on a handoff shortcut edge declared before the sequence backbone (Codex Major 1)", () => {
    // Mirrors the real sample-autonomy fixture: `adversary` owns adversary→decide
    // (handoff, declared first) AND adversary→steer (sequence). Edge-following
    // would render adversary→decide→…→steer and draw fake edges; declaration
    // order must win.
    const d = def({
      nodes: [
        { id: "trigger", type: "trigger", label: "T", position: { x: 0, y: 0 } },
        { id: "adversary", type: "step", label: "Adv", position: { x: 1, y: 0 } },
        { id: "steer", type: "step", label: "Steer", position: { x: 2, y: 0 } },
        { id: "decide", type: "step", label: "Decide", position: { x: 3, y: 0 } },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "adversary", kind: "sequence" },
        { id: "e2", from: "adversary", to: "decide", kind: "handoff" },
        { id: "e3", from: "adversary", to: "steer", kind: "sequence" },
      ],
    })
    expect(orderDefinitionNodes(d).map((n) => n.id)).toEqual(["trigger", "adversary", "steer", "decide"])
  })
})

describe("nodesForDefinition", () => {
  it("maps nodes to neutral draft canvas nodes with actor as 'who' and no gate receipts", () => {
    const nodes = nodesForDefinition(def())
    expect(nodes.map((n) => n.id)).toEqual(["trigger", "orchestrate", "verify"])
    expect(nodes.every((n) => n.status === "draft")).toBe(true)
    expect(nodes.every((n) => n.isCurrent === false)).toBe(true)
    expect(nodes.every((n) => n.gates.length === 0)).toBe(true)
    expect(nodes.find((n) => n.id === "orchestrate")?.who).toBe("jimbo")
    expect(nodes.find((n) => n.id === "trigger")?.who).toBe("schedule")
  })

  it("applies draft overrides for label + cadence", () => {
    const drafts: Record<string, NodeDraft> = { orchestrate: { label: "Renamed", cadence: "hourly", instructions: "" } }
    const nodes = nodesForDefinition(def(), drafts)
    const o = nodes.find((n) => n.id === "orchestrate")
    expect(o?.title).toBe("Renamed")
    expect(o?.cadence).toBe("hourly")
  })

  it("falls back to (untitled) when a draft label is blank", () => {
    const nodes = nodesForDefinition(def(), { trigger: { label: "", cadence: "", instructions: "" } })
    expect(nodes.find((n) => n.id === "trigger")?.title).toBe("(untitled)")
  })
})

describe("draftsFromDefinition / isDirty / buildNodesPatch", () => {
  it("seeds drafts from persisted values with cadence defaulting to empty string", () => {
    // GRS-016b extended the draft shape with option fields; GRS-016c added
    // switchMode/failMessage; GRS-016d added waitMinutes/waitUntil (all nodes,
    // "" = unset) and errorLanes (actor steps: one row per non-loop out-edge).
    const emptyOptions = { model: "", effort: "", output: "", onError: "", retryMaxAttempts: "", retryOn: [], timeoutMinutes: "", sessionMode: "", sessionId: "", switchMode: "", failMessage: "", waitMinutes: "", waitUntil: "" }
    const drafts = draftsFromDefinition(def())
    expect(drafts.orchestrate).toEqual({
      label: "Orchestrate", cadence: "every 2h", instructions: "", ...emptyOptions,
      errorLanes: [{ edgeId: "e2", to: "verify", error: false }],
    })
    expect(drafts.verify).toEqual({ label: "Verify", cadence: "", instructions: "", ...emptyOptions, errorLanes: [] })
  })

  it("isDirty is false for untouched drafts and true after a label/cadence change", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(isDirty(d, drafts)).toBe(false)
    expect(isDirty(d, { ...drafts, verify: { label: "Verify++", cadence: "", instructions: "" } })).toBe(true)
    expect(isDirty(d, { ...drafts, verify: { label: "Verify", cadence: "daily", instructions: "" } })).toBe(true)
  })

  it("buildNodesPatch applies the label and drops an emptied cadence to undefined", () => {
    const d = def()
    const drafts = { ...draftsFromDefinition(d), orchestrate: { label: "New", cadence: "   ", instructions: "" } }
    const patched = buildNodesPatch(d, drafts)
    const o = patched.find((n) => n.id === "orchestrate")!
    expect(o.label).toBe("New")
    expect("cadence" in o).toBe(false)
  })

  it("buildNodesPatch keeps a non-empty cadence", () => {
    const d = def()
    const drafts = { ...draftsFromDefinition(d), verify: { label: "Verify", cadence: "weekly", instructions: "" } }
    const v = buildNodesPatch(d, drafts).find((n) => n.id === "verify")!
    expect(v.cadence).toBe("weekly")
  })

  it("GRS-014c: buildNodesPatch round-trips instructions on STEP nodes and drops empty back to undefined", () => {
    const d = def()
    const withText = { ...draftsFromDefinition(d), verify: { label: "Verify", cadence: "", instructions: "Run the full suite and report." } }
    const v = buildNodesPatch(d, withText).find((n) => n.id === "verify")!
    expect(v.instructions).toBe("Run the full suite and report.")

    const emptied = { ...draftsFromDefinition(d), verify: { label: "Verify", cadence: "", instructions: "   " } }
    const v2 = buildNodesPatch(d, emptied).find((n) => n.id === "verify")!
    expect("instructions" in v2).toBe(false)
  })

  it("GRS-014c: buildNodesPatch never writes instructions onto a non-step node (validator rejects it)", () => {
    const d = def()
    const drafts = { ...draftsFromDefinition(d), trigger: { label: "Trigger", cadence: "", instructions: "sneaky" } }
    const t = buildNodesPatch(d, drafts).find((n) => n.id === "trigger")!
    expect("instructions" in t).toBe(false)
  })

  it("GRS-014c: isDirty flips on an instructions change", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(isDirty(d, { ...drafts, verify: { ...drafts.verify, instructions: "new task text" } })).toBe(true)
  })
})

const canvasNode: CanvasNode = {
  id: "orchestrate",
  kind: "step",
  title: "Orchestrate",
  role: "orchestrate",
  who: "jimbo",
  status: "draft",
  isCurrent: false,
  gates: [],
}

describe("EditableNodeInspector", () => {
  it("renders label + cadence inputs and fires onChange", () => {
    const onChange = vi.fn()
    render(
      <EditableNodeInspector
        node={canvasNode}
        draft={{ label: "Orchestrate", cadence: "every 2h", instructions: "" }}
        onChange={onChange}
        onClose={() => {}}
      />,
    )
    const label = screen.getByTestId("wf-edit-label") as HTMLInputElement
    expect(label.value).toBe("Orchestrate")
    fireEvent.change(label, { target: { value: "Orchestrate!" } })
    expect(onChange).toHaveBeenCalledWith({ label: "Orchestrate!" })
  })

  it("shows an inline error when the label is blank", () => {
    render(
      <EditableNodeInspector
        node={canvasNode}
        draft={{ label: "  ", cadence: "", instructions: "" }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Label can’t be empty/)).toBeTruthy()
  })

  it("GRS-014c: renders an instructions textarea for STEP nodes and fires onChange", () => {
    const onChange = vi.fn()
    render(
      <EditableNodeInspector
        node={canvasNode}
        draft={{ label: "Orchestrate", cadence: "", instructions: "Do the work." }}
        onChange={onChange}
        onClose={() => {}}
      />,
    )
    const area = screen.getByTestId("wf-edit-instructions") as HTMLTextAreaElement
    expect(area.value).toBe("Do the work.")
    fireEvent.change(area, { target: { value: "Do the work carefully." } })
    expect(onChange).toHaveBeenCalledWith({ instructions: "Do the work carefully." })
  })

  it("GRS-014c: hides the instructions textarea for non-step nodes", () => {
    render(
      <EditableNodeInspector
        node={{ ...canvasNode, id: "trigger", kind: "trigger", role: "trigger" }}
        draft={{ label: "Trigger", cadence: "", instructions: "" }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId("wf-edit-instructions")).toBeNull()
  })
})

describe("WorkflowEditView", () => {
  beforeEach(() => {
    getWorkflowDefinition.mockReset()
    updateWorkflowDefinition.mockReset()
    listWorkflowTriggers.mockReset().mockResolvedValue({ triggers: [], evidenceConfigured: true })
    createWorkflowTrigger.mockReset().mockImplementation(async (input) => ({
      trigger: {
        ...input,
        activation: "active",
        source: input.kind === "webhook" ? "event-webhook" : "poll",
        createdAt: "2026-07-06T12:00:00.000Z",
        updatedAt: "2026-07-06T12:00:00.000Z",
      },
    }))
    deleteWorkflowTrigger.mockReset().mockResolvedValue({ deleted: true })
    decideWorkflowTriggerActivationApproval.mockReset()
  })

  it("loads the definition and renders the edit toolbar with version", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    expect(screen.getAllByText(/v3/).length).toBeGreaterThan(0)
    expect(getWorkflowDefinition).toHaveBeenCalledWith("sample-autonomy")
  })

  it("marks dirty on edit, saves with expectedVersion + node patch, then clears dirty", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    const saved: SaveDefinitionResult = { ok: true, definition: def({ version: 4, nodes: def().nodes.map((n) => n.id === "verify" ? { ...n, label: "Verify++" } : n) }) }
    updateWorkflowDefinition.mockResolvedValue(saved)
    const onDirty = vi.fn()
    render(<WorkflowEditView workflowId="sample-autonomy" onDirtyChange={onDirty} />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())

    // Save is disabled until dirty.
    expect((screen.getByTestId("wf-edit-save") as HTMLButtonElement).disabled).toBe(true)

    // Select the verify node, edit its label.
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    const label = screen.getAllByTestId("wf-edit-label")[0] as HTMLInputElement
    fireEvent.change(label, { target: { value: "Verify++" } })
    await waitFor(() => expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy())
    expect(onDirty).toHaveBeenCalledWith(true)
    expect((screen.getByTestId("wf-edit-save") as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalled())
    const [id, patch, expectedVersion] = updateWorkflowDefinition.mock.calls[0]
    expect(id).toBe("sample-autonomy")
    expect(expectedVersion).toBe(3)
    expect(patch.nodes.find((n: { id: string; label: string }) => n.id === "verify").label).toBe("Verify++")

    // Post-save: version reloaded to 4, dirty cleared, saved indicator shown.
    await waitFor(() => expect(screen.getByTestId("wf-edit-saved")).toBeTruthy())
    expect(screen.queryByTestId("wf-edit-dirty")).toBeNull()
    expect(screen.getAllByText(/v4/).length).toBeGreaterThan(0)
  })

  it("omits manual layout intent for a property-only save", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({
      ok: true,
      definition: def({
        version: 4,
        nodes: def().nodes.map((node) => node.id === "verify" ? { ...node, label: "Verify carefully" } : node),
      }),
    } satisfies SaveDefinitionResult)
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "Verify carefully" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))

    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalledTimes(1))
    expect(updateWorkflowDefinition.mock.calls[0]).toHaveLength(3)
    expect(updateWorkflowDefinition).toHaveBeenCalledWith(
      "sample-autonomy",
      expect.objectContaining({ nodes: expect.any(Array), edges: expect.any(Array) }),
      3,
    )
  })

  it("blocks save while a label is blank", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "" } })
    await waitFor(() => expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy())
    expect((screen.getByTestId("wf-edit-save") as HTMLButtonElement).disabled).toBe(true)
  })

  it("surfaces 400 validation errors from the save without corrupting the view", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({
      ok: false,
      status: 400,
      message: "definition is invalid",
      errors: [{ code: "missing-title", message: "title is required", path: "title" }],
    } satisfies SaveDefinitionResult)
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "Verify++" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(screen.getByTestId("wf-edit-save-error")).toBeTruthy())
    expect(screen.getByText(/definition is invalid/)).toBeTruthy()
    expect(screen.getByText(/title is required/)).toBeTruthy()
    // Still dirty (save didn't take), version unchanged.
    expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy()
    expect(screen.getAllByText(/v3/).length).toBeGreaterThan(0)
  })

  it("does not wedge the editor when the save transport throws (Codex Major 2)", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockRejectedValue(new Error("Failed to fetch"))
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "Verify++" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(screen.getByTestId("wf-edit-save-error")).toBeTruthy())
    expect(screen.getByText(/Failed to fetch/)).toBeTruthy()
    // Still dirty, and Save is re-enabled (not stuck spinning), Discard usable.
    expect((screen.getByTestId("wf-edit-save") as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId("wf-edit-discard") as HTMLButtonElement).disabled).toBe(false)
  })

  it("offers a reload on a 409 version conflict", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({
      ok: false,
      status: 409,
      message: "version conflict: expected 3",
    } satisfies SaveDefinitionResult)
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "Verify++" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(screen.getByText(/Reload latest/)).toBeTruthy())
  })

  it("discard reverts drafts to the persisted definition", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-node-verify"))
    fireEvent.change(screen.getAllByTestId("wf-edit-label")[0], { target: { value: "Changed" } })
    await waitFor(() => expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("wf-edit-discard"))
    await waitFor(() => expect(screen.queryByTestId("wf-edit-dirty")).toBeNull())
    expect((screen.getAllByTestId("wf-edit-label")[0] as HTMLInputElement).value).toBe("Verify")
  })

  it("round-trips schedule and todo-status wake-ups through the definition trigger config", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: def({ version: 4 }) } satisfies SaveDefinitionResult)
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-wakeup-editor")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-wakeup-schedule"))
    fireEvent.change(screen.getByTestId("wf-wakeup-cron"), { target: { value: "0 9 * * 1-5" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-timezone"), { target: { value: "Europe/Sofia" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalled())

    let [, patch] = updateWorkflowDefinition.mock.calls.at(-1)!
    expect(patch.nodes.find((n: { id: string }) => n.id === "trigger").trigger).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Sofia",
    })

    getWorkflowDefinition.mockResolvedValue(def({ version: 4 }))
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: def({ version: 5 }) } satisfies SaveDefinitionResult)
    fireEvent.click(screen.getByTestId("wf-wakeup-todo-status"))
    fireEvent.change(screen.getByTestId("wf-wakeup-to-status"), { target: { value: "in_review" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-from-status"), { target: { value: "executing" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-filter-assignee"), { target: { value: "jinn-dev" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))
    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalledTimes(2))

    ;[, patch] = updateWorkflowDefinition.mock.calls.at(-1)!
    expect(patch.nodes.find((n: { id: string }) => n.id === "trigger").trigger).toEqual({
      kind: "todo-status-change",
      toStatus: "in_review",
      fromStatus: "executing",
      filter: { assignee: "jinn-dev" },
    })
  })

  it("keeps Save disabled for malformed schedule wake-ups", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-wakeup-editor")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-wakeup-schedule"))
    fireEvent.change(screen.getByTestId("wf-wakeup-cron"), { target: { value: "0 9 * *" } })

    expect((screen.getByTestId("wf-edit-save") as HTMLButtonElement).disabled).toBe(true)
  })

  it("round-trips event and poll wake-ups through workflow trigger bindings", async () => {
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: def({ version: 4 }) } satisfies SaveDefinitionResult)
    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-wakeup-editor")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-wakeup-event"))
    fireEvent.change(screen.getByTestId("wf-wakeup-trigger-name"), { target: { value: "lead-hook" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-event-name"), { target: { value: "lead.created" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-secret"), { target: { value: "binding-secret" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))

    await waitFor(() => expect(createWorkflowTrigger).toHaveBeenCalledWith({
      kind: "webhook",
      name: "lead-hook",
      event: "lead.created",
      targetWorkflowId: "sample-autonomy",
      secretToken: "binding-secret",
    }))
    expect(updateWorkflowDefinition).toHaveBeenCalledWith(
      "sample-autonomy",
      expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({ id: "trigger", trigger: { kind: "manual" } })]),
      }),
      3,
    )

    listWorkflowTriggers.mockResolvedValue({
      evidenceConfigured: true,
      triggers: [{ kind: "webhook", name: "lead-hook", event: "lead.created", targetWorkflowId: "sample-autonomy", activation: "active", source: "event-webhook", createdAt: "", updatedAt: "2026-07-06T12:00:00.000Z" }],
    })
    getWorkflowDefinition.mockResolvedValue(def({ version: 4 }))
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: def({ version: 5 }) } satisfies SaveDefinitionResult)
    createWorkflowTrigger.mockClear()

    fireEvent.click(screen.getByTestId("wf-wakeup-poll"))
    fireEvent.change(screen.getByTestId("wf-wakeup-trigger-name"), { target: { value: "daily-check" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-event-name"), { target: { value: "check.ready" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-command"), { target: { value: "node scripts/check.js" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-interval"), { target: { value: "300" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))

    await waitFor(() => expect(deleteWorkflowTrigger).toHaveBeenCalledWith("lead-hook"))
    expect(createWorkflowTrigger).toHaveBeenCalledWith({
      kind: "poll",
      name: "daily-check",
      event: "check.ready",
      targetWorkflowId: "sample-autonomy",
      command: "node scripts/check.js",
      intervalSeconds: 300,
    })
  })

  it("approves a pending poll activation through the native Workflow approval", async () => {
    const pending = {
      schemaVersion: 2,
      kind: "poll" as const,
      name: "daily-check",
      event: "check.ready",
      targetWorkflowId: "sample-autonomy",
      activation: "pending_approval" as const,
      source: "poll" as const,
      command: "node scripts/check.js",
      intervalSeconds: 300,
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
      approval: {
        requesterEmployee: "workflow-author",
        target: "workflow-manager",
        targetKind: "employee" as const,
        requestedAt: "2026-07-06T12:00:00.000Z",
        requestedBy: "workflow-trigger" as const,
        escalatedAt: null,
        state: "pending" as const,
        activationContractHash: "sha256:contract",
        decidedBy: null,
        decidedAt: null,
      },
    }
    listWorkflowTriggers.mockResolvedValue({ triggers: [pending], evidenceConfigured: true })
    getWorkflowDefinition.mockResolvedValue(def())
    decideWorkflowTriggerActivationApproval.mockResolvedValue({
      trigger: {
        ...pending,
        activation: "active",
        approval: {
          ...pending.approval,
          state: "approved",
          decidedBy: "workflow-manager",
          decidedAt: "2026-07-06T12:01:00.000Z",
        },
      },
    })

    render(<WorkflowEditView workflowId="sample-autonomy" />)

    await waitFor(() => expect(screen.getByTestId("wf-poll-approval")).toBeTruthy())
    expect(screen.getByTestId("wf-poll-approval").textContent).toContain("Pending approval")
    fireEvent.click(screen.getByTestId("wf-poll-approve"))

    await waitFor(() => expect(decideWorkflowTriggerActivationApproval).toHaveBeenCalledWith("daily-check", "approve"))
    expect(screen.getByTestId("wf-poll-approval").textContent).toContain("Approved")
  })

  it("does not delete the current wake-up binding when replacement creation fails", async () => {
    listWorkflowTriggers.mockResolvedValue({
      evidenceConfigured: true,
      triggers: [{ kind: "webhook", name: "lead-hook", event: "lead.created", targetWorkflowId: "sample-autonomy", activation: "active", source: "event-webhook", createdAt: "", updatedAt: "2026-07-06T12:00:00.000Z" }],
    })
    getWorkflowDefinition.mockResolvedValue(def())
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: def({ version: 4 }) } satisfies SaveDefinitionResult)
    createWorkflowTrigger.mockRejectedValue(new Error("trigger name already exists"))

    render(<WorkflowEditView workflowId="sample-autonomy" />)
    await waitFor(() => expect(screen.getByTestId("wf-wakeup-editor")).toBeTruthy())

    fireEvent.click(screen.getByTestId("wf-wakeup-poll"))
    fireEvent.change(screen.getByTestId("wf-wakeup-trigger-name"), { target: { value: "daily-check" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-event-name"), { target: { value: "check.ready" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-command"), { target: { value: "node scripts/check.js" } })
    fireEvent.change(screen.getByTestId("wf-wakeup-interval"), { target: { value: "300" } })
    fireEvent.click(screen.getByTestId("wf-edit-save"))

    await waitFor(() => expect(screen.getByTestId("wf-edit-save-error").textContent).toContain("trigger name already exists"))
    expect(createWorkflowTrigger).toHaveBeenCalled()
    expect(deleteWorkflowTrigger).not.toHaveBeenCalled()
  })
})
