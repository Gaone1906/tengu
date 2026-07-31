import { useMemo, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardColumnData } from "../board/use-board"
import { groupTodoListItems } from "./group-items"
import { TodoListGroup } from "./list-group"

export function TodoList({
  columns,
  needsAttention,
  byName,
  trees,
  now,
  onOpen,
  onQuickAdd,
}: {
  columns: Record<WorkItemStatusWire, BoardColumnData>
  needsAttention: WorkItemCompactWire[]
  byName: Map<string, Employee>
  trees: Map<string, WorkItemTreeWire> | undefined
  now: number
  onOpen: (id: string, item: WorkItemCompactWire) => void
  onQuickAdd: (askAssignee: boolean) => void
}) {
  const groups = useMemo(() => groupTodoListItems(columns, needsAttention), [columns, needsAttention])
  const [closedOpen, setClosedOpen] = useState(false)

  return (
    <div className="flex flex-col gap-[18px] px-3 pb-24 pt-5 md:px-10 md:pb-10">
      {groups.map((group) => {
        const loadingMore = group.statuses.some((status) => columns[status].loadingMore)
        const hasMore = group.statuses.some((status) => columns[status].hasMore)
        const open = group.key !== "closed" || closedOpen
        return (
          <TodoListGroup
            key={group.key}
            group={group}
            byName={byName}
            trees={trees}
            now={now}
            open={open}
            onToggle={group.key === "closed" ? () => setClosedOpen((value) => !value) : undefined}
            onQuickAdd={() => onQuickAdd(group.key === "assigned")}
            onOpen={onOpen}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={() => {
              for (const status of group.statuses) {
                if (columns[status].hasMore) columns[status].loadMore()
              }
            }}
          />
        )
      })}
    </div>
  )
}
