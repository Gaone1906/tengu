import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { EditableWorkflowDefinitionWire } from "@/lib/api"

vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: vi.fn(),
    updateWorkflowDefinition: vi.fn(),
  },
}))

import {
  buildEdgesPatch,
  buildNodesPatch,
  conditionsFromRows,
  draftsFromDefinition,
  isDirty,
  nodesForDefinition,
  EditableNodeInspector,
  type ConditionRowDraft,
} from "../edit"

/**
 * GRS-016c — switch/fail inspector fields (plain controls; the polished builder is
 * GRS-016f). Contract under test: switchMode/failMessage/edge-`when` → drafts →
 * nodes+edges patch, with ABSENT staying absent, a no-op edit keeping the persisted
 * objects (no key-order churn), and cleared conditions dropping `when` entirely.
 */

function def(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "wf-sw",
    title: "WF Switch",
    version: 1,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, role: "trigger" },
      { id: "review", type: "step", label: "Review", position: { x: 1, y: 0 }, actor: { kind: "engine", ref: "claude" } },
      { id: "sw", type: "switch", label: "Route", position: { x: 2, y: 0 } },
      { id: "ship", type: "step", label: "Ship", position: { x: 3, y: 0 }, actor: { kind: "engine", ref: "codex" } },
      { id: "stop", type: "fail", label: "Stop", position: { x: 3, y: 1 }, failMessage: "rejected" },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "review", kind: "sequence" },
      { id: "e2", from: "review", to: "sw", kind: "sequence" },
      { id: "e3", from: "sw", to: "ship", kind: "sequence", when: [
        { path: "steps.review.outcome.fields.verdict", op: "eq", value: "ship" },
        { path: "steps.review.outcome.fields.bugCount", op: "lte", value: 5 },
      ] },
      { id: "e4", from: "sw", to: "stop", kind: "sequence" },
    ],
    ...overrides,
  }
}

describe("switch/fail drafts (GRS-016c)", () => {
  it("hydrates switchMode, failMessage, and per-out-edge condition rows with value types", () => {
    const drafts = draftsFromDefinition(def())
    expect(drafts.sw.switchMode).toBe("")
    expect(drafts.stop.failMessage).toBe("rejected")
    expect(drafts.sw.branches).toEqual([
      {
        edgeId: "e3", to: "ship",
        rows: [
          { path: "steps.review.outcome.fields.verdict", op: "eq", value: "ship", valueType: "string" },
          { path: "steps.review.outcome.fields.bugCount", op: "lte", value: "5", valueType: "number" },
        ],
      },
      { edgeId: "e4", to: "stop", rows: [] },
    ])
    expect(isDirty(def(), drafts)).toBe(false)
  })

  it("encodes rows by declared value type; exists/absent carry no value; empty rows → undefined", () => {
    const rows: ConditionRowDraft[] = [
      { path: "steps.review.outcome.fields.verdict", op: "eq", value: "ship", valueType: "string" },
      { path: "run.rounds", op: "gte", value: "2", valueType: "number" },
      { path: "steps.review.outcome.fields.needsHuman", op: "eq", value: "true", valueType: "boolean" },
      { path: "steps.review.outcome.fields.verdict", op: "exists", value: "ignored", valueType: "string" },
      { path: "   ", op: "eq", value: "x", valueType: "string" }, // blank path rows are dropped
    ]
    expect(conditionsFromRows(rows)).toEqual([
      { path: "steps.review.outcome.fields.verdict", op: "eq", value: "ship" },
      { path: "run.rounds", op: "gte", value: 2 },
      { path: "steps.review.outcome.fields.needsHuman", op: "eq", value: true },
      { path: "steps.review.outcome.fields.verdict", op: "exists" },
    ])
    expect(conditionsFromRows([])).toBeUndefined()
  })

  it("buildEdgesPatch: no-op edits keep the persisted edge objects; condition edits re-encode; cleared rows drop `when`", () => {
    const d = def()
    const clean = draftsFromDefinition(d)
    // no-op: every edge object identity is preserved (no key-order churn)
    const same = buildEdgesPatch(d, clean)
    expect(same[2]).toBe(d.edges[2])
    expect(same[3]).toBe(d.edges[3])
    // edit a condition value
    const edited = draftsFromDefinition(d)
    edited.sw = {
      ...edited.sw,
      branches: edited.sw.branches!.map((b) =>
        b.edgeId === "e3" ? { ...b, rows: [{ path: "steps.review.outcome.fields.verdict", op: "eq", value: "reject", valueType: "string" as const }] } : b,
      ),
    }
    expect(isDirty(d, edited)).toBe(true)
    const patched = buildEdgesPatch(d, edited)
    expect(patched[2].when).toEqual([{ path: "steps.review.outcome.fields.verdict", op: "eq", value: "reject" }])
    // clear all rows → `when` key dropped (the edge becomes the default branch)
    const cleared = draftsFromDefinition(d)
    cleared.sw = { ...cleared.sw, branches: cleared.sw.branches!.map((b) => ({ ...b, rows: [] })) }
    const dropped = buildEdgesPatch(d, cleared)
    expect("when" in dropped[2]).toBe(false)
    expect(dropped[3]).toBe(d.edges[3]) // was already conditionless — untouched
  })

  it("buildNodesPatch round-trips switchMode and failMessage; empty drops the key", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    drafts.sw = { ...drafts.sw, switchMode: "allMatches" }
    drafts.stop = { ...drafts.stop, failMessage: "rejected by review" }
    const nodes = buildNodesPatch(d, drafts)
    expect(nodes.find((n) => n.id === "sw")!.switchMode).toBe("allMatches")
    expect(nodes.find((n) => n.id === "stop")!.failMessage).toBe("rejected by review")
    const clearedMode = draftsFromDefinition(d)
    clearedMode.sw = { ...clearedMode.sw, switchMode: "" }
    expect("switchMode" in buildNodesPatch(d, clearedMode).find((n) => n.id === "sw")!).toBe(false)
  })

  it("isDirty catches switchMode and failMessage edits", () => {
    const d = def()
    const a = draftsFromDefinition(d)
    a.sw = { ...a.sw, switchMode: "allMatches" }
    expect(isDirty(d, a)).toBe(true)
    const b = draftsFromDefinition(d)
    b.stop = { ...b.stop, failMessage: "changed" }
    expect(isDirty(d, b)).toBe(true)
  })
})

describe("switch/fail inspector controls", () => {
  it("renders the mode select and per-branch condition rows for a switch node", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === "sw")!
    const onChange = vi.fn()
    render(<EditableNodeInspector node={node} draft={drafts.sw} onChange={onChange} onClose={() => {}} />)
    expect(screen.getByTestId("wf-edit-switch-mode")).toBeTruthy()
    // e3's two condition rows render; e4 shows as the default branch
    expect(screen.getByTestId("wf-edit-cond-e3-0-path")).toHaveProperty("value", "steps.review.outcome.fields.verdict")
    expect(screen.getByTestId("wf-edit-cond-e3-1-op")).toHaveProperty("value", "lte")
    expect(screen.getByTestId("wf-edit-branch-e4-default")).toBeTruthy()
    // editing a value patches the branches draft
    fireEvent.change(screen.getByTestId("wf-edit-cond-e3-0-value"), { target: { value: "reject" } })
    const patch = onChange.mock.calls.at(-1)![0]
    expect(patch.branches[0].rows[0].value).toBe("reject")
  })

  it("renders the failMessage input for a fail node and patches it", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === "stop")!
    const onChange = vi.fn()
    render(<EditableNodeInspector node={node} draft={drafts.stop} onChange={onChange} onClose={() => {}} />)
    const input = screen.getByTestId("wf-edit-fail-message")
    expect(input).toHaveProperty("value", "rejected")
    fireEvent.change(input, { target: { value: "nope" } })
    expect(onChange).toHaveBeenCalledWith({ failMessage: "nope" })
  })
})
