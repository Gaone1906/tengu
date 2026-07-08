import { Check, Clock, Zap, Bell, Loader2, X, AlertCircle, Send } from "lucide-react"
import type { CanvasNode } from "./canvas-model"
import { nodeStatusLine } from "./status-line"

/* GRS-019 — the ONE node card both canvas layouts render.
 *
 * Desktop (React Flow spatial) and mobile (vertical rail) differ only in
 * LAYOUT; the card itself is shared so the two breakpoints can never drift.
 * Per the approved direction: state glyph + short human label + ONE
 * plain-language status line. No role chips, no engine captions, no W-numbers
 * — everything verbose lives in the inspector. Honest-state visuals preserved:
 * a spawned step spins blue (never green), a parked gate is the yellow
 * doorbell bell with an inline Review affordance. */

export function stateGlyph(node: CanvasNode): { Icon: typeof Check; color: string; spin?: boolean; pulse?: boolean } {
  if (node.kind === "trigger") return { Icon: Zap, color: "var(--accent)" }
  switch (node.status) {
    case "parked":
      return { Icon: Bell, color: "var(--system-yellow)", pulse: true }
    case "passed":
    case "completed":
      return { Icon: Check, color: "var(--system-green)" }
    case "running":
      // Spawn ≠ done: spun blue, NEVER a green check (Fable memo-5 §2.2).
      return { Icon: Loader2, color: "var(--system-blue)", spin: true }
    case "active":
      return { Icon: Loader2, color: "var(--system-blue)", spin: true }
    case "blocked":
      return { Icon: AlertCircle, color: "var(--system-red)" }
    case "needs_fix":
      return { Icon: AlertCircle, color: "var(--system-orange)" }
    case "dispatched":
      return { Icon: Send, color: "var(--text-tertiary)" }
    case "cancelled":
      return { Icon: X, color: "var(--text-tertiary)" }
    default:
      return { Icon: Clock, color: "var(--text-tertiary)" }
  }
}

function StateCircle({ node, dense = false }: { node: CanvasNode; dense?: boolean }) {
  const { Icon, color, spin, pulse } = stateGlyph(node)
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full ${dense ? "size-7" : "size-8"}`}
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
    >
      <Icon className={`${dense ? "size-3.5" : "size-4"} ${spin ? "animate-spin" : ""} ${pulse ? "animate-pulse" : ""}`} style={{ color }} />
    </span>
  )
}

/** The trigger renders as a calm chip, not a step card — the schedule reads at
 * a glance ("Every 2 hours"), and tapping it still opens the inspector. */
function TriggerChip({
  node,
  selected,
  onSelect,
}: {
  node: CanvasNode
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      data-node-id={node.id}
      data-testid={`wf-node-${node.id}`}
      aria-pressed={selected}
      className="inline-flex h-9 items-center gap-2 rounded-full px-4 text-[length:var(--text-footnote)] font-[var(--weight-semibold)]"
      style={{
        background: "var(--accent-fill)",
        color: "var(--accent)",
        boxShadow: selected
          ? "0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent), var(--inset-shine)"
          : "var(--inset-shine)",
      }}
    >
      <Zap className="size-3.5" aria-hidden />
      <span className="max-w-[220px] truncate">{node.cadence ?? node.title}</span>
    </button>
  )
}

/** One workflow node card — glyph, label, one status line. Shared verbatim by
 * the spatial canvas (desktop) and the rail (mobile). */
export function NodeCard({
  node,
  selected,
  onSelect,
  width,
  height,
  dense = false,
  reviewAffordance = true,
}: {
  node: CanvasNode
  selected: boolean
  onSelect: (id: string) => void
  /** Fixed box for the spatial canvas; the rail leaves these unset (fluid). */
  width?: number
  height?: number
  /** Tighter paddings/type for side-by-side rail pairs at 390px. */
  dense?: boolean
  /** The parked Review chip (rail only — the spatial card stays uncluttered;
   * tapping the node opens the inspector where Approve lives). */
  reviewAffordance?: boolean
}) {
  if (node.kind === "trigger") {
    return (
      <div className="flex items-center justify-center" style={width ? { width, height } : undefined}>
        <TriggerChip node={node} selected={selected} onSelect={onSelect} />
      </div>
    )
  }
  const parked = node.status === "parked"
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      data-node-id={node.id}
      data-testid={`wf-node-${node.id}`}
      aria-pressed={selected}
      data-current={node.isCurrent || undefined}
      className={`flex items-center rounded-[var(--radius-lg)] text-left transition-[transform,box-shadow] duration-200 ${dense ? "gap-2.5 px-3" : "gap-3 px-3.5"}`}
      style={{
        width,
        height,
        minHeight: height ?? 60,
        background: "var(--bg-secondary)",
        boxShadow: selected
          ? "var(--shadow-key), 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent)"
          : node.isCurrent
            ? "var(--shadow-key), 0 0 0 3px var(--accent-fill)"
            : "var(--shadow-card)",
      }}
    >
      <StateCircle node={node} dense={dense} />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)] ${dense ? "text-[14px]" : "text-[length:var(--text-subheadline)]"}`}
          title={node.title}
        >
          {node.title}
        </span>
        <span className={`block truncate ${dense ? "text-[length:var(--text-caption2)]" : "text-[length:var(--text-caption1)]"} ${node.isCurrent || parked ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]"}`}>
          {nodeStatusLine(node)}
        </span>
      </span>
      {parked && reviewAffordance && (
        <span
          className="shrink-0 rounded-full px-3 py-1 text-[length:var(--text-footnote)] font-[var(--weight-semibold)]"
          style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
        >
          Review
        </span>
      )}
    </button>
  )
}
