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
  buildNodesPatch,
  draftsFromDefinition,
  isDirty,
  nodesForDefinition,
  EditableNodeInspector,
} from "../edit"

/**
 * GRS-016e web surface — the session-mode picker (fresh | workflow | existing).
 * Contract: drafts round-trip losslessly ("" = fresh default → the key is
 * dropped), the sessionId field renders ONLY for 'existing' and carries the
 * operator warning ("workflow will message this live session" — operator ruling),
 * and switching the mode away from 'existing' drops the stale sessionId in the
 * same save (the 016d-fix orphaned-sub-setting precedent).
 */

function def(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "wf-016e",
    title: "WF 016e",
    version: 1,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, role: "trigger" },
      { id: "a", type: "step", label: "A", position: { x: 1, y: 0 }, actor: { kind: "engine", ref: "codex" }, options: { session: { mode: "workflow" } } },
      { id: "b", type: "step", label: "B", position: { x: 2, y: 0 }, actor: { kind: "engine", ref: "codex" }, options: { session: { mode: "existing", sessionId: "op-42" } } },
      { id: "c", type: "step", label: "C", position: { x: 3, y: 0 }, actor: { kind: "engine", ref: "codex" } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "a", kind: "sequence" },
      { id: "e2", from: "a", to: "b", kind: "sequence" },
      { id: "e3", from: "b", to: "c", kind: "sequence" },
    ],
    ...overrides,
  }
}

describe("session-mode drafts (GRS-016e)", () => {
  it("hydrates session mode + sessionId and reads clean as not-dirty", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(drafts.a.sessionMode).toBe("workflow")
    expect(drafts.a.sessionId).toBe("")
    expect(drafts.b.sessionMode).toBe("existing")
    expect(drafts.b.sessionId).toBe("op-42")
    expect(drafts.c.sessionMode).toBe("")
    expect(isDirty(d, drafts)).toBe(false)
  })

  it("an unset mode never persists a session key; setting one round-trips it", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    // c stays option-less
    expect(buildNodesPatch(d, drafts).find((n) => n.id === "c")!.options).toBeUndefined()

    const edited = { ...drafts, c: { ...drafts.c, sessionMode: "workflow" } }
    expect(isDirty(d, edited)).toBe(true)
    const c = buildNodesPatch(d, edited).find((n) => n.id === "c")!
    expect(c.options?.session).toEqual({ mode: "workflow" })
  })

  it("mode 'existing' persists the drafted sessionId", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const edited = { ...drafts, c: { ...drafts.c, sessionMode: "existing", sessionId: "op-77" } }
    const c = buildNodesPatch(d, edited).find((n) => n.id === "c")!
    expect(c.options?.session).toEqual({ mode: "existing", sessionId: "op-77" })
  })

  it("switching the mode OFF 'existing' drops the stale sessionId in the same save", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const edited = { ...drafts, b: { ...drafts.b, sessionMode: "workflow" } }
    expect(isDirty(d, edited)).toBe(true)
    const b = buildNodesPatch(d, edited).find((n) => n.id === "b")!
    expect(b.options?.session).toEqual({ mode: "workflow" })
  })

  it("a no-op edit keeps the persisted options object (no key-order churn)", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const b = buildNodesPatch(d, drafts).find((n) => n.id === "b")!
    expect(b.options).toBe(d.nodes.find((n) => n.id === "b")!.options)
  })
})

describe("session-mode inspector (GRS-016e)", () => {
  function renderInspector(nodeId: string, draftPatch: Record<string, unknown> = {}) {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const draft = { ...drafts[nodeId], ...draftPatch }
    const node = nodesForDefinition(d, drafts).find((n) => n.id === nodeId)!
    const onChange = vi.fn()
    render(<EditableNodeInspector node={node} draft={draft} onChange={onChange} onClose={() => {}} />)
    return { onChange }
  }

  it("offers the three modes on an actor step", () => {
    renderInspector("c")
    const select = screen.getByTestId("wf-edit-opt-session-mode") as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(["", "workflow", "existing"])
  })

  it("changing the mode patches the draft", () => {
    const { onChange } = renderInspector("c")
    fireEvent.change(screen.getByTestId("wf-edit-opt-session-mode"), { target: { value: "workflow" } })
    expect(onChange).toHaveBeenCalledWith({ sessionMode: "workflow" })
  })

  it("the sessionId field + live-session warning render ONLY for 'existing'", () => {
    renderInspector("b")
    const input = screen.getByTestId("wf-edit-opt-session-id") as HTMLInputElement
    expect(input.value).toBe("op-42")
    expect(screen.getByTestId("wf-edit-session-warning").textContent).toMatch(/will message this live session/i)
  })

  it("no sessionId field for workflow/fresh modes", () => {
    renderInspector("a")
    expect(screen.queryByTestId("wf-edit-opt-session-id")).toBeNull()
    expect(screen.queryByTestId("wf-edit-session-warning")).toBeNull()
  })

  it("typing a session id patches the draft", () => {
    const { onChange } = renderInspector("b")
    fireEvent.change(screen.getByTestId("wf-edit-opt-session-id"), { target: { value: "op-99" } })
    expect(onChange).toHaveBeenCalledWith({ sessionId: "op-99" })
  })
})
