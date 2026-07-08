import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { X, Check, ChevronRight, MessageSquareText, TerminalSquare } from "lucide-react"
import { api, type Employee, type WorkItemDetailWire } from "@/lib/api"
import {
  STATUS_LABEL,
  effectiveVerifyMode,
  effectiveMaxRounds,
  priorityLabel,
  provenanceLabel,
  monogram,
  formatCost,
} from "@/lib/todos"
import { StatusCircle } from "./state-glyph"
import { displayNameOf, formatRelativeTime } from "./util"

/* GRS-021d — the detail sheet: a DECISION (design's middle depth). Mobile = an
 * opaque bottom sheet that scrolls FROM INSIDE (pinned header, scrollable body,
 * pinned decision footer — the shipped GRS-019 sheet pattern, never the
 * un-scrollable-sheet bug). Desktop = a right panel. Technical noise (ids,
 * timestamps, refs) collapses behind a single disclosure. */

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

function SheetBody({
  detail,
  byName,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
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

      {item.body && (
        <Section label="What it does">
          <p className="text-[16px] leading-relaxed text-[var(--text-secondary)]">{item.body}</p>
        </Section>
      )}

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
          <Row k="Assignee">
            {item.assignee ? (
              <>
                <span className="grid size-[18px] place-items-center rounded-full bg-[var(--fill-secondary)] text-[8.5px] font-bold text-[var(--text-secondary)]">
                  {monogram(displayNameOf(item.assignee, byName))}
                </span>
                {displayNameOf(item.assignee, byName)}
              </>
            ) : (
              "Unassigned"
            )}
          </Row>
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
          <Row k="Priority">{priorityLabel(item.priority)}</Row>
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

export function DetailSheet({
  id,
  initial,
  byName,
  resolving,
  onApprove,
  onSendBack,
  onClose,
}: {
  id: string
  initial?: WorkItemDetailWire
  byName: Map<string, Employee>
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

  const detail = data
  const pending = detail?.workItem.approvalState === "pending"
  const execSession = sessions?.[0]

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

        {/* Pinned header */}
        <div className="flex shrink-0 items-start gap-3 p-[6px_20px_14px] md:pt-[20px]">
          {detail && <StatusCircle status={detail.workItem.status} size={42} />}
          <div className="min-w-0 flex-1">
            <h2 className="text-[length:var(--text-title3)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
              {detail?.workItem.title ?? "…"}
            </h2>
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
          {detail ? (
            <SheetBody detail={detail} byName={byName} />
          ) : (
            <div className="flex h-32 items-center justify-center text-[var(--text-tertiary)]">Loading…</div>
          )}
        </div>

        {/* Pinned decision footer — only when the operator's call is required. */}
        {detail && pending && (
          <DecisionFooter
            detail={detail}
            resolving={resolving}
            onApprove={onApprove}
            onSendBack={onSendBack}
            onOpenSession={execSession ? () => navigate(`/?session=${encodeURIComponent(execSession.id)}`) : undefined}
          />
        )}
      </aside>
    </div>
  )
}
