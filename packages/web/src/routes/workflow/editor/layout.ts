import dagre from "@dagrejs/dagre"
import type { EditorEdge, EditorNode } from "./graph"
import { nodeBox } from "./ports"

const GRID = 20

function snap(value: number): number {
  return Math.round(value / GRID) * GRID
}

/** Dagre left-to-right tidy — data flows strictly left → right, branches fan
 *  into their own rows, positions snap to the 20px grid. */
export function tidyLayout(nodes: EditorNode[], edges: EditorEdge[]): EditorNode[] {
  if (nodes.length === 0) return nodes
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: "LR", nodesep: 46, ranksep: 96, marginx: 40, marginy: 40 })
  for (const node of nodes) {
    const box = nodeBox(node.data.node)
    graph.setNode(node.id, { width: box.width, height: box.height })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return nodes.map((node) => {
    const placed = graph.node(node.id)
    if (!placed) return node
    const box = nodeBox(node.data.node)
    return { ...node, position: { x: snap(placed.x - box.width / 2), y: snap(placed.y - box.height / 2) } }
  })
}
