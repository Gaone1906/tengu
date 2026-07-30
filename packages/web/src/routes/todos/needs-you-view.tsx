import { useMemo, useState } from "react"
import { Check, MessageSquareText } from "lucide-react"
import type { Employee, WorkItemCompactWire, WorkItemDetailWire, WorkItemStatusWire } from "@/lib/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmployeeChip } from "@/components/ui/employee-chip"
import { STATUS_LABEL, effectiveMaxRounds, operatorSafeTodoError, provenanceLabel, publicWorkItemReference } from "@/lib/todos"
import { legalTargets } from "@/lib/legal-targets"
import { ProvenanceIcon, StateCircle, StatusCircle, type StateGlyphKey } from "./state-glyph"
import { rejectConsequence } from "./task-page/banner"
import { reasonOf, rollupOf } from "./board/card"
import { useBoardTrees } from "./board/use-board"
import { useOpenDetails, useSetWorkItemStatus } from "./use-todos"
import { displayNameOf, formatRelativeTime } from "./util"

/* Todos v2 slice 6 stage C — the Attention inbox restyled to the approved
 * states mock (states.html §1, design-doc §6): a LIST, never a board. Three
 * kickers in fixed order — Approvals, Escalated, Blocked — true counts,
 * oldest-first within a group (the longest-waiting ask wins). Every entry is
 * the same object: neutral card, 34px state disc, title + mono ID line, then
 * the VOICE (attribution row + 2px-rail quote in the delegation language).
 * Actions per kind: approvals decide in place (Approve · Reject…, the note
 * carried by the rejection itself — see banner.tsx); escalated routes through
 * a legal-exit menu (human-only edges); blocked unblocks through its legal
 * manual exits. The menus consume the same legalTargets() module as drag and
 * the pickers — one legality truth. */

type AttentionKind = "approval" | "escalated" | "blocked"

function attentionKind(item: WorkItemCompactWire): AttentionKind {
  if (item.approvalState === "pending") return "approval"
  return item.status === "blocked" ? "blocked" : "escalated"
}

function stateKey(kind: AttentionKind): StateGlyphKey {
  return kind === "approval" ? "approval" : kind
}

function shortRef(id: string): string {
  return id.length > 18 ? `${id.slice(0, 17)}…` : id
}

/** Provenance attribution for unassigned items (moved here from the retired
 *  legacy row at the stage-C cutover — this inbox is its one consumer). */
function ProvChip({ source, sourceRef }: { source: WorkItemCompactWire["source"]; sourceRef?: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      <ProvenanceIcon source={source} className="flex-none opacity-85" />
      <span className="truncate">{provenanceLabel(source, sourceRef)}</span>
    </span>
  )
}

function WorkRef({ item }: { item: WorkItemCompactWire }) {
  if (item.sessionRef) {
    // Gateway shape is { sessionId, ref? } — the ref suffix is the human label
    // when present, else the shortened session id.
    const sessionRef = publicWorkItemReference(item.sessionRef.ref) ?? publicWorkItemReference(item.sessionRef.sessionId)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <MessageSquareText size={12.5} strokeWidth={1.75} aria-hidden />
        <span className="truncate">{sessionRef ? `Session · ${shortRef(sessionRef)}` : "Session"}</span>
      </span>
    )
  }
  return <ProvChip source={item.source} sourceRef={item.sourceRef} />
}

/** The mock's mono ID line: `PLA-26 · In review`, `ACM-9 · was in review ·
 *  round 2 of 2`, `PLA-19 · blocked 1d`. Transport-only ids never render. */
export function attentionIdLine(
  item: WorkItemCompactWire,
  kind: AttentionKind,
  detail: WorkItemDetailWire | undefined,
): string {
  const parts: string[] = []
  const publicId = publicWorkItemReference(item.id)
  if (publicId) parts.push(publicId)
  if (kind === "escalated") {
    const events = detail?.events ?? []
    let from: WorkItemStatusWire | null = null
    let at: string | null = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].toStatus === "escalated") {
        from = events[i].fromStatus ?? null
        at = events[i].createdAt
        break
      }
    }
    parts.push(from ? `was ${STATUS_LABEL[from].toLowerCase()}` : STATUS_LABEL[item.status].toLowerCase())
    const full = detail?.workItem
    if (full) parts.push(`round ${full.rounds} of ${effectiveMaxRounds(full)}`)
    else if (at) parts.push(formatRelativeTime(at).toLowerCase())
  } else if (kind === "blocked") {
    const events = detail?.events ?? []
    let at: string | null = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].toStatus === "blocked") {
        at = events[i].createdAt
        break
      }
    }
    parts.push(`blocked ${formatRelativeTime(at ?? item.updatedAt).toLowerCase()}`)
  } else {
    parts.push(STATUS_LABEL[item.status])
  }
  return parts.join(" · ")
}

const BTN =
  "focus-ring flex h-[34px] items-center gap-[7px] whitespace-nowrap rounded-[17px] px-3.5 text-[13px] font-semibold outline-none transition-colors disabled:opacity-40"
const BTN_QUIET = `${BTN} text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)]`
const BTN_FILLED = `${BTN} bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]`

/** Legal-exit menu (Route… / Unblock…): the same legalTargets() map the board
 *  drag and the pickers consume; gated rows disabled at 50% + inline reason. */
function RouteMenu({
  label,
  item,
  openChildren,
  busy,
  onTransition,
  testId,
}: {
  label: string
  item: WorkItemCompactWire
  openChildren: number
  busy: boolean
  onTransition: (id: string, status: WorkItemStatusWire) => void
  testId: string
}) {
  const targets = legalTargets(item.status, { openChildren })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid={testId} disabled={busy} className={BTN_FILLED}>
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[220px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
      >
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.status}
            data-testid={`${testId}-${target.status}`}
            disabled={target.gated}
            aria-disabled={target.gated || undefined}
            onClick={() => {
              if (!target.gated) onTransition(item.id, target.status)
            }}
            className={`flex min-h-10 cursor-pointer flex-col items-start justify-center gap-0 rounded-[9px] px-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)] ${
              target.gated ? "cursor-default opacity-50" : ""
            }`}
          >
            <span className="flex items-center gap-2">
              <StatusCircle status={target.status} size={18} />
              {STATUS_LABEL[target.status]}
            </span>
            {target.gated && target.reason && (
              <span className="pl-[26px] text-[11px] font-normal text-[var(--text-tertiary)]">{target.reason}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NeedsYouCard({
  item,
  detail,
  openChildren,
  byName,
  resolving,
  onApprove,
  onReject,
  onTransition,
  onOpen,
}: {
  item: WorkItemCompactWire
  detail: WorkItemDetailWire | undefined
  openChildren: number
  byName: Map<string, Employee>
  resolving: boolean
  onApprove: (id: string) => void
  onReject: (id: string, note: string) => void
  onTransition: (id: string, status: WorkItemStatusWire) => void
  onOpen: (id: string) => void
}) {
  const [composing, setComposing] = useState(false)
  const [note, setNote] = useState("")
  const kind = attentionKind(item)
  const pending = kind === "approval"
  const tone = kind === "escalated" ? "var(--system-red)" : kind === "blocked" ? "var(--system-orange)" : "var(--accent)"
  const verb = pending ? "asks" : kind === "escalated" ? "escalated" : "is blocked"
  const reason = reasonOf(item, detail)
  const quote = pending
    ? item.approvalRequest ?? "Awaiting your decision."
    : reason
      ?? (kind === "escalated"
        ? "Escalated to you. Review the Todo and decide the next move."
        : "Blocked and waiting on a decision or missing input.")
  const railColor = pending ? "var(--fill-primary)" : `color-mix(in srgb, ${tone} 38%, transparent)`
  const idLine = attentionIdLine(item, kind, detail)

  return (
    <div
      data-testid="needs-item"
      className="mb-2.5 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[16px_18px] shadow-[var(--shadow-card)]"
    >
      {/* Head: 34px disc · title over the mono ID line. */}
      <button type="button" className="focus-ring flex w-full items-start gap-3 rounded-lg text-left outline-none" onClick={() => onOpen(item.id)}>
        <StateCircle keyOf={stateKey(kind)} size={34} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)]">
            {item.title}
          </span>
          {idLine && (
            <span
              className="mt-0.5 block text-[11px] tracking-[.04em] text-[var(--text-tertiary)]"
              style={{ fontFamily: "var(--font-code)" }}
            >
              {idLine}
            </span>
          )}
        </span>
      </button>

      {/* The employee speaking (attribution at the mock's 46px indent)… */}
      <div className="ml-[46px] mt-3 flex min-w-0 items-center gap-2 text-[13px]">
        {item.assignee ? (
          <>
            <EmployeeChip employee={item.assignee} displayName={displayNameOf(item.assignee, byName)} size={22} />
            <span className="text-[var(--text-tertiary)]">{verb}</span>
          </>
        ) : (
          <WorkRef item={item} />
        )}
        <span className="text-[11px] text-[var(--text-quaternary)]">{formatRelativeTime(item.updatedAt)}</span>
        {pending && item.approvalOperatorOnly && (
          <span
            data-testid="needs-operator-only"
            title="No employee can decide this gate, including the COO and through escalation."
            className="rounded-full bg-[var(--fill-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]"
          >
            Yours only
          </span>
        )}
      </div>

      {/* …and their words behind the thread-rail (quote at 58px). */}
      <div className="relative ml-[58px] mt-[7px] py-0.5 pl-3">
        <span
          aria-hidden
          className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
          style={{ background: railColor }}
        />
        <p className="max-w-[62ch] text-[15px] leading-[1.55] text-[var(--text-secondary)]">{quote}</p>
      </div>

      {/* Actions per kind (states mock §1). */}
      {pending && composing ? (
        <form
          className="ml-[58px] mt-3.5 flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            onReject(item.id, note.trim())
          }}
        >
          <textarea
            autoFocus
            data-testid="needs-reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What needs to change?"
            aria-label="Rejection feedback"
            rows={2}
            className="apple-input w-full resize-none text-[length:var(--text-subheadline)]"
          />
          <p data-testid="needs-reject-consequence" className="text-[12px] leading-[1.45] text-[var(--text-tertiary)]">
            {rejectConsequence(note)}
          </p>
          <div className="flex items-center gap-2.5">
            <button
              type="submit"
              data-testid="needs-reject-confirm"
              disabled={resolving}
              className={BTN_FILLED}
              style={note.trim() ? undefined : { color: "var(--system-red)" }}
            >
              {note.trim() ? "Send back" : "Reject"}
            </button>
            <button type="button" onClick={() => setComposing(false)} className={BTN_QUIET}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ml-[58px] mt-3.5 flex flex-wrap items-center gap-2.5">
          {pending ? (
            <>
              {/* A gate that offers variants can't be settled from a summary row —
                  the pick belongs next to what is being picked between. */}
              {item.approvalOptions?.length ? (
                <button type="button" data-testid="needs-choose" onClick={() => onOpen(item.id)} className={BTN}
                  style={{
                    background: "color-mix(in srgb, var(--accent) 16%, transparent)",
                    color: "var(--accent)",
                    boxShadow: "var(--inset-shine)",
                  }}
                >
                  Choose…
                </button>
              ) : (
              <button
                type="button"
                data-testid="needs-approve"
                disabled={resolving}
                onClick={() => onApprove(item.id)}
                className={BTN}
                style={{
                  background: "color-mix(in srgb, var(--system-green) 16%, transparent)",
                  color: "var(--system-green)",
                  boxShadow: "var(--inset-shine)",
                }}
              >
                <Check size={13} strokeWidth={2.6} aria-hidden />
                Approve
              </button>
              )}
              <button
                type="button"
                data-testid="needs-reject"
                disabled={resolving}
                onClick={() => setComposing(true)}
                className={BTN_QUIET}
                style={{ color: "var(--system-red)" }}
              >
                Reject…
              </button>
            </>
          ) : kind === "escalated" ? (
            <>
              <button type="button" data-testid="needs-open" onClick={() => onOpen(item.id)} className={BTN_FILLED}>
                Open
              </button>
              <RouteMenu
                label="Route…"
                item={item}
                openChildren={openChildren}
                busy={resolving}
                onTransition={onTransition}
                testId="needs-route"
              />
            </>
          ) : (
            <>
              <RouteMenu
                label="Unblock…"
                item={item}
                openChildren={openChildren}
                busy={resolving}
                onTransition={onTransition}
                testId="needs-unblock"
              />
              <button type="button" data-testid="needs-open" onClick={() => onOpen(item.id)} className={BTN_QUIET}>
                Open
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Zero state — the states mock's "All quiet." card (§6). */
export function NeedsYouEmpty() {
  return (
    <div className="flex justify-center pt-10" data-testid="needs-you-empty">
      <div className="flex w-[330px] flex-col items-center rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[36px_24px] text-center shadow-[var(--shadow-card)]">
        <div
          className="grid size-16 place-items-center rounded-[22px]"
          style={{
            background: "color-mix(in srgb, var(--system-green) 13%, transparent)",
            color: "var(--system-green)",
            boxShadow: "var(--inset-shine)",
          }}
          aria-hidden
        >
          <Check size={26} strokeWidth={2.4} />
        </div>
        <h2 className="mt-4 text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">All quiet.</h2>
        <p className="mt-1.5 text-[14px] leading-[1.5] text-[var(--text-tertiary)]">
          Nothing needs you. Approvals, escalations and blocks land here the moment they exist.
        </p>
      </div>
    </div>
  )
}

const GROUPS: { kind: AttentionKind; label: string }[] = [
  { kind: "approval", label: "Approvals" },
  { kind: "escalated", label: "Escalated" },
  { kind: "blocked", label: "Blocked" },
]

export function NeedsYouView({
  items,
  byName,
  resolvingIds,
  onApprove,
  onReject,
  onOpen,
}: {
  items: WorkItemCompactWire[]
  byName: Map<string, Employee>
  resolvingIds: Set<string>
  onApprove: (id: string) => void
  onReject: (id: string, note: string) => void
  onOpen: (id: string) => void
}) {
  const visible = items.filter((item) => !resolvingIds.has(item.id))

  // The voice needs the reason note + rounds (details) and the roll-up gate
  // pre-check for the route menus (trees) — the inbox is small and bounded.
  const detailIds = useMemo(() => visible.map((item) => item.id).slice(0, 60), [items, resolvingIds]) // eslint-disable-line react-hooks/exhaustive-deps
  const details = useOpenDetails(detailIds)
  const detailById = useMemo(() => {
    const map = new Map<string, WorkItemDetailWire>()
    for (const d of details.data ?? []) map.set(d.workItem.id, d)
    return map
  }, [details.data])
  const routeIds = useMemo(
    () => visible.filter((item) => attentionKind(item) !== "approval").map((item) => item.id).slice(0, 60),
    [items, resolvingIds], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const trees = useBoardTrees(routeIds)
  const openChildrenOf = (id: string, status: WorkItemStatusWire): number => {
    const tree = trees.data?.get(id)
    if (!tree) return 0
    const roll = rollupOf(tree, status)
    return roll ? roll.total - roll.closed : 0
  }

  // Route…/Unblock… commit through the operator PUT lane; a refusal surfaces
  // the gateway's words in the view's own transient callout.
  const setStatus = useSetWorkItemStatus()
  const [callout, setCallout] = useState<string | null>(null)
  const onTransition = (id: string, status: WorkItemStatusWire) => {
    setCallout(null)
    setStatus.mutate(
      { id, status },
      {
        onError: (error) => {
          setCallout(operatorSafeTodoError(error, "The gateway refused the move"))
          window.setTimeout(() => setCallout(null), 6000)
        },
      },
    )
  }

  if (visible.length === 0) return <NeedsYouEmpty />

  const grouped = GROUPS.map((group) => ({
    ...group,
    // Oldest-first within a group — the longest-waiting ask wins (§6).
    items: visible
      .filter((item) => attentionKind(item) === group.kind)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
  })).filter((group) => group.items.length > 0)

  return (
    <div data-testid="needs-you">
      {grouped.map((group) => (
        <section key={group.kind} data-testid={`needs-group-${group.kind}`}>
          <div
            className="mb-2 mt-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)] first:mt-0"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {group.label}
            <span className="tracking-normal text-[var(--text-quaternary)]">{group.items.length}</span>
          </div>
          {group.items.map((item) => (
            <NeedsYouCard
              key={item.id}
              item={item}
              detail={detailById.get(item.id)}
              openChildren={openChildrenOf(item.id, item.status)}
              byName={byName}
              resolving={resolvingIds.has(item.id) || setStatus.isPending}
              onApprove={onApprove}
              onReject={onReject}
              onTransition={onTransition}
              onOpen={onOpen}
            />
          ))}
        </section>
      ))}

      {callout && (
        <div
          role="status"
          data-testid="needs-callout"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[var(--radius-lg)] bg-[var(--material-thick)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        >
          {callout}
        </div>
      )}
    </div>
  )
}
