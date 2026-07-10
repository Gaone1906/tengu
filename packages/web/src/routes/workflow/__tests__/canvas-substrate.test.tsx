import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowCanvas, buildFlowGraph } from "../canvas"
import type { CanvasNode } from "../canvas-model"

/* GRS-013 — substrate-level tests: the React Flow canvas renders Jinn node
 * cards at real spatial positions with port-anchored edges. The honest-state
 * suites (canvas/run-view/edit tests) cover the derivations; this file covers
 * only what the substrate swap added. */

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: "step",
  title: id,
  role: "implement",
  who: "codex",
  status: "pending",
  isCurrent: false,
  gates: [],
  ...over,
})

describe("WorkflowCanvas — React Flow substrate", () => {
  it("renders a React Flow surface (pannable/zoomable viewport), not a flex chain", () => {
    const { container } = render(
      <WorkflowCanvas nodes={[node("a"), node("b")]} selectedId={null} onSelect={vi.fn()} />,
    )
    expect(container.querySelector(".react-flow")).toBeTruthy()
    expect(container.querySelector(".react-flow__viewport")).toBeTruthy()
  })

  it("places node cards at the definition's stored x/y positions", () => {
    const { container } = render(
      <WorkflowCanvas
        nodes={[node("a", { position: { x: 240, y: 0 } }), node("b", { position: { x: 240, y: 140 } })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    )
    const wrappers = container.querySelectorAll(".react-flow__node")
    expect(wrappers.length).toBe(2)
    const transforms = [...wrappers].map((w) => (w as HTMLElement).style.transform)
    expect(transforms).toContain("translate(240px,0px)")
    expect(transforms).toContain("translate(240px,140px)")
  })

  it("derives one port-anchored curved edge per consecutive pair with honest colouring", () => {
    // Edge PATHS need real handle measurement (a browser); the derivation is pure.
    const { flowEdges } = buildFlowGraph(
      [
        node("a", { position: { x: 0, y: 0 }, status: "passed" }),
        node("b", { position: { x: 300, y: 0 }, status: "passed" }),
        node("c", { position: { x: 300, y: 300 }, status: "running" }),
      ],
      null,
      vi.fn(),
    )
    expect(flowEdges.map((e) => e.id)).toEqual(["a->b", "b->c"])
    // Strict LTR port discipline: EVERY main-lane wire exits the right output
    // port and enters the left input port — even a vertically-offset pair.
    expect(flowEdges[0]).toMatchObject({ sourceHandle: "out", targetHandle: "in", type: "jinn" })
    expect(flowEdges[1]).toMatchObject({ sourceHandle: "out", targetHandle: "in", type: "jinn" })
    // Completed segment renders solid green; the in-flight one stays dashed and marches.
    expect(flowEdges[0].style).toMatchObject({ stroke: "var(--system-green)", strokeDasharray: undefined })
    expect(flowEdges[0].animated ?? false).toBe(false)
    expect(flowEdges[1].style).toMatchObject({ strokeDasharray: "5 5" })
    expect(flowEdges[1].animated).toBe(true)
    // The edge layer itself is mounted on the canvas.
    const { container } = render(
      <WorkflowCanvas nodes={[node("a"), node("b")]} selectedId={null} onSelect={vi.fn()} />,
    )
    expect(container.querySelector(".react-flow__edges")).toBeTruthy()
  })

  it("marks every flow node non-draggable/non-connectable at fixed card size", () => {
    const { flowNodes } = buildFlowGraph([node("a"), node("b")], null, vi.fn())
    for (const n of flowNodes) {
      expect(n.draggable).toBe(false)
      expect(n.connectable).toBe(false)
      expect(n.width).toBeGreaterThan(0)
      expect(n.height).toBeGreaterThan(0)
    }
  })

  it("keeps the Jinn card contract: testid, click-to-select, aria-pressed", () => {
    const onSelect = vi.fn()
    render(
      <WorkflowCanvas nodes={[node("a"), node("b")]} selectedId="b" onSelect={onSelect} />,
    )
    fireEvent.click(screen.getByTestId("wf-node-a"))
    expect(onSelect).toHaveBeenCalledWith("a")
    expect(screen.getByTestId("wf-node-b").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("wf-node-a").getAttribute("aria-pressed")).toBe("false")
  })

  it("offers no wiring affordances: nodes are not draggable or connectable", () => {
    const { container } = render(
      <WorkflowCanvas nodes={[node("a"), node("b")]} selectedId={null} onSelect={vi.fn()} />,
    )
    expect(container.querySelector(".react-flow__node.draggable")).toBeNull()
    // Port handles exist as edge anchors but are never connectable.
    const handles = container.querySelectorAll(".react-flow__handle")
    expect(handles.length).toBeGreaterThan(0)
    expect(container.querySelectorAll(".react-flow__handle.connectable").length).toBe(0)
  })
})

describe("buildFlowGraph — real definition edges (GRS-019)", () => {
  it("draws the supplied snapshot topology (fan-out + reconverge), not the chain", () => {
    const { flowEdges } = buildFlowGraph(
      [
        node("build", { position: { x: 0, y: 100 }, status: "passed" }),
        node("verify", { position: { x: 300, y: 0 }, status: "passed" }),
        node("redteam", { position: { x: 300, y: 200 }, status: "passed" }),
        node("gate", { position: { x: 600, y: 100 }, status: "parked", kind: "gate" }),
      ],
      null,
      vi.fn(),
      [
        { id: "e1", from: "build", to: "verify" },
        { id: "e2", from: "build", to: "redteam" },
        { id: "e3", from: "verify", to: "gate" },
        { id: "e4", from: "redteam", to: "gate" },
        { id: "e-fix", from: "build", to: "missing-node" },
      ],
    )
    // Every snapshot edge with both endpoints on the canvas is drawn; the
    // dangling one is dropped, never a severed line.
    expect(flowEdges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"])
    expect(flowEdges[0]).toMatchObject({ source: "build", target: "verify" })
    // Both fan-in edges land on the parked gate, animated (the doorbell draws the eye).
    expect(flowEdges[2].animated).toBe(true)
    expect(flowEdges[3].animated).toBe(true)
  })

  it("renders an error-lane edge dashed red, never animated", () => {
    const { flowEdges } = buildFlowGraph(
      [
        node("build", { position: { x: 0, y: 0 }, status: "passed" }),
        node("plan", { position: { x: 300, y: 0 }, status: "passed" }),
      ],
      null,
      vi.fn(),
      [{ id: "e-fix", from: "build", to: "plan", lane: "error" }],
    )
    expect(flowEdges[0].style).toMatchObject({ stroke: "var(--system-red)" })
    expect(flowEdges[0].style?.strokeDasharray).toBeTruthy()
    expect(flowEdges[0].animated).toBe(false)
  })

  it("keeps the declaration-order backbone when only decorative sub-node edges exist", () => {
    const { flowEdges } = buildFlowGraph(
      [
        node("plan", { position: { x: 0, y: 0 }, status: "passed", visual: "wide" }),
        node("plan__dock_actor", { position: { x: 20, y: 160 }, visual: "sub" }),
        node("verify", { position: { x: 320, y: 0 }, status: "running", visual: "wide" }),
      ],
      null,
      vi.fn(),
      [{ id: "plan->plan__dock_actor", from: "plan", to: "plan__dock_actor", lane: "sub" }],
    )

    expect(flowEdges.map((e) => e.id)).toEqual(["plan->verify", "plan->plan__dock_actor"])
  })
})
