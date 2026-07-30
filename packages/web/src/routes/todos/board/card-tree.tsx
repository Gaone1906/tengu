import { memo, useState } from "react"
import { Plus } from "lucide-react"
import type { WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateCircle } from "../state-glyph"
import { stateKeyOf } from "@/lib/todos"

/* Todos v2 slice 6 — the in-place tree tray (design-doc §4, polish law 8:
 * the tray sits flush on the card's 13px content edge; rows use the standard
 * 8px inner inset). Children are ROWS, not board cards: 16px discs, mono IDs,
 * one-line titles, 16px avatars; depth indents 22px per level. The add row is
 * absent at the depth cap. Expansion animates via the collapsed-hidden grow
 * (200ms ease-smooth, instant under reduced motion). */

const DEPTH_CAP = 3

interface FlatRow {
  node: WorkItemTreeNodeWire
  level: number
}

function flatten(nodes: WorkItemTreeNodeWire[], level: number, out: FlatRow[]): FlatRow[] {
  for (const node of nodes) {
    out.push({ node, level })
    flatten(node.children ?? [], level + 1, out)
  }
  return out
}

export const CardTree = memo(function CardTree({
  tree,
  cardDepth,
  onOpenChild,
  onAddSubTask,
}: {
  tree: WorkItemTreeWire
  cardDepth: number
  onOpenChild: (id: string) => void
  onAddSubTask: (title: string) => void
}) {
  const rows = flatten(tree.root.children ?? [], 0, [])
  const atCap = cardDepth >= DEPTH_CAP
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")

  const submit = () => {
    const t = title.trim()
    if (!t) {
      setAdding(false)
      return
    }
    onAddSubTask(t)
    setTitle("")
    setAdding(false)
  }

  return (
    <div
      data-testid="board-card-tree"
      className="mt-2 flex w-full flex-col rounded-[10px] bg-[var(--fill-quaternary)] p-[3px] motion-safe:animate-[treeGrow_200ms_var(--ease-smooth)]"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {rows.map(({ node, level }) => {
        const closed = node.status === "done" || node.status === "cancelled"
        return (
          <div
            key={node.id}
            role="button"
            tabIndex={0}
            data-testid={`tree-row-${node.id}`}
            onClick={() => onOpenChild(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpenChild(node.id)
            }}
            className="focus-ring flex min-h-[34px] cursor-pointer items-center gap-2 rounded-lg px-2 py-1 outline-none hover:bg-[var(--fill-tertiary)]"
            style={level > 0 ? { marginLeft: level * 22 } : undefined}
          >
            <StateCircle keyOf={stateKeyOf(node.status)} size={16} />
            <span
              className="flex-none text-[10.5px] text-[var(--text-quaternary)]"
              style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
            >
              {node.id}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                closed ? "font-normal text-[var(--text-tertiary)]" : "font-medium text-[var(--text-primary)]"
              }`}
            >
              {node.title}
            </span>
            {node.assignee && (
              <EmployeeAvatar name={node.assignee} size={16} fontSize={9} className="bg-[var(--fill-secondary)]" />
            )}
          </div>
        )
      })}

      {/* The add row simply doesn't exist at the cap (design §7.2). */}
      {!atCap && (
        adding ? (
          <div className="flex min-h-8 items-center gap-[7px] rounded-lg px-2 py-1">
            <Plus size={12} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
                if (e.key === "Escape") {
                  setTitle("")
                  setAdding(false)
                }
              }}
              onBlur={submit}
              placeholder="Sub-task title"
              aria-label="New sub-task title"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
            />
          </div>
        ) : (
          <button
            type="button"
            data-testid="tree-add-subtask"
            onClick={() => setAdding(true)}
            className="focus-ring flex min-h-8 items-center gap-[7px] rounded-lg px-2 py-1 text-left text-[12px] font-medium text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            <Plus size={12} aria-hidden />
            Add sub-task
          </button>
        )
      )}
    </div>
  )
})
