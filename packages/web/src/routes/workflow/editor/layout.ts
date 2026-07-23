import dagre from "@dagrejs/dagre"
import type { EditorEdge, EditorNode } from "./graph"
import { nodeBox } from "./ports"

const GRID = 20
const CLEARANCE = 24

function snap(value: number): number {
  return Math.round(value / GRID) * GRID
}

/** Nudge a proposed center downward until the box clears every existing card —
 *  free-handle `+` additions must never land on a neighbor. */
export function freeCenter(
  nodes: EditorNode[],
  center: { x: number; y: number },
  box: { width: number; height: number },
): { x: number; y: number } {
  const collides = (y: number) =>
    nodes.some((node) => {
      const other = nodeBox(node.data.node)
      return (
        center.x - box.width / 2 < node.position.x + other.width + CLEARANCE &&
        center.x + box.width / 2 > node.position.x - CLEARANCE &&
        y - box.height / 2 < node.position.y + other.height + CLEARANCE &&
        y + box.height / 2 > node.position.y - CLEARANCE
      )
    })
  let y = center.y
  for (let guard = 0; guard < 200 && collides(y); guard += 1) y += GRID
  return { x: center.x, y }
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
