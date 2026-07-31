import { ChevronDown, Plus } from "lucide-react"
import type { Employee, WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { StateCircle, StatusCircle } from "../state-glyph"
import type { TodoListGroup as TodoListGroupValue } from "./group-items"
import { TodoListRow } from "./list-row"

export function TodoListGroup({
  group,
  byName,
  trees,
  now,
  open,
  onToggle,
  onQuickAdd,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  group: TodoListGroupValue
  byName: Map<string, Employee>
  trees: Map<string, WorkItemTreeWire> | undefined
  now: number
  open: boolean
  onToggle?: () => void
  onQuickAdd: () => void
  onOpen: (id: string, item: WorkItemCompactWire) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  const headerGlyph = group.key === "needs-you"
    ? <StateCircle keyOf="approval" size={16} />
    : group.key === "closed"
      ? <StatusCircle status="done" size={16} />
      : <StatusCircle status={group.statuses[0] as WorkItemStatusWire} size={16} />

  return (
    <section data-testid={`todo-list-group-${group.key}`}>
      <div className="flex min-h-[34px] items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--fill-quaternary)] px-2.5">
        {onToggle ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="focus-ring -ml-1 flex min-h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-1 text-left outline-none"
          >
            <ChevronDown
              size={13}
              aria-hidden
              className={`flex-none text-[var(--text-quaternary)] transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
            />
            {headerGlyph}
            <GroupLabel group={group} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {headerGlyph}
            <GroupLabel group={group} />
          </div>
        )}
        <button
          type="button"
          data-testid={`todo-list-add-${group.key}`}
          aria-label={`Add Todo from ${group.label}`}
          onClick={onQuickAdd}
          className="focus-ring -mr-1 grid size-9 flex-none place-items-center rounded-full text-[var(--text-quaternary)] outline-none transition-[background-color,color,scale] duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
        >
          <Plus size={15} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      {open && (
        <div className="pt-0.5">
          {group.items.map((item) => (
            <TodoListRow
              key={item.id}
              item={item}
              priority={trees?.get(item.id)?.root.priority ?? 0}
              byName={byName}
              now={now}
              onOpen={onOpen}
            />
          ))}
          {group.items.length === 0 && (
            <div className="px-2.5 py-3 text-[12px] text-[var(--text-quaternary)]">No Todos here.</div>
          )}
          {hasMore && (
            <button
              type="button"
              data-testid={`todo-list-show-more-${group.key}`}
              disabled={loadingMore}
              onClick={onLoadMore}
              className="focus-ring mt-1 min-h-10 rounded-[var(--radius-md)] px-2.5 text-[12px] font-semibold text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function GroupLabel({ group }: { group: TodoListGroupValue }) {
  return (
    <>
      <span className="truncate text-[12px] font-bold text-[var(--text-secondary)]">{group.label}</span>
      <span className="text-[11px] tabular-nums text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
        {group.count}
      </span>
    </>
  )
}
