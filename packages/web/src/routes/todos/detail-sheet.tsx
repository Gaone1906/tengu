import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { X, Check, ChevronRight, MessageSquareText } from "lucide-react"
import { api, type Employee, type LinkedSessionWire, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import {
  STATUS_LABEL,
  effectiveVerifyMode,
  effectiveMaxRounds,
  publicWorkItemReference,
  priorityLabel,
  provenanceLabel,
  formatCost,
  isOpen,
} from "@/lib/todos"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateLine } from "@/components/ui/state-line"
import { StatusCircle } from "./state-glyph"
import { displayNameOf, formatRelativeTime } from "./util"
import { useSetWorkItemStatus } from "./use-todos"
import { TodoDialog } from "./todo-dialog"
import { useTodoDraft, type TodoDraftPatch, type TodoEditableDraft } from "./use-todo-draft"

/* GRS-021d — the detail sheet: a DECISION (design's middle depth). Mobile = an
 * opaque bottom sheet that scrolls FROM INSIDE (pinned header, scrollable body,
 * pinned decision footer); desktop = a right panel.
 *
 * design-todos §4.4 — the sheet is now the operator's pen: title, body,
 * assignee, department, and priority read as text at rest and edit on tap
 * (Apple Notes pattern — no input chrome until focus). Status stays
 * server-owned: only legal transitions render as actions (Mark in progress / Mark done /
 * Cancel / the approval controls), never a free status picker. Edits go through the §7.4
 * PATCH and retain the local draft with an explicit Retry/Discard path on failure. */

const MENU_CLASS =
  "min-w-[200px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"

function Row({ k, children, onClick }: { k: string; children: React.ReactNode; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div"
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[10px] p-[10px_12px] text-left ${onClick ? "transition-colors hover:bg-[var(--fill-tertiary)]" : ""}`}
    >
      <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{k}</span>
      <span className="ml-auto inline-flex min-w-0 max-w-[65%] items-center gap-1.5 break-words text-right text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
        {children}
      </span>
      {onClick && <ChevronRight size={14} className="ml-0.5 flex-none text-[var(--text-quaternary)]" aria-hidden />}
    </Tag>
  )
}

/** A Details row whose value edits through a Ledger dropdown menu. */
function MenuRow({ k, value, children }: { k: string; value: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 w-full min-w-0 items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[10px] p-[10px_12px] text-left transition-colors hover:bg-[var(--fill-tertiary)]">
            <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{k}</span>
            <span className="ml-auto inline-flex min-w-0 max-w-[65%] items-center gap-1.5 break-words text-right text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
              {value}
            </span>
            <ChevronRight size={14} className="ml-0.5 flex-none text-[var(--text-quaternary)]" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CLASS}>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function MenuCheck({ on }: { on: boolean }) {
  return <Check size={12} strokeWidth={2.6} className={`ml-auto ${on ? "text-[var(--accent)]" : "opacity-0"}`} aria-hidden />
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-1">{children}</div>
}

function Section({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      {label && (
        <div className="mb-2.5 text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

export function sessionLinkLabel(session: LinkedSessionWire): string {
  if (session.status === "running" || session.status === "waiting") return "Running session"
  if (session.status === "idle") return "Completed session"
  if (session.status === "interrupted") return "Interrupted session"
  return "Session"
}

/** The body as a quiet tap-to-edit field (text at rest, textarea on tap). */
function EditableBody({ body, onCommit }: { body: string | null; onCommit: (next: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body ?? "")
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <textarea
        ref={ref}
        data-todo-field-edit
        data-testid="sheet-body-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft.trim() !== (body ?? "").trim()) onCommit(draft.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            setDraft(body ?? "")
            setEditing(false)
          }
        }}
        rows={Math.max(3, draft.split("\n").length)}
        className="w-full min-w-0 resize-none break-words rounded-[var(--radius-md)] border-0 bg-[var(--fill-quaternary)] p-2.5 -m-2.5 text-[16px] leading-relaxed text-[var(--text-secondary)] outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      data-testid="sheet-body"
      onClick={() => {
        setDraft(body ?? "")
        setEditing(true)
      }}
      className="w-full min-w-0 break-words rounded-[var(--radius-md)] p-2.5 -m-2.5 text-left transition-colors hover:bg-[var(--fill-quaternary)]"
    >
      {body ? (
        <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      ) : (
        <span className="text-[16px] leading-relaxed text-[var(--text-quaternary)]">Add a description…</span>
      )}
    </button>
  )
}

function SheetBody({
  detail,
  byName,
  employees,
  departments,
  onEdit,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  employees: Employee[]
  departments: string[]
  onEdit: (patch: Parameters<typeof api.updateWorkItem>[1]) => void
}) {
  const navigate = useNavigate()
  const item = detail.workItem
  const [showTech, setShowTech] = useState(false)
  const pending = item.approvalState === "pending"

  const { data: sessions, isSuccess: sessionsReady } = useQuery({
    queryKey: ["work-item-sessions", item.id],
    queryFn: () => api.listWorkItemSessions(item.id),
    staleTime: 10_000,
  })
  const execSession = sessions?.[0]
  const hasRunningSession = sessions?.some((session) => session.status === "running" || session.status === "waiting") ?? false

  const mode = effectiveVerifyMode(item)
  const maxRounds = effectiveMaxRounds(item)
  const verifier = item.verifyPolicy?.verifier
  const verifierText = verifier
    ? [verifier.employee, verifier.engine, verifier.model].filter(Boolean).join(" · ")
    : null
  const cost = formatCost(detail.spendUsd, item.budgetUsd) ?? `$${detail.spendUsd.toFixed(2)}`
  const acceptanceLines = (item.acceptance ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)

  return (
    <>
      {/* Ask banner — only when a decision is pending. */}
      {pending && item.approvalRequest && (
        <div
          className="rounded-[var(--radius-md)] p-[12px_14px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)]"
          style={{ background: "var(--accent-fill)" }}
        >
          {item.approvalRequest}
        </div>
      )}

      {item.status === "executing" && sessionsReady && !hasRunningSession && (
        <StateLine
          state="dispatched"
          label="In progress · no execution session"
          className="mb-1 text-[var(--text-tertiary)]"
        />
      )}

      <Section label="What it does">
        <EditableBody body={item.body} onCommit={(next) => onEdit({ body: next })} />
      </Section>

      {acceptanceLines.length > 0 && (
        <Section label="Acceptance">
          <div className="flex flex-col gap-0.5">
            {acceptanceLines.map((line, i) => (
              <div key={i} className="flex items-start gap-2.5 p-[7px_2px] text-[length:var(--text-subheadline)] leading-snug text-[var(--text-primary)]">
                <span
                  className="mt-px grid size-[18px] flex-none place-items-center rounded-[6px] bg-[var(--fill-tertiary)] text-[var(--text-quaternary)]"
                  aria-hidden
                >
                  <span className="size-[6px] rounded-full bg-[var(--text-quaternary)]" />
                </span>
                {line}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section label="Details">
        <Group>
          <Row k="Status">{STATUS_LABEL[item.status]}</Row>
          <MenuRow
            k="Assignee"
            value={
              item.assignee ? (
                <>
                  <EmployeeAvatar name={item.assignee} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
                  {displayNameOf(item.assignee, byName)}
                </>
              ) : (
                "Unassigned"
              )
            }
          >
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => onEdit({ assignee: null })}>
              Unassigned
              <MenuCheck on={!item.assignee} />
            </DropdownMenuItem>
            {employees.map((e) => (
              <DropdownMenuItem key={e.name} className={ITEM_CLASS} onClick={() => onEdit({ assignee: e.name })}>
                <EmployeeAvatar name={e.name} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
                {e.displayName}
                <MenuCheck on={item.assignee === e.name} />
              </DropdownMenuItem>
            ))}
          </MenuRow>
          {departments.length > 0 && (
            <MenuRow k="Department" value={item.department ? item.department.charAt(0).toUpperCase() + item.department.slice(1) : "None"}>
              <DropdownMenuItem className={ITEM_CLASS} onClick={() => onEdit({ department: null })}>
                None
                <MenuCheck on={!item.department} />
              </DropdownMenuItem>
              {departments.map((d) => (
                <DropdownMenuItem key={d} className={ITEM_CLASS} onClick={() => onEdit({ department: d })}>
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                  <MenuCheck on={item.department === d} />
                </DropdownMenuItem>
              ))}
            </MenuRow>
          )}
          <Row k="From">{provenanceLabel(item.source, item.sourceRef)}</Row>
          <Row k="Review">
            <span
              className="rounded-[6px] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.04em]"
              style={{
                background: "color-mix(in srgb, var(--system-purple) 16%, transparent)",
                color: "var(--system-purple)",
              }}
            >
              {mode}
            </span>
            {verifierText}
          </Row>
          <MenuRow k="Priority" value={priorityLabel(item.priority)}>
            {[3, 2, 1, 0].map((p) => (
              <DropdownMenuItem key={p} className={ITEM_CLASS} onClick={() => onEdit({ priority: p })}>
                {priorityLabel(p)}
                <MenuCheck on={item.priority === p} />
              </DropdownMenuItem>
            ))}
          </MenuRow>
          <Row k="Rounds">
            {item.rounds} of {maxRounds}
          </Row>
          <Row k="Cost">{cost}</Row>
        </Group>
      </Section>

      {(execSession || detail.workflowRun) && (
        <Section label="Links">
          <Group>
            {execSession && (
              <Row k={sessionLinkLabel(execSession)} onClick={() => navigate(`/?session=${encodeURIComponent(execSession.id)}`)}>
                <span className="text-[length:var(--text-caption1)] font-semibold text-[var(--accent)]">Open</span>
              </Row>
            )}
            {detail.workflowRun && (
              <Row k="Workflow run" onClick={() => navigate(`/workflow/${encodeURIComponent(detail.workflowRun!.workflowId)}`)}>
                <span className="text-[length:var(--text-caption1)] font-semibold text-[var(--accent)]">Open</span>
              </Row>
            )}
          </Group>
        </Section>
      )}

      <Section>
        <Group>
          <button
            type="button"
            data-testid="tech-disclosure"
            onClick={() => setShowTech((v) => !v)}
            className="flex w-full items-center gap-3 p-[11px_14px] text-left transition-colors hover:bg-[var(--fill-tertiary)]"
          >
            <span className="flex-1">
              <span className="block text-[length:var(--text-subheadline)] text-[var(--text-primary)]">Technical details</span>
              <span className="mt-px block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Source reference, events, timestamps</span>
            </span>
            <ChevronRight
              size={14}
              className="flex-none text-[var(--text-quaternary)] transition-transform duration-200"
              style={{ transform: showTech ? "rotate(90deg)" : undefined }}
              aria-hidden
            />
          </button>
          {showTech && (
            <div className="min-w-0 rounded-[10px] bg-[var(--fill-tertiary)] p-[11px_14px] font-[var(--font-code)] text-[length:var(--text-caption1)] leading-relaxed text-[var(--text-tertiary)]">
              {publicWorkItemReference(item.sourceRef) && <div className="break-all">sourceRef: {publicWorkItemReference(item.sourceRef)}</div>}
              {publicWorkItemReference(item.approvalRef) && <div className="break-all">approvalRef: {publicWorkItemReference(item.approvalRef)}</div>}
              <div>created: {item.createdAt}</div>
              <div>updated: {item.updatedAt}</div>
              {item.closedAt && <div>closed: {item.closedAt}</div>}
              <div>events: {detail.events.length}</div>
            </div>
          )}
        </Group>
      </Section>
    </>
  )
}

function DecisionFooter({
  detail,
  resolving,
  onApprove,
  onSendBack,
  onOpenSession,
}: {
  detail: WorkItemDetailWire
  resolving: boolean
  onApprove: (id: string) => void
  onSendBack: (id: string, note: string) => void
  onOpenSession?: () => void
}) {
  const [composing, setComposing] = useState(false)
  const [note, setNote] = useState("")
  const id = detail.workItem.id

  if (composing) {
    return (
      <div className="flex shrink-0 flex-col gap-2.5 p-[14px_20px] pb-[max(14px,env(safe-area-inset-bottom))]">
        <textarea
          autoFocus
          data-testid="sheet-sendback-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Add a note for the send-back (optional)…"
          className="apple-input w-full resize-none text-[length:var(--text-subheadline)]"
        />
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid="sheet-sendback-confirm"
            disabled={resolving}
            onClick={() => onSendBack(id, note.trim())}
            className="min-h-11 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-primary)] disabled:opacity-40"
          >
            Send back
          </button>
          <button type="button" onClick={() => setComposing(false)} className="min-h-11 rounded-full px-3 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)]">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2.5 p-[14px_20px] pb-[max(14px,env(safe-area-inset-bottom))]">
      <button
        type="button"
        data-testid="sheet-approve"
        disabled={resolving}
        onClick={() => onApprove(id)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-40"
        style={{ background: "color-mix(in srgb, var(--system-green) 16%, transparent)", color: "var(--system-green)", boxShadow: "var(--inset-shine)" }}
      >
        <Check size={13} strokeWidth={2.4} aria-hidden />
        Approve
      </button>
      <button
        type="button"
        data-testid="sheet-sendback"
        disabled={resolving}
        onClick={() => setComposing(true)}
        className="min-h-11 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-primary)] disabled:opacity-40"
      >
        Send back
      </button>
      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[length:var(--text-caption1)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        >
          <MessageSquareText size={13} strokeWidth={1.75} aria-hidden />
          Session
        </button>
      )}
    </div>
  )
}

/** Legal-transition actions when no approval is pending (§4.4): manual progress for
 *  backlog/assigned work, Mark done + Cancel for open work. Never a picker. */
function TransitionFooter({
  status,
  busy,
  onProgress,
  onDone,
  onCancel,
}: {
  status: WorkItemStatusWire
  busy: boolean
  onProgress: () => void
  onDone: () => void
  onCancel: () => void
}) {
  const open = isOpen(status)
  if (!open) return null
  return (
    <div className="flex shrink-0 items-center gap-2.5 p-[14px_20px] pb-[max(14px,env(safe-area-inset-bottom))]">
      {(status === "backlog" || status === "assigned") && (
        <button
          type="button"
          data-testid="sheet-mark-in-progress"
          disabled={busy}
          onClick={onProgress}
          className="min-h-11 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
        >
          Mark in progress
        </button>
      )}
      <button
        type="button"
        data-testid="sheet-mark-done"
        disabled={busy}
        onClick={onDone}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-40"
        style={{ background: "color-mix(in srgb, var(--system-green) 16%, transparent)", color: "var(--system-green)", boxShadow: "var(--inset-shine)" }}
      >
        <Check size={13} strokeWidth={2.4} aria-hidden />
        Mark done
      </button>
      <button
        type="button"
        data-testid="sheet-cancel-item"
        disabled={busy}
        onClick={onCancel}
        className="min-h-11 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
      >
        Cancel Todo
      </button>
    </div>
  )
}

export function DetailSheet({
  id,
  initial,
  byName,
  employees = [],
  departments = [],
  resolving,
  onApprove,
  onSendBack,
  onClose,
}: {
  id: string
  initial?: WorkItemDetailWire
  byName: Map<string, Employee>
  employees?: Employee[]
  departments?: string[]
  resolving: boolean
  onApprove: (id: string) => void
  onSendBack: (id: string, note: string) => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ["work-item", id],
    queryFn: () => api.getWorkItem(id),
    initialData: initial,
    staleTime: 10_000,
  })
  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", id],
    queryFn: () => api.listWorkItemSessions(id),
    staleTime: 10_000,
  })

  const setStatus = useSetWorkItemStatus()
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [closeAfterSave, setCloseAfterSave] = useState(false)
  const [showCloseGuard, setShowCloseGuard] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const titleBeforeEdit = useRef("")
  useEffect(() => {
    if (editingTitle) titleRef.current?.select()
  }, [editingTitle])

  const detail = data
  const initialDraft = useMemo<TodoEditableDraft>(() => ({
    title: detail?.workItem.title ?? "",
    body: detail?.workItem.body ?? "",
    assignee: detail?.workItem.assignee ?? null,
    department: detail?.workItem.department ?? null,
    priority: detail?.workItem.priority ?? 0,
  }), [detail])
  const saveRemote = useCallback(async (patch: TodoDraftPatch) => {
    const result = await api.updateWorkItem(id, patch)
    queryClient.setQueryData<WorkItemDetailWire>(["work-item", id], (current) =>
      current ? { ...current, workItem: { ...current.workItem, ...result.workItem } } : current,
    )
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["work-items"] }),
      queryClient.invalidateQueries({ queryKey: ["work-item", id] }),
    ])
  }, [id, queryClient])
  const draftState = useTodoDraft({ id, initial: initialDraft, save: saveRemote })
  useEffect(() => {
    if (!draftState.hasUnsaved) return
    const guardReload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", guardReload)
    return () => window.removeEventListener("beforeunload", guardReload)
  }, [draftState.hasUnsaved])
  useEffect(() => {
    if (detail && draftState.status === "idle") draftState.replaceInitial(initialDraft)
  }, [detail, initialDraft, draftState.status, draftState.replaceInitial])

  const displayDetail = useMemo<WorkItemDetailWire | undefined>(() => detail ? {
    ...detail,
    workItem: { ...detail.workItem, ...draftState.draft },
  } : undefined, [detail, draftState.draft])
  const pending = displayDetail?.workItem.approvalState === "pending"
  const execSession = sessions?.[0]

  const edit = (patch: TodoDraftPatch) => {
    for (const [field, value] of Object.entries(patch) as [keyof TodoEditableDraft, TodoEditableDraft[keyof TodoEditableDraft]][]) {
      draftState.change(field, value as never)
    }
    draftState.save(patch)
  }
  const transitionTo = (status: WorkItemStatusWire) => {
    setTransitionError(null)
    setStatus.mutate(
      { id, status },
      { onError: (e) => setTransitionError(e instanceof Error ? e.message : "Couldn't update status") },
    )
  }

  const commitTitle = () => {
    setEditingTitle(false)
    const next = draftState.draft.title.trim()
    if (!next) {
      draftState.change("title", titleBeforeEdit.current)
      return
    }
    if (next !== titleBeforeEdit.current) draftState.save({ title: next })
  }

  const requestClose = useCallback(() => {
    if (draftState.status === "error") {
      setShowCloseGuard(true)
      return
    }
    const patch = draftState.unsavedPatch()
    if (Object.keys(patch).length > 0) draftState.save(patch)
    if (!draftState.isAcknowledged || Object.keys(patch).length > 0) {
      setCloseAfterSave(true)
      return
    }
    onClose()
  }, [draftState, onClose])

  useEffect(() => {
    if (!closeAfterSave) return
    if (draftState.status === "error") {
      setShowCloseGuard(true)
      return
    }
    if (draftState.isAcknowledged) {
      setCloseAfterSave(false)
      onClose()
      return
    }
    if (draftState.status === "dirty") {
      const patch = draftState.unsavedPatch()
      if (Object.keys(patch).length > 0) draftState.save(patch)
    }
  }, [closeAfterSave, draftState.isAcknowledged, draftState.save, draftState.status, draftState.unsavedPatch, onClose])

  return (
    <TodoDialog
      label="Todo details"
      onRequestClose={requestClose}
      testId="detail-sheet"
      overlayTestId="detail-overlay"
      className="inset-x-0 bottom-0 flex max-h-[92vh] min-w-0 flex-col overflow-x-hidden rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom-4 md:bottom-4 md:left-auto md:right-4 md:top-4 md:max-h-none md:w-[420px] md:rounded-[var(--radius-xl)] md:motion-safe:data-[state=open]:slide-in-from-right-4"
    >
        <div className="flex shrink-0 justify-center pb-2 pt-2.5 md:hidden">
          <span className="h-[5px] w-9 rounded-full bg-[var(--fill-primary)]" aria-hidden />
        </div>

        {/* Pinned header — title edits in place (tap; Enter commits, Esc reverts). */}
        <div className="flex shrink-0 items-start gap-3 p-[6px_20px_14px] md:pt-[20px]">
          {displayDetail && <StatusCircle status={displayDetail.workItem.status} size={42} />}
          <div className="min-w-0 flex-1">
            {editingTitle && displayDetail ? (
              <input
                ref={titleRef}
                data-todo-field-edit
                data-testid="sheet-title-edit"
                value={draftState.draft.title}
                onChange={(e) => draftState.change("title", e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle()
                  if (e.key === "Escape") {
                    e.preventDefault()
                    e.stopPropagation()
                    draftState.change("title", titleBeforeEdit.current)
                    setEditingTitle(false)
                  }
                }}
                className="w-full min-w-0 break-words rounded-[7px] border-0 bg-[var(--fill-quaternary)] px-1.5 -mx-1.5 text-[length:var(--text-title3)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] outline-none"
              />
            ) : (
              <button
                type="button"
                aria-label="Edit title"
                data-testid="sheet-title"
                onClick={() => {
                  if (!displayDetail) return
                  titleBeforeEdit.current = draftState.draft.title
                  setEditingTitle(true)
                }}
                className="w-full min-w-0 cursor-text break-words rounded-[7px] px-1.5 -mx-1.5 text-left text-[length:var(--text-title3)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] transition-colors hover:bg-[var(--fill-quaternary)]"
              >
                {displayDetail?.workItem.title ?? "…"}
              </button>
            )}
            {displayDetail && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                <span>{STATUS_LABEL[displayDetail.workItem.status]} · updated {formatRelativeTime(displayDetail.workItem.updatedAt)}</span>
                <span aria-live="polite" className="text-[var(--text-tertiary)]">
                  {draftState.status === "saving" ? "Saving…" : draftState.status === "saved" ? "Saved" : null}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="grid min-h-11 min-w-11 flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <X size={12} strokeWidth={2.4} aria-hidden />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-[0_20px_20px]" data-scrollable>
          {(draftState.error || transitionError) && (
            <div
              data-testid="sheet-save-error"
              className="mb-3 flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
            >
              <span className="min-w-0 flex-1 break-words">{draftState.error ?? transitionError}</span>
              {draftState.status === "error" && <button type="button" onClick={draftState.retry} className="min-h-11 rounded-full px-3 font-semibold">Retry</button>}
            </div>
          )}
          {showCloseGuard && (
            <div className="mb-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              <p>Your draft is still here. Retry saving or discard it before closing.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => { setCloseAfterSave(true); setShowCloseGuard(false); draftState.retry() }} className="min-h-11 rounded-full bg-[var(--accent-fill)] px-4 font-semibold text-[var(--accent)]">Retry</button>
                <button type="button" onClick={() => { draftState.discard(); onClose() }} className="min-h-11 rounded-full px-4 text-[var(--text-tertiary)]">Discard</button>
              </div>
            </div>
          )}
          {displayDetail ? (
            <SheetBody detail={displayDetail} byName={byName} employees={employees} departments={departments} onEdit={edit} />
          ) : (
            <div className="flex h-32 items-center justify-center text-[var(--text-tertiary)]">Loading…</div>
          )}
        </div>

        {/* Pinned footer — the operator's call (approval) or legal transitions. */}
        {displayDetail && pending ? (
          <DecisionFooter
            detail={displayDetail}
            resolving={resolving}
            onApprove={onApprove}
            onSendBack={onSendBack}
            onOpenSession={execSession ? () => navigate(`/?session=${encodeURIComponent(execSession.id)}`) : undefined}
          />
        ) : displayDetail ? (
          <TransitionFooter
            status={displayDetail.workItem.status}
            busy={setStatus.isPending}
            onProgress={() => transitionTo("executing")}
            onDone={() => transitionTo("done")}
            onCancel={() => transitionTo("cancelled")}
          />
        ) : null}
    </TodoDialog>
  )
}
