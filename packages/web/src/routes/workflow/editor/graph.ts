import type { Edge, Node } from "@xyflow/react"
import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { NODE_TYPE_LABEL, type WorkflowNodeTypeV2, type WorkflowNodeWire, nodeBox } from "./ports"

/** Live run state painted onto a card when the canvas renders a run. Its
 *  presence flips the card into read-only mode: no add affordances, handles
 *  not connectable, status badge + tinted ring instead. */
export interface NodeRunView {
  status: string
  dimmed: boolean
}

/** Run state for one wire: `taken` marks the traversed path. Its presence
 *  hides the edge's insert affordance. */
export interface EdgeRunView {
  taken: boolean
}

export type EditorNodeData = { node: WorkflowNodeWire; run?: NodeRunView }
export type EditorNode = Node<EditorNodeData>
export type EditorEdgeData = { run?: EdgeRunView }
export type EditorEdge = Edge<EditorEdgeData>

/** The subset of a definition the canvas can draw — run detail carries this
 *  snapshot shape; the editor passes the full definition. */
export type GraphSnapshot = Pick<WorkflowDefinitionV2Wire, "nodes" | "edges"> & {
  ui?: WorkflowDefinitionV2Wire["ui"]
}

/** Everything about the definition that is not the graph itself, echoed back on save. */
export interface EditorMeta {
  id: string
  title: string
  description?: string
  revision: number
  enabled: boolean
  inputs?: WorkflowDefinitionV2Wire["inputs"]
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export function toEditorMeta(definition: WorkflowDefinitionV2Wire): EditorMeta {
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    revision: definition.revision,
    enabled: definition.enabled,
    ...(definition.inputs === undefined ? {} : { inputs: definition.inputs }),
    ...(definition.createdBy === undefined ? {} : { createdBy: definition.createdBy }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

export function toFlowNodes(definition: GraphSnapshot): EditorNode[] {
  const positions = definition.ui?.positions ?? {}
  return definition.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: positions[node.id] ?? { x: 0, y: 0 },
    data: { node },
    ...nodeBox(node),
  }))
}

export function toFlowEdges(definition: GraphSnapshot): EditorEdge[] {
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.from.nodeId,
    sourceHandle: edge.from.port,
    target: edge.to.nodeId,
    targetHandle: "input",
    type: "workflow",
  }))
}

export function hasStoredPositions(definition: GraphSnapshot): boolean {
  const positions = definition.ui?.positions ?? {}
  return definition.nodes.length > 0 && definition.nodes.every((node) => positions[node.id] !== undefined)
}

/** Map the store back to the full wire definition for PUT. The server owns
 *  revision/enabled/timestamps; we echo the last acknowledged values. */
export function serializeDefinition(
  meta: EditorMeta,
  nodes: EditorNode[],
  edges: EditorEdge[],
): WorkflowDefinitionV2Wire {
  return {
    schemaVersion: 1,
    id: meta.id,
    title: meta.title,
    ...(meta.description === undefined || meta.description === "" ? {} : { description: meta.description }),
    revision: meta.revision,
    enabled: meta.enabled,
    ...(meta.inputs === undefined ? {} : { inputs: meta.inputs }),
    ...(meta.createdBy === undefined ? {} : { createdBy: meta.createdBy }),
    nodes: nodes.map((node) => {
      const value = node.data.node
      return { id: value.id, type: value.type, name: value.name.trim() || NODE_TYPE_LABEL[value.type], config: value.config }
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      from: { nodeId: edge.source, port: edge.sourceHandle ?? "success" },
      to: { nodeId: edge.target, port: "input" as const },
    })),
    ui: {
      positions: Object.fromEntries(
        nodes.map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]),
      ),
    },
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

export function allocateNodeId(type: WorkflowNodeTypeV2, taken: ReadonlySet<string>): string {
  if (!taken.has(type)) return type
  for (let index = 2; ; index += 1) {
    const candidate = `${type}-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

export function allocateEdgeId(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `e${index}`
    if (!taken.has(candidate)) return candidate
  }
}

export function allocateConditionPort(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `case-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

function defaultConfig(type: WorkflowNodeTypeV2): Record<string, unknown> {
  switch (type) {
    case "trigger":
      return { kind: "manual" }
    case "employee":
      return { employee: { source: "fixed", value: "" }, prompt: "" }
    case "condition":
      return { cases: [{ port: "case-1", label: "Case 1", all: [] }], defaultPort: "else" }
    case "merge":
      return { mode: "wait-all" }
    case "approval":
      return { description: "" }
    case "wait":
      return { mode: "duration", minutes: 60 }
    case "end":
      return { result: "success" }
  }
}

export function createWorkflowNode(type: WorkflowNodeTypeV2, id: string): WorkflowNodeWire {
  return { id, type, name: NODE_TYPE_LABEL[type], config: defaultConfig(type) }
}
