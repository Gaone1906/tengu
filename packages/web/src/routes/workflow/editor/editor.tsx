import "@xyflow/react/dist/style.css"
import { useCallback, useEffect, useRef } from "react"
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
} from "@xyflow/react"
import { useShallow } from "zustand/react/shallow"
import { AlertTriangle, Maximize, Minus, Plus, Route, X } from "lucide-react"
import { ApiError, api } from "@/lib/api"
import { serializeDefinition } from "./graph"
import { editorEdgeTypes } from "./edge"
import { editorNodeTypes } from "./node-card"
import { Inspector } from "./inspector"
import { DND_MIME, MobileAddNode, NodePalette } from "./palette"
import type { WorkflowNodeTypeV2 } from "./ports"
import { useEditor, useEditorApi, type EditorState, type EditorStoreApi } from "./store"

/** Dumb autosave: debounce edits, map store → wire definition, PUT with
 *  expectedRevision. 409 → conflict banner offering reload. That is the entire
 *  save story. */
export function useAutosave(store: EditorStoreApi): { flushNow: () => Promise<void> } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef(false)
  const queued = useRef(false)

  const flush = useCallback(async () => {
    if (inflight.current) {
      queued.current = true
      return
    }
    const state = store.getState()
    if (state.serial === 0 || state.save.state === "conflict") return
    inflight.current = true
    state.setSave({ state: "saving" })
    try {
      const definition = serializeDefinition(state.meta, state.nodes, state.edges)
      const saved = await api.saveWorkflowDefinitionV2(state.meta.id, definition, state.meta.revision)
      store.getState().acknowledge(saved)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        store.getState().setSave({ state: "conflict" })
      } else {
        store.getState().setSave({
          state: "error",
          message: error instanceof Error ? error.message : "Save failed.",
        })
      }
    } finally {
      inflight.current = false
      if (queued.current) {
        queued.current = false
        void flush()
      }
    }
  }, [store])

  useEffect(() => {
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.serial === previous.serial || state.serial === 0) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 1000)
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [flush, store])

  const flushNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    await flush()
    // A queued follow-up may still be running; wait for it to settle.
    while (inflight.current) await new Promise((resolve) => setTimeout(resolve, 50))
  }, [flush])

  return { flushNow }
}

/* ── ambient save status ──────────────────────────────────────────────────── */

export function SaveChip({ onReload }: { onReload: () => void }) {
  const save = useEditor((state) => state.save)
  const retry = useEditorApi()
  if (save.state === "saved") {
    return <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">Saved</span>
  }
  if (save.state === "saving") {
    return <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Saving…</span>
  }
  if (save.state === "conflict") {
    return (
      <button
        type="button"
        onClick={onReload}
        className="rounded-full bg-[color-mix(in_srgb,var(--system-orange)_14%,transparent)] px-2.5 py-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--system-orange)]"
      >
        Changed elsewhere — reload
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => retry.setState((state) => ({ serial: state.serial + 1 }))}
      title={save.message}
      className="rounded-full bg-[color-mix(in_srgb,var(--system-red)_12%,transparent)] px-2.5 py-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--system-red)]"
    >
      Save failed — retry
    </button>
  )
}

/* ── validation verdicts from the server ──────────────────────────────────── */

function IssuesCard() {
  const issues = useEditor((state) => state.issues)
  const setIssues = useEditor((state) => state.setIssues)
  const selectNode = useEditor((state) => state.selectNode)
  const names = useEditor(
    useShallow((state) => Object.fromEntries(state.nodes.map((node) => [node.id, node.data.node.name]))),
  )
  if (!issues || issues.length === 0) return null
  return (
    <Panel position="top-center" className="max-w-[92vw]">
      <div className="w-[360px] max-w-full rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-3 shadow-[var(--shadow-overlay)]">
        <div className="mb-1.5 flex items-center gap-2">
          <AlertTriangle size={14} className="text-[var(--system-orange)]" aria-hidden />
          <span className="flex-1 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            Not ready to enable
          </span>
          <button
            type="button"
            aria-label="Dismiss issues"
            onClick={() => setIssues(null)}
            className="grid size-7 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="max-h-[240px] space-y-0.5 overflow-y-auto">
          {issues.map((issue, index) => (
            <button
              key={index}
              type="button"
              onClick={() => issue.nodeId && selectNode(issue.nodeId)}
              className="block w-full rounded-[9px] px-2 py-1.5 text-left text-[length:var(--text-caption1)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
            >
              {issue.nodeId && (
                <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {names[issue.nodeId] ?? issue.nodeId}
                  {" — "}
                </span>
              )}
              {issue.message}
            </button>
          ))}
        </div>
      </div>
    </Panel>
  )
}

/* ── canvas chrome ────────────────────────────────────────────────────────── */

function CanvasControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const tidy = useEditor((state) => state.tidy)
  const buttons: Array<{ label: string; icon: React.ReactNode; onClick: () => void }> = [
    { label: "Fit view", icon: <Maximize size={15} />, onClick: () => void fitView({ padding: 0.2, duration: 300 }) },
    { label: "Zoom out", icon: <Minus size={15} />, onClick: () => void zoomOut() },
    { label: "Zoom in", icon: <Plus size={15} />, onClick: () => void zoomIn() },
    { label: "Tidy layout", icon: <Route size={15} />, onClick: tidy },
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

/* ── the canvas ───────────────────────────────────────────────────────────── */

const selector = (state: EditorState) => ({
  nodes: state.nodes,
  edges: state.edges,
  onNodesChange: state.onNodesChange,
  onEdgesChange: state.onEdgesChange,
})

function Canvas() {
  const { nodes, edges, onNodesChange, onEdgesChange } = useEditor(useShallow(selector))
  const store = useEditorApi()
  const { screenToFlowPosition } = useReactFlow()

  const onConnect = useCallback(
    (connection: Connection) => {
      store.getState().connect(connection.source, connection.sourceHandle ?? "success", connection.target)
    },
    [store],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(DND_MIME) as WorkflowNodeTypeV2 | ""
      if (!type) return
      event.preventDefault()
      store.getState().addNodeAt(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [screenToFlowPosition, store],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={editorNodeTypes}
      edgeTypes={editorEdgeTypes}
      defaultEdgeOptions={{ type: "workflow" }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      deleteKeyCode={["Backspace", "Delete"]}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      minZoom={0.25}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--separator)" />
      <NodePalette />
      <MobileAddNode />
      <CanvasControls />
      <IssuesCard />
    </ReactFlow>
  )
}

export function EditorCanvas() {
  return (
    <div className="relative h-full w-full">
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
      <Inspector />
    </div>
  )
}
