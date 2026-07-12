import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { WorkflowCanvas, buildFlowGraph } from "../canvas"
import {
  nodeGeometry, condPortTop, dockFraction,
  COND_HEADER, COND_ROW, COND_PAD, WIDE_H, WIDE_H_DOCKS,
  type CanvasNode,
} from "../canvas-model"
import { HERO_FIXTURE, IF_FIXTURE, SWITCH_FIXTURE } from "../preview-fixtures"

/* Spec §2.5 — the geometry regression gate.
 *
 * React Flow anchors every handle to the DECLARED node box; the estimate-drift
 * class of bug (rendered card ≠ declared box → every wire off the wall) can't
 * re-enter silently while these hold:
 *   1. every visual type's declared box is fixed (no content-dependent drift
 *      beyond the enumerated constants),
 *   2. every handle a node renders is positioned ON its box perimeter at the
 *      spec's offsets (jsdom can read the inline style even without layout),
 *   3. every main-lane edge names only real ports (out / out-<i> / d<i> → in).
 * The within-1px visual check runs in a real browser (screenshot pass). */

const node = (over: Partial<CanvasNode> & Pick<CanvasNode, "id">): CanvasNode => ({
  kind: "step", title: over.id, role: "step", who: "", status: "passed", isCurrent: false, gates: [], ...over,
})

describe("fixed boxes (spec §2.1/§3)", () => {
  it("declares the normative box per type", () => {
    expect(nodeGeometry(node({ id: "t", kind: "trigger" }))).toEqual({ w: 188, h: 56 })
    expect(nodeGeometry(node({ id: "s", kind: "step" }))).toEqual({ w: 220, h: 64 })
    expect(nodeGeometry(node({ id: "g", kind: "gate" }))).toEqual({ w: 232, h: 72 })
    expect(nodeGeometry(node({ id: "w", kind: "step", summary: "x" }))).toEqual({ w: 300, h: WIDE_H })
    expect(nodeGeometry(node({ id: "wd", kind: "step", summary: "x", subNodes: [{ role: "model", kind: "MODEL", label: "Opus" }] })))
      .toEqual({ w: 300, h: WIDE_H_DOCKS })
    expect(nodeGeometry(node({ id: "sp", visual: "split" }))).toEqual({ w: 52, h: 52 })
    expect(nodeGeometry(node({ id: "su", visual: "sub" }))).toEqual({ w: 46, h: 46 })
  })
  it("condition height is exactly COND_HEADER + n×COND_ROW + COND_PAD", () => {
    for (const n of [2, 3, 4, 6]) {
      const outs = Array.from({ length: n }, (_, i) => ({ id: `${i}`, label: `${i}` }))
      expect(nodeGeometry(node({ id: "c", kind: "switch", outputs: outs })).h)
        .toBe(COND_HEADER + n * COND_ROW + COND_PAD)
    }
  })
})

/** Render one graph and index its handles: nodeId → handleId → inline style. */
function renderHandles(nodes: CanvasNode[], edges?: { id?: string; from: string; to: string }[]) {
  const { container } = render(
    <WorkflowCanvas nodes={nodes} edges={edges} selectedId={null} onSelect={vi.fn()} />,
  )
  const out = new Map<string, Map<string, CSSStyleDeclaration>>()
  for (const el of container.querySelectorAll<HTMLElement>(".react-flow__node")) {
    const nodeId = el.getAttribute("data-id")!
    const handles = new Map<string, CSSStyleDeclaration>()
    for (const h of el.querySelectorAll<HTMLElement>(".react-flow__handle")) {
      handles.set(h.getAttribute("data-handleid") ?? "", h.style)
    }
    out.set(nodeId, handles)
  }
  return out
}

describe("handles sit ON the box perimeter (spec §2.2/§2.3)", () => {
  it("standard/gate/wide: one left input + one right output, both at the wall's vertical center", () => {
    const handles = renderHandles([
      node({ id: "a", position: { x: 0, y: 0 } }),
      node({ id: "g", kind: "gate", position: { x: 400, y: 0 } }),
    ], [{ from: "a", to: "g" }])
    for (const id of ["a", "g"]) {
      const h = handles.get(id)!
      expect(h.get("in")).toMatchObject({ left: "0px", top: "50%" })
      expect(h.get("in")!.transform).toContain("translate(-50%, -50%)")
      expect(h.get("out")).toMatchObject({ right: "0px", top: "50%" })
      expect(h.get("out")!.transform).toContain("translate(50%, -50%)")
    }
  })

  it("trigger exposes an output port only (no input)", () => {
    const handles = renderHandles([node({ id: "t", kind: "trigger", position: { x: 0, y: 0 } })])
    const h = handles.get("t")!
    expect(h.get("in")).toBeUndefined()
    expect(h.get("out")).toBeTruthy()
  })

  it("condition: one output port PER ROW on the card wall at condPortTop(i) — never inside a padded row", () => {
    const outs = [
      { id: "0", label: "critical" }, { id: "1", label: "high" },
      { id: "2", label: "medium" }, { id: "3", label: "low" },
    ]
    const handles = renderHandles([node({ id: "sw", kind: "switch", outputs: outs, position: { x: 0, y: 0 } })])
    const h = handles.get("sw")!
    outs.forEach((_, i) => {
      const style = h.get(`out-${i}`)!
      expect(style).toMatchObject({ right: "0px", top: `${condPortTop(i)}px` })
      expect(style.transform).toContain("translate(50%, -50%)")
    })
    // ...and every row center lies strictly inside the declared box.
    const box = nodeGeometry(node({ id: "sw", kind: "switch", outputs: outs }))
    outs.forEach((_, i) => expect(condPortTop(i)).toBeLessThan(box.h))
  })

  it("IF port dots tint by tone (true green / false red)", () => {
    const handles = renderHandles([node({ id: "if", kind: "switch", position: { x: 0, y: 0 } })])
    const h = handles.get("if")!
    expect(h.get("out-0")!.background).toContain("--system-green")
    expect(h.get("out-1")!.background).toContain("--system-red")
  })

  it("wide dock ports sit on the bottom wall at dockFraction(i, total)", () => {
    const subs = [
      { role: "model" as const, kind: "MODEL", label: "Opus" },
      { role: "employee" as const, kind: "EMPLOYEE", label: "Dev" },
    ]
    const handles = renderHandles([node({ id: "w", summary: "x", subNodes: subs, position: { x: 0, y: 0 } })])
    const h = handles.get("w")!
    subs.forEach((_, i) => {
      const style = h.get(`d${i}`)!
      expect(style).toMatchObject({ bottom: "0px", left: `${dockFraction(i, subs.length) * 100}%` })
      expect(style.transform).toContain("translate(-50%, 50%)")
    })
  })

  it("split/merge/sub discs anchor at disc-wall centers (the box IS the disc)", () => {
    const handles = renderHandles([
      node({ id: "sp", visual: "split", position: { x: 0, y: 0 } }),
      node({ id: "su", visual: "sub", subRole: "model", subKind: "MODEL", position: { x: 200, y: 0 } }),
    ])
    expect(handles.get("sp")!.get("in")).toMatchObject({ left: "0px", top: "50%" })
    expect(handles.get("sp")!.get("out")).toMatchObject({ right: "0px", top: "50%" })
    // Sub disc: single TOP target (the dock wire arrives from above).
    expect(handles.get("su")!.get("in")).toMatchObject({ top: "0px", left: "50%" })
  })

  it("ports are visible 8px dots with the 2px bg halo — not hidden 1px anchors", () => {
    const handles = renderHandles([node({ id: "a", position: { x: 0, y: 0 } })])
    const style = handles.get("a")!.get("in")!
    expect(style.width).toBe("8px")
    expect(style.height).toBe("8px")
    expect(style.boxShadow).toContain("var(--bg)")
    expect(style.opacity).not.toBe("0")
  })
})

describe("main-lane edges name only real ports (spec §2.2)", () => {
  it.each([["hero", HERO_FIXTURE], ["if", IF_FIXTURE], ["switch", SWITCH_FIXTURE]] as const)(
    "%s: every edge is out/out-<i>/d<i> → in; no top/bottom main-lane exits",
    (_id, fx) => {
      const { flowEdges } = buildFlowGraph(fx.nodes, null, vi.fn(), fx.edges)
      for (const e of flowEdges) {
        expect(e.sourceHandle).toMatch(/^(out(-\d+)?|d\d+)$/)
        expect(e.targetHandle).toBe("in")
      }
    },
  )

  it("a loop-back edge still leaves right and enters left (direction survives)", () => {
    const { flowEdges } = buildFlowGraph(
      [node({ id: "a", position: { x: 0, y: 0 } }), node({ id: "b", position: { x: 400, y: 0 } })],
      null, vi.fn(),
      [{ id: "fwd", from: "a", to: "b" }, { id: "loop", from: "b", to: "a" }],
    )
    const loop = flowEdges.find((e) => e.id === "loop")!
    expect(loop.sourceHandle).toBe("out")
    expect(loop.targetHandle).toBe("in")
  })

  it("routes authored loop edges through stable lanes below every node envelope", () => {
    const { flowEdges } = buildFlowGraph(
      [node({ id: "a", position: { x: 0, y: 20 } }), node({ id: "b", position: { x: 400, y: 120 } })],
      null, vi.fn(),
      [
        { id: "loop-a", from: "b", to: "a", kind: "loop" },
        { id: "loop-b", from: "b", to: "a", kind: "loop" },
      ],
    )
    const firstY = (flowEdges[0].data as { routeY: number }).routeY
    const secondY = (flowEdges[1].data as { routeY: number }).routeY
    expect(firstY).toBeGreaterThan(120 + 64)
    expect(secondY).toBe(firstY + 40)
  })
})
