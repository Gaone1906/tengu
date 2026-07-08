import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { EditableWorkflowDefinitionWire, RunStepReceiptWire } from "@/lib/api"

vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: vi.fn(),
    updateWorkflowDefinition: vi.fn(),
  },
}))

import {
  buildEdgesPatch,
  buildNodesPatch,
  draftsFromDefinition,
  isDirty,
  nodesForDefinition,
  EditableNodeInspector,
} from "../edit"
import { stepNodeStatus } from "../run-view"

/**
 * GRS-016d web surface — wait node fields, error-lane markers, the output:'none' /
 * onError:'error-edge' option choices, and the fired/waiting run statuses.
 * Contract: drafts round-trip losslessly, ABSENT stays absent, no-op edits keep
 * persisted objects (no key-order churn), lanes persist as edge lane:'error'.
 */

function def(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "wf-016d",
    title: "WF 016d",
    version: 1,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, role: "trigger" },
      { id: "risky", type: "step", label: "Risky", position: { x: 1, y: 0 }, actor: { kind: "engine", ref: "codex" }, options: { onError: "error-edge" } },
      { id: "ok", type: "step", label: "OK", position: { x: 2, y: 0 }, actor: { kind: "engine", ref: "codex" } },
      { id: "rescue", type: "step", label: "Rescue", position: { x: 2, y: 1 }, actor: { kind: "engine", ref: "codex" } },
      { id: "w", type: "wait", label: "Cool down", position: { x: 3, y: 0 }, waitMinutes: 30 },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "risky", kind: "sequence" },
      { id: "e2", from: "risky", to: "ok", kind: "sequence" },
      { id: "e3", from: "risky", to: "rescue", kind: "sequence", lane: "error" },
      { id: "e4", from: "ok", to: "w", kind: "sequence" },
    ],
    ...overrides,
  }
}

describe("wait node drafts (GRS-016d)", () => {
  it("hydrates waitMinutes/waitUntil and round-trips them through buildNodesPatch", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(drafts.w.waitMinutes).toBe("30")
    expect(drafts.w.waitUntil).toBe("")
    expect(isDirty(d, drafts)).toBe(false)

    const edited = { ...drafts, w: { ...drafts.w, waitMinutes: "", waitUntil: "2026-07-06T09:00:00Z" } }
    expect(isDirty(d, edited)).toBe(true)
    const w = buildNodesPatch(d, edited).find((n) => n.id === "w")!
    expect("waitMinutes" in w).toBe(false)
    expect(w.waitUntil).toBe("2026-07-06T09:00:00Z")
  })

  it("a numeric edit re-encodes as a number", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const edited = { ...drafts, w: { ...drafts.w, waitMinutes: "45" } }
    const w = buildNodesPatch(d, edited).find((n) => n.id === "w")!
    expect(w.waitMinutes).toBe(45)
  })

  it("renders the wait inspector fields and patches drafts", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === "w")!
    const onChange = vi.fn()
    render(<EditableNodeInspector node={node} draft={drafts.w} onChange={onChange} onClose={() => {}} />)
    const minutes = screen.getByTestId("wf-edit-wait-minutes")
    expect((minutes as HTMLInputElement).value).toBe("30")
    fireEvent.change(minutes, { target: { value: "60" } })
    expect(onChange).toHaveBeenCalledWith({ waitMinutes: "60" })
    fireEvent.change(screen.getByTestId("wf-edit-wait-until"), { target: { value: "2026-07-06T09:00:00Z" } })
    expect(onChange).toHaveBeenCalledWith({ waitUntil: "2026-07-06T09:00:00Z" })
  })

  it("uses the canvas wait tint for the wait inspector badge", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === "w")!
    render(<EditableNodeInspector node={node} draft={drafts.w} onChange={() => {}} onClose={() => {}} />)
    expect(screen.getByText("wait").getAttribute("style")).toContain("var(--system-orange)")
  })
})

describe("error-lane drafts (GRS-016d)", () => {
  it("hydrates one lane row per out-edge with the persisted lane state; no-op stays clean", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(drafts.risky.errorLanes).toEqual([
      { edgeId: "e2", to: "ok", error: false },
      { edgeId: "e3", to: "rescue", error: true },
    ])
    expect(isDirty(d, drafts)).toBe(false)
    // No-op patch keeps the exact persisted edge objects (no key-order churn).
    const edges = buildEdgesPatch(d, drafts)
    expect(edges[1]).toBe(d.edges[1])
    expect(edges[2]).toBe(d.edges[2])
  })

  it("toggling lanes adds/removes lane:'error' on the right edges", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const edited = {
      ...drafts,
      risky: {
        ...drafts.risky,
        errorLanes: [
          { edgeId: "e2", to: "ok", error: true },
          { edgeId: "e3", to: "rescue", error: false },
        ],
      },
    }
    expect(isDirty(d, edited)).toBe(true)
    const edges = buildEdgesPatch(d, edited)
    expect(edges.find((e) => e.id === "e2")!.lane).toBe("error")
    expect("lane" in edges.find((e) => e.id === "e3")!).toBe(false)
  })

  it("toggling onError OFF error-edge neutralizes the node's lanes in the same save (Codex finding 2: no orphaned lane, no 400)", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    // The user switches risky's onError away from error-edge; the lane checkbox
    // UI disappears, so the stale persisted lane must be cleared by the patch.
    const edited = { ...drafts, risky: { ...drafts.risky, onError: "" } }
    expect(isDirty(d, edited)).toBe(true)
    const nodes = buildNodesPatch(d, edited)
    expect(nodes.find((n) => n.id === "risky")!.options).toBeUndefined()
    const edges = buildEdgesPatch(d, edited)
    expect("lane" in edges.find((e) => e.id === "e3")!).toBe(false) // orphan cleared
    // Untouched edges keep their persisted objects.
    expect(edges.find((e) => e.id === "e2")).toBe(d.edges[1])

    // Switching to 'continue' (not just unset) clears lanes the same way.
    const toContinue = { ...drafts, risky: { ...drafts.risky, onError: "continue" } }
    expect("lane" in buildEdgesPatch(d, toContinue).find((e) => e.id === "e3")!).toBe(false)
  })

  it("toggling error-edge back ON reconstructs cleanly: rows render, checking one re-persists the lane", () => {
    // Start from a definition where the mode is OFF and no lane exists (the
    // post-toggle-off save state).
    const d = def({
      nodes: def().nodes.map((n) => {
        if (n.id !== "risky") return n
        const next = { ...n }
        delete next.options
        return next
      }),
      edges: def().edges.map((e) => {
        if (e.id !== "e3") return e
        const next = { ...e }
        delete next.lane
        return next
      }),
    })
    const drafts = draftsFromDefinition(d)
    expect(drafts.risky.errorLanes).toEqual([
      { edgeId: "e2", to: "ok", error: false },
      { edgeId: "e3", to: "rescue", error: false },
    ])
    const edited = {
      ...drafts,
      risky: {
        ...drafts.risky,
        onError: "error-edge",
        errorLanes: [
          { edgeId: "e2", to: "ok", error: false },
          { edgeId: "e3", to: "rescue", error: true },
        ],
      },
    }
    expect(isDirty(d, edited)).toBe(true)
    expect(buildNodesPatch(d, edited).find((n) => n.id === "risky")!.options).toEqual({ onError: "error-edge" })
    expect(buildEdgesPatch(d, edited).find((e) => e.id === "e3")!.lane).toBe("error")
  })

  it("the inspector offers none/error-edge choices and shows lane checkboxes only under error-edge", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === "risky")!
    const onChange = vi.fn()
    const { rerender } = render(
      <EditableNodeInspector node={node} draft={drafts.risky} onChange={onChange} onClose={() => {}} />,
    )
    // risky declares onError:'error-edge' → lane checkboxes render, e3 checked.
    expect(screen.getByTestId("wf-edit-error-lanes")).toBeTruthy()
    expect((screen.getByTestId("wf-edit-lane-e3") as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId("wf-edit-lane-e2"))
    expect(onChange).toHaveBeenCalledWith({
      errorLanes: [
        { edgeId: "e2", to: "ok", error: true },
        { edgeId: "e3", to: "rescue", error: true },
      ],
    })
    // The output select carries the new fire-and-forget mode.
    const output = screen.getByTestId("wf-edit-opt-output") as HTMLSelectElement
    expect([...output.options].map((o) => o.value)).toContain("none")

    // A plain step (no error-edge) hides the lane editor.
    const okNode = nodesForDefinition(d, drafts).find((n) => n.id === "ok")!
    rerender(<EditableNodeInspector node={okNode} draft={drafts.ok} onChange={onChange} onClose={() => {}} />)
    expect(screen.queryByTestId("wf-edit-error-lanes")).toBeNull()
  })
})

describe("run-view statuses (GRS-016d)", () => {
  const receipt = (status: RunStepReceiptWire["status"]): RunStepReceiptWire =>
    ({ nodeId: "n", label: "N", actor: null, status, at: "2026-07-05T09:00:00.000Z" })

  it("fired maps to passed (settled by declaration); waiting maps to running (the run genuinely holds)", () => {
    expect(stepNodeStatus(receipt("fired"))).toBe("passed")
    expect(stepNodeStatus(receipt("waiting"))).toBe("running")
  })
})
