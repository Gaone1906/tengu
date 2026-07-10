import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import type { Employee, WorkItemSourceWire } from "@/lib/api"
import { STATUS_LABEL, activeFilterCount, type DateFilter, type StatusFilter, type TodoFilters } from "@/lib/todos"

/* design-todos §4.3 — one quiet 30px row of menu chips + search. Chips are
 * capsules on --fill-tertiary (no borders anywhere); a set chip carries its
 * value on --accent-fill with a 10px ×. The chips map 1:1 to server query
 * params — filtering re-queries, never client-slices — and persist in the URL. */

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
  "min-w-[180px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"

function MenuCheck({ on }: { on: boolean }) {
  return <Check size={12} strokeWidth={2.6} className={`ml-auto ${on ? "text-[var(--accent)]" : "opacity-0"}`} aria-hidden />
}

function Chip({
  set,
  label,
  leading,
  onClear,
  testId,
}: {
  set: boolean
  label: string
  leading?: React.ReactNode
  onClear?: () => void
  testId?: string
}) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        data-testid={testId}
        className={`inline-flex h-[30px] flex-none items-center gap-[5px] rounded-full border-0 px-[11px] text-[length:var(--text-footnote)] font-medium transition-colors duration-150 ease-[var(--ease-smooth)] ${
          set
            ? "bg-[var(--accent-fill)] text-[var(--accent)]"
            : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        }`}
      >
        {leading}
        {label}
        {set && onClear ? (
          <X
            size={10}
            strokeWidth={2.5}
            className="opacity-70"
            aria-label={`Clear ${label} filter`}
            onPointerDown={(e) => {
              // Clear without opening the menu.
              e.preventDefault()
              e.stopPropagation()
              onClear()
            }}
          />
        ) : (
          <ChevronDown size={10} strokeWidth={2.5} className={set ? "opacity-70" : "text-[var(--text-quaternary)]"} aria-hidden />
        )}
      </button>
    </DropdownMenuTrigger>
  )
}

export function FilterBar({
  filters,
  onChange,
  employees,
  departments,
  byName,
}: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  employees: Employee[]
  departments: string[]
  byName: Map<string, Employee>
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [q, setQ] = useState(filters.q ?? "")
  const debounce = useRef<number | null>(null)
  useEffect(() => setQ(filters.q ?? ""), [filters.q])

  const setSearch = (value: string) => {
    setQ(value)
    if (debounce.current != null) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      onChange({ ...filters, q: value.trim() || undefined })
    }, 250)
  }

  const active = activeFilterCount(filters)
  const personName = filters.assignee ? (byName.get(filters.assignee)?.displayName ?? filters.assignee) : null
  const dateLabel = DATE_OPTIONS.find((d) => d.value === filters.date)?.label ?? "Any time"

  return (
    <div className="mb-5" data-testid="todos-filters">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 max-[500px]:-mx-4 max-[500px]:overflow-x-auto max-[500px]:px-4 max-[500px]:[scrollbar-width:none] max-[500px]:[&::-webkit-scrollbar]:hidden">
          <DropdownMenu>
            <Chip
              set={filters.status !== "open"}
              label={STATUS_OPTIONS.find((s) => s.value === filters.status)?.label ?? "Open"}
              onClear={() => onChange({ ...filters, status: "open" })}
              testId="filter-status"
            />
            <DropdownMenuContent align="start" className={MENU_CLASS}>
              {STATUS_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, status: o.value })}>
                  {o.label}
                  <MenuCheck on={filters.status === o.value} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Chip
              set={!!filters.assignee}
              label={personName ?? "Person"}
              leading={
                filters.assignee ? (
                  <EmployeeAvatar name={filters.assignee} size={16} fontSize={9} className="bg-[var(--fill-secondary)]" />
                ) : undefined
              }
              onClear={() => onChange({ ...filters, assignee: undefined })}
              testId="filter-person"
            />
            <DropdownMenuContent align="start" className={`${MENU_CLASS} max-h-[320px] overflow-y-auto`}>
              {employees.map((e) => (
                <DropdownMenuItem key={e.name} className={ITEM_CLASS} onClick={() => onChange({ ...filters, assignee: e.name })}>
                  <EmployeeAvatar name={e.name} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
                  {e.displayName}
                  <MenuCheck on={filters.assignee === e.name} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Chip
              set={!!filters.department}
              label={filters.department ? filters.department.charAt(0).toUpperCase() + filters.department.slice(1) : "Department"}
              onClear={() => onChange({ ...filters, department: undefined })}
              testId="filter-department"
            />
            <DropdownMenuContent align="start" className={MENU_CLASS}>
              {departments.map((d) => (
                <DropdownMenuItem key={d} className={ITEM_CLASS} onClick={() => onChange({ ...filters, department: d })}>
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                  <MenuCheck on={filters.department === d} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Chip
              set={!!filters.source}
              label={SOURCE_OPTIONS.find((s) => s.value === filters.source)?.label ?? "Source"}
              onClear={() => onChange({ ...filters, source: undefined })}
              testId="filter-source"
            />
            <DropdownMenuContent align="start" className={MENU_CLASS}>
              {SOURCE_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: o.value })}>
                  {o.label}
                  <MenuCheck on={filters.source === o.value} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Chip
              set={!!filters.date}
              label={dateLabel}
              onClear={() => onChange({ ...filters, date: undefined })}
              testId="filter-date"
            />
            <DropdownMenuContent align="start" className={MENU_CLASS}>
              {DATE_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.label} className={ITEM_CLASS} onClick={() => onChange({ ...filters, date: o.value })}>
                  {o.label}
                  <MenuCheck on={filters.date === o.value} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {active > 0 && (
            <button
              type="button"
              data-testid="filter-clear"
              onClick={() => onChange({ status: "open" })}
              className="h-[30px] flex-none rounded-full px-2 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              Clear
            </button>
          )}

          {/* ≤500px the search collapses to an icon chip at the end of the row. */}
          <button
            type="button"
            aria-label="Search todos"
            onClick={() => setSearchOpen((v) => !v)}
            className={`hidden size-[30px] flex-none place-items-center rounded-full max-[500px]:grid ${
              filters.q ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]"
            }`}
          >
            <Search size={13} strokeWidth={2} />
          </button>
        </div>

        <label className="inline-flex h-[30px] w-[180px] flex-none items-center gap-[7px] rounded-full bg-[var(--fill-tertiary)] px-3 transition-colors focus-within:bg-[var(--fill-secondary)] max-[500px]:hidden">
          <Search size={13} strokeWidth={2} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
          <input
            data-testid="filter-search"
            value={q}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search todos"
            className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
        </label>
      </div>

      {searchOpen && (
        <label className="mt-2 hidden h-[34px] items-center gap-[7px] rounded-full bg-[var(--fill-tertiary)] px-3 max-[500px]:flex">
          <Search size={13} strokeWidth={2} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search todos"
            className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
        </label>
      )}
    </div>
  )
}
