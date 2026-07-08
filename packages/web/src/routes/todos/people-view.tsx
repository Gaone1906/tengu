import { ChevronRight } from "lucide-react"
import type { WorkItemStatusWire } from "@/lib/api"
import { monogram, STATUS_LABEL, type PersonQueue } from "@/lib/todos"
import { StatusCircle } from "./state-glyph"
import { roleLabel, formatRelativeTime } from "./util"

/* GRS-021d — People: one row per employee (monogram, name, role, a status-dot
 * distribution, open count), expandable to that employee's queue ordered by
 * status then priority. Idle employees read "All clear". Answers "what is
 * everyone doing" in one glance. The idle tail is capped so a large, mostly-idle
 * roster stays calm. */

const MAX_IDLE_ROWS = 12

const DOT_COLOR: Record<WorkItemStatusWire, string> = {
  executing: "var(--accent)",
  in_review: "var(--system-purple)",
  escalated: "var(--system-red)",
  assigned: "var(--system-blue)",
  blocked: "var(--system-orange)",
  backlog: "var(--text-quaternary)",
  done: "var(--text-quaternary)",
  cancelled: "var(--text-quaternary)",
}

function QueueRow({ item, onOpen }: { item: PersonQueue["items"][number]; onOpen: (id: string) => void }) {
  const attention = item.status === "escalated" || item.status === "blocked"
  const sub =
    item.status === "executing" ? `Executing · ${formatRelativeTime(item.updatedAt)}` : STATUS_LABEL[item.status]
  return (
    <button
      type="button"
      data-testid={`people-queue-row-${item.id}`}
      onClick={() => onOpen(item.id)}
      className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-[10px_11px] text-left transition-colors hover:bg-[var(--fill-tertiary)]"
    >
      <StatusCircle status={item.status} size={25} />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] font-medium text-[var(--text-primary)]">
        {item.title}
      </span>
      {attention ? (
        <span
          className="flex-none rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold"
          style={{
            background: `color-mix(in srgb, var(${item.status === "escalated" ? "--system-red" : "--system-orange"}) ${item.status === "escalated" ? 18 : 16}%, transparent)`,
            color: `var(${item.status === "escalated" ? "--system-red" : "--system-orange"})`,
          }}
        >
          {STATUS_LABEL[item.status]}
        </span>
      ) : (
        <span className="flex-none text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{sub}</span>
      )}
    </button>
  )
}

function PersonRow({
  queue,
  expanded,
  onToggle,
  onOpen,
}: {
  queue: PersonQueue
  expanded: boolean
  onToggle: (name: string) => void
  onOpen: (id: string) => void
}) {
  const { employee, items, dist, openCount } = queue
  const clear = openCount === 0
  return (
    <div className="overflow-hidden rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
      <button
        type="button"
        data-testid={`people-row-${employee.name}`}
        disabled={clear}
        onClick={() => onToggle(employee.name)}
        className="flex w-full items-center gap-3 p-[15px_16px] text-left disabled:cursor-default"
      >
        <span className="grid size-[34px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[13px] font-bold text-[var(--text-secondary)]">
          {monogram(employee.displayName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold leading-tight text-[var(--text-primary)]">
            {employee.displayName}
          </span>
          <span className="mt-px block truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{roleLabel(employee)}</span>
        </span>
        {dist.length > 0 && (
          <span className="mr-1 flex flex-none items-center gap-1.5">
            {dist.map((s) => (
              <span key={s} className="size-[7px] rounded-full" style={{ background: DOT_COLOR[s] }} />
            ))}
          </span>
        )}
        <span
          className={`min-w-[48px] flex-none text-right text-[length:var(--text-footnote)] tabular-nums ${clear ? "text-[var(--text-quaternary)]" : "text-[var(--text-tertiary)]"}`}
        >
          {clear ? "All clear" : `${openCount} open`}
        </span>
        <ChevronRight
          size={15}
          className="flex-none text-[var(--text-quaternary)] transition-transform duration-200"
          style={{ transform: expanded ? "rotate(90deg)" : undefined, opacity: clear ? 0.4 : 1 }}
          aria-hidden
        />
      </button>
      {expanded && !clear && (
        <div className="flex flex-col gap-[7px] p-[2px_12px_12px]">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

export function PeopleView({
  queues,
  expanded,
  onToggle,
  onOpen,
}: {
  queues: PersonQueue[]
  expanded: Set<string>
  onToggle: (name: string) => void
  onOpen: (id: string) => void
}) {
  const withWork = queues.filter((q) => q.openCount > 0)
  const idle = queues.filter((q) => q.openCount === 0)
  const idleShown = idle.slice(0, MAX_IDLE_ROWS)
  const idleHidden = idle.length - idleShown.length

  return (
    <div className="flex flex-col gap-3" data-testid="people">
      {withWork.map((q) => (
        <PersonRow key={q.employee.name} queue={q} expanded={expanded.has(q.employee.name)} onToggle={onToggle} onOpen={onOpen} />
      ))}
      {idleShown.map((q) => (
        <PersonRow key={q.employee.name} queue={q} expanded={false} onToggle={onToggle} onOpen={onOpen} />
      ))}
      {idleHidden > 0 && (
        <div className="px-1 pt-1 text-center text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          +{idleHidden} more all clear
        </div>
      )}
    </div>
  )
}
