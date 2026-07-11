import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type {
  EditableWorkflowDefinitionWire,
  SaveDefinitionResult,
  WorkflowEdgeWire,
  WorkflowNodePosition,
  WorkflowNodeWire,
} from "@/lib/api"

const getWorkflowDefinition = vi.fn()
const updateWorkflowDefinition = vi.fn()
const listWorkflowTriggers = vi.fn()
const planWorkflowDefinition = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: (...args: unknown[]) => getWorkflowDefinition(...args),
    updateWorkflowDefinition: (...args: unknown[]) => updateWorkflowDefinition(...args),
    listWorkflowTriggers: (...args: unknown[]) => listWorkflowTriggers(...args),
    planWorkflowDefinition: (...args: unknown[]) => planWorkflowDefinition(...args),
  },
}))

import * as editModule from "../edit"

interface WorkflowGraphDraft {
  nodes: WorkflowNodeWire[]
  edges: WorkflowEdgeWire[]
  layout?: { source: "generated" | "normalized" | "manual"; version: 1 }
}

type MoveNode = (graph: WorkflowGraphDraft, nodeId: string, position: WorkflowNodePosition) => WorkflowGraphDraft
type ConnectNodes = (graph: WorkflowGraphDraft, from: string, to: string) => WorkflowGraphDraft
type RemoveNode = (graph: WorkflowGraphDraft, nodeId: string) => WorkflowGraphDraft
type RemoveEdge = (graph: WorkflowGraphDraft, edgeId: string) => WorkflowGraphDraft
type AddNode = (graph: WorkflowGraphDraft, type: WorkflowNodeWire["type"]) => WorkflowGraphDraft
type IsGraphDirty = (definition: EditableWorkflowDefinitionWire, graph: WorkflowGraphDraft) => boolean

const graphApi = editModule as unknown as {
  moveNode?: MoveNode
  connectNodes?: ConnectNodes
  removeNode?: RemoveNode
  removeEdge?: RemoveEdge
  addNode?: AddNode
  isGraphDirty?: IsGraphDirty
}

function definition(overrides: Partial<EditableWorkflowDefinitionWire> = {}): EditableWorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: "sample",
    title: "Sample",
    version: 3,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 20, y: 100 }, trigger: { kind: "manual" } },
      { id: "build", type: "step", label: "Build", position: { x: 300, y: 100 }, actor: { kind: "engine", ref: "codex" } },
      { id: "verify", type: "step", label: "Verify", position: { x: 600, y: 100 }, actor: { kind: "engine", ref: "codex" } },
    ],
    edges: [
      { id: "trigger-build", from: "trigger", to: "build", kind: "sequence" },
      { id: "build-verify", from: "build", to: "verify", kind: "sequence" },
    ],
    ...overrides,
  }
}

function graph(def = definition()): WorkflowGraphDraft {
  return {
    nodes: def.nodes.map((node) => ({ ...node, position: { ...node.position } })),
    edges: def.edges.map((edge) => ({ ...edge })),
    layout: { source: "manual", version: 1 },
  }
}

describe("workflow graph draft operations", () => {
  it("snaps a dragged node to the 20px grid without mutating the prior graph", () => {
    expect(graphApi.moveNode, "moveNode graph operation is not implemented").toBeTypeOf("function")
    const before = graph()
    const moved = graphApi.moveNode!(before, "build", { x: 413, y: 187 })

    expect(moved.nodes.find((node) => node.id === "build")?.position).toEqual({ x: 420, y: 180 })
    expect(before.nodes.find((node) => node.id === "build")?.position).toEqual({ x: 300, y: 100 })
    expect(moved.layout).toEqual({ source: "manual", version: 1 })
  })

  it("connects two nodes with a collision-proof durable edge", () => {
    expect(graphApi.connectNodes, "connectNodes graph operation is not implemented").toBeTypeOf("function")
    const before = graph({ ...definition(), edges: definition().edges.slice(0, 1) })
    const connected = graphApi.connectNodes!(before, "build", "verify")

    expect(connected.edges).toContainEqual(expect.objectContaining({ from: "build", to: "verify" }))
    expect(new Set(connected.edges.map((edge) => edge.id)).size).toBe(connected.edges.length)
  })

  it("removes a node and every incident edge while protecting the trigger", () => {
    expect(graphApi.removeNode, "removeNode graph operation is not implemented").toBeTypeOf("function")
    const before = graph()
    const removed = graphApi.removeNode!(before, "verify")

    expect(removed.nodes.some((node) => node.id === "verify")).toBe(false)
    expect(removed.edges.some((edge) => edge.from === "verify" || edge.to === "verify")).toBe(false)
    expect(graphApi.removeNode!(before, "trigger")).toEqual(before)
  })

  it("removes one durable edge without mutating nodes or sibling edges", () => {
    expect(graphApi.removeEdge, "removeEdge graph operation is not implemented").toBeTypeOf("function")
    const before = graph()
    const removed = graphApi.removeEdge!(before, "build-verify")

    expect(removed.edges.map((edge) => edge.id)).toEqual(["trigger-build"])
    expect(removed.nodes).toEqual(before.nodes)
    expect(before.edges).toHaveLength(2)
  })

  it("adds schema-valid node defaults with a unique id", () => {
    expect(graphApi.addNode, "addNode graph operation is not implemented").toBeTypeOf("function")
    const before = graph()
    const added = graphApi.addNode!(before, "wait")
    const newNode = added.nodes.find((node) => !before.nodes.some((old) => old.id === node.id))

    expect(added.nodes).toHaveLength(before.nodes.length + 1)
    if (!newNode) throw new Error("added node is missing")
    expect(newNode).toMatchObject({ type: "wait", waitMinutes: 5 })
    expect(newNode.position.x % 20).toBe(0)
    expect(newNode.position.y % 20).toBe(0)
  })

  it("treats geometry and topology changes as dirty", () => {
    expect(graphApi.isGraphDirty, "isGraphDirty graph operation is not implemented").toBeTypeOf("function")
    const def = definition()
    const clean = graph(def)
    const moved = { ...clean, nodes: clean.nodes.map((node) => node.id === "build" ? { ...node, position: { x: 320, y: 100 } } : node) }
    const rewired = { ...clean, edges: clean.edges.slice(0, 1) }

    expect(graphApi.isGraphDirty!(def, clean)).toBe(false)
    expect(graphApi.isGraphDirty!(def, moved)).toBe(true)
    expect(graphApi.isGraphDirty!(def, rewired)).toBe(true)
  })
})

describe("WorkflowEditView graph layout lifecycle", () => {
  beforeEach(() => {
    getWorkflowDefinition.mockReset().mockResolvedValue(definition())
    updateWorkflowDefinition.mockReset()
    listWorkflowTriggers.mockReset().mockResolvedValue({ triggers: [], evidenceConfigured: true })
    planWorkflowDefinition.mockReset().mockResolvedValue({
      ok: true,
      layout: {
        diagnostics: { source: "generated", version: 1, normalized: true, reasons: [], quality: { valid: true, score: 100 }, envelopes: [], loopRoutes: {} },
        normalizedPreview: definition({
          nodes: definition().nodes.map((node, index) => ({ ...node, position: { x: 20 + index * 320, y: 100 } })),
        }),
      },
    })
  })

  it("previews Tidy without dirtying, then Apply layout becomes a saveable manual edit", async () => {
    const saved = definition({
      version: 4,
      nodes: definition().nodes.map((node, index) => ({ ...node, position: { x: 20 + index * 320, y: 100 } })),
    })
    updateWorkflowDefinition.mockResolvedValue({ ok: true, definition: saved } satisfies SaveDefinitionResult)

    render(<editModule.WorkflowEditView workflowId="sample" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Tidy" }))
    await waitFor(() => expect(planWorkflowDefinition).toHaveBeenCalledTimes(1))
    expect(planWorkflowDefinition).toHaveBeenCalledWith(
      expect.not.objectContaining({ layout: expect.anything() }),
      { layoutIntent: "normalize" },
    )
    expect(screen.queryByTestId("wf-edit-dirty")).toBeNull()
    expect(screen.getByRole("button", { name: "Apply layout" }).hasAttribute("disabled")).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Apply layout" }))
    expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy()
    fireEvent.click(screen.getByTestId("wf-edit-save"))

    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalledWith(
      "sample",
      expect.objectContaining({
        nodes: expect.any(Array),
        edges: expect.any(Array),
      }),
      3,
      { layoutIntent: "manual" },
    ))
    expect(updateWorkflowDefinition.mock.calls[0][1]).not.toHaveProperty("layout")
  })

  it("Discard cancels an applied layout and restores the persisted graph", async () => {
    render(<editModule.WorkflowEditView workflowId="sample" />)
    await waitFor(() => expect(screen.getByTestId("wf-edit-save")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Tidy" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply layout" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Apply layout" }))
    expect(screen.getByTestId("wf-edit-dirty")).toBeTruthy()

    fireEvent.click(screen.getByTestId("wf-edit-discard"))
    await waitFor(() => expect(screen.queryByTestId("wf-edit-dirty")).toBeNull())
    expect(screen.queryByRole("button", { name: "Apply layout" })).toBeNull()
  })
})
