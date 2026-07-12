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
import type { Employee } from "@/lib/api"
import { activeFilterCount, type TodoFilters } from "@/lib/todos"
import { DATE_OPTIONS, SOURCE_OPTIONS, STATUS_OPTIONS } from "./filter-options"
import { TodoFilterSheet } from "./todo-filter-sheet"

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

const MOBILE_QUERY = "(max-width: 767px)"

function useIsTodoMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false))
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

export function FilterBar({
  filters,
  onChange,
  onSearchChange,
  employees,
  departments,
  byName,
  onPeopleView,
}: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  onSearchChange?: (query: string | undefined) => void
  employees: Employee[]
  departments: string[]
  byName: Map<string, Employee>
  onPeopleView?: () => void
}) {
  const mobile = useIsTodoMobile()
  const [mobileOpen, setMobileOpen] = useState(false)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const wasMobileRef = useRef(mobile)
  const filterTriggerOwnsFocusRef = useRef(false)
  const [q, setQ] = useState(filters.q ?? "")
  const debounce = useRef<number | null>(null)
  const filtersRef = useRef(filters)
  const searchChangeRef = useRef(onSearchChange)
  filtersRef.current = filters
  searchChangeRef.current = onSearchChange
  const filterStateKey = [filters.status, filters.assignee, filters.department, filters.source, filters.date, filters.q].join("\u0000")
  const cancelPendingSearch = () => {
    if (debounce.current != null) window.clearTimeout(debounce.current)
    debounce.current = null
  }
  useEffect(() => {
    cancelPendingSearch()
    setQ(filters.q ?? "")
  }, [filterStateKey])
  useEffect(() => () => {
    if (debounce.current != null) window.clearTimeout(debounce.current)
  }, [])
  useEffect(() => {
    const releaseFocusOwnership = (event: FocusEvent | PointerEvent) => {
      const target = event.target
      if (target === filterTriggerRef.current) return
      if (event.type === "focusin" && target === document.body) return
      filterTriggerOwnsFocusRef.current = false
    }
    document.addEventListener("focusin", releaseFocusOwnership)
    document.addEventListener("pointerdown", releaseFocusOwnership, true)
    return () => {
      document.removeEventListener("focusin", releaseFocusOwnership)
      document.removeEventListener("pointerdown", releaseFocusOwnership, true)
    }
  }, [])
  useEffect(() => {
    const previousMobile = wasMobileRef.current
    const crossed = previousMobile !== mobile
    wasMobileRef.current = mobile
    if (!crossed) return
    const crossedToDesktopWithSheet = previousMobile && !mobile && mobileOpen
    if (crossedToDesktopWithSheet) {
      setMobileOpen(false)
    }
    const shouldTransfer = crossedToDesktopWithSheet || filterTriggerOwnsFocusRef.current
    if (!shouldTransfer) return
    queueMicrotask(() => filterTriggerRef.current?.focus())
  }, [mobile, mobileOpen])

  const ownFilterTriggerFocus = () => {
    filterTriggerOwnsFocusRef.current = true
  }

  const setSearch = (value: string) => {
    setQ(value)
    cancelPendingSearch()
    debounce.current = window.setTimeout(() => {
      debounce.current = null
      const normalized = value.trim() || undefined
      if (searchChangeRef.current) searchChangeRef.current(normalized)
      else onChange({ ...filtersRef.current, q: normalized })
    }, 250)
  }

  const changeFilters = (next: TodoFilters) => {
    cancelPendingSearch()
    onChange({ ...next, q: q.trim() || undefined })
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
            placeholder="Search todos"
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
        </label>

        {mobile ? (
          <button
            ref={filterTriggerRef}
            type="button"
            aria-label="Filter todos"
            onClick={() => setMobileOpen(true)}
            onFocus={ownFilterTriggerFocus}
            className={`inline-flex min-h-11 flex-none items-center gap-2 rounded-[14px] px-3.5 text-[length:var(--text-subheadline)] font-medium transition-[background-color,color,transform] active:scale-[0.96] ${
              active > 0
                ? "bg-[var(--accent-fill)] text-[var(--accent)]"
                : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
            }`}
          >
            <Filter size={16} strokeWidth={1.9} aria-hidden />
            <span className="max-[420px]:sr-only">Filter</span>
            {active > 0 && <span className="tabular-nums">{active}</span>}
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={filterTriggerRef}
                type="button"
                aria-label="Filter todos"
                onFocus={ownFilterTriggerFocus}
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
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, status: option.value })}>
                    {option.label}<MenuCheck on={filters.status === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Person</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, assignee: undefined })}>
                  Anyone<MenuCheck on={!filters.assignee} />
                </DropdownMenuItem>
                {employees.map((employee) => (
                  <DropdownMenuItem key={employee.name} className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, assignee: employee.name })}>
                    <EmployeeAvatar name={employee.name} size={20} fontSize={10} className="bg-[var(--fill-secondary)]" />
                    {employee.displayName}<MenuCheck on={filters.assignee === employee.name} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Department</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, department: undefined })}>
                  Any department<MenuCheck on={!filters.department} />
                </DropdownMenuItem>
                {departments.map((department) => (
                  <DropdownMenuItem key={department} className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, department })}>
                    {department.charAt(0).toUpperCase() + department.slice(1)}<MenuCheck on={filters.department === department} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Source</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, source: undefined })}>
                  Any source<MenuCheck on={!filters.source} />
                </DropdownMenuItem>
                {SOURCE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, source: option.value })}>
                    {option.label}<MenuCheck on={filters.source === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Date</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                {DATE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.label} className={ITEM_CLASS} onClick={() => changeFilters({ ...filters, date: option.value })}>
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
              <DropdownMenuItem className={`${ITEM_CLASS} mt-1 text-[var(--text-secondary)]`} onClick={() => changeFilters({ status: "open" })}>
                Clear all filters
              </DropdownMenuItem>
            )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {active > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Active filters">
          {statusLabel && <ActiveChip label={`Status: ${statusLabel}`} onRemove={() => changeFilters({ ...filters, status: "open" })} />}
          {personName && <ActiveChip label={`Person: ${personName}`} onRemove={() => changeFilters({ ...filters, assignee: undefined })} />}
          {filters.department && (
            <ActiveChip
              label={`Department: ${filters.department.charAt(0).toUpperCase() + filters.department.slice(1)}`}
              onRemove={() => changeFilters({ ...filters, department: undefined })}
            />
          )}
          {sourceLabel && <ActiveChip label={`Source: ${sourceLabel}`} onRemove={() => changeFilters({ ...filters, source: undefined })} />}
          {filters.date && dateLabel && <ActiveChip label={`Date: ${dateLabel}`} onRemove={() => changeFilters({ ...filters, date: undefined })} />}
        </div>
      )}

      {mobile && mobileOpen && (
        <TodoFilterSheet
          filters={filters}
          onChange={changeFilters}
          employees={employees}
          departments={departments}
          byName={byName}
          onPeopleView={onPeopleView}
          onClose={() => setMobileOpen(false)}
        />
      )}
    </div>
  )
}
