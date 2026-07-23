import { useState } from "react"
import { ArrowUpRight, Plus, UserRound } from "lucide-react"
import type { Employee, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import { STATUS_LABEL, stateKeyOf } from "@/lib/todos"
import { legalTargets } from "@/lib/legal-targets"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateCircle, StatusCircle } from "../state-glyph"
import { PickerPopover, PickerRow } from "../pickers/picker-shell"
import { AssigneePickerContent } from "../pickers/picker-contents"

/* Todos v2 slice 6 — the task page's sub-tasks section (design-doc §7.2.8,
 * mock task-detail.html): kicker with "N of M done", 3px green progress, rows
 * clean at rest that GROW quick actions on hover (round-2 redline) — the disc
 * gains a 3px halo and opens the legal-states popover FOR THAT CHILD, and two
 * 26px icon buttons fade in (assign, open). Touch: actions always visible.
 * Depth cap: the add row simply doesn't exist at depth 3. */

const DEPTH_CAP = 3

/** Closed/total over ALL descendants (self excluded) — the roll-up numbers. */
function subtreeCounts(node: WorkItemTreeNodeWire | undefined): { total: number; done: number } {
  let total = 0
  let done = 0
  const walk = (children: WorkItemTreeNodeWire[]) => {
    for (const child of children) {
      total += 1
      if (child.status === "done" || child.status === "cancelled") done += 1
      walk(child.children ?? [])
    }
  }
  walk(node?.children ?? [])
  return { total, done }
}

export function SubTasksSection({
  node,
  parentDepth,
  employees,
  byName,
  mobile,
  onOpenChild,
  onChildStatus,
  onChildAssign,
  onAddSubTask,
}: {
  node: WorkItemTreeNodeWire | undefined
  parentDepth: number
  employees: Employee[]
  byName: Map<string, Employee>
  mobile: boolean
  onOpenChild: (id: string) => void
  onChildStatus: (childId: string, status: WorkItemStatusWire) => void
  onChildAssign: (childId: string, assignee: string) => void
  onAddSubTask: (title: string) => void
}) {
  const children = node?.children ?? []
  // Counts cover the whole SUBTREE (the board's 2/5 roll-up counts descendants
  // too); the rows list direct children — deeper levels wear "N sub" badges.
  const { total, done } = subtreeCounts(node)
  const atCap = parentDepth >= DEPTH_CAP
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")
  const [openFor, setOpenFor] = useState<{ id: string; kind: "status" | "assign" } | null>(null)

  if (children.length === 0 && atCap) return null

  const submit = () => {
    const text = title.trim()
    setTitle("")
    setAdding(false)
    if (text) onAddSubTask(text)
  }

  return (
    <section data-testid="task-subtasks">
      <div
        className="mb-3 mt-8 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        Sub-tasks
        {children.length > 0 && (
          <span className="text-[11px] font-normal normal-case tracking-[.02em] text-[var(--text-quaternary)]">
            {done} of {total} done
          </span>
        )}
      </div>

      {children.length > 0 ? (
        <>
          <div className="mb-2 flex items-center gap-2.5">
            <span className="h-[3px] w-full max-w-[220px] overflow-hidden rounded-[2px] bg-[var(--fill-secondary)]" aria-hidden>
              <span
                className="block h-full rounded-[2px] bg-[var(--system-green)] transition-[width] duration-300"
                style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
                data-testid="subtasks-progress"
              />
            </span>
          </div>
          <div>
            {children.map((child) => {
              const closed = child.status === "done" || child.status === "cancelled"
              const kids = (child.children ?? []).length
              const openKids = (child.children ?? []).filter((c) => c.status !== "done" && c.status !== "cancelled").length
              const picking = openFor?.id === child.id ? openFor.kind : null
              return (
                <div
                  key={child.id}
                  data-testid={`subtask-row-${child.id}`}
                  className="group/sub relative -mx-2.5 flex min-h-[38px] items-center gap-[9px] rounded-[10px] px-2.5 py-[5px] text-[14.5px] hover:bg-[var(--fill-quaternary)]"
                >
                  {/* The disc IS a control: halo on hover, opens that child's
                      legal-states popover. */}
                  <button
                    type="button"
                    aria-label={`Change status of ${child.id} (${STATUS_LABEL[child.status]})`}
                    data-testid={`subtask-status-${child.id}`}
                    onClick={() => setOpenFor(picking === "status" ? null : { id: child.id, kind: "status" })}
                    className="focus-ring mr-[5px] flex-none rounded-full outline-none transition-shadow duration-120 group-hover/sub:shadow-[0_0_0_3px_var(--fill-secondary)]"
                  >
                    <StateCircle keyOf={stateKeyOf(child.status)} size={16} />
                  </button>
                  <span
                    className="flex-none text-[11px] text-[var(--text-quaternary)]"
                    style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
                  >
                    {child.id}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenChild(child.id)}
                    className={`focus-ring min-w-0 flex-1 truncate text-left outline-none ${
                      closed ? "font-normal text-[var(--text-tertiary)]" : "font-medium text-[var(--text-primary)]"
                    }`}
                  >
                    {child.title}
                  </button>
                  {kids > 0 && (
                    <span className="flex-none text-[11px] tabular-nums text-[var(--text-quaternary)]">
                      {kids} sub{kids === 1 ? "" : "s"}
                    </span>
                  )}
                  {child.assignee && (
                    <EmployeeAvatar name={child.assignee} size={18} fontSize={10} className="flex-none bg-[var(--fill-secondary)]" />
                  )}
                  {/* Quick actions: hidden at rest, fade in on hover; always
                      visible on touch (no hover there). */}
                  <span
                    className={`flex flex-none gap-0.5 transition-opacity duration-120 ${
                      mobile ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/sub:opacity-100"
                    }`}
                  >
                    <button
                      type="button"
                      aria-label={`Assign ${child.id}`}
                      data-testid={`subtask-assign-${child.id}`}
                      onClick={() => setOpenFor(picking === "assign" ? null : { id: child.id, kind: "assign" })}
                      className="focus-ring grid size-[26px] place-items-center rounded-lg text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
                    >
                      <UserRound size={14} strokeWidth={2} aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Open ${child.id}`}
                      data-testid={`subtask-open-${child.id}`}
                      onClick={() => onOpenChild(child.id)}
                      className="focus-ring grid size-[26px] place-items-center rounded-lg text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
                    >
                      <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
                    </button>
                  </span>

                  {picking === "status" && (
                    <PickerPopover
                      label={`Status of ${child.id}`}
                      onClose={() => setOpenFor(null)}
                      testId={`subtask-status-picker-${child.id}`}
                    >
                      <PickerRow
                        glyph={<StatusCircle status={child.status} size={18} />}
                        label={STATUS_LABEL[child.status]}
                        checked
                        onSelect={() => setOpenFor(null)}
                      />
                      {legalTargets(child.status, { openChildren: openKids })
                        .filter((target) => target.status !== child.status)
                        .map((target) => (
                          <PickerRow
                            key={target.status}
                            glyph={<StatusCircle status={target.status} size={18} />}
                            label={STATUS_LABEL[target.status]}
                            disabled={target.gated}
                            reason={target.reason}
                            onSelect={() => {
                              onChildStatus(child.id, target.status)
                              setOpenFor(null)
                            }}
                            testId={`subtask-status-option-${target.status}`}
                          />
                        ))}
                    </PickerPopover>
                  )}
                  {picking === "assign" && (
                    <PickerPopover
                      label={`Assign ${child.id}`}
                      onClose={() => setOpenFor(null)}
                      autoFocusFirst={false}
                      testId={`subtask-assign-picker-${child.id}`}
                    >
                      <AssigneePickerContent
                        detail={{ workItem: child, spendUsd: 0, events: [] }}
                        employees={employees}
                        onDone={() => setOpenFor(null)}
                        commit={(assignee) => {
                          if (assignee) onChildAssign(child.id, assignee)
                        }}
                      />
                    </PickerPopover>
                  )}
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <p className="py-1 text-[13px] text-[var(--text-quaternary)]">No sub-tasks — break this down if it grows.</p>
      )}

      {!atCap ? (
        adding ? (
          <div className="-mx-2.5 flex min-h-9 items-center px-2.5 py-[5px]">
            <Plus size={12} strokeWidth={2.2} aria-hidden className="mr-4 flex-none text-[var(--text-quaternary)]" />
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
                if (e.key === "Escape") {
                  setTitle("")
                  setAdding(false)
                }
              }}
              onBlur={submit}
              placeholder="Sub-task title"
              aria-label="New sub-task title"
              data-testid="subtask-add-input"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
            />
          </div>
        ) : (
          <button
            type="button"
            data-testid="subtask-add"
            onClick={() => setAdding(true)}
            className="focus-ring -mx-2.5 flex min-h-9 w-[calc(100%+20px)] items-center rounded-[10px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-quaternary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
          >
            <Plus size={12} strokeWidth={2.2} aria-hidden className="mr-4" />
            Add sub-task
          </button>
        )
      ) : (
        <p className="py-1 text-[12px] text-[var(--text-quaternary)]" data-testid="subtask-depth-cap">
          Deepest level — sub-tasks nest three levels.
        </p>
      )}
    </section>
  )
}
