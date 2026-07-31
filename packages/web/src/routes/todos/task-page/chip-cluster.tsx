import type { Employee, WorkItemDetailWire } from "@/lib/api"
import { STATUS_LABEL, priorityLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { displayNameOf } from "../util"
import { RailPriorityBars } from "./props-rail"
import type { PickerKey } from "./use-task-pickers"

/* Variant A — the task's working identity lives directly under its title.
 * Desktop uses the approved 28px chips; mobile keeps every interactive target
 * at 34px. Less-frequent properties remain in the folded Details document. */

function Chip({
  onOpen,
  children,
  testId,
  label,
  mobile,
}: {
  onOpen: () => void
  children: React.ReactNode
  testId?: string
  label: string
  mobile: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
      className={`focus-ring flex flex-none items-center gap-[7px] bg-[var(--fill-tertiary)] font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-secondary)] ${
        mobile
          ? "h-[34px] rounded-[17px] px-3 text-[13.5px]"
          : "h-7 rounded-[14px] px-[11px] text-[12.5px]"
      }`}
    >
      {children}
    </button>
  )
}

export function ChipCluster({
  detail,
  byName,
  onOpenPicker,
  mobile,
  working,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  onOpenPicker: (key: PickerKey) => void
  mobile: boolean
  working?: string | null
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  return (
    <div
      data-testid="task-chip-cluster"
      className="mt-3 flex min-h-7 flex-wrap gap-2 max-[700px]:min-h-[34px] max-[700px]:flex-nowrap max-[700px]:overflow-x-auto"
    >
      <Chip mobile={mobile} label="Status" testId="chip-status" onOpen={() => onOpenPicker("status")}>
        <StatusCircle status={item.status} size={16} />
        {STATUS_LABEL[item.status]}
        {working && (
          <span className="flex items-center gap-1.5 text-[var(--system-blue)]" data-testid="chip-working">
            <span
              className="size-1.5 rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
              aria-hidden
            />
            Working · {working}
          </span>
        )}
      </Chip>
      <Chip mobile={mobile} label="Assignee" testId="chip-assignee" onOpen={() => onOpenPicker("assignee")}>
        {item.assignee ? (
          <>
            <EmployeeAvatar name={item.assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
            {displayNameOf(item.assignee, byName)}
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">Unassigned</span>
        )}
      </Chip>
      <Chip mobile={mobile} label="Priority" testId="chip-priority" onOpen={() => onOpenPicker("priority")}>
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </Chip>
      {labels.length > 0 && (
        <Chip mobile={mobile} label="Labels" testId="chip-labels" onOpen={() => onOpenPicker("labels")}>
          {labels.map((label) => (
            <span key={label.id} className="flex items-center gap-1">
              <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
              {label.name}
            </span>
          ))}
        </Chip>
      )}
    </div>
  )
}
