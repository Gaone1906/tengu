import type { Employee, WorkItemCompactWire } from "@/lib/api"
import { emojiForName } from "@/lib/emoji-pool"
import { StatusCircle } from "../state-glyph"
import { formatRelativeTime } from "../util"

function PriorityBars({ priority }: { priority: number }) {
  const strong = priority >= 3
  const low = priority <= 1
  return (
    <span className="flex h-2.5 w-3 flex-none items-end gap-[1.5px]" aria-label={`Priority ${priority}`}>
      {[4, 7, 10].map((height, index) => (
        <span
          key={height}
          aria-hidden
          className="w-[2.5px] rounded-[1px]"
          style={{
            height,
            background: strong ? "var(--text-secondary)" : "var(--text-quaternary)",
            opacity: low && index > 0 ? 0.35 : 1,
          }}
        />
      ))}
    </span>
  )
}

export function TodoListRow({
  item,
  priority,
  byName,
  now,
  onOpen,
}: {
  item: WorkItemCompactWire
  priority: number
  byName: Map<string, Employee>
  now: number
  onOpen: (id: string, item: WorkItemCompactWire) => void
}) {
  const assignee = item.assignee ? byName.get(item.assignee) : undefined
  return (
    <button
      type="button"
      data-testid={`todo-list-row-${item.id}`}
      onClick={() => onOpen(item.id, item)}
      className="focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 text-left outline-none transition-colors duration-150 hover:bg-[var(--fill-quaternary)] max-[700px]:min-h-[52px] max-[700px]:gap-2"
    >
      <PriorityBars priority={priority} />
      <span
        className="w-[66px] flex-none truncate text-[12px] tracking-[.02em] text-[var(--text-quaternary)] max-[700px]:w-[58px]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        {item.id}
      </span>
      <StatusCircle status={item.status} size={16} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--text-primary)]">
        {item.title}
      </span>
      <span className="flex flex-none items-center gap-2 max-[700px]:gap-1.5">
        {(item.labels ?? []).slice(0, 2).map((label) => (
          <span
            key={label.id}
            className="flex h-5 items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] px-2 text-[11px] font-medium text-[var(--text-tertiary)] max-[700px]:hidden"
          >
            <span className="size-1.5 rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
            {label.name}
          </span>
        ))}
        <span
          className="w-14 text-right text-[11px] tabular-nums text-[var(--text-quaternary)] max-[700px]:hidden"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {formatRelativeTime(item.updatedAt, now)}
        </span>
        {item.assignee && (
          <span
            title={assignee?.displayName ?? item.assignee}
            className="grid size-5 place-items-center rounded-full bg-[var(--fill-secondary)] text-[11px]"
          >
            {emojiForName(item.assignee)}
          </span>
        )}
      </span>
    </button>
  )
}
