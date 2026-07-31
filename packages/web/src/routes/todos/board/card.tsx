import { memo, useCallback, useMemo } from "react"
import { Bell, Calendar, ChevronRight, Pause, TriangleAlert } from "lucide-react"
import type {
  Employee,
  WorkItemCompactWire,
  WorkItemOpenDetailWire,
  WorkItemTreeWire,
} from "@/lib/api"
import { publicWorkItemReference } from "@/lib/todos"
import { stripMarkdown } from "@/lib/strip-markdown"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateCircle } from "../state-glyph"
import { stateKeyOf } from "@/lib/todos"
import { CardTree } from "./card-tree"

/* Todos v2 slice 6 — the board card (design-doc §3, states mock specimen 3).
 * Status is NEVER on the card — the column says it. Variant A adds one quiet,
 * markdown-free body preview so the board carries enough context to choose a
 * conversation. Mobile keeps the same preview under its compact title row. */

export interface CardEnrichment {
  tree?: WorkItemTreeWire
  detail?: WorkItemOpenDetailWire
}

/** Roll-up counts over all descendants (the mock's 2/5 = closed/total). */
export function rollupOf(tree: WorkItemTreeWire | undefined, rootStatus: string): { closed: number; total: number } | null {
  if (!tree) return null
  let total = 0
  let closed = 0
  for (const [status, count] of Object.entries(tree.totals)) {
    total += count ?? 0
    if (status === "done" || status === "cancelled") closed += count ?? 0
  }
  // The totals include the root itself — remove it.
  total -= 1
  if (rootStatus === "done" || rootStatus === "cancelled") closed -= 1
  if (total <= 0) return null
  return { closed, total }
}

/** The one-line why on blocked/escalated cards: the latest transition note. */
export function reasonOf(item: WorkItemCompactWire, detail: WorkItemOpenDetailWire | undefined): string | null {
  if (item.status !== "blocked" && item.status !== "escalated") return null
  const events = detail?.events ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.toStatus === item.status) {
      const note = typeof e.detail?.note === "string" ? e.detail.note.trim() : ""
      if (note) return note
      if (e.kind === "escalated" && typeof e.detail?.reason === "string") {
        return e.detail.reason === "max-rounds-exhausted" ? "Review rounds exhausted" : e.detail.reason
      }
      return null
    }
  }
  return null
}

/** Elapsed label for the executing StateLine ("Working · 21m"). Only cards
 *  with a live session ref carry the line (the mock: PLA-18/ACM-41, not
 *  PLA-12) — the StateLine is delegation grammar about a session, not a
 *  generic "this column is executing" repeat. */
export function workingSince(item: WorkItemCompactWire, detail: WorkItemOpenDetailWire | undefined): string | null {
  if (item.status !== "executing" || !item.sessionRef) return null
  const events = detail?.events ?? []
  let startedAt: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].toStatus === "executing") {
      startedAt = events[i].createdAt
      break
    }
  }
  const start = Date.parse(startedAt ?? item.updatedAt)
  if (Number.isNaN(start)) return null
  const mins = Math.max(0, Math.round((Date.now() - start) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Vertical anatomy used by the column FLIP dependency. Enrichment may add a
 * body preview, state line, reason, or first footer after the column painted;
 * each bit tells the column to cushion cards below that growth. */
export function cardLayoutKey(item: WorkItemCompactWire, enrichment: CardEnrichment | undefined): string {
  const tree = enrichment?.tree
  const detail = enrichment?.detail
  const rollup = rollupOf(tree, item.status)
  const spendUsd = tree?.spendUsd ?? 0
  const body = stripMarkdown(tree?.root.body ?? "").trim().length > 0
  const working = workingSince(item, detail) !== null
  const reason = reasonOf(item, detail) !== null
  const footer = !!item.assignee || !!rollup || (spendUsd > 0 && (!!item.dueAt || item.approvalState === "pending"))
  return `${Number(body)}${Number(working)}${Number(reason)}${Number(footer)}`
}

function formatDue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** Priority bars (polish law 14: bars ride 0.5px high). 3=High strong bars,
 *  1=Low first-bar-only, 2=Medium hidden on desktop cards (the mock's rule).
 *  The wire has no urgent level (0..3, spec §3.1). */
export function PriorityGlyph({ priority, muted = false }: { priority: number; muted?: boolean }) {
  if (priority === 2 && !muted) return null
  const strong = priority >= 3
  const low = priority <= 1
  const barColor = strong ? "var(--text-secondary)" : "var(--text-quaternary)"
  return (
    <span
      aria-hidden
      className="relative top-[-0.5px] flex flex-none items-end gap-[1.5px]"
      style={{ height: 10 }}
      data-testid="prio-bars"
      data-priority={priority}
    >
      {[4, 7, 10].map((h, i) => (
        <i
          key={h}
          className="block w-[2.5px] rounded-[1px]"
          style={{ height: h, background: barColor, opacity: low && i > 0 ? 0.35 : 1 }}
        />
      ))}
    </span>
  )
}

export interface BoardCardProps {
  item: WorkItemCompactWire
  enrichment?: CardEnrichment
  byName: Map<string, Employee>
  expanded: boolean
  onToggleTree: (id: string) => void
  onOpen: (id: string, item?: WorkItemCompactWire) => void
  onOpenChild: (id: string) => void
  onAddSubTask: (parentId: string, title: string) => void
  /** Drag lift entry point (the drag hook owns pointer capture). */
  onLiftPointerDown?: (event: React.PointerEvent, item: WorkItemCompactWire) => void
  dragging?: boolean
  /** Rendered as the floating drag preview: lifted treatment, inert. */
  ghost?: boolean
}

export const BoardCard = memo(function BoardCard({
  item,
  enrichment,
  byName,
  expanded,
  onToggleTree,
  onOpen,
  onOpenChild,
  onAddSubTask,
  onLiftPointerDown,
  dragging,
  ghost,
}: BoardCardProps) {
  const tree = enrichment?.tree
  const detail = enrichment?.detail
  const rollup = useMemo(() => rollupOf(tree, item.status), [tree, item.status])
  const reason = reasonOf(item, detail)
  const working = workingSince(item, detail)
  const priority = tree?.root.priority ?? detail?.workItem.priority ?? 2
  const spendUsd = tree?.spendUsd ?? 0
  const employee = item.assignee ? byName.get(item.assignee) : undefined
  const assigneeName = employee?.displayName ?? item.assignee
  const overdue = !!item.dueAt && Date.parse(item.dueAt) < Date.now()
  const approvalPending = item.approvalState === "pending"
  const sessionRefLabel = publicWorkItemReference(item.sessionRef?.ref ?? null)
  const addSubTask = useCallback((title: string) => onAddSubTask(item.id, title), [item.id, onAddSubTask])
  const bodyPreview = stripMarkdown(tree?.root.body ?? "").replace(/\s*\n+\s*/g, " ")

  return (
    <article
      data-board-card={item.id}
      data-testid={`board-card-${item.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${item.id} ${item.title}`}
      onClick={() => onOpen(item.id, item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen(item.id, item)
      }}
      onPointerDown={(e) => onLiftPointerDown?.(e, item)}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 160px" }}
      className={[
        "group focus-ring cursor-pointer select-none rounded-[var(--radius-lg)] px-[13px] py-3 outline-none transition-colors duration-150",
        ghost
          ? "bg-[var(--bg-tertiary)] shadow-[var(--shadow-overlay)]"
          : "bg-[var(--bg-secondary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] hover:bg-[var(--bg-tertiary)]",
        ghost
          ? ""
          : "max-[700px]:flex max-[700px]:flex-wrap max-[700px]:items-center max-[700px]:gap-2.5 max-[700px]:rounded-xl max-[700px]:bg-transparent max-[700px]:px-1.5 max-[700px]:py-3 max-[700px]:shadow-none max-[700px]:hover:bg-[var(--fill-quaternary)]",
        dragging ? "opacity-0" : "",
      ].join(" ")}
    >
      {/* Mobile lead: priority bars (always, muted at Medium) + status disc. */}
      <span className="hidden max-[700px]:flex max-[700px]:items-center max-[700px]:gap-2.5">
        <PriorityGlyph priority={priority} muted />
        <StateCircle keyOf={stateKeyOf(item.status)} size={20} />
      </span>

      {/* Top row: priority · ID · due/approval right. Never status. */}
      <div className="flex min-h-4 items-center gap-[7px] max-[700px]:hidden">
        <PriorityGlyph priority={priority} />
        <span
          className="text-[11px] tracking-[.04em] text-[var(--text-tertiary)]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {item.id}
        </span>
        {approvalPending ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-[var(--accent)]">
            <Bell size={11} aria-hidden /> Approval
          </span>
        ) : item.dueAt ? (
          <span
            className={`ml-auto flex items-center gap-1 text-[11px] ${overdue ? "text-[var(--system-red)]" : "text-[var(--text-tertiary)]"}`}
          >
            <Calendar size={11} aria-hidden />
            {formatDue(item.dueAt)}
          </span>
        ) : spendUsd > 0 ? (
          <span className="ml-auto text-[11px] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
            ${spendUsd.toFixed(2)}
          </span>
        ) : null}
      </div>

      {/* Title — the only primary ink on the card. 2-line clamp / 1-line mobile. */}
      <div className="mt-1 line-clamp-2 text-[15px] font-medium leading-[1.3] text-[var(--text-primary)] max-[700px]:m-0 max-[700px]:line-clamp-1 max-[700px]:min-w-0 max-[700px]:flex-1 max-[700px]:text-[16px]">
        {item.title}
      </div>

      {bodyPreview && (
        <div className="mt-1.5 line-clamp-1 min-w-0 text-[12.5px] leading-[1.35] text-[var(--text-tertiary)] max-[700px]:ml-[50px] max-[700px]:mt-[-4px] max-[700px]:basis-full max-[700px]:pr-2">
          {bodyPreview}
        </div>
      )}

      {/* Labels: dot + name chips. */}
      {(item.labels?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-[5px] max-[700px]:hidden">
          {item.labels!.map((label) => (
            <span
              key={label.id}
              className="flex h-5 items-center gap-[5px] rounded-[10px] bg-[var(--fill-tertiary)] px-2 text-[11px] font-medium text-[var(--text-secondary)]"
            >
              <span
                className="size-[5px] rounded-full"
                style={{ background: label.color ?? "var(--text-quaternary)" }}
              />
              {label.name}
            </span>
          ))}
        </div>
      )}

      {/* Executing StateLine — delegation grammar verbatim. */}
      {working && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--system-blue)] max-[700px]:hidden">
          <span className="size-1.5 flex-none rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]" aria-hidden />
          <span className="whitespace-nowrap">Working · {working}</span>
          {sessionRefLabel && (
            <span className="truncate text-[11px] font-normal text-[var(--text-tertiary)]" style={{ fontFamily: "var(--font-code)" }}>
              {sessionRefLabel}
            </span>
          )}
        </div>
      )}

      {/* Blocked/escalated: the card carries WHY (the only tinted text).
          The mock leads the line with a small bare status glyph (F4). */}
      {reason && (
        <div
          className={`mt-2 flex items-center gap-1.5 text-[12px] max-[700px]:hidden ${
            item.status === "escalated" ? "text-[var(--system-red)]" : "text-[var(--system-orange)]"
          }`}
        >
          {item.status === "escalated" ? (
            <TriangleAlert size={11} aria-hidden className="flex-none" />
          ) : (
            <Pause size={11} aria-hidden className="flex-none" />
          )}
          {reason}
        </div>
      )}

      {/* Footer: assignee · roll-up · spend right. */}
      {(assigneeName || rollup || (spendUsd > 0 && (item.dueAt || approvalPending))) && (
        <div className="mt-2 flex items-center gap-2 max-[700px]:m-0 max-[700px]:gap-1.5">
          {assigneeName && (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <EmployeeAvatar name={item.assignee!} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
              <span className="truncate max-[700px]:hidden">{assigneeName}</span>
            </span>
          )}
          {rollup && (
            <button
              type="button"
              data-testid={`board-rollup-${item.id}`}
              aria-expanded={expanded}
              aria-label={`${rollup.closed} of ${rollup.total} sub-tasks done — ${expanded ? "collapse" : "expand"}`}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTree(item.id)
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="focus-ring flex h-5 items-center gap-1 rounded-[10px] bg-[var(--fill-tertiary)] py-0 pl-[5px] pr-2 text-[11px] font-medium tabular-nums text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <ChevronRight
                size={10}
                aria-hidden
                className={`text-[var(--text-quaternary)] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
              />
              {rollup.closed}/{rollup.total}
            </button>
          )}
          {spendUsd > 0 && (item.dueAt || approvalPending) && (
            <span className="ml-auto text-[11px] text-[var(--text-quaternary)] max-[700px]:hidden" style={{ fontFamily: "var(--font-code)" }}>
              ${spendUsd.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* In-place tree tray. */}
      {expanded && tree && (
        <CardTree
          tree={tree}
          cardDepth={item.depth ?? 0}
          onOpenChild={onOpenChild}
          onAddSubTask={addSubTask}
        />
      )}
    </article>
  )
})
