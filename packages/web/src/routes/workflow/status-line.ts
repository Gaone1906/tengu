import type { CanvasNode } from "./canvas-model"
import type { EditableWorkflowDefinitionWire, WorkflowRunSummaryWire } from "@/lib/api"

/* GRS-019 — plain-language status vocabulary for the workflows surfaces.
 *
 * The operator rejected the jargon walls (W-numbers, ORCHESTRATE chips, session
 * ids) on the canvas. Every string a node card or a list card shows now comes
 * from here: one short human phrase per honest state, nothing else. The honest
 * VOCABULARY itself (spawn ≠ done, parked doorbell, dispatched-unknown) is
 * unchanged — this is only its rendering. Pure data → unit-tests without DOM. */

/** One plain-language line for a canvas node card. NEVER exposes internal
 * status names; the precise state stays available in the inspector. */
export function nodeStatusLine(node: CanvasNode): string {
  const checks = node.gates.length > 0
    ? ` · ${node.gates.filter((g) => g.passed).length}/${node.gates.length} checks`
    : ""
  switch (node.status) {
    case "passed":
    case "completed":
      return `Done${checks}`
    case "active":
      return `In progress${checks}`
    case "running":
      return "Running"
    case "parked":
      return "Waits for your approval"
    case "blocked":
      return "Failed"
    case "needs_fix":
      return `Needs fixes${checks}`
    case "dispatched":
      return "Dispatched · outcome unknown"
    case "cancelled":
      return "Cancelled"
    case "draft":
      return "Draft"
    case "pending":
    default:
      return `Up next${checks}`
  }
}

/* ── Trigger summary (list cards + canvas trigger chip) ─────────────────────── */

/** Humanize the common cron shapes; fall back to the raw expression rather than
 * guessing. Deliberately small — the list card needs one calm line, not a cron
 * parser. */
export function humanizeCron(cron: string): string {
  const m = cron.trim().split(/\s+/)
  if (m.length !== 5) return cron
  const [min, hour, dom, mon, dow] = m
  const all = (f: string) => f === "*"
  if (min.startsWith("*/") && all(hour) && all(dom) && all(mon) && all(dow)) {
    return `Every ${min.slice(2)} min`
  }
  if (/^\d+$/.test(min) && hour.startsWith("*/") && all(dom) && all(mon) && all(dow)) {
    const h = hour.slice(2)
    return h === "1" ? "Every hour" : `Every ${h} hours`
  }
  if (/^\d+$/.test(min) && all(hour) && all(dom) && all(mon) && all(dow)) {
    return "Every hour"
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && all(dom) && all(mon)) {
    const hh = hour.padStart(2, "0")
    const mm = min.padStart(2, "0")
    if (all(dow)) return `Daily at ${hh}:${mm}`
    if (dow === "1-5") return `Weekdays at ${hh}:${mm}`
    return `At ${hh}:${mm} (${dow})`
  }
  return cron
}

/** One-line trigger summary for a definition: reads the (single) trigger node. */
export function triggerSummaryOf(def: Pick<EditableWorkflowDefinitionWire, "nodes">): string {
  const t = def.nodes.find((n) => n.type === "trigger")
  if (!t?.trigger) return "Manual"
  const spec = t.trigger as { kind?: string; cron?: string }
  if (spec.kind === "schedule" && typeof spec.cron === "string" && spec.cron.trim()) {
    return humanizeCron(spec.cron)
  }
  return "Manual"
}

/* ── Last-run summary (list cards) ──────────────────────────────────────────── */

/** Compact relative time for the list card — two words max. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ""
  const mins = Math.max(0, Math.round((now.getTime() - then) / 60_000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = new Date(then)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export type LastRunTone = "ok" | "fail" | "wait" | "busy" | "none"

/** Quiet glyph+words summary of the newest run for a list card. */
export function lastRunSummary(
  newest: WorkflowRunSummaryWire | undefined,
  now: Date = new Date(),
): { tone: LastRunTone; label: string } {
  if (!newest) return { tone: "none", label: "No runs yet" }
  switch (newest.status) {
    case "parked":
      return { tone: "wait", label: "Waiting for you" }
    case "running":
      return { tone: "busy", label: "Running now" }
    case "failed":
      return { tone: "fail", label: `Failed ${relativeTime(newest.startedAt, now)}` }
    case "completed":
      return { tone: "ok", label: `Ran ${relativeTime(newest.startedAt, now)}` }
    case "dispatched":
      return { tone: "busy", label: `Dispatched ${relativeTime(newest.startedAt, now)}` }
    case "cancelled":
      return { tone: "none", label: `Cancelled ${relativeTime(newest.startedAt, now)}` }
    default:
      return { tone: "none", label: relativeTime(newest.startedAt, now) }
  }
}
