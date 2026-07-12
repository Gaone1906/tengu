import type { WorkItemSourceWire } from "@/lib/api"
import type { DateFilter, StatusFilter } from "@/lib/todos"

export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "backlog", label: "Backlog" },
  { value: "assigned", label: "Assigned" },
  { value: "executing", label: "Executing" },
  { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" },
  { value: "escalated", label: "Escalated" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
]

export const SOURCE_OPTIONS: { value: WorkItemSourceWire; label: string }[] = [
  { value: "human", label: "You" },
  { value: "delegation", label: "Delegation" },
  { value: "cron", label: "Cron" },
  { value: "workflow", label: "Workflow" },
  { value: "session", label: "Session" },
  { value: "connector", label: "Connector" },
  { value: "goal", label: "Goal" },
]

export const DATE_OPTIONS: { value: DateFilter | undefined; label: string }[] = [
  { value: undefined, label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
]
