import { describe, expect, it } from "vitest"
import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { serializeDefinition } from "../editor/graph"
import { outputPorts, nodeBox } from "../editor/ports"
import { createEditorStore } from "../editor/store"

const definition: WorkflowDefinitionV2Wire = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [
    { id: "trigger", type: "trigger", name: "Manual", config: { kind: "manual" } },
    {
      id: "route",
      type: "condition",
      name: "Route",
      config: {
        cases: [
          { port: "case-1", label: "Long", all: [] },
          { port: "case-2", label: "Short", all: [] },
        ],
        defaultPort: "else",
      },
    },
    { id: "end", type: "end", name: "Done", config: { result: "success" } },
  ],
  edges: [
    { id: "e1", from: { nodeId: "trigger", port: "success" }, to: { nodeId: "route", port: "input" } },
    { id: "e2", from: { nodeId: "route", port: "case-2" }, to: { nodeId: "end", port: "input" } },
  ],
  ui: { positions: { trigger: { x: 0, y: 0 }, route: { x: 400, y: 0 }, end: { x: 800, y: 0 } } },
}

function freshStore() {
  return createEditorStore(structuredClone(definition))
}

describe("editor store", () => {
  it("round-trips a definition through the store unchanged", () => {
    const store = freshStore()
    const { meta, nodes, edges } = store.getState()
    const wire = serializeDefinition(meta, nodes, edges)
    expect(wire.nodes).toEqual(definition.nodes)
    expect(wire.edges).toEqual(definition.edges)
    expect(wire.ui.positions).toEqual(definition.ui.positions)
    expect(wire.revision).toBe(3)
    expect(store.getState().serial).toBe(0)
  })

  it("lays out imported drafts that carry no stored positions", () => {
    const bare = structuredClone(definition)
    bare.ui = { positions: {} }
    const store = createEditorStore(bare)
    const byId = new Map(store.getState().nodes.map((node) => [node.id, node.position]))
    expect(byId.get("route")!.x).toBeGreaterThan(byId.get("trigger")!.x)
    expect(byId.get("end")!.x).toBeGreaterThan(byId.get("route")!.x)
    expect(store.getState().serial).toBe(0)
  })

  it("adds nodes with allocated ids and connects them once", () => {
    const store = freshStore()
    const id = store.getState().addNodeAt("employee", { x: 100, y: 100 })
    expect(id).toBe("employee")
    expect(store.getState().addNodeAt("employee", { x: 0, y: 0 })).toBe("employee-2")
    store.getState().connect("trigger", "success", id)
    store.getState().connect("trigger", "success", id)
    const wires = store.getState().edges.filter((edge) => edge.target === id)
    expect(wires).toHaveLength(1)
    expect(store.getState().serial).toBeGreaterThan(0)
  })

  it("refuses edges into a trigger", () => {
    const store = freshStore()
    store.getState().connect("end", "success", "trigger")
    expect(store.getState().edges).toHaveLength(2)
  })

  it("splices an inserted node into an existing connection", () => {
    const store = freshStore()
    store.getState().insertOnEdge("employee", "e1", { x: 200, y: 0 })
    const edges = store.getState().edges
    expect(edges.some((edge) => edge.source === "trigger" && edge.target === "route")).toBe(false)
    expect(edges.some((edge) => edge.source === "trigger" && edge.target === "employee")).toBe(true)
    expect(edges.some((edge) => edge.source === "employee" && edge.sourceHandle === "success" && edge.target === "route")).toBe(true)
  })

  it("prunes wires whose condition case was removed", () => {
    const store = freshStore()
    store.getState().updateNodeConfig("route", {
      cases: [{ port: "case-1", label: "Long", all: [] }],
      defaultPort: "else",
    })
    expect(store.getState().edges.find((edge) => edge.id === "e2")).toBeUndefined()
    expect(store.getState().edges.find((edge) => edge.id === "e1")).toBeTruthy()
  })

  it("removes a node together with its wires", () => {
    const store = freshStore()
    store.getState().removeNode("route")
    expect(store.getState().nodes.map((node) => node.id)).toEqual(["trigger", "end"])
    expect(store.getState().edges).toHaveLength(0)
  })

  it("serializes blank names back to the type label", () => {
    const store = freshStore()
    store.getState().renameNode("end", "   ")
    const { meta, nodes, edges } = store.getState()
    const wire = serializeDefinition(meta, nodes, edges)
    expect(wire.nodes.find((node) => node.id === "end")!.name).toBe("End")
  })
})

describe("port metadata", () => {
  it("keeps every port dot on the declared box perimeter", () => {
    for (const node of definition.nodes) {
      const box = nodeBox(node)
      for (const port of outputPorts(node)) {
        if (port.wall === "side") expect(port.x).toBe(box.width)
        else expect(port.y).toBe(box.height)
        expect(port.y).toBeGreaterThanOrEqual(0)
        expect(port.y).toBeLessThanOrEqual(box.height)
      }
    }
  })

  it("derives condition ports from cases plus the default", () => {
    const ports = outputPorts(definition.nodes[1]!)
    expect(ports.map((port) => port.id)).toEqual(["case-1", "case-2", "else"])
    const rowGap = ports[1]!.y - ports[0]!.y
    expect(ports[2]!.y - ports[1]!.y).toBe(rowGap)
  })
})
