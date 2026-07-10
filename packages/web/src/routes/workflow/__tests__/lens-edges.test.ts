import { describe, it, expect } from "vitest"
import { edgesForDefinition, ghostNodeForDefinition } from "../edit"
import { edgesForDefinitionRun } from "../run-view"
import type { EditableWorkflowDefinitionWire, WorkflowRunWire, RunStepReceiptWire } from "@/lib/api"
import type { CanvasNode } from "../canvas-model"

/* Spec §6 — both lenses draw the SAME topology on the same geometry: the
 * Editor now renders the definition's real edges (not the declaration chain),
 * and switch out-edges carry their output-row index in BOTH lenses so branch
 * wires leave the correct row port on the card wall. */

const DEF: EditableWorkflowDefinitionWire = {
  schemaVersion: 2, id: "wf", title: "WF", version: 1, status: "active",
  nodes: [
    { id: "trig", type: "trigger", label: "Trigger", position: { x: 0, y: 100 } },
    { id: "sw", type: "switch", label: "Route", position: { x: 300, y: 80 } },
    { id: "a", type: "step", label: "A", position: { x: 600, y: 0 } },
    { id: "b", type: "step", label: "B", position: { x: 600, y: 200 } },
  ],
  edges: [
    { id: "e1", from: "trig", to: "sw" },
    { id: "err", from: "sw", to: "a", lane: "error" },
    { id: "e2", from: "sw", to: "a", label: "hot" },
    { id: "e3", from: "sw", to: "b", label: "cold" },
  ],
}

describe("edgesForDefinition — the Editor lens draws the real topology", () => {
  it("maps switch out-edges to their output-row index, skipping the error lane", () => {
    const edges = edgesForDefinition(DEF)
    expect(edges.map((e) => e.id)).toEqual(["e1", "err", "e2", "e3"])
    expect(edges.find((e) => e.id === "e1")!.outIndex).toBeUndefined()
    // Ordering matches deriveDisplayFields' lane!=='error' filter: e2 → row 0, e3 → row 1.
    expect(edges.find((e) => e.id === "e2")!.outIndex).toBe(0)
    expect(edges.find((e) => e.id === "e3")!.outIndex).toBe(1)
    // The error lane keeps its lane marker and no output row.
    expect(edges.find((e) => e.id === "err")).toMatchObject({ lane: "error" })
    expect(edges.find((e) => e.id === "err")!.outIndex).toBeUndefined()
  })
})

describe("ghostNodeForDefinition — empty-canvas teaching affordance (spec §7)", () => {
  it("appends a ghost one gap right of a lone positioned trigger", () => {
    const empty: EditableWorkflowDefinitionWire = { ...DEF, nodes: [DEF.nodes[0]], edges: [] }
    const ghost = ghostNodeForDefinition(empty)!
    expect(ghost.visual).toBe("ghost")
    expect(ghost.position!.x).toBeGreaterThan(DEF.nodes[0].position.x)
  })
  it("is absent once the definition has any real step", () => {
    expect(ghostNodeForDefinition(DEF)).toBeNull()
  })
})

describe("edgesForDefinitionRun — run snapshot switch edges name their row port", () => {
  it("carries outIndex from the frozen snapshot's lane!=='error' ordering", () => {
    const run = {
      runId: "r1", workflowId: "wf", definitionVersion: 1, title: "WF",
      trigger: { kind: "manual" }, status: "completed",
      startedAt: "2026-07-10T07:00:00Z", endedAt: null, steps: [], parked: null,
      definitionSnapshot: DEF,
    } as unknown as WorkflowRunWire
    const nodes: CanvasNode[] = [] // trigger remap not exercised here
    const edges = edgesForDefinitionRun(run, nodes)
    expect(edges.find((e) => e.id === "e2")!.outIndex).toBe(0)
    expect(edges.find((e) => e.id === "e3")!.outIndex).toBe(1)
    expect(edges.find((e) => e.id === "err")!.outIndex).toBeUndefined()
  })
})

/* QA defect 2 — execution edges carry their receipt-derived item counts, so the
 * run lens renders the mid-wire pills: taken lanes count one item per settled
 * round, `fired` lanes are taken-but-empty (`0 items`), untaken branches carry
 * no count at all. */
describe("edgesForDefinitionRun — taken lanes carry receipt-derived item counts", () => {
  const receipt = (nodeId: string, over: Partial<RunStepReceiptWire> = {}): RunStepReceiptWire => ({
    nodeId, label: nodeId, actor: null, status: "done", at: "2026-07-10T07:01:00Z", ...over,
  })
  const runWith = (steps: RunStepReceiptWire[], snapshot: EditableWorkflowDefinitionWire = DEF): WorkflowRunWire =>
    ({
      runId: "r1", workflowId: "wf", definitionVersion: 1, title: "WF",
      trigger: { kind: "manual" }, status: "completed",
      startedAt: "2026-07-10T07:00:00Z", endedAt: null, steps, parked: null,
      definitionSnapshot: snapshot,
    }) as unknown as WorkflowRunWire

  it("counts the taken switch branch and leaves the untaken branch pill-less", () => {
    const run = runWith([
      receipt("sw", { status: "routed", route: ["e2"] }),
      receipt("a", { status: "done" }),
      receipt("b", { status: "skipped" }),
    ])
    const edges = edgesForDefinitionRun(run, [])
    // Trigger fired for any visible run → its out-edge carried the one payload.
    expect(edges.find((e) => e.id === "e1")!.items).toBe(1)
    expect(edges.find((e) => e.id === "e2")!.items).toBe(1)
    expect(edges.find((e) => e.id === "e3")!.items).toBeUndefined()
  })

  it("renders taken-but-empty: a fired (output: none) source passes 0 items", () => {
    const snap: EditableWorkflowDefinitionWire = {
      ...DEF,
      nodes: [
        { id: "trig", type: "trigger", label: "Trigger", position: { x: 0, y: 0 } },
        { id: "f", type: "step", label: "F", position: { x: 300, y: 0 } },
        { id: "x", type: "step", label: "X", position: { x: 600, y: 0 } },
      ] as EditableWorkflowDefinitionWire["nodes"],
      edges: [
        { id: "t1", from: "trig", to: "f" },
        { id: "fx", from: "f", to: "x" },
      ],
    }
    const run = runWith([receipt("f", { status: "fired" }), receipt("x", { status: "pending" })], snap)
    const edges = edgesForDefinitionRun(run, [])
    expect(edges.find((e) => e.id === "fx")!.items).toBe(0)
  })

  it("sums loop rounds: two settled rounds of the source = 2 items on its lane", () => {
    const snap: EditableWorkflowDefinitionWire = {
      ...DEF,
      nodes: [
        { id: "a", type: "step", label: "A", position: { x: 0, y: 0 } },
        { id: "b", type: "step", label: "B", position: { x: 300, y: 0 } },
      ] as EditableWorkflowDefinitionWire["nodes"],
      edges: [{ id: "ab", from: "a", to: "b" }],
    }
    const run = runWith(
      [receipt("a", { round: 1 }), receipt("b", { round: 1 }), receipt("a", { round: 2 }), receipt("b", { round: 2 })],
      snap,
    )
    expect(edgesForDefinitionRun(run, []).find((e) => e.id === "ab")!.items).toBe(2)
  })

  it("keeps unsettled lanes quiet: a running source has not passed control yet", () => {
    const run = runWith([
      receipt("sw", { status: "running" }),
      receipt("a", { status: "pending" }),
      receipt("b", { status: "pending" }),
    ])
    const edges = edgesForDefinitionRun(run, [])
    expect(edges.find((e) => e.id === "e2")!.items).toBeUndefined()
    expect(edges.find((e) => e.id === "e3")!.items).toBeUndefined()
  })
})
