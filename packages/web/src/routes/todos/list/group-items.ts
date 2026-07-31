import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"

export interface TodoListColumnInput {
  items: WorkItemCompactWire[]
  total: number
}

export type TodoListColumns = Record<WorkItemStatusWire, TodoListColumnInput>

export type TodoListGroupKey =
  | "needs-you"
  | "executing"
  | "in-review"
  | "assigned"
  | "backlog"
  | "blocked"
  | "escalated"
  | "closed"

export interface TodoListGroup {
  key: TodoListGroupKey
  label: string
  statuses: WorkItemStatusWire[]
  items: WorkItemCompactWire[]
  count: number
  collapsed?: boolean
}

const OPEN_GROUPS: Array<{
  key: Exclude<TodoListGroupKey, "needs-you" | "closed">
  label: string
  status: WorkItemStatusWire
  omitWhenEmpty?: boolean
}> = [
  { key: "executing", label: "Executing", status: "executing" },
  { key: "in-review", label: "In review", status: "in_review" },
  { key: "assigned", label: "Assigned", status: "assigned" },
  { key: "backlog", label: "Backlog", status: "backlog" },
  { key: "blocked", label: "Blocked", status: "blocked", omitWhenEmpty: true },
  { key: "escalated", label: "Escalated", status: "escalated", omitWhenEmpty: true },
]

export function groupTodoListItems(
  columns: TodoListColumns,
  needsAttention: WorkItemCompactWire[],
): TodoListGroup[] {
  const attentionIds = new Set(needsAttention.map(({ id }) => id))
  const allItems = Object.values(columns).flatMap(({ items }) => items)
  const needsItems = allItems.filter(({ id }) => attentionIds.has(id))
  const hoistedByStatus = new Map<WorkItemStatusWire, number>()
  for (const item of needsItems) {
    hoistedByStatus.set(item.status, (hoistedByStatus.get(item.status) ?? 0) + 1)
  }

  const groups: TodoListGroup[] = [{
    key: "needs-you",
    label: "Needs you",
    statuses: [],
    items: needsItems,
    count: needsItems.length,
  }]

  for (const definition of OPEN_GROUPS) {
    const column = columns[definition.status]
    const items = column.items.filter(({ id }) => !attentionIds.has(id))
    const count = Math.max(items.length, column.total - (hoistedByStatus.get(definition.status) ?? 0))
    if (definition.omitWhenEmpty && count === 0) continue
    groups.push({
      key: definition.key,
      label: definition.label,
      statuses: [definition.status],
      items,
      count,
    })
  }

  const closedStatuses: WorkItemStatusWire[] = ["done", "cancelled"]
  const closedItems = closedStatuses.flatMap((status) =>
    columns[status].items.filter(({ id }) => !attentionIds.has(id)),
  )
  const closedCount = closedStatuses.reduce(
    (total, status) => total + columns[status].total - (hoistedByStatus.get(status) ?? 0),
    0,
  )
  groups.push({
    key: "closed",
    label: "Closed",
    statuses: closedStatuses,
    items: closedItems,
    count: Math.max(closedItems.length, closedCount),
    collapsed: true,
  })

  return groups
}
