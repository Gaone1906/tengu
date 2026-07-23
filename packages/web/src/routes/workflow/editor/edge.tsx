import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react"
import { Plus, Unlink } from "lucide-react"
import { NodeTypeMenu, useMenu } from "./add-menu"
import type { EditorEdge } from "./graph"
import type { WorkflowNodeTypeV2 } from "./ports"
import { useEditorApi } from "./store"

/** The template's insert-node-on-edge affordance: a quiet `+` riding the wire's
 *  midpoint that splices a new node into the connection. Editor-only — it
 *  writes into the editor store. */
function EdgeInsertAffordance({ edgeId, labelX, labelY }: { edgeId: string; labelX: number; labelY: number }) {
  const store = useEditorApi()
  const menu = useMenu()

  const onPick = (type: WorkflowNodeTypeV2) => {
    store.getState().insertOnEdge(type, edgeId, { x: labelX, y: labelY })
    menu.setOpen(false)
  }

  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan pointer-events-auto absolute"
        style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
      >
        <button
          type="button"
          aria-label="Insert node on connection"
          onClick={(event) => {
            event.stopPropagation()
            menu.setOpen(!menu.open)
          }}
          className="grid size-[18px] place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
          style={{ background: "var(--material-regular)", boxShadow: "var(--shadow-overlay)" }}
        >
          <Plus size={11} strokeWidth={2.25} aria-hidden />
        </button>
        {menu.open && (
          <div ref={menu.ref} className="absolute left-1/2 z-50 mt-1.5 -translate-x-1/2">
            <NodeTypeMenu
              onPick={onPick}
              extra={
                <button
                  type="button"
                  onClick={() => {
                    store.getState().removeEdge(edgeId)
                    menu.setOpen(false)
                  }}
                  className="mt-0.5 flex h-[34px] w-full items-center gap-2.5 rounded-[9px] px-2 text-left text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--system-red)] hover:bg-[var(--fill-secondary)]"
                >
                  <span className="grid size-[22px] place-items-center">
                    <Unlink size={12} strokeWidth={2} aria-hidden />
                  </span>
                  Remove connection
                </button>
              }
            />
          </div>
        )}
      </div>
    </EdgeLabelRenderer>
  )
}

/** One edge component for both surfaces: run data (when present) paints the
 *  traversed path and drops every editing affordance; otherwise the editor's
 *  insert-on-edge `+` rides the wire. */
export function WorkflowEditorEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<EditorEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  })

  const run = data?.run
  if (run) {
    return (
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: run.taken ? "var(--accent)" : "var(--separator-opaque)",
          strokeWidth: 2,
          opacity: run.taken ? 0.95 : 0.45,
        }}
      />
    )
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? "var(--accent)" : "var(--separator-opaque)",
          strokeWidth: selected ? 2.5 : 2,
          opacity: 0.9,
        }}
      />
      <EdgeInsertAffordance edgeId={id} labelX={labelX} labelY={labelY} />
    </>
  )
}

export const editorEdgeTypes = { workflow: WorkflowEditorEdge }
