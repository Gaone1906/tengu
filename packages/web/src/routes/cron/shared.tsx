import { Check, Minus, X } from "lucide-react"
import type { Employee } from "@/lib/api"

/* design-cron §2 — shared grammar for the Cron list + detail: the wire types
 * the gateway's read tier actually returns (compact by design — prompt/env are
 * deliberately scrubbed server-side), the last-run outcome glyph, and the
 * settings-idiom ToggleSwitch. */

export interface CronRunWire {
  id?: string
  jobId?: string
  timestamp?: string | number
  startedAt?: string | number
  finishedAt?: string | number
  sessionKey?: string
  status?: string
  exitCode?: number
  durationMs?: number
  duration?: number
}

export interface CronJobWire {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string | null
  engine?: string | null
  timezone?: string | null
  lastRun?: CronRunWire | null
  [key: string]: unknown
}

export function runTimestamp(run: CronRunWire | null | undefined): string | number | null {
  if (!run) return null
  return run.timestamp ?? run.startedAt ?? null
}

export function runDurationMs(run: CronRunWire | null | undefined): number | null {
  if (!run) return null
  return run.durationMs ?? run.duration ?? null
}

export type RunOutcome = "ok" | "error" | "running" | "none"

export function runOutcome(run: CronRunWire | null | undefined): RunOutcome {
  switch (run?.status) {
    case "success":
      return "ok"
    case "error":
      return "error"
    case "started":
      return "running"
    default:
      return "none" // never ran / skipped / duplicate / expired
  }
}

/** The 24px last-run outcome circle (Todos StatusCircle grammar): ✓ success,
 *  ✕ error, pulsing dot while a run is live, quiet dash otherwise. */
export function RunGlyph({ outcome, size = 24 }: { outcome: RunOutcome; size?: number }) {
  const palette: Record<RunOutcome, { bg: string; fg: string }> = {
    ok: { bg: "color-mix(in srgb, var(--system-green) 13%, transparent)", fg: "var(--system-green)" },
    error: { bg: "color-mix(in srgb, var(--system-red) 13%, transparent)", fg: "var(--system-red)" },
    running: { bg: "color-mix(in srgb, var(--system-blue) 13%, transparent)", fg: "var(--system-blue)" },
    none: { bg: "var(--fill-tertiary)", fg: "var(--text-quaternary)" },
  }
  const { bg, fg } = palette[outcome]
  return (
    <span
      className="grid flex-none place-items-center rounded-full"
      style={{ width: size, height: size, background: bg, color: fg }}
      aria-hidden
    >
      {outcome === "ok" && <Check size={size * 0.5} strokeWidth={3} />}
      {outcome === "error" && <X size={size * 0.46} strokeWidth={3} />}
      {outcome === "running" && (
        <span
          className="rounded-full motion-safe:animate-[jinn-pulse_1.4s_var(--ease-smooth)_infinite]"
          style={{ width: size / 3, height: size / 3, background: "currentColor" }}
        />
      )}
      {outcome === "none" && <Minus size={size * 0.42} strokeWidth={3} />}
    </span>
  )
}

/** The settings-page switch idiom — the one enable/disable interaction. */
export function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className="relative h-[24px] w-[44px] flex-none cursor-pointer rounded-[12px] border-none transition-[background] duration-200 ease-[var(--ease-smooth)]"
      style={{ background: checked ? "var(--system-green)" : "var(--fill-primary)" }}
    >
      <span
        className="absolute top-[2px] size-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-[var(--ease-spring)]"
        style={{ left: checked ? 22 : 2 }}
      />
    </button>
  )
}

export function displayNameOf(name: string | null | undefined, byName: Map<string, Employee>): string {
  if (!name) return "Unassigned"
  return byName.get(name)?.displayName || name
}

/** Group jobs by employee: largest groups first, Unassigned always last.
 *  Pure — unit-tested. */
export function groupJobsByEmployee(jobs: CronJobWire[]): { employee: string | null; jobs: CronJobWire[] }[] {
  const map = new Map<string | null, CronJobWire[]>()
  for (const job of jobs) {
    const key = job.employee || null
    const list = map.get(key)
    if (list) list.push(job)
    else map.set(key, [job])
  }
  return Array.from(map.entries())
    .map(([employee, list]) => ({ employee, jobs: list }))
    .sort((a, b) => {
      if (a.employee === null) return 1
      if (b.employee === null) return -1
      return b.jobs.length - a.jobs.length || a.employee.localeCompare(b.employee)
    })
}

export type CronFilter = "all" | "enabled" | "disabled"

export function filterJobs(jobs: CronJobWire[], filter: CronFilter): CronJobWire[] {
  if (filter === "enabled") return jobs.filter((j) => j.enabled)
  if (filter === "disabled") return jobs.filter((j) => !j.enabled)
  return jobs
}
