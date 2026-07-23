import { Calendar } from "lucide-react"
import type { DepartmentSummaryWire, Employee, WorkItemDetailWire } from "@/lib/api"
import { STATUS_LABEL, effectiveMaxRounds, effectiveVerifyMode, priorityLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { displayNameOf } from "../util"
import { RailPriorityBars, VerifyPill, formatDueLong } from "./props-rail"
import type { PickerKey } from "./use-task-pickers"

/* Todos v2 slice 6 — the mobile property chip cluster (design-doc §8, mock
 * task-detail.html): a --fill-quaternary rounded-XL group of wrapping 34px
 * chips directly under the title. Every chip opens the same picker as its rail
 * row, as a bottom sheet (§7.3). */

function Chip({
  onOpen,
  children,
  testId,
  label,
  ghost,
}: {
  onOpen: () => void
  children: React.ReactNode
  testId?: string
  label: string
  ghost?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
      className={`focus-ring flex h-[34px] items-center gap-[7px] rounded-[17px] px-3 text-[13.5px] font-medium outline-none ${
        ghost
          ? "text-[var(--text-quaternary)]"
          : "bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-ambient),var(--shadow-subtle)]"
      }`}
    >
      {children}
    </button>
  )
}

export function ChipCluster({
  detail,
  byName,
  departments,
  onOpenPicker,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  departments: DepartmentSummaryWire[] | undefined
  onOpenPicker: (key: PickerKey) => void
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  const dept = item.department ? departments?.find((d) => d.slug === item.department) : undefined
  return (
    <div
      data-testid="task-chip-cluster"
      className="mt-4 flex flex-wrap gap-2 rounded-[var(--radius-xl)] bg-[var(--fill-quaternary)] p-3"
    >
      <Chip label="Status" testId="chip-status" onOpen={() => onOpenPicker("status")}>
        <StatusCircle status={item.status} size={18} />
        {STATUS_LABEL[item.status]}
      </Chip>
      <Chip label="Priority" testId="chip-priority" onOpen={() => onOpenPicker("priority")}>
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </Chip>
      <Chip label="Assignee" testId="chip-assignee" onOpen={() => onOpenPicker("assignee")}>
        {item.assignee ? (
          <>
            <EmployeeAvatar name={item.assignee} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
            {displayNameOf(item.assignee, byName)}
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">Unassigned</span>
        )}
      </Chip>
      {labels.length > 0 && (
        <Chip label="Labels" testId="chip-labels" onOpen={() => onOpenPicker("labels")}>
          {labels.map((label) => (
            <span key={label.id} className="flex items-center gap-1">
              <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
              {label.name}
            </span>
          ))}
        </Chip>
      )}
      <Chip label="Department" testId="chip-department" onOpen={() => onOpenPicker("department")}>
        <span className="text-[11px] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}>
          {dept?.prefix ?? "—"}
        </span>
        {item.department ? item.department.charAt(0).toUpperCase() + item.department.slice(1) : "No department"}
      </Chip>
      <Chip label="Due date" testId="chip-due" onOpen={() => onOpenPicker("due")}>
        <Calendar size={13} strokeWidth={2} aria-hidden className="text-[var(--text-quaternary)]" />
        {item.dueAt ? formatDueLong(item.dueAt) : "Due"}
      </Chip>
      <Chip label="Review policy" testId="chip-verify" onOpen={() => onOpenPicker("verify")}>
        <VerifyPill mode={effectiveVerifyMode(item)} />
        <span className="text-[11px] text-[var(--text-quaternary)]">
          {item.rounds}/{effectiveMaxRounds(item)}
        </span>
      </Chip>
      {(detail.spendUsd > 0 || (item.budgetUsd ?? 0) > 0) && (
        <span className="flex h-[34px] items-center rounded-[17px] bg-[var(--bg-secondary)] px-3 shadow-[var(--shadow-ambient),var(--shadow-subtle)]">
          <span className="text-[11px] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
            ${detail.spendUsd.toFixed(2)}
            {item.budgetUsd != null && item.budgetUsd > 0 ? ` / $${item.budgetUsd % 1 === 0 ? item.budgetUsd.toFixed(0) : item.budgetUsd.toFixed(2)}` : ""}
          </span>
        </span>
      )}
      {labels.length === 0 && (
        <Chip label="Add labels" testId="chip-add" ghost onOpen={() => onOpenPicker("labels")}>
          +
        </Chip>
      )}
    </div>
  )
}
