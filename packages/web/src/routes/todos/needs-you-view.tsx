import { useState } from "react"
import { Check, ExternalLink, MessageSquareText, TerminalSquare, TriangleAlert } from "lucide-react"
import type { Employee, WorkItemCompactWire } from "@/lib/api"
import { EmployeeChip } from "@/components/ui/employee-chip"
import { StateCircle, type StateGlyphKey } from "./state-glyph"
import { ProvChip } from "./row"
import { displayNameOf, formatRelativeTime } from "./util"

/* GRS-027 — Needs You is a server-derived attention inbox (the gateway chooses
 * what belongs here, newest-first). design-todos §4.6 — the request body speaks
 * the delegation language: an approval IS an employee speaking, so it renders
 * as an attribution row (22px emoji avatar + name + verb + time) over a 2px
 * thread-rail quote — never a boxed message. Escalated/blocked tint the rail. */

function attentionKind(item: WorkItemCompactWire): "approval" | "escalated" | "blocked" {
  if (item.approvalState === "pending") return "approval"
  return item.status === "blocked" ? "blocked" : "escalated"
}

function kindLabel(kind: "approval" | "escalated" | "blocked"): string {
  if (kind === "approval") return "Approval"
  return kind === "blocked" ? "Blocked" : "Escalated"
}

function stateKey(kind: "approval" | "escalated" | "blocked"): StateGlyphKey {
  return kind === "approval" ? "approval" : kind
}

function shortRef(id: string): string {
  return id.length > 18 ? `${id.slice(0, 17)}…` : id
}

function WorkRef({ item }: { item: WorkItemCompactWire }) {
  if (item.workflowRun) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <TerminalSquare size={12.5} strokeWidth={1.75} aria-hidden />
        <span className="truncate">Run · {shortRef(item.workflowRun.runId)}</span>
      </span>
    )
  }
  if (item.sessionRef) {
    // Gateway shape is { sessionId, ref? } — the ref suffix is the human label
    // when present, else the shortened session id.
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <MessageSquareText size={12.5} strokeWidth={1.75} aria-hidden />
        <span className="truncate">Session · {item.sessionRef.ref?.trim() || shortRef(item.sessionRef.sessionId)}</span>
      </span>
    )
  }
  return <ProvChip source={item.source} sourceRef={item.sourceRef} />
}

function NeedsYouCard({
  item,
  byName,
  resolving,
  onApprove,
  onSendBack,
  onEscalate,
  onOpen,
}: {
  item: WorkItemCompactWire
  byName: Map<string, Employee>
  resolving: boolean
  onApprove: (id: string) => void
  onSendBack: (id: string, note: string) => void
  onEscalate: (id: string) => void
  onOpen: (id: string) => void
}) {
  const [composing, setComposing] = useState(false)
  const [note, setNote] = useState("")
  const kind = attentionKind(item)
  const pending = kind === "approval"
  const tone = kind === "escalated" ? "var(--system-red)" : kind === "blocked" ? "var(--system-orange)" : "var(--accent)"
  const verb = pending ? "asks" : kind === "escalated" ? "escalated" : "is blocked"
  const message =
    pending
      ? item.approvalRequest ?? "Awaiting your decision."
      : kind === "escalated"
        ? "Escalated to you. Review the Todo and decide the next move."
        : "Blocked and waiting on a decision or missing input."
  const railColor = pending ? "var(--fill-primary)" : `color-mix(in srgb, ${tone} 38%, transparent)`

  return (
    <div
      data-testid={`needs-item-${item.id}`}
      className="flex flex-col gap-[13px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[16px_18px] shadow-[var(--shadow-card)]"
    >
      <button type="button" className="flex items-start gap-3 text-left" onClick={() => onOpen(item.id)}>
        <StateCircle keyOf={stateKey(kind)} size={34} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-snug text-[var(--text-primary)]">
            {item.title}
          </span>
          <span
            className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[length:var(--text-caption2)] font-semibold"
            style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}
          >
            {kindLabel(kind)}
          </span>
        </span>
      </button>

      {/* The employee speaking + their words behind the thread-rail. */}
      <div>
        <div className="flex min-w-0 items-center gap-2">
          {item.assignee ? (
            <>
              <EmployeeChip employee={item.assignee} displayName={displayNameOf(item.assignee, byName)} size={22} />
              <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{verb}</span>
            </>
          ) : (
            <WorkRef item={item} />
          )}
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
            · {formatRelativeTime(item.updatedAt)}
          </span>
        </div>
        <div className="relative ml-2.5 mt-1.5 pl-4">
          <span
            aria-hidden
            className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
            style={{ background: railColor }}
          />
          <p className="max-w-[62ch] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)]">
            {message}
          </p>
        </div>
      </div>

      {pending && composing ? (
        <div className="flex flex-col gap-2.5">
          <textarea
            autoFocus
            data-testid={`sendback-note-${item.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the send-back (optional)…"
            rows={2}
            className="apple-input w-full resize-none text-[length:var(--text-subheadline)]"
          />
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              data-testid={`sendback-confirm-${item.id}`}
              disabled={resolving}
              onClick={() => onSendBack(item.id, note.trim())}
              className="h-9 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-primary)] disabled:opacity-40"
            >
              Send back
            </button>
            <button
              type="button"
              onClick={() => setComposing(false)}
              className="h-9 rounded-full px-3 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          {pending ? (
            <>
              <button
                type="button"
                data-testid={`approve-${item.id}`}
                disabled={resolving}
                onClick={() => onApprove(item.id)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-40"
                style={{
                  background: "color-mix(in srgb, var(--system-green) 16%, transparent)",
                  color: "var(--system-green)",
                  boxShadow: "var(--inset-shine)",
                }}
              >
                <Check size={13} strokeWidth={2.4} aria-hidden />
                Approve
              </button>
              <button
                type="button"
                data-testid={`sendback-${item.id}`}
                disabled={resolving}
                onClick={() => setComposing(true)}
                className="h-9 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-primary)] disabled:opacity-40"
              >
                Send back
              </button>
              <button
                type="button"
                data-testid={`escalate-${item.id}`}
                disabled={resolving}
                onClick={() => onEscalate(item.id)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
                style={{ color: "var(--text-secondary)" }}
              >
                <TriangleAlert size={13} strokeWidth={2} aria-hidden />
                Escalate
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-full bg-[var(--fill-secondary)] px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-primary)]"
            >
              <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
              Open Todo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function NeedsYouEmpty() {
  return (
    <div className="px-8 pb-24 pt-28 text-center" data-testid="needs-you-empty">
      <div
        className="mx-auto mb-6 grid size-[76px] place-items-center rounded-[24px]"
        style={{
          background: "color-mix(in srgb, var(--system-green) 13%, transparent)",
          color: "var(--system-green)",
          boxShadow: "var(--inset-shine)",
        }}
        aria-hidden
      >
        <Check size={34} strokeWidth={2} />
      </div>
      <h2 className="font-[var(--font-display)] text-[length:var(--text-title2)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
        Nothing needs you.
      </h2>
      <p className="mx-auto mt-2.5 max-w-[320px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
        Approvals routed to you, escalations, and blocked work land here. For now, the company&rsquo;s got it.
      </p>
    </div>
  )
}

export function NeedsYouView({
  items,
  byName,
  resolvingIds,
  onApprove,
  onSendBack,
  onEscalate,
  onOpen,
}: {
  items: WorkItemCompactWire[]
  byName: Map<string, Employee>
  resolvingIds: Set<string>
  onApprove: (id: string) => void
  onSendBack: (id: string, note: string) => void
  onEscalate: (id: string) => void
  onOpen: (id: string) => void
}) {
  const visible = items.filter((item) => !resolvingIds.has(item.id))

  if (visible.length === 0) return <NeedsYouEmpty />

  return (
    <div className="flex flex-col gap-3" data-testid="needs-you">
      {visible.map((item) => (
        <NeedsYouCard
          key={item.id}
          item={item}
          byName={byName}
          resolving={resolvingIds.has(item.id)}
          onApprove={onApprove}
          onSendBack={onSendBack}
          onEscalate={onEscalate}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
