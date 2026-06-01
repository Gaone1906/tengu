/**
 * Jinn Talk — TaskTracker (Concept AURA).
 *
 * A floating glass HUD panel (intended top-right of the full-screen Talk page)
 * that rolls up the parallel jobs the COO is running. One row per task: a
 * status dot (colored by status; running pulses), the task title, a mono owner
 * chip, a thin animated progress bar (eased width, or an indeterminate shimmer
 * for running rows without concrete progress), and — when done/errored — a
 * settled tinted result line.
 *
 * Visual language mirrors the AURA prototype's `.card` / `.ttl` / `.bar` /
 * `.chip`, but as a calm glass panel that layers over the living orb. All color
 * comes from Ledger tokens (works light + dark, no hardcoded colors). Motion
 * uses the shared EASING strings from ./motion, injected as CSS vars so the
 * co-located keyframes feel identical to JS-driven motion. Honors
 * prefers-reduced-motion (opacity only — see tracker.css).
 */
import { useMemo } from "react"
import type { CSSProperties, JSX } from "react"
import type { TrackerTask, JobStatus } from "./types"
import { EASING } from "./motion"
import "./tracker.css"

export interface TaskTrackerProps {
  tasks: TrackerTask[]
  className?: string
}

/** Stagger between row enter animations (ms). */
const ROW_STAGGER = 70

/** Expose the canonical easing curves to the stylesheet once, at the root. */
const EASE_VARS: CSSProperties = {
  ["--ease-spring" as string]: EASING.spring,
  ["--ease-smooth" as string]: EASING.smooth,
  ["--ease-snappy" as string]: EASING.snappy,
}

/** Human, accent-colored count badge: prefer running, else any active work. */
function deriveCount(tasks: TrackerTask[]): string {
  const running = tasks.filter((t) => t.status === "running").length
  if (running > 0) return `${running} RUNNING`
  const active = tasks.filter(
    (t) => t.status === "running" || t.status === "queued",
  ).length
  if (active > 0) return `${active} ACTIVE`
  const done = tasks.filter((t) => t.status === "done").length
  if (done > 0 && done === tasks.length) return "ALL DONE"
  const errored = tasks.filter((t) => t.status === "error").length
  if (errored > 0) return `${errored} ERROR`
  return `${tasks.length} TASKS`
}

function TaskRow({ task, index }: { task: TrackerTask; index: number }) {
  const { title, owner, status, progress, result } = task

  // Bar fill: concrete progress when we have it; running-without-progress gets
  // an indeterminate shimmer; queued sits empty; done/error settle full.
  const hasProgress = typeof progress === "number"
  const indeterminate = status === "running" && !hasProgress
  const settled = status === "done" || status === "error"

  const fillWidth = settled
    ? "100%"
    : hasProgress
      ? `${Math.round(clamp01(progress!) * 100)}%`
      : status === "queued"
        ? "0%"
        : undefined // running+indeterminate: width is driven by the shimmer class

  const fillClass = [
    "tracker__bar-fill",
    indeterminate ? "tracker__bar-fill--indeterminate" : "",
    status === "done" ? "tracker__bar-fill--done" : "",
    status === "error" ? "tracker__bar-fill--error" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const rowStyle: CSSProperties = {
    ["--enter-delay" as string]: `${index * ROW_STAGGER}ms`,
  }

  return (
    <div
      className={`tracker__row${status === "error" ? " tracker__row--error" : ""}`}
      style={rowStyle}
      data-status={status}
    >
      <span
        className={`tracker__dot tracker__dot--${status}`}
        aria-hidden="true"
      />
      <span className="tracker__title">{title}</span>
      <span className="tracker__owner">{owner}</span>

      <div
        className="tracker__bar"
        role="progressbar"
        aria-label={`${title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          settled ? 100 : hasProgress ? Math.round(clamp01(progress!) * 100) : undefined
        }
      >
        <span
          className={fillClass}
          style={fillWidth != null ? { width: fillWidth } : undefined}
        />
      </div>

      {settled && result ? (
        <div className={`tracker__result tracker__result--${status}`}>
          {result}
        </div>
      ) : null}
    </div>
  )
}

export function TaskTracker({ tasks, className }: TaskTrackerProps): JSX.Element {
  const count = useMemo(() => deriveCount(tasks), [tasks])

  return (
    <section
      className={`tracker${className ? ` ${className}` : ""}`}
      style={EASE_VARS}
      aria-label="Parallel tasks"
    >
      <header className="tracker__header">
        <span className="tracker__eyebrow">Parallel Tasks</span>
        <span className="tracker__count">{count}</span>
      </header>

      <div className="tracker__list">
        {tasks.map((task, i) => (
          <TaskRow key={task.id} task={task} index={i} />
        ))}
      </div>
    </section>
  )
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// Keep the JobStatus import meaningful for downstream readers / tooling.
export type { JobStatus }
