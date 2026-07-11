import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { X, Check, ChevronRight, MessageSquareText } from "lucide-react"
import { api, type Employee, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import {
  STATUS_LABEL,
  effectiveVerifyMode,
  effectiveMaxRounds,
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
import { StatusCircle } from "./state-glyph"
import { displayNameOf, formatRelativeTime } from "./util"
import { useSetWorkItemStatus, useUpdateWorkItem } from "./use-todos"

/* GRS-021d — the detail sheet: a DECISION (design's middle depth). Mobile = an
 * opaque bottom sheet that scrolls FROM INSIDE (pinned header, scrollable body,
 * pinned decision footer); desktop = a right panel.
 *
 * design-todos §4.4 — the sheet is now the operator's pen: title, body,
 * assignee, department, and priority read as text at rest and edit on tap
 * (Apple Notes pattern — no input chrome until focus). Status stays
 * server-owned: only legal transitions render as actions (Start / Mark done /
 * Cancel / the approval controls), never a free status picker. Edits go through the §7.4
 * PATCH; a gateway that predates it fails quietly and the read view stays true. */

const MENU_CLASS =
  "min-w-[200px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"

function Row({ k, children, onClick }: { k: string; children: React.ReactNode; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div"
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`flex min-h-[46px] w-full items-center gap-3 p-[11px_14px] text-left [&+&]:border-t-[0.5px] [&+&]:border-[var(--separator)] ${onClick ? "transition-colors hover:bg-[var(--fill-tertiary)]" : ""}`}
    >
      <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{k}</span>
      <span className="ml-auto inline-flex items-center gap-1.5 text-right text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
        {children}
      </span>
      {onClick && <ChevronRight size={14} className="ml-0.5 flex-none text-[var(--text-quaternary)]" aria-hidden />}
    </Tag>
  )
}

/** A Details row whose value edits through a Ledger dropdown menu. */
function MenuRow({ k, value, children }: { k: string; value: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[46px] w-full items-center gap-3 [&+*]:border-t-[0.5px] [&+*]:border-[var(--separator)]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex min-h-[46px] w-full items-center gap-3 p-[11px_14px] text-left transition-colors hover:bg-[var(--fill-tertiary)]">
            <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{k}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-right text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
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
  return <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]">{children}</div>
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
        data-testid="sheet-body-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft.trim() !== (body ?? "").trim()) onCommit(draft.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(body ?? "")
            setEditing(false)
          }
        }}
        rows={Math.max(3, draft.split("\n").length)}
        className="w-full resize-none rounded-[var(--radius-md)] border-0 bg-[var(--fill-quaternary)] p-2.5 -m-2.5 text-[16px] leading-relaxed text-[var(--text-secondary)] outline-none"
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
      className="w-full rounded-[var(--radius-md)] p-2.5 -m-2.5 text-left transition-colors hover:bg-[var(--fill-quaternary)]"
    >
      {body ? (
        <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
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

  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", item.id],
    queryFn: () => api.listWorkItemSessions(item.id),
    staleTime: 10_000,
  })
  const execSession = sessions?.[0]

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
              <Row k="Executing session" onClick={() => navigate(`/?session=${encodeURIComponent(execSession.id)}`)}>
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
              <span className="mt-px block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">ID, source ref, events, timestamps</span>
            </span>
            <ChevronRight
              size={14}
              className="flex-none text-[var(--text-quaternary)] transition-transform duration-200"
              style={{ transform: showTech ? "rotate(90deg)" : undefined }}
              aria-hidden
            />
          </button>
          {showTech && (
            <div className="border-t-[0.5px] border-[var(--separator)] p-[11px_14px] font-[var(--font-code)] text-[length:var(--text-caption1)] leading-relaxed text-[var(--text-tertiary)]">
              <div className="break-all">id: {item.id}</div>
              {item.sourceRef && <div className="break-all">sourceRef: {item.sourceRef}</div>}
              {item.approvalRef && <div className="break-all">approvalRef: {item.approvalRef}</div>}
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
          data-testid={`sheet-sendback-note-${id}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Add a note for the send-back (optional)…"
          className="apple-input w-full resize-none text-[length:var(--text-subheadline)]"
        />
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid={`sheet-sendback-confirm-${id}`}
            disabled={resolving}
            onClick={() => onSendBack(id, note.trim())}
            className="h-9 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-primary)] disabled:opacity-40"
          >
            Send back
          </button>
          <button type="button" onClick={() => setComposing(false)} className="h-9 rounded-full px-3 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)]">
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
        data-testid={`sheet-approve-${id}`}
        disabled={resolving}
        onClick={() => onApprove(id)}
        className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-40"
        style={{ background: "color-mix(in srgb, var(--system-green) 16%, transparent)", color: "var(--system-green)", boxShadow: "var(--inset-shine)" }}
      >
        <Check size={13} strokeWidth={2.4} aria-hidden />
        Approve
      </button>
      <button
        type="button"
        data-testid={`sheet-sendback-${id}`}
        disabled={resolving}
        onClick={() => setComposing(true)}
        className="h-9 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-primary)] disabled:opacity-40"
      >
        Send back
      </button>
      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[length:var(--text-caption1)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        >
          <MessageSquareText size={13} strokeWidth={1.75} aria-hidden />
          Session
        </button>
      )}
    </div>
  )
}

/** Legal-transition actions when no approval is pending (§4.4): Start for
 *  backlog/assigned work, Mark done + Cancel for open work. Never a picker. */
function TransitionFooter({
  status,
  busy,
  onStart,
  onDone,
  onCancel,
}: {
  status: WorkItemStatusWire
  busy: boolean
  onStart: () => void
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
          data-testid="sheet-start-item"
          disabled={busy}
          onClick={onStart}
          className="h-9 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
        >
          Start
        </button>
      )}
      <button
        type="button"
        data-testid="sheet-mark-done"
        disabled={busy}
        onClick={onDone}
        className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-40"
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
        className="h-9 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
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

  const update = useUpdateWorkItem()
  const setStatus = useSetWorkItemStatus()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editingTitle) titleRef.current?.select()
  }, [editingTitle])

  const detail = data
  const pending = detail?.workItem.approvalState === "pending"
  const execSession = sessions?.[0]

  const edit = (patch: Parameters<typeof api.updateWorkItem>[1]) => {
    setSaveError(null)
    update.mutate(
      { id, patch },
      { onError: (e) => setSaveError(e instanceof Error ? e.message : "Couldn't save") },
    )
  }
  const transitionTo = (status: WorkItemStatusWire) => {
    setSaveError(null)
    setStatus.mutate(
      { id, status },
      { onError: (e) => setSaveError(e instanceof Error ? e.message : "Couldn't update status") },
    )
  }

  const commitTitle = () => {
    setEditingTitle(false)
    const next = titleDraft.trim()
    if (detail && next && next !== detail.workItem.title) edit({ title: next })
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Todo details">
      {/* Scrim — dim on mobile, transparent on desktop (the panel is inset). */}
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 md:bg-transparent"
        style={{ background: "color-mix(in srgb, var(--bg) 58%, transparent)" }}
      />
      <aside
        className="absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] md:inset-x-auto md:bottom-4 md:right-4 md:top-4 md:max-h-none md:w-[420px] md:rounded-[var(--radius-xl)]"
        data-testid="detail-sheet"
      >
        <div className="flex shrink-0 justify-center pb-2 pt-2.5 md:hidden">
          <span className="h-[5px] w-9 rounded-full bg-[var(--fill-primary)]" aria-hidden />
        </div>

        {/* Pinned header — title edits in place (tap; Enter commits, Esc reverts). */}
        <div className="flex shrink-0 items-start gap-3 p-[6px_20px_14px] md:pt-[20px]">
          {detail && <StatusCircle status={detail.workItem.status} size={42} />}
          <div className="min-w-0 flex-1">
            {editingTitle && detail ? (
              <input
                ref={titleRef}
                data-testid="sheet-title-edit"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle()
                  if (e.key === "Escape") setEditingTitle(false)
                }}
                className="w-full rounded-[7px] border-0 bg-[var(--fill-quaternary)] px-1.5 -mx-1.5 text-[length:var(--text-title3)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] outline-none"
              />
            ) : (
              <h2
                data-testid="sheet-title"
                onClick={() => {
                  if (!detail) return
                  setTitleDraft(detail.workItem.title)
                  setEditingTitle(true)
                }}
                className="cursor-text rounded-[7px] px-1.5 -mx-1.5 text-[length:var(--text-title3)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] transition-colors hover:bg-[var(--fill-quaternary)]"
              >
                {detail?.workItem.title ?? "…"}
              </h2>
            )}
            {detail && (
              <div className="mt-0.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                {STATUS_LABEL[detail.workItem.status]} · updated {formatRelativeTime(detail.workItem.updatedAt)}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-[30px] flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <X size={12} strokeWidth={2.4} aria-hidden />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-[0_20px_20px]" data-scrollable>
          {saveError && (
            <div
              data-testid="sheet-save-error"
              className="mb-3 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {saveError}
            </div>
          )}
          {detail ? (
            <SheetBody detail={detail} byName={byName} employees={employees} departments={departments} onEdit={edit} />
          ) : (
            <div className="flex h-32 items-center justify-center text-[var(--text-tertiary)]">Loading…</div>
          )}
        </div>

        {/* Pinned footer — the operator's call (approval) or legal transitions. */}
        {detail && pending ? (
          <DecisionFooter
            detail={detail}
            resolving={resolving}
            onApprove={onApprove}
            onSendBack={onSendBack}
            onOpenSession={execSession ? () => navigate(`/?session=${encodeURIComponent(execSession.id)}`) : undefined}
          />
        ) : detail ? (
          <TransitionFooter
            status={detail.workItem.status}
            busy={setStatus.isPending}
            onStart={() => transitionTo("executing")}
            onDone={() => transitionTo("done")}
            onCancel={() => transitionTo("cancelled")}
          />
        ) : null}
      </aside>
    </div>
  )
}
