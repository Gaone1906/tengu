import { useCallback, useState } from "react"
import { Panel, useReactFlow } from "@xyflow/react"
import { Plus, X } from "lucide-react"
import { INSERTABLE_TYPES } from "./add-menu"
import { NodeTypeIcon } from "./node-icons"
import { NODE_TYPE_LABEL, type WorkflowNodeTypeV2 } from "./ports"
import { useEditor, useEditorApi } from "./store"

export const DND_MIME = "application/x-jinn-workflow-node"

function usePaletteTypes(): WorkflowNodeTypeV2[] {
  const hasTrigger = useEditor((state) => state.nodes.some((node) => node.data.node.type === "trigger"))
  return hasTrigger ? INSERTABLE_TYPES : ["trigger", ...INSERTABLE_TYPES]
}

/** Desktop: the draggable node rail, floating quietly over the canvas. */
export function NodePalette() {
  const types = usePaletteTypes()
  return (
    <Panel position="top-left" className="hidden md:block">
      <div className="w-[172px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-1.5 shadow-[var(--shadow-card)]">
        <p className="px-2 pb-1 pt-1.5 text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
          Add step
        </p>
        {types.map((type) => (
          <div
            key={type}
            draggable
            role="button"
            aria-label={`Add ${NODE_TYPE_LABEL[type]}`}
            onDragStart={(event) => {
              event.dataTransfer.setData(DND_MIME, type)
              event.dataTransfer.effectAllowed = "move"
            }}
            className="flex h-[34px] cursor-grab items-center gap-2.5 rounded-[10px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] hover:bg-[var(--fill-tertiary)] active:cursor-grabbing"
          >
            <NodeTypeIcon type={type} size={22} iconSize={12} />
            {NODE_TYPE_LABEL[type]}
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** Mobile: a `+` button opening a bottom sheet; tapping a type drops the node
 *  at the center of the current viewport. */
export function MobileAddNode() {
  const [open, setOpen] = useState(false)
  const types = usePaletteTypes()
  const store = useEditorApi()
  const { screenToFlowPosition } = useReactFlow()

  const add = useCallback(
    (type: WorkflowNodeTypeV2) => {
      const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect()
      const center = pane
        ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      store.getState().addNodeAt(type, screenToFlowPosition(center))
      setOpen(false)
    },
    [screenToFlowPosition, store],
  )

  return (
    <>
      <Panel position="bottom-right" className="md:hidden">
        <button
          type="button"
          aria-label="Add step"
          onClick={() => setOpen(true)}
          className="mb-1 mr-1 grid size-11 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[var(--shadow-overlay)]"
        >
          <Plus size={20} strokeWidth={2.25} aria-hidden />
        </button>
      </Panel>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="Add step">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0"
            style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
          />
          <div
            className="absolute inset-x-0 rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] px-4 pb-4 pt-3 shadow-[var(--shadow-overlay)]"
            style={{ bottom: "calc(49px + var(--safe-bottom))" }}
          >
            <div className="mx-auto mb-3 h-[5px] w-9 rounded-full bg-[var(--fill-secondary)]" aria-hidden />
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Add step</p>
              <button
                type="button"
                aria-label="Close add step"
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
              >
                <X size={17} aria-hidden />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pb-1">
              {types.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => add(type)}
                  className="flex h-11 items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 text-left text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]"
                >
                  <NodeTypeIcon type={type} size={26} iconSize={13} />
                  {NODE_TYPE_LABEL[type]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
