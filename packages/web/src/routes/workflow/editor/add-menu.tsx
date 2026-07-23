import { useEffect, useRef, useState } from "react"
import { NODE_TYPE_LABEL, type WorkflowNodeTypeV2 } from "./ports"
import { NodeTypeIcon } from "./node-icons"

/** Types offerable mid-graph — a workflow has exactly one Trigger, placed from the palette. */
export const INSERTABLE_TYPES: WorkflowNodeTypeV2[] = ["employee", "condition", "approval", "wait", "merge", "end"]

export function useMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])
  return { open, setOpen, ref }
}

/** The quiet add-node list card shared by edge-insert and free-port add. */
export function NodeTypeMenu({
  onPick,
  extra,
}: {
  onPick: (type: WorkflowNodeTypeV2) => void
  extra?: React.ReactNode
}) {
  return (
    <div className="w-[188px] rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] p-1 shadow-[var(--shadow-overlay)]">
      {INSERTABLE_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onPick(type)}
          className="flex h-[34px] w-full items-center gap-2.5 rounded-[9px] px-2 text-left text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] hover:bg-[var(--fill-secondary)]"
        >
          <NodeTypeIcon type={type} size={22} iconSize={12} />
          {NODE_TYPE_LABEL[type]}
        </button>
      ))}
      {extra}
    </div>
  )
}
