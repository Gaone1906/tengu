import { Pause, TriangleAlert, Workflow, MessageSquareText } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type LinkedSessionWire } from "@/lib/api"
import { attentionOf, formatCost, monogram, provenanceLabel } from "@/lib/todos"
import { StatusCircle, ProvenanceIcon } from "./state-glyph"
import { displayNameOf, formatRelativeTime } from "./util"

/* GRS-021d — the card is a GLANCE (design's shallowest depth): status glyph,
 * title, owner, a provenance whisper, and — only when a budget is set — a cost
 * pill. blocked/escalated wear an in-place badge. One tap opens the sheet.
 *
 * GRS-024b — an executing/blocked item is actively DOING something, so it also
 * surfaces a compact execution-context line (which workflow run / session it's
 * driving) instead of leaving the operator staring at a nameless spinner. The
 * data is already in the fetched detail (workflowRun) or one linked-sessions
 * call; the card just renders it. Plain manual Todos show nothing extra. */

/** What an active item is executing — a workflow run, or (fallback) its linked
 *  session. Pure + exported so the surfacing logic is unit-testable. Returns
 *  null when there's no run context to show (non-active status, detail not yet
 *  loaded, or a plain manual Todo). */
export type ExecContext = {
  kind: "run" | "session"
  label: string
  value: string
  href: string
}

/** Shorten a long run/session id to a calm `prefix…` so the line never wraps. */
function shortRef(id: string): string {
  return id.length > 15 ? id.slice(0, 14) + "…" : id
}

export function executionContext(
  item: WorkItemCompactWire,
  detail?: WorkItemDetailWire,
  sessions?: LinkedSessionWire[],
): ExecContext | null {
  const active = item.status === "executing" || item.status === "blocked"
  if (!active || !detail) return null
  if (detail.workflowRun) {
    return {
      kind: "run",
      label: "Workflow run",
      value: shortRef(detail.workflowRun.runId),
      href: `/workflow/${encodeURIComponent(detail.workflowRun.workflowId)}`,
    }
  }
  const session = sessions?.[0]
  if (session) {
    const title = session.title?.trim()
    return {
      kind: "session",
      label: "Session",
      value: title && title.length > 0 ? title : shortRef(session.id),
      href: `/?session=${encodeURIComponent(session.id)}`,
    }
  }
  return null
}

export function OwnerChip({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
      <span className="grid size-[19px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[9.5px] font-bold text-[var(--text-secondary)]">
        {monogram(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  )
}

export function ProvChip({ source, sourceRef }: { source: WorkItemCompactWire["source"]; sourceRef?: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      <ProvenanceIcon source={source} className="flex-none opacity-85" />
      <span className="truncate">{provenanceLabel(source, sourceRef)}</span>
    </span>
  )
}

export function AttentionBadge({ kind }: { kind: "blocked" | "escalated" }) {
  const orange = kind === "blocked"
  const Icon = orange ? Pause : TriangleAlert
  return (
    <span
      className="inline-flex flex-none items-center gap-1 rounded-[6px] px-[7px] py-[2px] text-[length:var(--text-caption2)] font-semibold"
      style={{
        background: `color-mix(in srgb, var(${orange ? "--system-orange" : "--system-red"}) ${orange ? 16 : 18}%, transparent)`,
        color: `var(${orange ? "--system-orange" : "--system-red"})`,
      }}
    >
      <Icon size={10} strokeWidth={2} aria-hidden />
      {orange ? "Blocked" : "Escalated"}
    </span>
  )
}

export function TodoCard({
  item,
  detail,
  byName,
  onOpen,
  now = Date.now(),
}: {
  item: WorkItemCompactWire
  detail?: WorkItemDetailWire
  byName: Map<string, Employee>
  onOpen: (id: string) => void
  now?: number
}) {
  const navigate = useNavigate()
  const att = attentionOf(item.status)
  const cost = detail ? formatCost(detail.spendUsd, detail.workItem.budgetUsd) : null
  const sourceRef = detail?.workItem.sourceRef ?? null
  const hasOwner = !!item.assignee
  const timeHint = formatRelativeTime(item.updatedAt, now)
  const isDone = item.status === "done"

  // Execution context (GRS-024b): prefer the already-fetched workflowRun (zero
  // extra cost); only fall back to the linked-sessions call for an active item
  // that has a session but no run. The query key matches the detail sheet's, so
  // react-query dedupes it. Disabled entirely for non-active / no-detail items.
  const active = item.status === "executing" || item.status === "blocked"
  const wantSession = active && !!detail && !detail.workflowRun
  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", item.id],
    queryFn: () => api.listWorkItemSessions(item.id),
    enabled: wantSession,
    staleTime: 10_000,
  })
  const exec = executionContext(item, detail, sessions)
  const ExecIcon = exec?.kind === "run" ? Workflow : MessageSquareText

  return (
    <button
      type="button"
      data-testid={`todo-card-${item.id}`}
      onClick={() => onOpen(item.id)}
      className="hover-lift flex w-full flex-col gap-[9px] rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-[13px_14px] text-left shadow-[var(--shadow-card)]"
      style={isDone ? { opacity: 0.82 } : undefined}
    >
      <span className="flex items-start gap-2.5">
        <StatusCircle status={item.status} size={28} />
        <span className="min-w-0 flex-1 text-[14.5px] font-semibold leading-[1.32] text-[var(--text-primary)]">
          {item.title}
        </span>
        {att && <AttentionBadge kind={att} />}
      </span>
      <span className="flex flex-wrap items-center gap-2.5 pl-[38px]">
        {hasOwner ? <OwnerChip name={displayNameOf(item.assignee, byName)} /> : <ProvChip source={item.source} sourceRef={sourceRef} />}
        <span className="flex-1" />
        {cost && (
          <span className="text-[11.5px] font-semibold tabular-nums text-[var(--text-tertiary)]">{cost}</span>
        )}
        {hasOwner && !cost && !isDone && <ProvChip source={item.source} sourceRef={sourceRef} />}
        {(isDone || cost) && timeHint && (
          <span className="text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]">{timeHint}</span>
        )}
      </span>
      {exec && (
        <span
          data-testid={`todo-exec-${item.id}`}
          className="flex min-w-0 items-center gap-1.5 pl-[38px]"
        >
          <ExecIcon size={12.5} strokeWidth={2} className="flex-none text-[var(--text-tertiary)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {exec.label}
            <span className="px-1 text-[var(--text-quaternary)]">·</span>
            <span className="font-[family-name:var(--font-code)] text-[var(--text-secondary)]">{exec.value}</span>
          </span>
          {/* Direct-open affordance for pointer users; keyboard/SR users still
              reach the same run/session via the card → detail-sheet Links. A
              plain span (not a nested button) keeps the card markup valid. */}
          <span
            data-testid={`todo-exec-open-${item.id}`}
            title={exec.kind === "run" ? "Open workflow run" : "Open session"}
            onClick={(e) => {
              e.stopPropagation()
              navigate(exec.href)
            }}
            className="flex-none cursor-pointer text-[length:var(--text-caption1)] font-semibold text-[var(--accent)]"
          >
            Open
          </span>
        </span>
      )}
    </button>
  )
}
