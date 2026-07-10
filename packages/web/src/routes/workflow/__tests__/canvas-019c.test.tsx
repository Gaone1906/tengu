import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  visualNodeType, nodeGeometry, expandCanvas, deriveDisplayFields, dockFraction,
  type CanvasNode,
} from "../canvas-model"
import { buildFlowGraph, WorkflowCanvas } from "../canvas"
import { pickFocusNode, tidyLayout } from "../canvas-view"
import { HERO_FIXTURE, IF_FIXTURE, SWITCH_FIXTURE } from "../preview-fixtures"
import type { WorkflowNodeWire, WorkflowEdgeWire } from "@/lib/api"

/* GRS-019c — the n8n-mashup canvas: per-type sizing, sub-node docks, switch
 * outputs, decorated edges, and the mobile focused-view picker + Dagre tidy. */

const node = (over: Partial<CanvasNode> & Pick<CanvasNode, "id">): CanvasNode => ({
  kind: "step", title: over.id, role: "step", who: "", status: "passed", isCurrent: false, gates: [], ...over,
})

describe("visualNodeType", () => {
  it("maps structural kinds to visual types", () => {
    expect(visualNodeType(node({ id: "t", kind: "trigger" }))).toBe("trigger")
    expect(visualNodeType(node({ id: "g", kind: "gate" }))).toBe("gate")
    expect(visualNodeType(node({ id: "s", kind: "switch" }))).toBe("cond")
    expect(visualNodeType(node({ id: "f", kind: "fail" }))).toBe("error")
    expect(visualNodeType(node({ id: "w", kind: "wait" }))).toBe("wait")
  })
  it("splits a step into employee / engine / WIDE by content", () => {
    expect(visualNodeType(node({ id: "e", kind: "step", actorKind: "employee" }))).toBe("employee")
    expect(visualNodeType(node({ id: "n", kind: "step", actorKind: "engine" }))).toBe("engine")
    // A written task summary promotes the step to the wide AI node.
    expect(visualNodeType(node({ id: "b", kind: "step", actorKind: "engine", summary: "Do the work" }))).toBe("wide")
  })
  it("honours an explicit visual override (fixtures / synthesized split·merge·sub)", () => {
    expect(visualNodeType(node({ id: "sp", kind: "step", visual: "split" }))).toBe("split")
    expect(visualNodeType(node({ id: "su", kind: "step", visual: "sub" }))).toBe("sub")
  })
})

describe("nodeGeometry — size carries meaning", () => {
  it("gives each type its own box, wide is the widest", () => {
    const trig = nodeGeometry(node({ id: "t", kind: "trigger" }))
    const std = nodeGeometry(node({ id: "e", kind: "step", actorKind: "employee" }))
    const wide = nodeGeometry(node({ id: "b", kind: "step", actorKind: "engine", summary: "x" }))
    const mini = nodeGeometry(node({ id: "m", kind: "step", visual: "split" }))
    expect(trig.w).toBeLessThan(std.w)
    expect(wide.w).toBeGreaterThan(std.w)
    expect(mini.w).toBeLessThan(trig.w)
  })
  it("keeps the wide box FIXED regardless of summary length (2-line clamp — no estimate drift)", () => {
    const short = nodeGeometry(node({ id: "a", kind: "step", summary: "short" }))
    const long = nodeGeometry(node({ id: "b", kind: "step", summary: "x".repeat(400) }))
    expect(long).toEqual(short)
    // Only the dock-slot row changes the box, by a fixed constant.
    const docked = nodeGeometry(node({ id: "c", kind: "step", summary: "x", subNodes: [{ role: "model", kind: "MODEL", label: "Opus" }] }))
    expect(docked.h).toBeGreaterThan(short.h)
  })
  it("grows the condition by output count only: h = COND_HEADER + n×COND_ROW + pad", () => {
    const two = nodeGeometry(node({ id: "if", kind: "switch", outputs: [{ id: "1", label: "t" }, { id: "2", label: "f" }] }))
    const four = nodeGeometry(node({ id: "sw", kind: "switch", outputs: [1, 2, 3, 4].map((i) => ({ id: `${i}`, label: `${i}` })) }))
    expect(four.h - two.h).toBe(2 * 32)
  })
})

describe("expandCanvas — sub-node docks (decision 2)", () => {
  const wide = node({
    id: "build", kind: "step", actorKind: "engine", summary: "Build it", position: { x: 400, y: 200 },
    subNodes: [
      { role: "model", kind: "MODEL", label: "Opus" },
      { role: "employee", kind: "EMPLOYEE", label: "Jinn Dev" },
    ],
  })
  it("appends a sub disc + dashed dock edge per attachable, under the parent", () => {
    const { nodes, edges } = expandCanvas([wide], [])
    const discs = nodes.filter((n) => n.visual === "sub")
    expect(discs).toHaveLength(2)
    expect(discs.every((d) => d.position!.y > wide.position!.y)).toBe(true)
    const subEdges = edges.filter((e) => e.lane === "sub")
    expect(subEdges.map((e) => e.dockIndex)).toEqual([0, 1])
    expect(subEdges[0].from).toBe("build")
  })
  it("is a no-op without a position, without subNodes, or for non-wide nodes", () => {
    expect(expandCanvas([{ ...wide, position: undefined }]).nodes).toHaveLength(1)
    expect(expandCanvas([node({ id: "e", kind: "step", actorKind: "employee", position: { x: 0, y: 0 }, subNodes: wide.subNodes })]).nodes).toHaveLength(1)
    expect(expandCanvas([node({ id: "p", kind: "step" })]).nodes).toHaveLength(1)
  })
  it("spreads docks evenly across the underside", () => {
    expect(dockFraction(0, 3)).toBeCloseTo(0.25)
    expect(dockFraction(1, 3)).toBeCloseTo(0.5)
    expect(dockFraction(2, 3)).toBeCloseTo(0.75)
  })
})

describe("deriveDisplayFields — wire → per-type visual", () => {
  const wireStep = (over: Partial<WorkflowNodeWire>): WorkflowNodeWire => ({
    id: "n", type: "step", label: "N", position: { x: 0, y: 0 }, ...over,
  })
  it("carries actor + model, and makes a task-bearing engine step WIDE with docks", () => {
    const f = deriveDisplayFields(wireStep({
      actor: { kind: "engine", ref: "claude" }, options: { model: "Opus" }, instructions: "Do the thing",
    }))
    expect(f.summary).toBe("Do the thing")
    expect(f.model).toBe("Opus")
    expect(f.subNodes?.map((s) => s.kind)).toEqual(["MODEL"])
  })
  it("docks the teammate for an employee step with a task", () => {
    const f = deriveDisplayFields(wireStep({ actor: { kind: "employee", ref: "jinn-dev" }, instructions: "Ship it" }))
    expect(f.subNodes?.map((s) => s.role)).toEqual(["employee"])
    expect(f.actorKind).toBe("employee")
  })
  it("stays standard (no summary) when the step has no task text", () => {
    const f = deriveDisplayFields(wireStep({ actor: { kind: "engine", ref: "codex" } }))
    expect(f.summary).toBeUndefined()
    expect(f.subNodes).toBeUndefined()
  })
  it("derives switch output ports from the out-edges (skipping the error lane)", () => {
    const edges: WorkflowEdgeWire[] = [
      { id: "a", from: "sw", to: "x", label: "Billing" },
      { id: "b", from: "sw", to: "y", when: [{ path: "steps.route.outcome.fields.topic", op: "eq", value: "bug" }] },
      { id: "err", from: "sw", to: "z", lane: "error" },
    ]
    const f = deriveDisplayFields(wireStep({ id: "sw", type: "switch" }), edges)
    expect(f.outputs?.map((o) => o.label)).toEqual(["Billing", "topic eq bug"])
  })
})

describe("buildFlowGraph — decorated edges (GRS-019c)", () => {
  it("routes a sub-dock edge through the named dock handle, dashed grey, not animated", () => {
    const nodes: CanvasNode[] = [
      node({ id: "build", position: { x: 0, y: 0 }, summary: "x", subNodes: [{ role: "model", kind: "MODEL", label: "Opus" }] }),
    ]
    const { nodes: en, edges: ee } = expandCanvas(nodes, [])
    const { flowEdges } = buildFlowGraph(en, null, vi.fn(), ee)
    const sub = flowEdges.find((e) => e.sourceHandle === "d0")
    expect(sub).toBeTruthy()
    expect(sub!.targetHandle).toBe("in")
    expect(sub!.animated).toBe(false)
    expect(sub!.style?.strokeDasharray).toBeTruthy()
  })
  it("leaves a switch output edge from its named output port + shows the item count", () => {
    const { flowEdges } = buildFlowGraph(
      [node({ id: "sw", kind: "switch", position: { x: 0, y: 0 }, outputs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
       node({ id: "x", position: { x: 300, y: 0 } })],
      null, vi.fn(),
      [{ id: "e", from: "sw", to: "x", outIndex: 1, items: 3 }],
    )
    expect(flowEdges[0].sourceHandle).toBe("out-1")
    expect(flowEdges[0].label).toBe("3 items")
  })
  it("paints a wire touching a failed step red (honest failed lane)", () => {
    const { flowEdges } = buildFlowGraph(
      [node({ id: "a", position: { x: 0, y: 0 }, status: "passed" }), node({ id: "b", position: { x: 300, y: 0 }, status: "blocked" })],
      null, vi.fn(), [{ id: "e", from: "a", to: "b" }],
    )
    expect(flowEdges[0].style).toMatchObject({ stroke: "var(--system-red)" })
    expect(flowEdges[0].animated).toBe(false)
  })
})

describe("pickFocusNode — mobile focused-view (decision 1)", () => {
  const nodes: CanvasNode[] = [
    node({ id: "t", kind: "trigger" }),
    node({ id: "a", status: "passed" }),
    node({ id: "gate", kind: "gate", status: "parked" }),
    node({ id: "dock", visual: "sub" }),
  ]
  it("prefers the live doorbell, never a dock disc", () => {
    expect(pickFocusNode(nodes)?.id).toBe("gate")
  })
  it("honours an explicit active node", () => {
    expect(pickFocusNode(nodes, "a")?.id).toBe("a")
  })
  it("falls back to the first real step past the trigger", () => {
    expect(pickFocusNode([node({ id: "t", kind: "trigger" }), node({ id: "s1", status: "passed" })])?.id).toBe("s1")
  })
})

describe("tidyLayout — Dagre 'tidy up' (decision 3)", () => {
  it("lays real nodes left→right by edge order and skips dock discs", () => {
    const pos = tidyLayout(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "dock", visual: "sub" })],
      [{ from: "a", to: "b" }],
    )
    expect(pos.a).toBeTruthy()
    expect(pos.b.x).toBeGreaterThan(pos.a.x) // LR flow
    expect(pos.dock).toBeUndefined()
  })
})

describe("WorkflowCanvas — chrome", () => {
  it("mounts the frosted minimap, zoom readout and fit/zoom/tidy controls", () => {
    render(<WorkflowCanvas nodes={HERO_FIXTURE.nodes} edges={HERO_FIXTURE.edges} selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("wf-zoom")).toBeTruthy()
    expect(screen.getByLabelText("Fit to view")).toBeTruthy()
    expect(screen.getByLabelText("Zoom in")).toBeTruthy()
    expect(screen.getByLabelText("Tidy up")).toBeTruthy()
  })
  it("renders the wide node's synthesized dock discs on the canvas", () => {
    const { container } = render(<WorkflowCanvas nodes={HERO_FIXTURE.nodes} edges={HERO_FIXTURE.edges} selectedId={null} onSelect={vi.fn()} />)
    expect(container.querySelector('[data-node-id="build__dock_model"]')).toBeTruthy()
  })
})

describe("preview fixtures render through the real canvas", () => {
  it.each([["hero", HERO_FIXTURE], ["if", IF_FIXTURE], ["switch", SWITCH_FIXTURE]] as const)(
    "%s renders every node without throwing", (_id, fx) => {
      render(<WorkflowCanvas nodes={fx.nodes} edges={fx.edges} selectedId={null} onSelect={vi.fn()} />)
      expect(screen.getByTestId("wf-canvas")).toBeTruthy()
    },
  )
})
