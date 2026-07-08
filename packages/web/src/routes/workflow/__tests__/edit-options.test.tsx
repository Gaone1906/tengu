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
  draftsFromDefinition,
  isDirty,
  buildNodesPatch,
  nodesForDefinition,
  EditableNodeInspector,
} from "../edit"

/**
 * GRS-016b — inspector fields for the engine-node OPTIONS block (plain controls;
 * the React-Flow-substrate polish is GRS-016f). The contract under test is the
 * ROUND TRIP: options → drafts → nodes patch, with ABSENT staying absent (an
 * untouched definition must save byte-identically) and cleared fields dropping
 * back to undefined, never persisting "".
 */

function def(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "wf-opt",
    title: "WF Options",
    version: 1,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, role: "trigger" },
      {
        id: "a", type: "step", label: "A", position: { x: 1, y: 0 }, role: "implement",
        actor: { kind: "engine", ref: "codex" },
        options: {
          model: "gpt-5.5",
          effort: "xhigh",
          output: "full",
          onError: "continue",
          retry: { maxAttempts: 3, on: ["error", "timeout"] },
          timeoutMinutes: 30,
        },
      },
      { id: "b", type: "step", label: "B", position: { x: 2, y: 0 }, role: "verify", actor: { kind: "engine", ref: "claude" } },
      { id: "inline", type: "step", label: "Inline", position: { x: 3, y: 0 }, role: "qa" },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "a" },
      { id: "e2", from: "a", to: "b" },
      { id: "e3", from: "b", to: "inline" },
    ],
    ...overrides,
  }
}

describe("draftsFromDefinition — options round-trip in (GRS-016b)", () => {
  it("hydrates option drafts from node.options and empty drafts when absent", () => {
    const drafts = draftsFromDefinition(def())
    expect(drafts.a.model).toBe("gpt-5.5")
    expect(drafts.a.effort).toBe("xhigh")
    expect(drafts.a.output).toBe("full")
    expect(drafts.a.onError).toBe("continue")
    expect(drafts.a.retryMaxAttempts).toBe("3")
    expect(drafts.a.retryOn).toEqual(["error", "timeout"])
    expect(drafts.a.timeoutMinutes).toBe("30")

    expect(drafts.b.model).toBe("")
    expect(drafts.b.effort).toBe("")
    expect(drafts.b.output).toBe("")
    expect(drafts.b.onError).toBe("")
    expect(drafts.b.retryMaxAttempts).toBe("")
    expect(drafts.b.retryOn).toEqual([])
    expect(drafts.b.timeoutMinutes).toBe("")
  })
})

describe("buildNodesPatch — options round-trip out (GRS-016b)", () => {
  it("an untouched definition round-trips byte-identically (absent stays absent, present stays present)", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    expect(isDirty(d, drafts)).toBe(false)
    const patch = buildNodesPatch(d, drafts)
    expect(patch).toEqual(d.nodes)
    expect("options" in patch.find((n) => n.id === "b")!).toBe(false)
  })

  it("declaring options on a bare step emits exactly the declared subset", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    drafts.b = { ...drafts.b, model: "opus", timeoutMinutes: "5" }
    expect(isDirty(d, drafts)).toBe(true)
    const b = buildNodesPatch(d, drafts).find((n) => n.id === "b")!
    expect(b.options).toEqual({ model: "opus", timeoutMinutes: 5 })
  })

  it("retry is emitted only when maxAttempts is set, carrying the checked causes", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    drafts.b = { ...drafts.b, retryMaxAttempts: "2", retryOn: ["interrupted", "timeout"] }
    const b = buildNodesPatch(d, drafts).find((n) => n.id === "b")!
    expect(b.options).toEqual({ retry: { maxAttempts: 2, on: ["interrupted", "timeout"] } })
  })

  it("clearing every option drops the options key entirely — never an empty object", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    drafts.a = {
      ...drafts.a,
      model: "", effort: "", output: "", onError: "",
      retryMaxAttempts: "", retryOn: [], timeoutMinutes: "",
    }
    const a = buildNodesPatch(d, drafts).find((n) => n.id === "a")!
    expect("options" in a).toBe(false)
  })

  it("editing one option preserves the node's other declared options", () => {
    const d = def()
    const drafts = draftsFromDefinition(d)
    drafts.a = { ...drafts.a, effort: "high" }
    const a = buildNodesPatch(d, drafts).find((n) => n.id === "a")!
    expect(a.options).toEqual({
      model: "gpt-5.5",
      effort: "high",
      output: "full",
      onError: "continue",
      retry: { maxAttempts: 3, on: ["error", "timeout"] },
      timeoutMinutes: 30,
    })
  })
})

describe("EditableNodeInspector — option controls (GRS-016b)", () => {
  function inspectorFor(nodeId: string) {
    const d = def()
    const drafts = draftsFromDefinition(d)
    const node = nodesForDefinition(d, drafts).find((n) => n.id === nodeId)!
    const onChange = vi.fn()
    render(
      <EditableNodeInspector node={node} draft={drafts[nodeId]} onChange={onChange} onClose={() => {}} />,
    )
    return { onChange }
  }

  it("renders every option control for an actor-bearing step", () => {
    inspectorFor("a")
    expect((screen.getByTestId("wf-edit-opt-model") as HTMLInputElement).value).toBe("gpt-5.5")
    expect((screen.getByTestId("wf-edit-opt-effort") as HTMLSelectElement).value).toBe("xhigh")
    expect((screen.getByTestId("wf-edit-opt-output") as HTMLSelectElement).value).toBe("full")
    expect((screen.getByTestId("wf-edit-opt-onerror") as HTMLSelectElement).value).toBe("continue")
    expect((screen.getByTestId("wf-edit-opt-retry-max") as HTMLInputElement).value).toBe("3")
    expect((screen.getByTestId("wf-edit-opt-retry-error") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("wf-edit-opt-retry-timeout") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("wf-edit-opt-retry-interrupted") as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId("wf-edit-opt-timeout") as HTMLInputElement).value).toBe("30")
  })

  it("emits option patches through onChange", () => {
    const { onChange } = inspectorFor("b")
    fireEvent.change(screen.getByTestId("wf-edit-opt-model"), { target: { value: "opus" } })
    expect(onChange).toHaveBeenCalledWith({ model: "opus" })
    fireEvent.change(screen.getByTestId("wf-edit-opt-effort"), { target: { value: "high" } })
    expect(onChange).toHaveBeenCalledWith({ effort: "high" })
  })

  it("toggling a retry cause patches retryOn", () => {
    const { onChange } = inspectorFor("a")
    fireEvent.click(screen.getByTestId("wf-edit-opt-retry-interrupted"))
    expect(onChange).toHaveBeenCalledWith({ retryOn: ["error", "timeout", "interrupted"] })
    fireEvent.click(screen.getByTestId("wf-edit-opt-retry-error"))
    expect(onChange).toHaveBeenCalledWith({ retryOn: ["timeout"] })
  })

  it("hides option controls on triggers, gates, and ACTORLESS steps (options require an actor)", () => {
    inspectorFor("inline")
    expect(screen.queryByTestId("wf-edit-opt-model")).toBeNull()
  })
})
