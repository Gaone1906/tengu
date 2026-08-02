import { forwardRef } from "react"
import { ArrowUpRight, Calendar, ChevronDown, LoaderCircle, Send, UserRound } from "lucide-react"
import type { DepartmentSummaryWire, Employee, LinkedSessionWire, WorkItemDetailWire, WorkItemLabelWire } from "@/lib/api"
import { STATUS_LABEL, effectiveMaxRounds, effectiveVerifyMode, priorityLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { displayNameOf, formatRelativeTime } from "../util"

/* Todos v2 slice 6 — the chrome-free properties rail (design-doc §7.2/§7.3,
 * mock task-detail.html). No inset boxes: quiet rows on the page surface, the
 * whitespace is the design. Rows are flat at rest; interactive rows wash on
 * hover and grow a trailing chevron (120ms) — the whole row is the click
 * target, and while its popover is open the row keeps the wash (anchored
 * state, polish law 1). Rail rhythm: top pad 8, group gap 32 (law 10). */

export function RailKicker({ children, later }: { children: React.ReactNode; later?: boolean }) {
  return <div className={`mb-1 text-[13px] font-semibold text-[var(--text-tertiary)] ${later ? "mt-8" : ""}`}>{children}</div>
}

/** One rail row. Interactive rows are buttons (tabbable, Enter/Space opens);
 *  read-only rows render without the hover affordance (§7.3). The open state
 *  keeps the wash + chevron while a picker superimposes the row. */
export const RailRow = forwardRef<HTMLButtonElement, {
  children: React.ReactNode
  quiet?: boolean
  onOpen?: () => void
  open?: boolean
  testId?: string
  label?: string
}>(function RailRow({ children, quiet, onOpen, open, testId, label }, ref) {
  const base = "relative -mx-2.5 flex min-h-[34px] items-center gap-[9px] rounded-[9px] px-2.5 text-[13.5px] font-medium"
  const ink = quiet ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"
  if (!onOpen) {
    return (
      <div data-testid={testId} className={`${base} ${ink} cursor-default`}>
        {children}
      </div>
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open || false}
      onClick={onOpen}
      className={`${base} ${ink} focus-ring group/rail w-[calc(100%+20px)] text-left outline-none hover:bg-[var(--fill-quaternary)] ${
        open ? "bg-[var(--fill-quaternary)]" : ""
      }`}
    >
      {children}
      <ChevronDown
        size={11}
        strokeWidth={2.2}
        aria-hidden
        className={`ml-auto flex-none text-[var(--text-quaternary)] transition-opacity duration-120 ${
          open ? "opacity-100" : "opacity-0 group-hover/rail:opacity-100"
        }`}
      />
    </button>
  )
})

/** Rail priority bars: always rendered (unlike cards), emphasis by level. */
export function RailPriorityBars({ priority }: { priority: number }) {
  const strong = priority >= 3
  const low = priority <= 1
  const color = strong ? "var(--text-secondary)" : "var(--text-tertiary)"
  return (
    <span aria-hidden className="relative top-[-0.5px] flex w-4 flex-none items-end gap-[1.5px]" style={{ height: 10 }}>
      {[4, 7, 10].map((h, i) => (
        <i key={h} className="block w-[2.5px] rounded-[1px]" style={{ height: h, background: color, opacity: low && i > 0 ? 0.35 : 1 }} />
      ))}
    </span>
  )
}

export function LabelChip({ label, onRemove }: { label: WorkItemLabelWire; onRemove?: () => void }) {
  return (
    <span className="flex h-[22px] items-center gap-[5px] rounded-[11px] bg-[var(--fill-tertiary)] px-[9px] text-[11.5px] font-medium text-[var(--text-secondary)]">
      <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
      {label.name}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove label ${label.name}`}
          onClick={onRemove}
          className="focus-ring -mr-1 grid size-4 place-items-center rounded-full text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)]"
        >
          ×
        </button>
      )}
    </span>
  )
}

export function VerifyPill({ mode }: { mode: string }) {
  const tint = mode === "thorough" ? "var(--system-red)" : "var(--system-purple)"
  return (
    <span
      className="flex h-5 items-center rounded-[10px] px-2 text-[10.5px] font-semibold tracking-[.06em]"
      style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint }}
    >
      {mode.toUpperCase()}
    </span>
  )
}

export function formatDueLong(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export interface RailPickers {
  /** Task 6 mounts the picker surfaces here, keyed by row. Absent = read row. */
  status?: React.ReactNode
  rowFor?: (row: "status" | "priority" | "assignee" | "labels" | "department" | "due" | "verify") => {
    onOpen: () => void
    open: boolean
    picker: React.ReactNode
  } | undefined
}

export function PropsRail({
  detail,
  byName,
  departments,
  rowFor,
  dispatcherSession,
  dispatchPending,
  onDispatch,
  onOpenDispatcherSession,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  departments: DepartmentSummaryWire[] | undefined
  rowFor?: RailPickers["rowFor"]
  dispatcherSession?: LinkedSessionWire
  dispatchPending?: boolean
  onDispatch?: () => void
  onOpenDispatcherSession?: (sessionId: string) => void
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  const mode = effectiveVerifyMode(item)
  const dept = item.department ? departments?.find((d) => d.slug === item.department) : undefined
  const deptTitle = item.department ? item.department.charAt(0).toUpperCase() + item.department.slice(1) : "No department"
  const createdByLabel = !item.createdBy || item.createdBy === "operator" ? "You" : displayNameOf(item.createdBy, byName)
  const overdue = !!item.dueAt && Date.parse(item.dueAt) < Date.now()

  const pick = (row: Parameters<NonNullable<RailPickers["rowFor"]>>[0]) => rowFor?.(row)

  const statusPick = pick("status")
  const prioPick = pick("priority")
  const assigneePick = pick("assignee")
  const labelsPick = pick("labels")
  const deptPick = pick("department")
  const duePick = pick("due")
  const verifyPick = pick("verify")

  return (
    <aside data-testid="task-props-rail" className="relative pt-2">
      <RailKicker>Properties</RailKicker>
      <div className="relative">
        <RailRow testId="rail-status" label="Status" onOpen={statusPick?.onOpen} open={statusPick?.open}>
          <StatusCircle status={item.status} size={18} />
          {STATUS_LABEL[item.status]}
        </RailRow>
        {statusPick?.picker}
      </div>
      <div className="relative">
        <RailRow testId="rail-priority" label="Priority" onOpen={prioPick?.onOpen} open={prioPick?.open}>
          <RailPriorityBars priority={item.priority} />
          {priorityLabel(item.priority)}
        </RailRow>
        {prioPick?.picker}
      </div>
      <div className="relative">
        <RailRow testId="rail-assignee" label="Assignee" onOpen={assigneePick?.onOpen} open={assigneePick?.open}>
          {item.assignee ? (
            <>
              <EmployeeAvatar name={item.assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
              {displayNameOf(item.assignee, byName)}
            </>
          ) : (
            <>
              <span className="grid size-5 flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-quaternary)]">
                <UserRound size={11} aria-hidden />
              </span>
              <span className="text-[var(--text-tertiary)]">Unassigned</span>
            </>
          )}
        </RailRow>
        {assigneePick?.picker}
      </div>
      {dispatcherSession ? (
        <button
          type="button"
          data-testid="rail-dispatch-session"
          data-session-id={dispatcherSession.id}
          onClick={() => onOpenDispatcherSession?.(dispatcherSession.id)}
          className="focus-ring group/dispatch relative -mx-2.5 flex min-h-[34px] w-[calc(100%+20px)] items-center gap-[9px] rounded-[9px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-primary)] outline-none hover:bg-[var(--fill-quaternary)]"
        >
          <span className="size-1.5 flex-none rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]" aria-hidden />
          Dispatcher working
          <ArrowUpRight size={12} aria-hidden className="ml-auto text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover/dispatch:opacity-100" />
        </button>
      ) : (
        <button
          type="button"
          data-testid="rail-dispatch"
          disabled={dispatchPending}
          onClick={onDispatch}
          className="focus-ring relative -mx-2.5 flex min-h-[34px] w-[calc(100%+20px)] items-center gap-[9px] rounded-[9px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-primary)] outline-none hover:bg-[var(--fill-quaternary)] disabled:cursor-wait disabled:text-[var(--text-tertiary)]"
        >
          {dispatchPending ? <LoaderCircle size={14} aria-hidden className="animate-spin text-[var(--text-tertiary)]" /> : <Send size={14} aria-hidden className="text-[var(--text-tertiary)]" />}
          {dispatchPending ? "Starting Dispatcher…" : "Dispatch"}
        </button>
      )}

      <RailKicker later>Labels</RailKicker>
      <div className="relative">
        <div className="flex flex-wrap gap-1.5 pt-1" data-testid="rail-labels">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {labelsPick && (
            <button
              type="button"
              data-testid="rail-labels-add"
              aria-label="Edit labels"
              onClick={labelsPick.onOpen}
              className="focus-ring flex h-[22px] items-center rounded-[11px] bg-[var(--fill-tertiary)] px-[9px] text-[11.5px] font-medium text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)]"
            >
              +
            </button>
          )}
        </div>
        {labelsPick?.picker}
      </div>

      <RailKicker later>Details</RailKicker>
      <div className="relative">
        <RailRow quiet testId="rail-department" label="Department" onOpen={deptPick?.onOpen} open={deptPick?.open}>
          <span
            className="w-4 text-center text-[11px] font-normal text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
          >
            {dept?.prefix ?? "—"}
          </span>
          {deptTitle}
        </RailRow>
        {deptPick?.picker}
      </div>
      <div className="relative">
        <RailRow quiet testId="rail-due" label="Due date" onOpen={duePick?.onOpen} open={duePick?.open}>
          <Calendar size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
          {item.dueAt ? (
            <span className={overdue ? "text-[var(--system-red)]" : undefined}>Due {formatDueLong(item.dueAt)}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">No due date</span>
          )}
        </RailRow>
        {duePick?.picker}
      </div>
      <RailRow quiet testId="rail-created-by">
        <UserRound size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
        {createdByLabel}
        <span className="text-[12px] font-normal text-[var(--text-quaternary)]">· created {formatRelativeTime(item.createdAt)}</span>
      </RailRow>
      <div className="relative">
        <RailRow testId="rail-verify" label="Review policy" onOpen={verifyPick?.onOpen} open={verifyPick?.open}>
          <VerifyPill mode={mode} />
          <span className="text-[12px] font-normal text-[var(--text-quaternary)]">
            Round {item.rounds} of {effectiveMaxRounds(item)}
          </span>
        </RailRow>
        {verifyPick?.picker}
      </div>
      <RailRow quiet testId="rail-spend">
        <span className="text-[11px] font-normal text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          ${detail.spendUsd.toFixed(2)}
        </span>
        {item.budgetUsd != null && item.budgetUsd > 0 && (
          <>
            <span className="h-[3px] w-14 overflow-hidden rounded-[2px] bg-[var(--fill-secondary)]" aria-hidden>
              <span
                className="block h-full rounded-[2px] bg-[var(--accent)]"
                style={{ width: `${Math.min(100, Math.round((detail.spendUsd / item.budgetUsd) * 100))}%` }}
              />
            </span>
            <span className="text-[11px] font-normal text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
              ${item.budgetUsd % 1 === 0 ? item.budgetUsd.toFixed(0) : item.budgetUsd.toFixed(2)}
            </span>
          </>
        )}
      </RailRow>
    </aside>
  )
}
