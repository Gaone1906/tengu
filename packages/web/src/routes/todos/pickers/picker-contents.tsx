import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Minus, Plus, UserRound } from "lucide-react"
import {
  api,
  type DepartmentSummaryWire,
  type Employee,
  type VerifyModeWire,
  type WorkItemDetailWire,
  type WorkItemLabelWire,
  type WorkItemStatusWire,
} from "@/lib/api"
import { STATUS_LABEL, effectiveMaxRounds, effectiveVerifyMode, priorityLabel } from "@/lib/todos"
import { legalTargets } from "@/lib/legal-targets"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { RailPriorityBars, VerifyPill } from "../task-page/props-rail"
import { PickerNote, PickerRow } from "./picker-shell"

/* Todos v2 slice 6 — the picker CONTENTS (design-doc §7.3): one component per
 * property, rendered by either shell (popover desktop / bottom sheet mobile).
 * The status picker consumes the same legalTargets() module as board drag —
 * one legality truth, no client carve-outs. Selection commits optimistically;
 * a server refusal snaps back with the gateway's words (the page's callout). */

export interface PickerContentProps {
  detail: WorkItemDetailWire
  sheet?: boolean
  onDone: () => void
}

const ALL_STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled",
]

/** The design's presentation order (§7.3 + the popover mock): pipeline first,
 *  then Done, then the exception/closed states — regardless of legalTargets()
 *  enumeration order. Mockup wins (stage-B review F2). */
const STATUS_DISPLAY_ORDER: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled",
]

export function StatusPickerContent({
  detail,
  openChildren,
  commit,
  sheet,
  onDone,
}: PickerContentProps & { openChildren: number; commit: (status: WorkItemStatusWire) => void }) {
  const from = detail.workItem.status
  const targets = legalTargets(from, { openChildren })
    .filter((t) => t.status !== from)
    .sort((a, b) => STATUS_DISPLAY_ORDER.indexOf(a.status) - STATUS_DISPLAY_ORDER.indexOf(b.status))
  const offered = new Set<WorkItemStatusWire>([from, ...targets.map((t) => t.status)])
  const omitted = ALL_STATUSES.filter((s) => !offered.has(s))
  return (
    <>
      <PickerRow
        sheet={sheet}
        glyph={<StatusCircle status={from} size={18} />}
        label={STATUS_LABEL[from]}
        checked
        onSelect={onDone}
        testId={`status-option-${from}`}
      />
      {targets.map((target) => (
        <PickerRow
          key={target.status}
          sheet={sheet}
          glyph={<StatusCircle status={target.status} size={18} />}
          label={STATUS_LABEL[target.status]}
          disabled={target.gated}
          reason={target.reason}
          onSelect={() => {
            commit(target.status)
            onDone()
          }}
          testId={`status-option-${target.status}`}
        />
      ))}
      {omitted.length > 0 && (
        <PickerNote>
          Only legal moves are listed — {omitted.map((s) => STATUS_LABEL[s]).join(" and ")}{" "}
          {omitted.length === 1 ? "isn't" : "aren't"} reachable from {STATUS_LABEL[from]}.
        </PickerNote>
      )}
    </>
  )
}

const PRIORITIES = [3, 2, 1, 0] as const

export function PriorityPickerContent({
  detail,
  commit,
  sheet,
  onDone,
}: PickerContentProps & { commit: (priority: number) => void }) {
  const current = detail.workItem.priority
  return (
    <>
      {PRIORITIES.map((priority) => (
        <PickerRow
          key={priority}
          sheet={sheet}
          glyph={<RailPriorityBars priority={priority} />}
          label={priorityLabel(priority)}
          checked={current === priority}
          onSelect={() => {
            if (priority !== current) commit(priority)
            onDone()
          }}
          testId={`priority-option-${priority}`}
        />
      ))}
    </>
  )
}

export function AssigneePickerContent({
  detail,
  employees,
  commit,
  sheet,
  onDone,
}: PickerContentProps & { employees: Employee[]; commit: (assignee: string | null) => void }) {
  const [query, setQuery] = useState("")
  const current = detail.workItem.assignee
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(
      (e) => e.name.toLowerCase().includes(q) || e.displayName.toLowerCase().includes(q),
    )
  }, [employees, query])
  return (
    <>
      <div className="px-1 pb-1.5 pt-0.5">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          data-testid="assignee-search"
          className="w-full rounded-full bg-[var(--fill-tertiary)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
        />
      </div>
      <div className={sheet ? "" : "max-h-[288px] overflow-y-auto"}>
        {filtered.map((employee) => (
          <PickerRow
            key={employee.name}
            sheet={sheet}
            glyph={<EmployeeAvatar name={employee.name} size={22} fontSize={12} className="bg-[var(--fill-secondary)]" />}
            label={employee.displayName}
            sub={employee.department ? employee.department.charAt(0).toUpperCase() + employee.department.slice(1) : undefined}
            checked={current === employee.name}
            onSelect={() => {
              if (current !== employee.name) commit(employee.name)
              onDone()
            }}
            testId={`assignee-option-${employee.name}`}
          />
        ))}
        {filtered.length === 0 && <PickerNote>Nobody matches "{query.trim()}".</PickerNote>}
      </div>
      <PickerRow
        sheet={sheet}
        glyph={
          <span className="grid size-[22px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-quaternary)]">
            <UserRound size={12} aria-hidden />
          </span>
        }
        label={<span className="text-[var(--text-tertiary)]">Unassign</span>}
        checked={current === null}
        onSelect={() => {
          if (current !== null) commit(null)
          onDone()
        }}
        testId="assignee-option-unassign"
      />
    </>
  )
}

export function LabelsPickerContent({
  detail,
  commit,
  sheet,
}: PickerContentProps & { commit: (labelIds: string[]) => void }) {
  const registry = useQuery({
    queryKey: ["labels"],
    queryFn: async (): Promise<WorkItemLabelWire[]> => (await api.listLabels()).labels,
    staleTime: 60_000,
  })
  const selected = new Set((detail.labels ?? []).map((label) => label.id))
  const toggle = (label: WorkItemLabelWire) => {
    const next = new Set(selected)
    if (next.has(label.id)) next.delete(label.id)
    else next.add(label.id)
    commit([...next])
  }
  const labels = registry.data ?? []
  return (
    <>
      {labels.map((label) => (
        <PickerRow
          key={label.id}
          sheet={sheet}
          glyph={<span className="mx-1 size-[5px] flex-none rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />}
          label={label.name}
          sub={label.department ?? undefined}
          checked={selected.has(label.id)}
          onSelect={() => toggle(label)}
          testId={`label-option-${label.id}`}
        />
      ))}
      {labels.length === 0 && !registry.isLoading && (
        <PickerNote>No labels yet — labels are created by the operator or a manager.</PickerNote>
      )}
    </>
  )
}

function monthDays(year: number, month: number): Array<number | null> {
  const first = new Date(Date.UTC(year, month, 1))
  const lead = (first.getUTCDay() + 6) % 7 // Monday-first grid
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, i) => i + 1)]
}

export function DuePickerContent({
  detail,
  commit,
  sheet,
  onDone,
}: PickerContentProps & { commit: (dueAt: string | null) => void }) {
  const current = detail.workItem.dueAt ? new Date(detail.workItem.dueAt) : null
  const [view, setView] = useState(() => {
    const base = current ?? new Date()
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() }
  })
  const days = monthDays(view.year, view.month)
  const monthLabel = new Date(Date.UTC(view.year, view.month, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
  const isCurrent = (day: number) =>
    !!current &&
    current.getUTCFullYear() === view.year &&
    current.getUTCMonth() === view.month &&
    current.getUTCDate() === day
  const move = (delta: number) =>
    setView(({ year, month }) => {
      const next = new Date(Date.UTC(year, month + delta, 1))
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() }
    })
  return (
    <div className="px-1" data-testid="due-picker">
      <div className="flex items-center justify-between px-1.5 py-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => move(-1)}
          className="focus-ring grid size-7 place-items-center rounded-lg text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)]"
        >
          <ChevronLeft size={13} aria-hidden />
        </button>
        <span className="text-[12.5px] font-semibold text-[var(--text-secondary)]">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => move(1)}
          className="focus-ring grid size-7 place-items-center rounded-lg text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)]"
        >
          <ChevronRight size={13} aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px px-0.5 pb-1 text-center text-[10px] text-[var(--text-quaternary)]">
        {["M", "T", "W", "T2", "F", "S", "S2"].map((d) => (
          <span key={d}>{d.charAt(0)}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px px-0.5 pb-1">
        {days.map((day, i) =>
          day === null ? (
            <span key={`pad-${i}`} />
          ) : (
            <button
              key={day}
              type="button"
              data-testid={`due-day-${day}`}
              onClick={() => {
                commit(new Date(Date.UTC(view.year, view.month, day, 12)).toISOString())
                onDone()
              }}
              className={`grid ${sheet ? "h-10" : "h-8"} place-items-center rounded-lg text-[12.5px] tabular-nums outline-none focus-visible:bg-[var(--fill-tertiary)] ${
                isCurrent(day)
                  ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
              }`}
            >
              {day}
            </button>
          ),
        )}
      </div>
      {detail.workItem.dueAt && (
        <PickerRow
          sheet={sheet}
          label={<span className="text-[var(--text-tertiary)]">Clear due date</span>}
          onSelect={() => {
            commit(null)
            onDone()
          }}
          testId="due-clear"
        />
      )}
    </div>
  )
}

export function DepartmentPickerContent({
  detail,
  departments,
  commit,
  sheet,
  onDone,
}: PickerContentProps & { departments: DepartmentSummaryWire[]; commit: (department: string | null) => void }) {
  const current = detail.workItem.department
  return (
    <>
      {departments.map((dept) => (
        <PickerRow
          key={dept.slug}
          sheet={sheet}
          glyph={
            <span
              className="w-5 flex-none text-center text-[11px] text-[var(--text-quaternary)]"
              style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
            >
              {dept.prefix}
            </span>
          }
          label={dept.slug.charAt(0).toUpperCase() + dept.slug.slice(1)}
          checked={current === dept.slug}
          onSelect={() => {
            if (current !== dept.slug) commit(dept.slug)
            onDone()
          }}
          testId={`department-option-${dept.slug}`}
        />
      ))}
      <PickerRow
        sheet={sheet}
        label={<span className="text-[var(--text-tertiary)]">No department</span>}
        checked={current === null}
        onSelect={() => {
          if (current !== null) commit(null)
          onDone()
        }}
        testId="department-option-none"
      />
      <PickerNote>Moving departments never changes the ID — it keeps its birth prefix.</PickerNote>
    </>
  )
}

const VERIFY_MODES: readonly VerifyModeWire[] = ["trust", "verify", "thorough"]

export function VerifyPickerContent({
  detail,
  commit,
  sheet,
}: PickerContentProps & { commit: (policy: { mode: VerifyModeWire; maxRounds: number } | null) => void }) {
  const item = detail.workItem
  const mode = effectiveVerifyMode(item)
  const maxRounds = effectiveMaxRounds(item)
  const explicit = item.verifyPolicy !== null
  return (
    <>
      {VERIFY_MODES.map((option) => (
        <PickerRow
          key={option}
          sheet={sheet}
          glyph={<VerifyPill mode={option} />}
          label={<span className="sr-only">{option}</span>}
          checked={explicit && mode === option}
          onSelect={() => commit({ mode: option, maxRounds })}
          testId={`verify-option-${option}`}
        />
      ))}
      <div className="flex items-center gap-2.5 px-2.5 py-1.5">
        <span className="text-[12px] text-[var(--text-tertiary)]">Rounds</span>
        <button
          type="button"
          aria-label="Fewer rounds"
          data-testid="verify-rounds-down"
          disabled={maxRounds <= 1}
          onClick={() => commit({ mode, maxRounds: maxRounds - 1 })}
          className="focus-ring grid size-6 place-items-center rounded-lg bg-[var(--fill-tertiary)] text-[var(--text-secondary)] outline-none disabled:opacity-40"
        >
          <Minus size={11} aria-hidden />
        </button>
        <span className="text-[12.5px] font-semibold tabular-nums text-[var(--text-primary)]" data-testid="verify-rounds">
          {maxRounds}
        </span>
        <button
          type="button"
          aria-label="More rounds"
          data-testid="verify-rounds-up"
          disabled={maxRounds >= 20}
          onClick={() => commit({ mode, maxRounds: maxRounds + 1 })}
          className="focus-ring grid size-6 place-items-center rounded-lg bg-[var(--fill-tertiary)] text-[var(--text-secondary)] outline-none disabled:opacity-40"
        >
          <Plus size={11} aria-hidden />
        </button>
      </div>
      {explicit && (
        <PickerRow
          sheet={sheet}
          label={<span className="text-[var(--text-tertiary)]">Use the provenance default</span>}
          onSelect={() => commit(null)}
          testId="verify-clear"
        />
      )}
      <PickerNote>Review policy is the operator's knob — how this Todo's work gets verified.</PickerNote>
    </>
  )
}
