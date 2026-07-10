import { useEffect, useRef, useState } from "react"
import { GripVertical, Pause, TriangleAlert } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCompactWire, type WorkItemDetailWire, type LinkedSessionWire } from "@/lib/api"
import { attentionOf, provenanceLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateLine } from "@/components/ui/state-line"
import { StatusCircle, ProvenanceIcon } from "./state-glyph"
import { displayNameOf, formatRelativeTime } from "./util"

/* design-todos §4.1 — the row replaces the card. Flat and calm inside ONE
 * grouped-inset container (the group owns the only card surface): 46px min,
 * 13px inner radius, hover --fill-quaternary, whole row opens the sheet.
 * Executing rows speak the delegation StateLine grammar ("Working · 12m · ref");
 * blocked rows keep the ref line so the operator can still jump to the stuck
 * work. Titles rename inline on double-click (Enter commits, Esc reverts). */

/** What an active item is executing — a workflow run, or (fallback) its linked
 *  session. Pure + exported so the surfacing logic stays unit-testable. */
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

/** The 20px emoji avatar + caption-1 name (delegation attribution unit at row
 *  density — the monogram OwnerChip is retired). Name hides ≤500px. */
export function RowEmployee({ name, byName }: { name: string; byName: Map<string, Employee> }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <EmployeeAvatar name={name} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
      <span className="max-w-[110px] truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)] max-[500px]:hidden">
        {displayNameOf(name, byName)}
      </span>
    </span>
  )
}

export function TodoRow({
  item,
  detail,
  byName,
  onOpen,
  onRename,
  onGripPointerDown,
  now = Date.now(),
}: {
  item: WorkItemCompactWire
  detail?: WorkItemDetailWire
  byName: Map<string, Employee>
  onOpen: (id: string) => void
  /** Commits an inline rename; reject → the row reverts to the server title. */
  onRename?: (id: string, title: string) => Promise<void>
  /** Present only when the group supports manual reorder (drag handle). */
  onGripPointerDown?: (e: React.PointerEvent) => void
  now?: number
}) {
  const navigate = useNavigate()
  const att = attentionOf(item.status)
  const isDone = item.status === "done"
  const timeHint = formatRelativeTime(item.updatedAt, now)

  // GRS-024b: prefer the already-fetched workflowRun (zero extra cost); only
  // fall back to the linked-sessions call for an active item that has a session
  // but no run. The key matches the detail sheet's, so react-query dedupes it.
  const active = item.status === "executing" || item.status === "blocked"
  const wantSession = active && !!detail && !detail.workflowRun
  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", item.id],
    queryFn: () => api.listWorkItemSessions(item.id),
    enabled: wantSession,
    staleTime: 10_000,
  })
  const exec = executionContext(item, detail, sessions)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.title)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = () => {
    const next = draft.trim()
    setEditing(false)
    if (!onRename || !next || next === item.title) return
    void onRename(item.id, next)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`todo-row-${item.id}`}
      onClick={() => {
        if (!editing) onOpen(item.id)
      }}
      onKeyDown={(e) => {
        if (editing) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(item.id)
        }
      }}
      className="group/row relative flex min-h-[46px] cursor-default items-center gap-2.5 rounded-[13px] py-[7px] pl-2 pr-3 transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] focus-visible:bg-[var(--fill-quaternary)] focus-visible:outline-none max-[500px]:pl-3"
      style={isDone ? { opacity: 0.78 } : undefined}
    >
      {/* Grip — hover/focus-revealed, hidden at phone widths (long-press lifts). */}
      <span
        data-testid={onGripPointerDown ? `todo-grip-${item.id}` : undefined}
        onPointerDown={onGripPointerDown}
        onClick={(e) => e.stopPropagation()}
        className={`grid w-[14px] flex-none touch-none place-items-center self-stretch text-[var(--text-quaternary)] opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 max-[500px]:hidden ${
          onGripPointerDown ? "cursor-grab" : "pointer-events-none"
        }`}
        aria-hidden
      >
        {onGripPointerDown && <GripVertical size={13} strokeWidth={2} />}
      </span>

      <StatusCircle status={item.status} size={24} />

      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-2.5">
          {editing ? (
            <input
              ref={inputRef}
              data-testid={`todo-rename-${item.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") commitRename()
                if (e.key === "Escape") {
                  setDraft(item.title)
                  setEditing(false)
                }
              }}
              className="min-w-0 flex-1 rounded-[7px] border-0 bg-[var(--fill-quaternary)] px-1.5 py-0.5 -mx-1.5 -my-0.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-primary)] outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                if (!onRename) return
                e.stopPropagation()
                setDraft(item.title)
                setEditing(true)
              }}
              className={`min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] text-[var(--text-primary)] ${
                isDone ? "font-normal text-[var(--text-secondary)]" : "font-medium"
              }`}
            >
              {item.title}
            </span>
          )}
          <span className="flex flex-none items-center gap-2.5">
            {att && <AttentionBadge kind={att} />}
            {item.assignee ? (
              <RowEmployee name={item.assignee} byName={byName} />
            ) : (
              <span className="max-[500px]:hidden">
                <ProvChip source={item.source} sourceRef={item.sourceRef} />
              </span>
            )}
            <span className="min-w-[30px] text-right text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
              {timeHint}
            </span>
          </span>
        </span>

        {exec && (
          <span data-testid={`todo-exec-${item.id}`} className="flex min-w-0 items-center gap-1.5">
            {item.status === "executing" && (
              <>
                <StateLine state="working" dispatchedAt={Date.parse(item.updatedAt) || undefined} className="flex-none whitespace-nowrap" />
                <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">·</span>
              </>
            )}
            <span className="min-w-0 truncate font-[family-name:var(--font-code)] text-[11px] text-[var(--text-tertiary)]">
              {exec.kind === "run" ? `Run · ${exec.value}` : exec.value}
            </span>
            <span
              data-testid={`todo-exec-open-${item.id}`}
              title={exec.kind === "run" ? "Open workflow run" : "Open session"}
              onClick={(e) => {
                e.stopPropagation()
                navigate(exec.href)
              }}
              className="flex-none cursor-pointer text-[length:var(--text-caption1)] font-semibold text-[var(--accent)] opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
            >
              Open ›
            </span>
          </span>
        )}
      </span>
    </div>
  )
}
