import { AlertTriangle, Check } from "lucide-react"
import type { WorkflowRunStatusV2, WorkflowTriggerKindV2 } from "@/lib/api"

// One status grammar for runs, node runs, and attempts (their status unions
// overlap): a glyph kind + color per status, rendered by StatusGlyph/StatusLine.
// `live` statuses keep queries polling.
type GlyphKind = "dot" | "pulse" | "check" | "alert"

export interface StatusMeta {
  label: string
  kind: GlyphKind
  color: string
  live?: boolean
}

export const STATUS_META: Record<string, StatusMeta> = {
  pending: { label: "Pending", kind: "dot", color: "var(--text-quaternary)", live: true },
  ready: { label: "Ready", kind: "dot", color: "var(--text-quaternary)", live: true },
  dispatching: { label: "Dispatching", kind: "pulse", color: "var(--system-blue)", live: true },
  running: { label: "Running", kind: "pulse", color: "var(--system-blue)", live: true },
  waiting: { label: "Waiting", kind: "dot", color: "var(--system-orange)", live: true },
  completed: { label: "Completed", kind: "check", color: "var(--system-green)" },
  failed: { label: "Failed", kind: "alert", color: "var(--system-red)" },
  "timed-out": { label: "Timed out", kind: "alert", color: "var(--system-red)" },
  skipped: { label: "Skipped", kind: "dot", color: "var(--text-quaternary)" },
  cancelled: { label: "Cancelled", kind: "dot", color: "var(--text-tertiary)" },
}

const FALLBACK_META: StatusMeta = { label: "Unknown", kind: "dot", color: "var(--text-quaternary)" }

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? FALLBACK_META
}

export function isLiveRunStatus(status: WorkflowRunStatusV2 | undefined): boolean {
  return status !== undefined && Boolean(STATUS_META[status]?.live)
}

export const TRIGGER_KIND_LABEL: Record<WorkflowTriggerKindV2, string> = {
  manual: "Manual",
  schedule: "Schedule",
  event: "Event",
  "todo-status": "Todo status",
  "workflow-call": "Workflow call",
}

export function StatusGlyph({ status }: { status: string }) {
  const meta = statusMeta(status)
  if (meta.kind === "check") {
    return <Check size={13} strokeWidth={2.5} aria-hidden className="shrink-0" style={{ color: meta.color }} />
  }
  if (meta.kind === "alert") {
    return <AlertTriangle size={13} strokeWidth={2} aria-hidden className="shrink-0" style={{ color: meta.color }} />
  }
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full ${meta.kind === "pulse" ? "animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" : ""}`}
      style={{ backgroundColor: meta.color }}
    />
  )
}

export function StatusLine({ status, className = "" }: { status: string; className?: string }) {
  const meta = statusMeta(status)
  return (
    <span
      data-run-status={status}
      className={`inline-flex items-center gap-[6px] text-[length:var(--text-caption1)] font-[var(--weight-medium)] ${className}`}
      style={{ color: meta.color }}
    >
      <StatusGlyph status={status} />
      {meta.label}
    </span>
  )
}

export function formatDuration(startedAt: string | undefined, endedAt: string | null | undefined): string {
  if (!startedAt) return ""
  const start = Date.parse(startedAt)
  const end = endedAt ? Date.parse(endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ""
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
const DATE_CLOCK = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
})

export function formatStarted(iso: string): string {
  const value = Date.parse(iso)
  if (!Number.isFinite(value)) return iso
  const date = new Date(value)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? CLOCK.format(date) : DATE_CLOCK.format(date)
}
