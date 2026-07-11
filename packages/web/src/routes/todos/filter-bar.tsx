import { useEffect, useRef, useState } from "react"
import { Check, Filter, Search, Users, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import type { Employee, WorkItemSourceWire } from "@/lib/api"
import { activeFilterCount, type DateFilter, type StatusFilter, type TodoFilters } from "@/lib/todos"

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
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

const SOURCE_OPTIONS: { value: WorkItemSourceWire; label: string }[] = [
  { value: "human", label: "You" },
  { value: "delegation", label: "Delegation" },
  { value: "cron", label: "Cron" },
  { value: "workflow", label: "Workflow" },
  { value: "session", label: "Session" },
  { value: "connector", label: "Connector" },
  { value: "goal", label: "Goal" },
]

const DATE_OPTIONS: { value: DateFilter | undefined; label: string }[] = [
  { value: undefined, label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
]

const MENU_CLASS =
  "w-[min(320px,calc(100vw-24px))] rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-2 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const SUBMENU_CLASS =
  "max-h-[min(420px,70vh)] min-w-[220px] overflow-y-auto rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "min-h-11 cursor-pointer rounded-[10px] px-3 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"

function MenuCheck({ on }: { on: boolean }) {
  return <Check size={14} strokeWidth={2.6} className={`ml-auto ${on ? "text-[var(--accent)]" : "opacity-0"}`} aria-hidden />
}

function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onClick={onRemove}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[var(--accent-fill)] px-3 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--fill-secondary)]"
    >
      {label}
      <X size={12} strokeWidth={2.4} aria-hidden />
    </button>
  )
}

export function FilterBar({
  filters,
  onChange,
  employees,
  departments,
  byName,
  onPeopleView,
}: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  employees: Employee[]
  departments: string[]
  byName: Map<string, Employee>
  onPeopleView?: () => void
}) {
  const [q, setQ] = useState(filters.q ?? "")
  const debounce = useRef<number | null>(null)
  useEffect(() => setQ(filters.q ?? ""), [filters.q])
  useEffect(() => () => {
    if (debounce.current != null) window.clearTimeout(debounce.current)
  }, [])

  const setSearch = (value: string) => {
    setQ(value)
    if (debounce.current != null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      onChange({ ...filters, q: value.trim() || undefined })
    }, 250)
  }

  const active = activeFilterCount(filters)
  const personName = filters.assignee ? (byName.get(filters.assignee)?.displayName ?? filters.assignee) : null
  const statusLabel = filters.status === "open" ? null : (STATUS_OPTIONS.find((s) => s.value === filters.status)?.label ?? filters.status)
  const sourceLabel = SOURCE_OPTIONS.find((s) => s.value === filters.source)?.label
  const dateLabel = DATE_OPTIONS.find((d) => d.value === filters.date)?.label

  return (
    <div className="mb-5" data-testid="todos-filters">
      <div className="flex items-center gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[14px] bg-[var(--fill-tertiary)] px-3.5 transition-colors focus-within:bg-[var(--fill-secondary)]">
          <Search size={16} strokeWidth={1.9} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
          <input
            type="search"
            aria-label="Search todos"
            data-testid="filter-search"
            value={q}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or JIN-142"
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
        </label>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Filter todos"
              className={`inline-flex min-h-11 flex-none items-center gap-2 rounded-[14px] px-3.5 text-[length:var(--text-subheadline)] font-medium transition-colors ${
                active > 0
                  ? "bg-[var(--accent-fill)] text-[var(--accent)]"
                  : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
              }`}
            >
              <Filter size={16} strokeWidth={1.9} aria-hidden />
              <span className="max-[420px]:sr-only">Filter</span>
              {active > 0 && <span className="tabular-nums">{active}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CLASS}>
            <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              Refine this view
            </DropdownMenuLabel>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Status</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                {STATUS_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, status: option.value })}>
                    {option.label}<MenuCheck on={filters.status === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Person</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, assignee: undefined })}>
                  Anyone<MenuCheck on={!filters.assignee} />
                </DropdownMenuItem>
                {employees.map((employee) => (
                  <DropdownMenuItem key={employee.name} className={ITEM_CLASS} onClick={() => onChange({ ...filters, assignee: employee.name })}>
                    <EmployeeAvatar name={employee.name} size={20} fontSize={10} className="bg-[var(--fill-secondary)]" />
                    {employee.displayName}<MenuCheck on={filters.assignee === employee.name} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Department</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, department: undefined })}>
                  Any department<MenuCheck on={!filters.department} />
                </DropdownMenuItem>
                {departments.map((department) => (
                  <DropdownMenuItem key={department} className={ITEM_CLASS} onClick={() => onChange({ ...filters, department })}>
                    {department.charAt(0).toUpperCase() + department.slice(1)}<MenuCheck on={filters.department === department} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Source</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: undefined })}>
                  Any source<MenuCheck on={!filters.source} />
                </DropdownMenuItem>
                {SOURCE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: option.value })}>
                    {option.label}<MenuCheck on={filters.source === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Date</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                {DATE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.label} className={ITEM_CLASS} onClick={() => onChange({ ...filters, date: option.value })}>
                    {option.label}<MenuCheck on={filters.date === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {onPeopleView && (
              <DropdownMenuItem className={`${ITEM_CLASS} mt-1 bg-[var(--fill-quaternary)]`} onClick={onPeopleView}>
                <Users size={16} strokeWidth={1.9} aria-hidden />
                View by person
              </DropdownMenuItem>
            )}
            {active > 0 && (
              <DropdownMenuItem className={`${ITEM_CLASS} mt-1 text-[var(--text-secondary)]`} onClick={() => onChange({ status: "open" })}>
                Clear all filters
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {active > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Active filters">
          {statusLabel && <ActiveChip label={`Status: ${statusLabel}`} onRemove={() => onChange({ ...filters, status: "open" })} />}
          {personName && <ActiveChip label={`Person: ${personName}`} onRemove={() => onChange({ ...filters, assignee: undefined })} />}
          {filters.department && (
            <ActiveChip
              label={`Department: ${filters.department.charAt(0).toUpperCase() + filters.department.slice(1)}`}
              onRemove={() => onChange({ ...filters, department: undefined })}
            />
          )}
          {sourceLabel && <ActiveChip label={`Source: ${sourceLabel}`} onRemove={() => onChange({ ...filters, source: undefined })} />}
          {filters.date && dateLabel && <ActiveChip label={`Date: ${dateLabel}`} onRemove={() => onChange({ ...filters, date: undefined })} />}
        </div>
      )}
    </div>
  )
}
