import "@xyflow/react/dist/style.css"
import { useMemo } from "react"
import { Background, BackgroundVariant, Panel, ReactFlow, useReactFlow } from "@xyflow/react"
import { Maximize, Minus, Plus } from "lucide-react"
import type { WorkflowAttemptV2Wire, WorkflowNodeRunV2Wire, WorkflowRunDetailV2Wire } from "@/lib/api"
import { editorEdgeTypes } from "./editor/edge"
import {
  hasStoredPositions,
  toFlowEdges,
  toFlowNodes,
  type EditorEdge,
  type EditorNode,
} from "./editor/graph"
import { tidyLayout } from "./editor/layout"
import { editorNodeTypes } from "./editor/node-card"
import { deriveNodeStatus, isLiveRunStatus } from "./run-support"

/** Client mirror of the runner's edgeActivated: an edge was traversed when its
 *  source settled and routed through this port (condition/approval record the
 *  chosen port; a failed employee routes its error lane). */
function edgeTaken(
  sourceType: string | undefined,
  sourceRun: WorkflowNodeRunV2Wire | undefined,
  port: string,
): boolean {
  if (!sourceRun?.activated) return false
  if (sourceRun.status === "failed" && sourceType === "employee") return port === "error"
  if (sourceRun.status !== "completed") return false
  if (sourceType === "condition" || sourceType === "approval") {
    const routed = sourceRun.output?.fields?.["port"]
    return typeof routed === "string" && routed === port
  }
  return port === "success"
}

function buildGraph(
  detail: WorkflowRunDetailV2Wire,
  selectedNodeId: string | null,
): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const nodeRuns = new Map(detail.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]))
  const nodeTypes = new Map(detail.definition.nodes.map((node) => [node.id, node.type]))
  const attemptsByNode = new Map<string, WorkflowAttemptV2Wire[]>()
  for (const attempt of detail.attempts) {
    const list = attemptsByNode.get(attempt.nodeId) ?? []
    list.push(attempt)
    attemptsByNode.set(attempt.nodeId, list)
  }

  const base = toFlowNodes(detail.definition)
  const edges = toFlowEdges(detail.definition)
  const placed = hasStoredPositions(detail.definition) ? base : tidyLayout(base, edges)
  const live = isLiveRunStatus(detail.status)

  return {
    nodes: placed.map((node) => {
      const nodeRun = nodeRuns.get(node.id)
      const status = deriveNodeStatus(nodeRun, attemptsByNode.get(node.id) ?? [])
      return {
        ...node,
        selected: node.id === selectedNodeId,
        draggable: false,
        connectable: false,
        className: "cursor-pointer",
        data: {
          ...node.data,
          run: { status, dimmed: status === "skipped" || (status === "pending" && !nodeRun?.activated) },
        },
      }
    }),
    edges: edges.map((edge) => {
      const taken = edgeTaken(nodeTypes.get(edge.source), nodeRuns.get(edge.source), edge.sourceHandle ?? "success")
      return { ...edge, animated: taken && live, data: { run: { taken } } }
    }),
  }
}

function RunCanvasControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const buttons: Array<{ label: string; icon: React.ReactNode; onClick: () => void }> = [
    { label: "Fit view", icon: <Maximize size={15} />, onClick: () => void fitView({ padding: 0.2, duration: 300 }) },
    { label: "Zoom out", icon: <Minus size={15} />, onClick: () => void zoomOut() },
    { label: "Zoom in", icon: <Plus size={15} />, onClick: () => void zoomIn() },
  ]
  return (
    <Panel position="bottom-left">
      <div
        className="flex items-center gap-0.5 rounded-[11px] p-1 backdrop-blur-[20px]"
        style={{ background: "var(--material-regular)", boxShadow: "var(--shadow-overlay)" }}
      >
        {buttons.map((button) => (
          <button
            key={button.label}
            type="button"
            aria-label={button.label}
            onClick={button.onClick}
            className="grid size-9 place-items-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
          >
            {button.icon}
          </button>
        ))}
      </div>
    </Panel>
  )
}

/** The editor canvas, read-only: same cards, wires, and layout, painted with
 *  live per-node run state. Pan/zoom stay; every editing affordance is gone. */
export function RunCanvas({
  detail,
  selectedNodeId,
  onSelectNode,
}: {
  detail: WorkflowRunDetailV2Wire
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}) {
  const graph = useMemo(() => buildGraph(detail, selectedNodeId), [detail, selectedNodeId])

  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={editorNodeTypes}
      edgeTypes={editorEdgeTypes}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      minZoom={0.25}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--separator)" />
      <RunCanvasControls />
    </ReactFlow>
  )
}
