import { AlertTriangle, RefreshCw } from "lucide-react"
import type {
  EngineLimitEngineSnapshot,
  EngineLimitWindow,
} from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { Skeleton } from "@/components/ui/skeleton"
import { deriveFreshness, useEngineLimits, type FreshnessKind } from "./use-engine-limits"
import {
  deriveGovernorTone,
  useSessionTelemetry,
  type GovernorTone,
  type SessionTelemetryEvent,
  type SessionTelemetryRow,
} from "@/hooks/use-session-telemetry"

const DANGER = 90

function formatDuration(minutes?: number) {
  if (!minutes) return ""
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function windowLabel(window: EngineLimitWindow) {
  return formatDuration(window.windowDurationMins) || window.name
}

function clampPercent(value?: number) {
  return Math.max(0, Math.min(100, value ?? 0))
}

function barColor(value?: number) {
  return (value ?? 0) >= DANGER ? "var(--system-red)" : "var(--accent)"
}

function resetLabel(iso: string | undefined, now: number) {
  if (!iso) return null
  const diff = new Date(iso).getTime() - now
  if (diff <= 0) return "resetting now"
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `resets in ${hrs}h`
  const days = Math.round(hrs / 24)
  if (days <= 7) return `resets in ${days}d`
  return `resets ${new Date(iso).toLocaleDateString()}`
}

function agoLabel(iso: string | undefined, now: number) {
  if (!iso) return "unknown"
  const diff = now - new Date(iso).getTime()
  const mins = Math.max(0, Math.round(diff / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// Freshness kind → badge tone + label, evaluated at render time so a snapshot
// that ages past the freshness window flips to "Stale" without a re-fetch and a
// long-open tab can never present hours-old data as current.
function badge(kind: FreshnessKind, engine: EngineLimitEngineSnapshot, now: number) {
  switch (kind) {
    case "live":
      return { color: "var(--system-green)", label: "Live" }
    case "fresh":
      return { color: "var(--text-tertiary)", label: `Updated ${agoLabel(engine.refreshedAt, now)}` }
    case "stale":
      return { color: "var(--system-orange)", label: `Stale · ${agoLabel(engine.refreshedAt, now)}` }
    case "error":
      return { color: "var(--system-red)", label: "Error" }
    case "unavailable":
      return { color: "var(--text-tertiary)", label: "Unavailable" }
    case "unsupported":
      return { color: "var(--text-quaternary)", label: "Unsupported" }
    default:
      return { color: "var(--text-quaternary)", label: "No data" }
  }
}

// Fixed, operator-safe note per freshness kind. Deliberately does NOT render
// `engine.error` verbatim: that field can carry raw parser/exception text, so
// the client shows only allowlisted copy. `unsupportedReason` is collector-
// authored literal copy (never exception-derived) and is safe to surface.
function noteFor(engine: EngineLimitEngineSnapshot, kind: FreshnessKind): string | null {
  switch (kind) {
    case "stale":
      return engine.error
        ? "Couldn’t refresh — showing last-known values."
        : "Last-known snapshot is over 30 minutes old — may be out of date."
    case "error":
      return "Latest limits couldn’t be read."
    case "unavailable":
    case "unsupported":
      return engine.unsupportedReason ?? null
    default:
      return null
  }
}

function WindowBar({ window, now }: { window: EngineLimitWindow; now: number }) {
  const observed = window.usedPercent !== undefined
  const used = clampPercent(window.usedPercent)
  const reset = resetLabel(window.resetsAtIso, now)

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {windowLabel(window)} window
        </span>
        <span className="text-[length:var(--text-body)] font-[var(--weight-bold)] text-[var(--text-primary)] tabular-nums">
          {observed ? `${window.usedPercent}%` : "—"}
        </span>
      </div>
      <div className="mt-[var(--space-2)] h-2 rounded-full bg-[var(--fill-tertiary)] overflow-hidden">
        {observed && (
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-smooth)]"
            style={{ width: `${used}%`, background: barColor(window.usedPercent) }}
          />
        )}
      </div>
      {reset && (
        <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{reset}</div>
      )}
    </div>
  )
}

function EngineCard({ engine, now }: { engine: EngineLimitEngineSnapshot; now: number }) {
  const windows = engine.windows || []
  const fresh = deriveFreshness(engine, now)
  const tone = badge(fresh.kind, engine, now)
  const credits = engine.credits
  const creditLabel = credits?.unlimited
    ? "Unlimited credits"
    : credits?.balance
      ? `Credits ${credits.balance}`
      : null
  const note = noteFor(engine, fresh.kind)

  return (
    // Grouped-inset card (shared visual language): --bg-secondary carrying the
    // page's only card shadow — no border at rest.
    <section className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-6)] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <div className="flex items-baseline gap-[var(--space-3)] min-w-0">
          <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] capitalize truncate">
            {engine.name}
          </h2>
          {engine.accountPlan && (
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
              {engine.accountPlan}
            </span>
          )}
        </div>
        <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] whitespace-nowrap">
          <span className="w-2 h-2 rounded-full" style={{ background: tone.color }} />
          {tone.label}
        </span>
      </div>

      {windows.length > 0 ? (
        <div className="mt-[var(--space-6)] grid gap-[var(--space-5)]">
          {windows.map((window) => (
            <WindowBar key={`${engine.name}-${window.name}`} window={window} now={now} />
          ))}
        </div>
      ) : (
        <div className="mt-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          No quota windows observed yet.
        </div>
      )}

      {creditLabel && (
        <div className="mt-[var(--space-5)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {creditLabel}
        </div>
      )}

      {note && (
        <div className="mt-[var(--space-5)] flex items-start gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          <AlertTriangle size={14} className="mt-[2px] flex-shrink-0" style={{ color: tone.color }} />
          <span>{note}</span>
        </div>
      )}
    </section>
  )
}

// Governor tone → badge tone + label, same fixed-copy convention as `badge()`
// above — never render raw server text, only allowlisted phrases.
function governorBadge(tone: GovernorTone) {
  switch (tone) {
    case "red":
      return { color: "var(--system-red)", label: "Near limit" }
    case "amber":
      return { color: "var(--system-orange)", label: "Elevated" }
    default:
      return { color: "var(--system-green)", label: "Nominal" }
  }
}

// Pacing/fan-out state strip (Tengu step 2 of the design; steps 4 and 9 — the
// governor and pacing controller themselves — aren't built yet). Shows the
// real account-wide usage tone honestly rather than fabricating a pacing
// decision the backend doesn't make yet.
function PacingStrip({ account, now }: { account: SessionTelemetryEvent["account"] | undefined; now: number }) {
  const tone = deriveGovernorTone(account)
  const badgeTone = tone ? governorBadge(tone) : { color: "var(--text-quaternary)", label: "No live sessions" }
  const fiveHourReset = resetLabel(account?.fiveHourResetsAt, now)

  return (
    <section className="mb-4 rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] px-[var(--space-5)] py-[var(--space-4)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          <span className="w-2 h-2 rounded-full" style={{ background: badgeTone.color }} />
          <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{badgeTone.label}</span>
          {account?.fiveHourUsedPct !== undefined && (
            <span className="tabular-nums">· 5h {account.fiveHourUsedPct}%{fiveHourReset ? ` · ${fiveHourReset}` : ""}</span>
          )}
          {account?.sevenDayUsedPct !== undefined && (
            <span className="tabular-nums">· 7d {account.sevenDayUsedPct}%</span>
          )}
        </div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Pacing: balanced · Fan-out: sequential
        </div>
      </div>
    </section>
  )
}

function SessionCard({
  session,
  now,
  employeeProgress,
}: {
  session: SessionTelemetryRow
  now: number
  employeeProgress: SessionTelemetryEvent["employeeProgress"]
}) {
  const tone = session.stale
    ? { color: "var(--system-orange)", label: `Stale · ${agoLabel(session.capturedAt, now)}` }
    : { color: "var(--system-green)", label: "Live" }
  const progress = session.employee
    ? employeeProgress.find((p) => p.assignee === session.employee)
    : undefined

  return (
    <section className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-6)] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <div className="flex items-baseline gap-[var(--space-3)] min-w-0">
          <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">
            {session.employeeDisplayName ?? session.employee ?? "Unassigned"}
          </h2>
          {session.model && (
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
              {session.model}
            </span>
          )}
        </div>
        <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] whitespace-nowrap">
          <span className="w-2 h-2 rounded-full" style={{ background: tone.color }} />
          {tone.label}
        </span>
      </div>

      <div className="mt-[var(--space-5)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] truncate">
        {session.currentTodoTitle ?? "No active todo"}
      </div>

      {progress && progress.total > 0 && (
        <div className="mt-[var(--space-5)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {progress.completed}/{progress.total} todos done
        </div>
      )}
    </section>
  )
}

function SessionsSection({ telemetry, now }: { telemetry: SessionTelemetryEvent | null; now: number }) {
  const sessions = telemetry?.sessions ?? []
  if (sessions.length === 0) return null

  return (
    <div className="mb-6">
      <h2 className="mb-3 text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
        Sessions
      </h2>
      <div className="grid items-start gap-4 md:grid-cols-2">
        {sessions.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            now={now}
            employeeProgress={telemetry?.employeeProgress ?? []}
          />
        ))}
      </div>
    </div>
  )
}

export default function LimitsPage() {
  useBreadcrumbs([{ label: 'Limits' }])
  const { data, phase, refreshing, error, now, refresh } = useEngineLimits()
  const { data: telemetry } = useSessionTelemetry()

  return (
    <PageLayout>
      {/* Same page frame as Todos: one scrolling column, inline large-title
          header — no sticky chrome bar. */}
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header className="mb-6 flex items-end justify-between gap-3">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                Limits
              </h1>
              <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                Engine usage windows and quotas
              </div>
            </div>
            <button
              onClick={refresh}
              aria-label="Refresh engine limits"
              aria-busy={refreshing}
              className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw size={17} className={refreshing ? "animate-spin" : ""} />
            </button>
          </header>

          {error && (
            <div
              className="mb-5 rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {data ? `Couldn’t refresh — showing last-known values. (${error})` : error}
            </div>
          )}

          <PacingStrip account={telemetry?.account} now={now} />

          <SessionsSection telemetry={telemetry} now={now} />

          {phase === "loading" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton height={180} className="rounded-[var(--radius-xl)]" />
              <Skeleton height={180} className="rounded-[var(--radius-xl)]" />
            </div>
          ) : (
            <div className="grid items-start gap-4 md:grid-cols-2">
              {Object.values(data?.engines ?? {}).map((engine) => (
                <EngineCard key={engine.name} engine={engine} now={now} />
              ))}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
