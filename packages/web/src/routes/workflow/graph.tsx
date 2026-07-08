import type { CanvasNode } from "./canvas-model"
import { WorkflowCanvas, type CanvasEdgeSpec } from "./canvas"

/* GRS-019c — ONE spatial canvas, every breakpoint.
 *
 * The 019 responsive hybrid reflowed to a vertical rail below 768px; the
 * operator rejected that ("mind-boggling") in favour of n8n's model: the SAME
 * pannable/zoomable node canvas on desktop AND mobile, the chrome collapsing
 * around it rather than the graph turning into a list. WorkflowGraph is now a
 * thin pass-through to that canvas — kept as the callers' seam (page/run views)
 * so the mobile focused-view + minimap live in one place. */

export function WorkflowGraph({
  nodes,
  selectedId,
  onSelect,
  edges,
  activeNodeId,
}: {
  nodes: CanvasNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  edges?: CanvasEdgeSpec[]
  activeNodeId?: string | null
}) {
  return (
    <WorkflowCanvas
      nodes={nodes}
      selectedId={selectedId}
      onSelect={onSelect}
      edges={edges}
      activeNodeId={activeNodeId}
    />
  )
}
