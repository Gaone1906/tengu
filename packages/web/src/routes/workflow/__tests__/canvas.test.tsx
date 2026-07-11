import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowCanvas, NodeInspector, buildFlowGraph, nodesForRun, nodeStatusColor, type CanvasNode, type CanvasEdgeSpec } from "../canvas"
import type { WorkflowRunView } from "@/lib/api"

function run(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    wave: 26,
    item: "GRS-010c",
    fireIso: null,
    status: "active",
    lastWaveState: "in_progress",
    startedAt: null,
    endedAt: null,
    flagSource: "live",
    runGates: [],
    steps: [
      { id: "orchestrate", title: "Orchestrate backlog", role: "orchestrate", who: "Jimbo", optional: false, cadence: "every 2h", gates: [], passed: true, isCurrent: false },
      { id: "implement", title: "Implement slice", role: "implement", who: "Codex", optional: false, gates: [{ id: "g1", kind: "artifact", description: "impl report", passed: true, evidence: "reports/x.md" }], passed: false, isCurrent: true },
      { id: "verify", title: "Verify", role: "verify", who: "Codex", optional: false, gates: [], passed: false, isCurrent: false },
    ],
    ...overrides,
  }
}

describe("nodesForRun", () => {
  it("prepends a synthetic trigger node and preserves step order", () => {
    const nodes = nodesForRun(run(), "every 2h until Jul 7", "Jimbo")
    expect(nodes).toHaveLength(4)
    expect(nodes[0].kind).toBe("trigger")
    expect(nodes[0].cadence).toBe("every 2h until Jul 7")
    expect(nodes[0].who).toBe("→ Jimbo")
    expect(nodes.slice(1).map((n) => n.id)).toEqual(["orchestrate", "implement", "verify"])
  })

  it("maps step status: passed → passed, current+unpassed → active, else pending", () => {
    const nodes = nodesForRun(run(), "trigger", "Jimbo")
    expect(nodes.find((n) => n.id === "orchestrate")?.status).toBe("passed")
    expect(nodes.find((n) => n.id === "implement")?.status).toBe("active")
    expect(nodes.find((n) => n.id === "verify")?.status).toBe("pending")
  })

  it("carries the trigger 'who' as schedule when no orchestrator is given", () => {
    const nodes = nodesForRun(run(), "trigger")
    expect(nodes[0].who).toBe("schedule")
  })

  it("appends a synthetic 'Wave gates' gate node when the run has runGates (Codex Major)", () => {
    const withGates = run({
      status: "passed",
      runGates: [
        { id: "rg1", kind: "flag", description: "tests green", passed: true },
        { id: "rg2", kind: "artifact", description: "verifier report", passed: true, evidence: "reports/v.md" },
      ],
    })
    const nodes = nodesForRun(withGates, "trigger", "Jimbo")
    const gate = nodes[nodes.length - 1]
    expect(gate.kind).toBe("gate")
    expect(gate.id).toBe("__rungates__")
    expect(gate.title).toBe("Wave gates")
    expect(gate.gates).toHaveLength(2)
    expect(gate.status).toBe("passed") // all runGates pass
  })

  it("does not append a gate node when there are no runGates", () => {
    const nodes = nodesForRun(run({ runGates: [] }), "trigger", "Jimbo")
    expect(nodes.some((n) => n.kind === "gate")).toBe(false)
  })

  it("marks the wave-gate node pending when not all runGates pass on an unfinished run", () => {
    const nodes = nodesForRun(
      run({ status: "active", runGates: [{ id: "rg1", kind: "flag", description: "tests", passed: false }] }),
      "trigger",
      "Jimbo",
    )
    expect(nodes[nodes.length - 1].status).toBe("pending")
  })
})

describe("nodeStatusColor", () => {
  it("maps each status to a token", () => {
    expect(nodeStatusColor("passed")).toContain("green")
    expect(nodeStatusColor("active")).toContain("blue")
    expect(nodeStatusColor("blocked")).toContain("red")
    expect(nodeStatusColor("needs_fix")).toContain("orange")
    expect(nodeStatusColor("pending")).toContain("tertiary")
  })
})

describe("WorkflowCanvas", () => {
  const nodes = nodesForRun(run(), "every 2h", "Jimbo")

  it("makes durable nodes draggable and connectable only when explicitly editable", () => {
    const buildEditableFlowGraph = buildFlowGraph as unknown as (
      nodes: CanvasNode[],
      selectedId: string | null,
      onSelect: (id: string) => void,
      edges: CanvasEdgeSpec[] | undefined,
      editable: boolean,
    ) => ReturnType<typeof buildFlowGraph>

    const readOnly = buildEditableFlowGraph(nodes, null, vi.fn(), undefined, false)
    const editable = buildEditableFlowGraph(nodes, null, vi.fn(), undefined, true)

    expect(readOnly.flowNodes.every((node) => node.draggable === false && node.connectable === false)).toBe(true)
    expect(editable.flowNodes.every((node) => node.draggable === true && node.connectable === true)).toBe(true)
  })

  it("exposes connectable handles on the editor canvas while keeping run canvases read-only", () => {
    const { container: readOnly } = render(
      <WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} />,
    )
    expect(readOnly.querySelectorAll(".react-flow__handle.connectable")).toHaveLength(0)

    const { container: editable } = render(
      <WorkflowCanvas
        nodes={nodes}
        selectedId={null}
        onSelect={vi.fn()}
        editable
        onPositionChange={vi.fn()}
        onConnectNodes={vi.fn()}
        onRemoveNode={vi.fn()}
      />,
    )
    expect(editable.querySelectorAll(".react-flow__handle.connectable").length).toBeGreaterThan(0)
  })

  it("renders one node box per node including the trigger", () => {
    render(<WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("wf-node-__trigger__")).toBeTruthy()
    expect(screen.getByTestId("wf-node-orchestrate")).toBeTruthy()
    expect(screen.getByTestId("wf-node-implement")).toBeTruthy()
    expect(screen.getByTestId("wf-node-verify")).toBeTruthy()
  })

  it("renders an SVG edge layer (visible connections, not a list)", () => {
    const { container } = render(<WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} />)
    expect(container.querySelector("svg")).toBeTruthy()
  })

  it("fires onSelect with the node id when a node is clicked", () => {
    const onSelect = vi.fn()
    render(<WorkflowCanvas nodes={nodes} selectedId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("wf-node-implement"))
    expect(onSelect).toHaveBeenCalledWith("implement")
  })

  it("marks the selected node with aria-pressed", () => {
    render(<WorkflowCanvas nodes={nodes} selectedId="implement" onSelect={vi.fn()} />)
    expect(screen.getByTestId("wf-node-implement").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("wf-node-verify").getAttribute("aria-pressed")).toBe("false")
  })

  it("marks the current node (data-current — the GRS-019 card shows it as a ring, not a 'now' text chip)", () => {
    render(<WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("wf-node-implement").getAttribute("data-current")).toBe("true")
    expect(screen.getByTestId("wf-node-verify").getAttribute("data-current")).toBeNull()
  })
})

describe("NodeInspector", () => {
  const node: CanvasNode = nodesForRun(run(), "every 2h", "Jimbo").find((n) => n.id === "implement")!

  it("shows title, who, and gate receipts with evidence links", () => {
    render(<NodeInspector node={node} evidenceRoot="/root" runItem="GRS-010c" onClose={vi.fn()} />)
    expect(screen.getByText("Implement slice")).toBeTruthy()
    expect(screen.getByText("Codex")).toBeTruthy()
    expect(screen.getByText("impl report")).toBeTruthy()
    // Passed artifact gate links into the /file viewer, evidenceRoot-prefixed.
    const link = screen.getByText("reports/x.md").closest("a")
    expect(link?.getAttribute("href")).toContain("/file?path=")
    expect(link?.getAttribute("href")).toContain(encodeURIComponent("/root/reports/x.md"))
  })

  it("shows the run item for a step node", () => {
    render(<NodeInspector node={node} evidenceRoot="/root" runItem="GRS-010c" onClose={vi.fn()} />)
    expect(screen.getByText("Run item")).toBeTruthy()
    // getAllByText because the run item also appears in nothing else here, but be lenient
    expect(screen.getAllByText("GRS-010c").length).toBeGreaterThan(0)
  })

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn()
    render(<NodeInspector node={node} evidenceRoot="/root" runItem={null} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText("Close inspector"))
    expect(onClose).toHaveBeenCalled()
  })

  it("renders the trigger's fire phrase for a trigger node", () => {
    const trigger = nodesForRun(run(), "every 2h until Jul 7", "Jimbo")[0]
    render(<NodeInspector node={trigger} evidenceRoot="/root" runItem={null} onClose={vi.fn()} />)
    expect(screen.getByText("Fires")).toBeTruthy()
    expect(screen.getAllByText("every 2h until Jul 7").length).toBeGreaterThan(0)
  })
})
