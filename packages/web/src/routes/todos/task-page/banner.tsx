import { useEffect, useRef, useState } from "react"
import { Bell, Check, Pause, TriangleAlert } from "lucide-react"
import type { Employee, WorkItemDetailWire, WorkItemEventWire } from "@/lib/api"
import { effectiveMaxRounds } from "@/lib/todos"
import { displayNameOf, formatRelativeTime } from "../util"

/* Todos v2 slice 6 — the task page's banner zone (design-doc §7.2, states mock
 * §5). At most ONE banner: Escalated > Approval > Blocked. Neutral
 * --bg-secondary card, tinted header word + glyph, rail-quoted reason in the
 * author's voice — status colour as accent, never a painted panel. The reason
 * is asked for HERE, never demanded by a modal: an exception item without a
 * note grows an inline reason field (board drops focus it — review F6).
 *
 * Nothing in this banner commits without a deliberate submit. A reason and a
 * decision are both the operator's word, and a blur is not a word — switching
 * browser tabs mid-sentence used to save an unfinished note. And a rejection
 * carries its feedback in the SAME action that decides, because the note is
 * what picks the outcome: with one the work goes round again, without one it
 * stops. Deciding first and writing after took the "stop" path and orphaned
 * the feedback. */

export type BannerKind = "escalated" | "approval" | "blocked"

export function bannerKindOf(detail: WorkItemDetailWire): BannerKind | null {
  const item = detail.workItem
  if (item.status === "escalated") return "escalated"
  if (item.approvalState === "pending") return "approval"
  if (item.status === "blocked") return "blocked"
  return null
}

/** The newest event that carries this exception state's reason: a transition
 *  into the status, or a same-status annotate note (both carry toStatus). */
export function exceptionReasonOf(detail: WorkItemDetailWire): { note: string | null; event: WorkItemEventWire | null } {
  const status = detail.workItem.status
  for (let i = detail.events.length - 1; i >= 0; i--) {
    const e = detail.events[i]
    if (e.toStatus !== status) continue
    const note = typeof e.detail?.note === "string" ? e.detail.note.trim() : ""
    if (note) return { note, event: e }
    if (e.kind === "escalated" && e.detail?.reason === "max-rounds-exhausted") {
      return { note: "Review rounds exhausted", event: e }
    }
    if (e.kind === "status_change") return { note: null, event: e }
  }
  return { note: null, event: null }
}

const KIND_STYLE: Record<BannerKind, { color: string; rail: string }> = {
  escalated: { color: "var(--system-red)", rail: "color-mix(in srgb, var(--system-red) 38%, transparent)" },
  approval: { color: "var(--accent)", rail: "color-mix(in srgb, var(--accent) 38%, transparent)" },
  blocked: { color: "var(--system-orange)", rail: "color-mix(in srgb, var(--system-orange) 38%, transparent)" },
}

function BannerGlyph({ kind }: { kind: BannerKind }) {
  if (kind === "escalated") return <TriangleAlert size={15} strokeWidth={2} aria-hidden />
  if (kind === "approval") return <Bell size={15} strokeWidth={2} aria-hidden />
  return <Pause size={14} strokeWidth={2} aria-hidden />
}

const QUIET_BTN =
  "focus-ring min-h-11 rounded-full px-3 text-[12.5px] font-semibold text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-40 sm:min-h-8"

/** The one line that makes a rejection's consequence legible where it is made. */
export function rejectConsequence(note: string): string {
  return note.trim() ? "Sends it back for another round, with your note." : "Ends the work. Nothing goes back."
}

export function TaskBanner({
  detail,
  byName,
  focusReason,
  busy,
  onCommitReason,
  onApprove,
  onReject,
  actions,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  /** Board drop hand-off (review F6): focus the reason field on arrival. */
  focusReason: boolean
  busy: boolean
  onCommitReason: (note: string) => void
  /** Carries the picked option when the pending gate offers a choice. */
  onApprove: (choice?: string) => void
  /** One rejection, note included — an empty note IS the "stop here" decision. */
  onReject: (note: string) => void
  /** Kind-contextual route actions (the status/assignee pickers own them). */
  actions?: React.ReactNode
}) {
  const kind = bannerKindOf(detail)
  const item = detail.workItem
  const { note, event } = exceptionReasonOf(detail)
  const needsReason = kind !== null && kind !== "approval" && !note
  const [reason, setReason] = useState("")
  const [composing, setComposing] = useState(false)
  const [rejectNote, setRejectNote] = useState("")
  const [choice, setChoice] = useState<string | null>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if ((focusReason || needsReason) && reasonRef.current) reasonRef.current.focus()
    // Focus once on arrival / when the field appears — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReason, needsReason])

  if (!kind) return null
  const style = KIND_STYLE[kind]
  // A gate that offers variants is decided HERE, on the Todo: pick one, then
  // approve. Picking is separate from committing so a mis-tap on a phone never
  // ships the wrong variant.
  const options = detail.approvals?.find((a) => a.state === "pending")?.options ?? null
  const approveDisabled = busy || (options !== null && choice === null)

  const headWord = kind === "escalated" ? "Escalated" : kind === "approval" ? "Approval requested" : "Blocked"
  const when =
    kind === "approval"
      ? [item.approvalEscalatedAt ? "escalated" : null, formatRelativeTime(item.updatedAt)].filter(Boolean).join(" · ")
      : kind === "escalated"
        ? [event ? formatRelativeTime(event.createdAt) : null, `round ${item.rounds} of ${effectiveMaxRounds(item)}`]
            .filter(Boolean)
            .join(" · ")
        : [event ? formatRelativeTime(event.createdAt) : null, event?.actor ? displayNameOf(event.actor, byName) : null]
            .filter(Boolean)
            .join(" · ")

  const body =
    kind === "approval" ? item.approvalRequest : note

  const commitReason = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = reason.trim()
    if (!trimmed) return
    onCommitReason(trimmed)
    setReason("")
  }

  return (
    <div
      data-testid={`task-banner-${kind}`}
      className="mb-3.5 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[14px_16px] shadow-[var(--shadow-card)]"
    >
      <div className="flex items-center gap-2.5 text-[14px] font-semibold" style={{ color: style.color }}>
        <BannerGlyph kind={kind} />
        {headWord}
        {when && <span className="ml-auto text-[11px] font-normal text-[var(--text-quaternary)]">{when}</span>}
      </div>

      {body ? (
        <div className="relative ml-[25px] mt-2 py-0.5 pl-3 text-[14px] leading-[1.5] text-[var(--text-secondary)]">
          <span
            aria-hidden
            className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
            style={{ background: style.rail }}
          />
          {body}
        </div>
      ) : needsReason ? (
        // Submit-only: Enter or Save. A blur is not a decision — leaving the
        // tab must never freeze a half-written sentence onto the record.
        <form onSubmit={commitReason} className="relative ml-[25px] mt-2 flex items-center gap-2 py-0.5 pl-3">
          <span
            aria-hidden
            className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
            style={{ background: style.rail }}
          />
          <input
            ref={reasonRef}
            data-testid="task-banner-reason"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === "escalated" ? "Why is this escalated?" : "What is this waiting on?"}
            aria-label="Reason"
            className="min-w-0 flex-1 rounded-[9px] bg-[var(--fill-quaternary)] px-2.5 py-1.5 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
          <button
            type="submit"
            data-testid="task-banner-reason-save"
            disabled={busy || !reason.trim()}
            className={`${QUIET_BTN} flex-none`}
          >
            Save
          </button>
        </form>
      ) : null}

      {kind === "approval" && (
        composing ? (
          <form
            className="ml-[30px] mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              onReject(rejectNote.trim())
              setComposing(false)
              setRejectNote("")
            }}
          >
            <textarea
              autoFocus
              data-testid="task-banner-reject-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={2}
              placeholder="What needs to change?"
              aria-label="Rejection feedback"
              className="w-full min-w-0 resize-none rounded-[10px] bg-[var(--fill-quaternary)] p-2.5 text-[13.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
            />
            <p data-testid="task-banner-reject-consequence" className="text-[12px] leading-[1.45] text-[var(--text-tertiary)]">
              {rejectConsequence(rejectNote)}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                data-testid="task-banner-reject-confirm"
                disabled={busy}
                className={QUIET_BTN}
                style={rejectNote.trim() ? undefined : { color: "var(--system-red)" }}
              >
                {rejectNote.trim() ? "Send back" : "Reject"}
              </button>
              <button type="button" onClick={() => setComposing(false)} className={QUIET_BTN}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="ml-[30px] mt-3 flex flex-col gap-2.5 sm:ml-[30px]">
            {options && (
              <div role="radiogroup" aria-label="Choose an option" data-testid="task-banner-options" className="flex flex-wrap gap-2">
                {options.map((option) => {
                  const picked = choice === option
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      disabled={busy}
                      onClick={() => setChoice(picked ? null : option)}
                      className="focus-ring inline-flex min-h-11 items-center rounded-full px-3.5 text-[13px] font-medium outline-none transition-colors disabled:opacity-40 sm:min-h-9"
                      style={
                        picked
                          ? {
                              background: "color-mix(in srgb, var(--accent) 16%, transparent)",
                              color: "var(--accent)",
                              boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--accent) 42%, transparent)",
                            }
                          : { background: "var(--fill-quaternary)", color: "var(--text-secondary)" }
                      }
                    >
                      {option}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="task-banner-approve"
              disabled={approveDisabled}
              onClick={() => onApprove(choice ?? undefined)}
              className="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold outline-none transition-transform hover:scale-[0.98] disabled:opacity-40"
              style={{
                background: "color-mix(in srgb, var(--system-green) 16%, transparent)",
                color: "var(--system-green)",
                boxShadow: "var(--inset-shine)",
              }}
            >
              <Check size={13} strokeWidth={2.6} aria-hidden />
              {choice ? `Approve · ${choice}` : "Approve"}
            </button>
            <button
              type="button"
              data-testid="task-banner-reject"
              disabled={busy}
              onClick={() => setComposing(true)}
              className={`${QUIET_BTN} hover:!text-[var(--system-red)]`}
              style={{ color: "var(--system-red)" }}
            >
              Reject…
            </button>
            </div>
          </div>
        )
      )}

      {kind !== "approval" && actions && <div className="ml-[30px] mt-3 flex items-center gap-2.5">{actions}</div>}
    </div>
  )
}
