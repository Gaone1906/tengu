import { describe, it, expect } from "vitest"
import {
  buildCanvasNodes,
  resolveNodePositions,
  placeCanvasNodes,
  expandCanvas,
  NODE_W,
  NODE_H,
  GRID,
  type CanvasNode,
  type CanvasNodeSeed,
} from "../canvas-model"

/* GRS-013 — tests for the ONE CanvasNode-builder contract (KISS simplify item 2)
 * and the spatial layout seam under the React Flow substrate. The view adapters
 * (nodesForRun / nodesForDefinitionRun / nodesForDefinition) are covered by the
 * existing honest-state suites, which pass UNCHANGED on top of this builder. */

const step = (id: string, over: Partial<CanvasNodeSeed> = {}): CanvasNodeSeed => ({
  id,
  title: id,
  role: "implement",
  who: "codex",
  status: "pending",
  ...over,
})

describe("buildCanvasNodes — one contract for Live/Runs/Edit", () => {
  it("prepends a synthetic trigger with structural defaults filled", () => {
    const nodes = buildCanvasNodes({
      trigger: { title: "Trigger", role: "trigger", who: "schedule", status: "passed", cadence: "every 2h" },
      steps: [step("a"), step("b")],
    })
    expect(nodes.map((n) => n.id)).toEqual(["__trigger__", "a", "b"])
    expect(nodes[0].kind).toBe("trigger")
    expect(nodes[0].isCurrent).toBe(false)
    expect(nodes[0].gates).toEqual([])
    expect(nodes[1].kind).toBe("step") // kind defaults to step
  })

  it("renders steps only (no synthetic trigger) when the view brings its own nodes (Edit)", () => {
    const nodes = buildCanvasNodes({
      steps: [step("t", { kind: "trigger", role: "trigger" }), step("a"), step("g", { kind: "gate", role: "gate" })],
    })
    expect(nodes.map((n) => n.id)).toEqual(["t", "a", "g"])
    expect(nodes.map((n) => n.kind)).toEqual(["trigger", "step", "gate"])
  })

  it("appends a terminal gate and uniquifies both synthetic ids around real step ids", () => {
    const nodes = buildCanvasNodes({
      trigger: { title: "Trigger", role: "trigger", who: "schedule", status: "passed" },
      steps: [step("__trigger__"), step("__rungates__")],
      terminalGate: { id: "__rungates__", title: "Wave gates", role: "gate", who: "must all pass", status: "pending" },
    })
    const ids = nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(nodes.find((n) => n.kind === "trigger")?.id).not.toBe("__trigger__")
    expect(nodes[nodes.length - 1].kind).toBe("gate")
    expect(nodes[nodes.length - 1].id).not.toBe("__rungates__")
  })

  it("promotes the parked gate's own step node to the doorbell instead of duplicating it", () => {
    const nodes = buildCanvasNodes({
      steps: [step("a", { status: "passed" }), step("gate", { status: "pending" })],
      parked: { nodeId: "gate", description: "operator approves" },
    })
    const parked = nodes.filter((n) => n.status === "parked")
    expect(parked).toHaveLength(1)
    expect(parked[0].id).toBe("gate")
    expect(parked[0].kind).toBe("gate")
    expect(parked[0].who).toBe("awaiting human approval")
    expect(parked[0].detail).toBe("operator approves")
  })

  it("appends a synthetic parked doorbell (preferred id, with position) when the gate has no receipt", () => {
    const nodes = buildCanvasNodes({
      steps: [step("a")],
      parked: { nodeId: "merge-gate", description: "await sign-off", position: { x: 5, y: 7 } },
    })
    const parked = nodes[nodes.length - 1]
    expect(parked.id).toBe("merge-gate")
    expect(parked.title).toBe("Approval gate")
    expect(parked.status).toBe("parked")
    expect(parked.position).toEqual({ x: 5, y: 7 })
  })

  it("carries seed positions through to the canvas node", () => {
    const nodes = buildCanvasNodes({ steps: [step("a", { position: { x: 240, y: 140 } })] })
    expect(nodes[0].position).toEqual({ x: 240, y: 140 })
  })
})

const node = (id: string, position?: { x: number; y: number }): CanvasNode => ({
  id,
  kind: "step",
  title: id,
  role: "implement",
  who: "codex",
  status: "pending",
  isCurrent: false,
  gates: [],
  ...(position ? { position } : {}),
})

describe("resolveNodePositions — definition x/y honoured, Dagre-LR fallback otherwise", () => {
  it("lays unpositioned graphs out left→right (Dagre), snapped to the 20px grid", () => {
    const pos = resolveNodePositions([node("a"), node("b"), node("c")])
    expect(pos.b.x).toBeGreaterThan(pos.a.x)
    expect(pos.c.x).toBeGreaterThan(pos.b.x)
    expect(pos.a.y).toBe(pos.b.y)
    for (const p of Object.values(pos)) {
      expect(p.x % GRID).toBe(0)
      expect(p.y % GRID).toBe(0)
    }
  })

  it("uses the supplied topology for the fallback layout (branches fan into ranks)", () => {
    const pos = resolveNodePositions(
      [node("sw"), node("a"), node("b")],
      [{ from: "sw", to: "a" }, { from: "sw", to: "b" }],
    )
    // Both branch targets rank one column right of the switch, spread vertically.
    expect(pos.a.x).toBe(pos.b.x)
    expect(pos.a.x).toBeGreaterThan(pos.sw.x)
    expect(pos.a.y).not.toBe(pos.b.y)
  })

  it("honours stored pixel positions when they are meaningfully spread", () => {
    const pos = resolveNodePositions([node("a", { x: 240, y: 0 }), node("b", { x: 240, y: 140 })])
    expect(pos.a).toEqual({ x: 240, y: 0 })
    expect(pos.b).toEqual({ x: 240, y: 140 })
  })

  it("falls back to the lane for degenerate index-like positions (0,1,2 would stack cards)", () => {
    const pos = resolveNodePositions([node("a", { x: 0, y: 0 }), node("b", { x: 1, y: 0 }), node("c", { x: 2, y: 0 })])
    expect(pos.b.x - pos.a.x).toBeGreaterThanOrEqual(NODE_W)
    expect(pos.c.x - pos.b.x).toBeGreaterThanOrEqual(NODE_W)
  })

  it("continues a positioned vertical graph downward for unpositioned synthetic nodes", () => {
    const pos = resolveNodePositions([
      node("a", { x: 240, y: 0 }),
      node("b", { x: 240, y: 140 }),
      node("__rungate__"),
    ])
    expect(pos.__rungate__.x).toBe(240)
    expect(pos.__rungate__.y).toBeGreaterThanOrEqual(140 + NODE_H)
  })

  it("continues a positioned horizontal graph rightward for unpositioned synthetic nodes", () => {
    const pos = resolveNodePositions([
      node("a", { x: 0, y: 60 }),
      node("b", { x: 300, y: 60 }),
      node("__trigger__"),
    ])
    expect(pos.__trigger__.y).toBe(60)
    expect(pos.__trigger__.x).toBeGreaterThanOrEqual(300 + NODE_W)
  })

  it("stacks a two-way branch top-to-bottom in AUTHORED edge order (QA defect 3)", () => {
    const nodes = [node("sw"), node("fast"), node("thorough")]
    // Authored fast-first → fast renders above thorough…
    const a = resolveNodePositions(nodes, [
      { from: "sw", to: "fast" },
      { from: "sw", to: "thorough" },
    ])
    expect(a.fast.y).toBeLessThan(a.thorough.y)
    // …and thorough-first flips it: order is meaning, not Dagre's whim.
    const b = resolveNodePositions(nodes, [
      { from: "sw", to: "thorough" },
      { from: "sw", to: "fast" },
    ])
    expect(b.thorough.y).toBeLessThan(b.fast.y)
  })

  it("stacks a four-way fan in authored order with descendants following their lane", () => {
    const nodes = ["sw", "low", "medium", "high", "critical", "low2", "critical2"].map((id) => node(id))
    const pos = resolveNodePositions(nodes, [
      { from: "sw", to: "low" },
      { from: "sw", to: "medium" },
      { from: "sw", to: "high" },
      { from: "sw", to: "critical" },
      { from: "low", to: "low2" },
      { from: "critical", to: "critical2" },
    ])
    expect(pos.low.y).toBeLessThan(pos.medium.y)
    expect(pos.medium.y).toBeLessThan(pos.high.y)
    expect(pos.high.y).toBeLessThan(pos.critical.y)
    // Each branch's continuation stays on its lane side (no crossed wires).
    expect(pos.low2.y).toBeLessThan(pos.critical2.y)
  })
})

describe("placeCanvasNodes — main nodes are placed BEFORE dock expansion (QA defect 1)", () => {
  const wide = (id: string, position: { x: number; y: number }): CanvasNode => ({
    ...node(id, position),
    summary: "Do the work",
    actorKind: "engine",
    subNodes: [
      { role: "model", kind: "MODEL", label: "Opus" },
      { role: "employee", kind: "EMPLOYEE", label: "Dev" },
    ],
  })

  it("auto-lays-out a degenerate all-origin layout instead of honouring the pile", () => {
    const nodes = [node("a", { x: 0, y: 0 }), wide("b", { x: 0, y: 0 }), node("c", { x: 0, y: 0 })]
    const placed = placeCanvasNodes(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ])
    const keys = placed.map((n) => `${n.position!.x},${n.position!.y}`)
    expect(new Set(keys).size).toBe(3) // no two cards share a spot
    const byId = Object.fromEntries(placed.map((n) => [n.id, n.position!]))
    expect(byId.b.x).toBeGreaterThan(byId.a.x)
    expect(byId.c.x).toBeGreaterThan(byId.b.x)
  })

  it("keeps the expanded graph usable: docks pin under their LAID-OUT parent", () => {
    const nodes = [node("a", { x: 0, y: 0 }), wide("b", { x: 0, y: 0 }), node("c", { x: 0, y: 0 })]
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }]
    const placed = placeCanvasNodes(nodes, edges)
    const { nodes: expanded } = expandCanvas(placed, [])
    const parent = expanded.find((n) => n.id === "b")!
    const dock = expanded.find((n) => n.id === "b__dock_model")!
    expect(dock.position!.y).toBeGreaterThan(parent.position!.y)
    expect(Math.abs(dock.position!.x - parent.position!.x)).toBeLessThan(300)
    // And the mains kept their Dagre spread — the pile never reaches the flow graph.
    const mains = expanded.filter((n) => n.visual !== "sub")
    expect(new Set(mains.map((n) => `${n.position!.x},${n.position!.y}`)).size).toBe(mains.length)
  })

  it("passes meaningfully-spread stored positions through untouched (spatial memory wins)", () => {
    const nodes = [node("a", { x: 240, y: 0 }), node("b", { x: 240, y: 140 })]
    const placed = placeCanvasNodes(nodes)
    expect(placed[0].position).toEqual({ x: 240, y: 0 })
    expect(placed[1].position).toEqual({ x: 240, y: 140 })
  })
})

/* edgeAnchors (dominant-axis anchor picking) is deliberately GONE: direction is
 * meaning. Strict left-in/right-out port discipline is covered by the geometry
 * suite (canvas-geometry.test.tsx) and buildFlowGraph's handle assertions. */
