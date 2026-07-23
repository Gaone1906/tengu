import { createContext, useContext } from "react"
import { applyEdgeChanges, applyNodeChanges, type OnEdgesChange, type OnNodesChange, type XYPosition } from "@xyflow/react"
import { createStore, useStore } from "zustand"
import type { WorkflowDefinitionV2Wire, WorkflowIssueV2Wire } from "@/lib/api"
import {
  allocateEdgeId,
  allocateNodeId,
  createWorkflowNode,
  hasStoredPositions,
  toEditorMeta,
  toFlowEdges,
  toFlowNodes,
  type EditorEdge,
  type EditorMeta,
  type EditorNode,
} from "./graph"
import { tidyLayout } from "./layout"
import { acceptsInput, nodeBox, outputPorts, type WorkflowNodeTypeV2, type WorkflowNodeWire } from "./ports"

export type SaveState =
  | { state: "saved" }
  | { state: "saving" }
  | { state: "error"; message: string }
  | { state: "conflict" }

/** The ONE source of editor truth: React Flow nodes+edges plus workflow
 *  metadata. The properties panel writes straight into these nodes; autosave
 *  serializes straight out of them. There is no second draft layer. */
export interface EditorState {
  meta: EditorMeta
  nodes: EditorNode[]
  edges: EditorEdge[]
  /** Bumped by every user edit; 0 = pristine since load/acknowledge. */
  serial: number
  save: SaveState
  issues: WorkflowIssueV2Wire[] | null

  onNodesChange: OnNodesChange<EditorNode>
  onEdgesChange: OnEdgesChange<EditorEdge>
  connect: (source: string, sourceHandle: string, target: string) => void
  addNodeAt: (type: WorkflowNodeTypeV2, center: XYPosition) => string
  insertOnEdge: (type: WorkflowNodeTypeV2, edgeId: string, center: XYPosition) => void
  removeNode: (nodeId: string) => void
  removeEdge: (edgeId: string) => void
  renameNode: (nodeId: string, name: string) => void
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void
  selectNode: (nodeId: string | null) => void
  tidy: () => void
  setSave: (save: SaveState) => void
  /** Record the server's answer to a save — revision advances, edits stay. */
  acknowledge: (saved: Pick<WorkflowDefinitionV2Wire, "revision" | "enabled" | "updatedAt">) => void
  /** Replace everything with a fresh server definition (conflict reload, enable flip). */
  applyDefinition: (definition: WorkflowDefinitionV2Wire) => void
  setIssues: (issues: WorkflowIssueV2Wire[] | null) => void
}

function updateNode(nodes: EditorNode[], nodeId: string, patch: (node: WorkflowNodeWire) => WorkflowNodeWire): EditorNode[] {
  return nodes.map((node) => {
    if (node.id !== nodeId) return node
    const next = patch(node.data.node)
    return { ...node, data: { node: next }, ...nodeBox(next) }
  })
}

function initialGraph(definition: WorkflowDefinitionV2Wire): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const nodes = toFlowNodes(definition)
  const edges = toFlowEdges(definition)
  // Imported drafts carry no positions — lay them out once, in memory; the
  // layout persists with the first real edit.
  return { nodes: hasStoredPositions(definition) ? nodes : tidyLayout(nodes, edges), edges }
}

export function createEditorStore(definition: WorkflowDefinitionV2Wire) {
  return createStore<EditorState>()((set, get) => ({
    meta: toEditorMeta(definition),
    ...initialGraph(definition),
    serial: 0,
    save: { state: "saved" },
    issues: null,

    onNodesChange: (changes) => {
      const dirty = changes.some((change) => change.type === "position" || change.type === "remove")
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        ...(dirty ? { serial: state.serial + 1 } : {}),
      }))
    },

    onEdgesChange: (changes) => {
      const dirty = changes.some((change) => change.type === "remove")
      set((state) => ({
        edges: applyEdgeChanges(changes, state.edges),
        ...(dirty ? { serial: state.serial + 1 } : {}),
      }))
    },

    connect: (source, sourceHandle, target) => {
      const { edges, nodes } = get()
      const targetNode = nodes.find((node) => node.id === target)
      if (!targetNode || !acceptsInput(targetNode.data.node.type)) return
      if (edges.some((edge) => edge.source === source && edge.sourceHandle === sourceHandle && edge.target === target)) return
      const edge: EditorEdge = {
        id: allocateEdgeId(new Set(edges.map((item) => item.id))),
        source,
        sourceHandle,
        target,
        targetHandle: "input",
        type: "workflow",
      }
      set((state) => ({ edges: [...state.edges, edge], serial: state.serial + 1 }))
    },

    addNodeAt: (type, center) => {
      const { nodes } = get()
      const id = allocateNodeId(type, new Set(nodes.map((node) => node.id)))
      const value = createWorkflowNode(type, id)
      const box = nodeBox(value)
      const node: EditorNode = {
        id,
        type,
        position: { x: center.x - box.width / 2, y: center.y - box.height / 2 },
        data: { node: value },
        selected: true,
        ...box,
      }
      set((state) => ({
        nodes: [...state.nodes.map((item) => ({ ...item, selected: false })), node],
        serial: state.serial + 1,
      }))
      return id
    },

    insertOnEdge: (type, edgeId, center) => {
      const edge = get().edges.find((item) => item.id === edgeId)
      if (!edge || type === "trigger") return
      const id = get().addNodeAt(type, center)
      const inserted = get().nodes.find((node) => node.id === id)
      if (!inserted) return
      const firstOut = outputPorts(inserted.data.node)[0]
      set((state) => {
        const remaining = state.edges.filter((item) => item.id !== edgeId)
        const taken = new Set(remaining.map((item) => item.id))
        const incoming: EditorEdge = {
          id: allocateEdgeId(taken),
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: id,
          targetHandle: "input",
          type: "workflow",
        }
        taken.add(incoming.id)
        const outgoing: EditorEdge[] = firstOut
          ? [{
              id: allocateEdgeId(taken),
              source: id,
              sourceHandle: firstOut.id,
              target: edge.target,
              targetHandle: "input",
              type: "workflow",
            }]
          : []
        return { edges: [...remaining, incoming, ...outgoing], serial: state.serial + 1 }
      })
    },

    removeNode: (nodeId) => {
      set((state) => ({
        nodes: state.nodes.filter((node) => node.id !== nodeId),
        edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
        serial: state.serial + 1,
      }))
    },

    removeEdge: (edgeId) => {
      set((state) => ({ edges: state.edges.filter((edge) => edge.id !== edgeId), serial: state.serial + 1 }))
    },

    renameNode: (nodeId, name) => {
      set((state) => ({
        nodes: updateNode(state.nodes, nodeId, (node) => ({ ...node, name })),
        serial: state.serial + 1,
      }))
    },

    updateNodeConfig: (nodeId, config) => {
      set((state) => {
        const nodes = updateNode(state.nodes, nodeId, (node) => ({ ...node, config }))
        const changed = nodes.find((node) => node.id === nodeId)
        // A removed Condition case takes its wires with it — graph bookkeeping,
        // not validation (verdicts stay server-side).
        const ports = changed ? new Set(outputPorts(changed.data.node).map((port) => port.id)) : null
        const edges = ports
          ? state.edges.filter((edge) => edge.source !== nodeId || ports.has(edge.sourceHandle ?? ""))
          : state.edges
        return { nodes, edges, serial: state.serial + 1 }
      })
    },

    selectNode: (nodeId) => {
      set((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === nodeId })) }))
    },

    tidy: () => {
      set((state) => ({ nodes: tidyLayout(state.nodes, state.edges), serial: state.serial + 1 }))
    },

    setSave: (save) => set({ save }),

    acknowledge: (saved) => {
      set((state) => ({
        meta: { ...state.meta, revision: saved.revision, enabled: saved.enabled, updatedAt: saved.updatedAt },
        save: { state: "saved" },
      }))
    },

    applyDefinition: (definition) => {
      set({ meta: toEditorMeta(definition), ...initialGraph(definition), serial: 0, save: { state: "saved" }, issues: null })
    },

    setIssues: (issues) => set({ issues }),
  }))
}

export type EditorStoreApi = ReturnType<typeof createEditorStore>

export const EditorStoreContext = createContext<EditorStoreApi | null>(null)

export function useEditor<T>(selector: (state: EditorState) => T): T {
  const store = useContext(EditorStoreContext)
  if (!store) throw new Error("useEditor must be used inside the editor provider")
  return useStore(store, selector)
}

export function useEditorApi(): EditorStoreApi {
  const store = useContext(EditorStoreContext)
  if (!store) throw new Error("useEditorApi must be used inside the editor provider")
  return store
}
