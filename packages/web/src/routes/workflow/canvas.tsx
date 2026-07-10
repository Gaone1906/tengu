import "@xyflow/react/dist/style.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MiniMap,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type EdgeProps,
  type ReactFlowInstance,
} from "@xyflow/react"
import { CheckCircle2, Circle, Clock, Map as MapIcon, X } from "lucide-react"
import { stateGlyph } from "./node-card"
import { nodeStatusLine } from "./status-line"
import { jinnNodeTypes, type JinnNodeData } from "./node-components"
import { CanvasControls, useIsCanvasMobile, pickFocusNode, tidyLayout, minimapNodeColor } from "./canvas-view"

import type { WorkflowRunView, WorkflowStepView, WorkflowGateResult } from "@/lib/api"
import {
  buildCanvasNodes,
  resolveNodePositions,
  placeCanvasNodes,
  nodeStatusColor,
  nodeGeometry,
  visualNodeType,
  expandCanvas,
  type CanvasNode,
  type CanvasEdgeSpec,
} from "./canvas-model"

/* GRS-013 — the spatial workflow canvas (React Flow substrate).
 *
 * The GRS-010c bespoke flexbox-chain canvas was rejected by the operator on
 * mobile (memo 14 §2.2: center-anchored edges hidden behind boxes, positions
 * ignored, vertical card list on phones). This is the rendering-layer reset:
 * the same @xyflow/react substrate the org map already uses, with Jinn-owned
 * node cards rendered as custom nodes. Pan + pinch-zoom work on the SAME
 * spatial canvas on mobile — never a reflowed vertical list. Edges are
 * port-anchored curves chosen by the dominant axis between cards.
 *
 * Everything underneath the pixels is unchanged: derivation stays pure
 * (canvas-model.ts builder + the per-view adapters), honest run states keep
 * their vocabulary (spawn ≠ done spinner, parked doorbell), and the components
 * stay prop-driven so they unit-test without the gateway. No minimap, no
 * auto-layout engine, no drag-to-wire — read-only substrate; Edit keeps its
 * property panel (GRS-011c-2 owns topology editing). */

// Re-export the model so existing imports (`from "./canvas"`) keep working.
export { nodeStatusColor, buildCanvasNodes, resolveNodePositions, placeCanvasNodes, nodeGeometry, visualNodeType, expandCanvas, deriveDisplayFields } from "./canvas-model"
export type { CanvasNode, CanvasNodeSeed, CanvasGraphSpec, CanvasEdgeSpec, VisualNodeType, CanvasSubNode } from "./canvas-model"

/* ── The wire (spec §2.4) ─────────────────────────────────────────────────────
 * One custom bezier edge: curvature 0.35 (short hops stay gently curved, long
 * fans sweep), stroke/dash decided by the caller's honest-state style, and the
 * item-count pill as a calm frosted capsule riding the bezier midpoint. Custom
 * (rather than RF's default) so the curvature and the pill are exact — the
 * wire is the product. */
function JinnEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, label, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.35,
  })
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd as string | undefined} />
      {label != null && label !== "" && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: "var(--material-regular)",
              borderRadius: 7,
              padding: "3px 6px",
              fontFamily: "var(--font-code)",
              fontSize: 10.5,
              fontWeight: 600,
              color: "var(--text-secondary)",
              boxShadow: "var(--shadow-subtle)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const jinnEdgeTypes = { jinn: JinnEdge }

/** Inspector header glyph — the same state visual the node card carries. */
export function InspectorStateCircle({ node }: { node: CanvasNode }) {
  const { Icon, color, spin, pulse } = stateGlyph(node)
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-full"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
    >
      <Icon className={`size-[18px] ${spin ? "animate-spin" : ""} ${pulse ? "animate-pulse" : ""}`} style={{ color }} />
    </span>
  )
}

/** Build the ordered node list for a derived Live run: synthetic trigger node +
 * each step (+ the wave-gate receipts as a terminal gate node). Thin adapter
 * over the shared builder — only the honest status mapping lives here. */
export function nodesForRun(run: WorkflowRunView, triggerSummary: string, orchestrator?: string): CanvasNode[] {
  // Wave-level gates (the run must pass ALL) belong on the graph too — a
  // synthetic terminal gate node whose inspector shows the receipts. This keeps
  // prose off the canvas while preserving the gate evidence (Codex GRS-010c Major).
  const allPass = run.runGates.every((g) => g.passed)
  return buildCanvasNodes({
    trigger: {
      title: "Trigger",
      role: "trigger",
      who: orchestrator ? `→ ${orchestrator}` : "schedule",
      // The trigger has fired for any run we can see, so it always reads as passed.
      status: "passed",
      cadence: triggerSummary,
      detail: triggerSummary,
    },
    steps: run.steps.map((s: WorkflowStepView) => ({
      id: s.id,
      title: s.title,
      role: s.role,
      who: s.who,
      status: s.isCurrent && !s.passed ? "active" : s.passed ? "passed" : "pending",
      isCurrent: s.isCurrent,
      cadence: s.cadence,
      optional: s.optional,
      gates: s.gates,
    })),
    terminalGate: run.runGates.length > 0
      ? {
          id: "__rungates__",
          title: "Wave gates",
          role: "gate",
          who: "must all pass",
          status: allPass ? "passed" : run.status === "blocked" ? "blocked" : run.status === "needs_fix" ? "needs_fix" : "pending",
          cadence: `${run.runGates.filter((g) => g.passed).length}/${run.runGates.length} passing`,
          gates: run.runGates,
        }
      : undefined,
  })
}

function GateReceipt({ gate, evidenceRoot }: { gate: WorkflowGateResult; evidenceRoot?: string }) {
  const Icon = gate.passed ? CheckCircle2 : Circle
  const color = gate.passed ? "var(--system-green)" : "var(--text-tertiary)"
  const isArtifact = gate.kind === "artifact" && gate.passed && gate.evidence
  const fileHref = isArtifact && evidenceRoot
    ? `/file?path=${encodeURIComponent(`${evidenceRoot}/${gate.evidence}`)}`
    : null
  return (
    <div className="flex items-start gap-2 text-[length:var(--text-caption1)]">
      <Icon className="mt-0.5 size-3.5 shrink-0" style={{ color }} />
      <div className="min-w-0">
        <span className="text-[var(--text-secondary)]">{gate.description}</span>
        {gate.evidence && (
          fileHref ? (
            <a href={fileHref} className="ml-1.5 break-all font-mono text-[10px] text-[var(--accent)] hover:underline">
              {gate.evidence}
            </a>
          ) : (
            <span className="ml-1.5 break-all font-mono text-[10px] text-[var(--text-tertiary)]">{gate.evidence}</span>
          )
        )}
      </div>
    </div>
  )
}

/* The inspector — right panel on desktop, bottom sheet on mobile. Fully OPAQUE
 * elevated surface (the old `var(--background)` token never existed, which is
 * why the sheets were see-through). This is where every verbose string from the
 * old changelog page lives. */
export function NodeInspector({
  node,
  evidenceRoot,
  runItem,
  onClose,
}: {
  node: CanvasNode
  evidenceRoot?: string
  runItem?: string | null
  onClose: () => void
}) {
  return (
    <div
      data-testid="wf-inspector"
      className="flex h-full flex-col bg-[var(--bg-secondary)]"
    >
      <div className="flex items-start justify-between gap-2 p-[var(--space-4)] pb-[var(--space-2)]">
        <div className="flex min-w-0 items-center gap-3">
          <InspectorStateCircle node={node} />
          <div className="min-w-0">
            <h2 className="truncate text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {node.title}
            </h2>
            <div className="mt-0.5 truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              <span>{nodeStatusLine(node)}</span> · <span>{node.who}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-[var(--space-4)]">
        {node.cadence && (
          <div className="flex items-start gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <span>{node.cadence}</span>
          </div>
        )}
        {node.optional && (
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Optional step</div>
        )}
        {node.kind === "step" && runItem && (
          <div>
            <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Run item
            </div>
            <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{runItem}</div>
          </div>
        )}
        {node.gates.length > 0 && (
          <div>
            <div className="mb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Gates ({node.gates.filter((g) => g.passed).length}/{node.gates.length})
            </div>
            <div className="flex flex-col gap-1.5">
              {node.gates.map((g, i) => <GateReceipt key={g.id ?? i} gate={g} evidenceRoot={evidenceRoot} />)}
            </div>
          </div>
        )}
        {node.detail && node.kind === "trigger" && (
          <div>
            <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Fires
            </div>
            <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{node.detail}</div>
          </div>
        )}
      </div>
    </div>
  )
}

/* The canvas itself: one React Flow surface for Live / Runs / Edit. Selection
 * is owned by the caller so each view opens its inspector in the right place
 * per breakpoint. Edges connect CONSECUTIVE nodes (the declaration-order chain
 * every view walks today — true edge-order rendering is GRS-011c-2), coloured
 * green-solid when both endpoints passed, dashed otherwise, with a marching
 * dash into the node that is actively working. Pan/zoom state is view-local. */
/** Map canvas nodes to the React Flow graph: per-type geometry + spatial
 * positions resolved once (Dagre-LR when the definition carries none), strict
 * left→right ports per edge — source = the named output port (`out`, a
 * condition row's `out-<i>`, or a dock's `d<i>`), target = the one input port.
 * No dominant-axis anchor picking: direction is meaning; a loop-back still
 * leaves right and enters left, curving around, exactly like n8n. When the
 * caller supplies the REAL definition edges (a run's frozen snapshot), those
 * are drawn — every branch connected, nothing severed; without them the
 * declaration-order chain remains the honest fallback. Sub-dock edges render
 * as dashed grey docks; error lanes dashed red; item counts as a calm mid-edge
 * pill (`0 items` included — honesty beats blankness). Exported pure so the
 * derivation unit-tests without a layout engine (jsdom can't measure handle
 * bounds, so edge PATHS only materialize in a real browser). */
export function buildFlowGraph(
  nodes: CanvasNode[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  edges?: CanvasEdgeSpec[],
): { flowNodes: FlowNode<JinnNodeData>[]; flowEdges: FlowEdge[] } {
  const positions = resolveNodePositions(nodes, edges?.map((e) => ({ from: e.from, to: e.to, lane: e.lane })))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const flowNodes: FlowNode<JinnNodeData>[] = nodes.map((n) => {
    const { w, h } = nodeGeometry(n)
    return {
      id: n.id,
      type: "jinn",
      position: positions[n.id],
      width: w,
      height: h,
      draggable: false,
      connectable: false,
      selectable: false,
      data: { node: n, selected: selectedId === n.id, onSelect },
    }
  })

  const settled = (s: string) => s === "passed" || s === "completed"
  const toFlowEdge = (a: CanvasNode, b: CanvasNode, id: string, spec?: CanvasEdgeSpec): FlowEdge => {
    const lane = spec?.lane
    const isError = lane === "error"
    const isSub = lane === "sub"
    // Strict port discipline (spec §2.2): the source is the NAMED output port —
    // a dock (`d<i>`), a condition row (`out-<i>`), or the single `out`; the
    // target is always the one `in` port. edgeAnchors is gone.
    const sourceHandle = isSub && spec?.dockIndex != null ? `d${spec.dockIndex}`
      : spec?.outIndex != null ? `out-${spec.outIndex}`
      : "out"
    const targetHandle = "in"
    const done = settled(a.status) && settled(b.status)
    const active = settled(a.status) && (b.status === "active" || b.status === "running" || b.status === "parked")
    // A wire touching a genuinely-failed step reads red (the honest failed lane) —
    // distinct from an authored error-edge (dashed red) and from the calm greys.
    const failed = a.status === "blocked" || b.status === "blocked"
    // The editor lens has no run state (every node is a draft) — its wires rest
    // SOLID grey; only a run's untaken/pending lanes read dashed.
    const draft = a.status === "draft" && b.status === "draft"
    const edge: FlowEdge = {
      id,
      source: a.id,
      target: b.id,
      sourceHandle,
      targetHandle,
      type: "jinn", // bezier, curvature 0.35 — the visible curve in the gap
      animated: !isError && !isSub && active,
      style: isSub
        ? { stroke: "var(--separator-opaque)", strokeWidth: 1.5, strokeDasharray: "5 5", opacity: 0.75 }
        : isError
          ? { stroke: "var(--system-red)", strokeWidth: 1.5, strokeDasharray: "4 5", opacity: 0.45 }
          : failed
            ? { stroke: "var(--system-red)", strokeWidth: 2, opacity: 0.7 }
            : {
                stroke: done ? "var(--system-green)" : active ? nodeStatusColor(b.status) : "var(--separator-opaque)",
                strokeWidth: 2,
                strokeDasharray: done || draft ? undefined : "5 5",
                opacity: done ? 0.75 : 0.9,
              },
    }
    // Run-view item count: a calm frosted pill riding the wire (mock: "1 item").
    // Zero on a taken path renders "0 items"; untaken branches carry no pill.
    if (spec?.items != null && !isSub && !isError) {
      edge.label = `${spec.items} ${spec.items === 1 ? "item" : "items"}`
    }
    return edge
  }

  const flowEdges: FlowEdge[] = []
  const topologyEdges = (edges ?? []).filter((e) => e.lane !== "sub")
  const decorationEdges = (edges ?? []).filter((e) => e.lane === "sub")
  if (topologyEdges.length > 0) {
    for (const e of topologyEdges) {
      const a = byId.get(e.from)
      const b = byId.get(e.to)
      if (!a || !b) continue // snapshot edge to a node this run never materialized
      flowEdges.push(toFlowEdge(a, b, e.id ?? `${a.id}->${b.id}`, e))
    }
  } else {
    const chainNodes = nodes.filter((n) => n.visual !== "sub")
    for (let i = 0; i < chainNodes.length - 1; i++) {
      flowEdges.push(toFlowEdge(chainNodes[i], chainNodes[i + 1], `${chainNodes[i].id}->${chainNodes[i + 1].id}`))
    }
  }
  for (const e of decorationEdges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    flowEdges.push(toFlowEdge(a, b, e.id ?? `${a.id}->${b.id}`, e))
  }
  return { flowNodes, flowEdges }
}

export function WorkflowCanvas({
  nodes,
  selectedId,
  onSelect,
  edges,
  activeNodeId,
  minimap = true,
  controls = true,
}: {
  nodes: CanvasNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Real definition edges (run snapshot topology); absent = declaration chain. */
  edges?: CanvasEdgeSpec[]
  /** Node the mobile canvas opens focused on; absent = the picker chooses. */
  activeNodeId?: string | null
  minimap?: boolean
  controls?: boolean
}) {
  const isMobile = useIsCanvasMobile()
  // View-local "tidy up" override: Dagre-computed positions applied on top of the
  // definition's manual layout (operator decision 3). Cleared when the base graph
  // changes so a new run/definition starts from its own honest positions.
  const [tidyPos, setTidyPos] = useState<Record<string, { x: number; y: number }> | null>(null)
  useEffect(() => { setTidyPos(null) }, [nodes, edges])
  // Mobile: the minimap collapses behind a map-icon toggle (spec §7) — the
  // phone canvas keeps its pixels; the whole-shape overview is one tap away.
  const [mapOpen, setMapOpen] = useState(false)

  // Sub-node docks are synthesized here (decision 2) so the ONE canvas renders
  // every attachable. expandCanvas is a no-op for graphs without wide docks, so
  // the substrate/derivation tests see the exact same nodes they always did.
  // MAIN-node positions are resolved BEFORE the expansion: dock discs carry
  // varied derived offsets, so expanding first would make a degenerate stored
  // layout (all real cards at the origin) pass the usability check and open as
  // an overlapping pile that only Tidy up could rescue.
  const { expNodes, expEdges } = useMemo(() => {
    const base = tidyPos ? nodes.map((n) => (tidyPos[n.id] ? { ...n, position: tidyPos[n.id] } : n)) : nodes
    const { nodes: en, edges: ee } = expandCanvas(placeCanvasNodes(base, edges), edges)
    return { expNodes: en, expEdges: ee }
  }, [nodes, edges, tidyPos])

  const { flowNodes, flowEdges } = useMemo(
    () => buildFlowGraph(expNodes, selectedId, onSelect, expEdges),
    [expNodes, selectedId, onSelect, expEdges],
  )

  type Inst = ReactFlowInstance<FlowNode<JinnNodeData>, FlowEdge>
  const instanceRef = useRef<Inst | null>(null)
  const focus = useMemo(() => pickFocusNode(expNodes, activeNodeId), [expNodes, activeNodeId])

  // Open framing: desktop fits the whole graph; mobile opens FOCUSED on the most
  // relevant node at a readable zoom (operator decision 1) — the minimap carries
  // the whole-shape overview, fit is one tap away. Never a fit-tiny phone canvas.
  const onInit = useCallback((inst: Inst) => {
    instanceRef.current = inst
    if (isMobile && focus?.position) {
      const { w, h } = nodeGeometry(focus)
      inst.setCenter(focus.position.x + w / 2, focus.position.y + h / 2, { zoom: 0.9, duration: 0 })
    } else {
      inst.fitView({ padding: 0.2 })
    }
  }, [isMobile, focus])

  const onTidy = useCallback(() => {
    setTidyPos(tidyLayout(nodes, (edges ?? []).map((e) => ({ from: e.from, to: e.to, lane: e.lane }))))
    requestAnimationFrame(() => instanceRef.current?.fitView({ padding: 0.2, duration: 400 }))
  }, [nodes, edges])

  return (
    <div data-testid="wf-canvas" className="relative h-full min-h-[320px] w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={jinnNodeTypes}
        edgeTypes={jinnEdgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        onInit={onInit}
        panOnDrag
        zoomOnPinch
        zoomOnScroll
        zoomOnDoubleClick={false}
        fitView={false}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--separator)" />
        {minimap && (!isMobile || mapOpen) && (
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            nodeStrokeWidth={0}
            maskColor="color-mix(in srgb, var(--bg) 55%, transparent)"
            style={{
              width: isMobile ? 128 : 190,
              height: isMobile ? 80 : 120,
              marginBottom: isMobile ? 64 : undefined,
              borderRadius: "var(--radius-md)",
              background: "var(--material-regular)",
              boxShadow: "var(--shadow-overlay)",
              backdropFilter: "blur(20px)",
            }}
          />
        )}
        {minimap && isMobile && (
          <button
            type="button"
            aria-label={mapOpen ? "Hide minimap" : "Show minimap"}
            aria-pressed={mapOpen}
            data-testid="wf-minimap-toggle"
            onClick={() => setMapOpen((v) => !v)}
            className="absolute bottom-4 right-4 z-10 grid size-11 place-items-center rounded-[11px] transition-colors"
            style={{
              color: mapOpen ? "var(--text-primary)" : "var(--text-secondary)",
              background: "var(--material-regular)",
              boxShadow: "var(--shadow-overlay)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
            }}
          >
            <MapIcon className="size-[20px]" />
          </button>
        )}
        {controls && <CanvasControls onTidy={onTidy} mobile={isMobile} />}
      </ReactFlow>
    </div>
  )
}
