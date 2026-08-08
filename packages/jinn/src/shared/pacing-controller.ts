import type { PacingConfig } from "./types.js";

/**
 * Pacing controller (docs/tengu/08-pacing-controller.md, D9) — spend the
 * 5-hour window, protect the 7-day one. Pure arithmetic, evaluated on every
 * telemetry write plus a 60s idle tick (see gateway wiring); this module
 * itself has no timers or I/O, so it stays trivially unit-testable and can
 * never itself become the polling agent the design explicitly rejects.
 *
 * `effort` moves BEFORE fan-out on both the accelerate and throttle ladders
 * (docs/tengu/08-pacing-controller.md "Effort is the primary throttle"): it
 * burns budget with zero duplication/merge/mid-flight-halt risk, so it is
 * exhausted before concurrency — the riskier lever — is ever touched.
 */

export type PacingMode = "even" | "balanced" | "eager";
export type PacingAction = "accelerate" | "hold" | "throttle";
export type FanoutDegree = 1 | 2 | 3;

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Never start a unit that would cross this fraction of the 5-hour window —
 *  the same stop line the governor halts at (shared/governor.ts). */
export const PACING_SOFT_CEILING_PCT = 80;

export type ResolvedPacingConfig = Required<PacingConfig>;

export const DEFAULT_PACING_CONFIG: ResolvedPacingConfig = {
  mode: "balanced",
  accelerateBelowPace: 0.8,
  throttleAbovePace: 1.2,
  accelerateAfterWindowElapsed: 0.6,
  noFanoutAfterWindowElapsed: 0.85,
  effortLadder: ["low", "medium", "high", "xhigh"],
  eagerModeWeeklyBrake: 70,
};

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolvePacingConfig(config: PacingConfig | undefined): ResolvedPacingConfig {
  return {
    mode: config?.mode ?? DEFAULT_PACING_CONFIG.mode,
    accelerateBelowPace: positiveNumber(config?.accelerateBelowPace, DEFAULT_PACING_CONFIG.accelerateBelowPace),
    throttleAbovePace: positiveNumber(config?.throttleAbovePace, DEFAULT_PACING_CONFIG.throttleAbovePace),
    accelerateAfterWindowElapsed: positiveNumber(config?.accelerateAfterWindowElapsed, DEFAULT_PACING_CONFIG.accelerateAfterWindowElapsed),
    noFanoutAfterWindowElapsed: positiveNumber(config?.noFanoutAfterWindowElapsed, DEFAULT_PACING_CONFIG.noFanoutAfterWindowElapsed),
    effortLadder: config?.effortLadder && config.effortLadder.length > 0 ? config.effortLadder : DEFAULT_PACING_CONFIG.effortLadder,
    eagerModeWeeklyBrake: positiveNumber(config?.eagerModeWeeklyBrake, DEFAULT_PACING_CONFIG.eagerModeWeeklyBrake),
  };
}

/** Fraction of a window elapsed, clamped to [0, 1]. `resetsAt` in the past
 *  (a stale/overdue snapshot) reads as fully elapsed rather than going
 *  negative or over 1. */
export function fractionElapsed(resetsAt: string, windowMs: number, now: Date = new Date()): number {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs) || windowMs <= 0) return 0;
  const elapsed = 1 - (resetMs - now.getTime()) / windowMs;
  return Math.min(1, Math.max(0, elapsed));
}

/** `windowsLeft = hoursUntilWeeklyReset / 5`, floored just above zero so a
 *  fair-share division near week's end degrades to "almost nothing left"
 *  rather than dividing by zero. */
export function windowsLeftInWeek(sevenDayResetsAt: string, now: Date = new Date()): number {
  const resetMs = Date.parse(sevenDayResetsAt);
  if (!Number.isFinite(resetMs)) return 1;
  const msLeft = Math.max(0, resetMs - now.getTime());
  return Math.max(msLeft / FIVE_HOUR_MS, 1e-6);
}

/** `fairShare = weeklyRemaining / windowsLeft` — the weekly-% this window may spend. */
export function computeFairShare(weeklyRemainingPct: number, windowsLeft: number): number {
  if (windowsLeft <= 0) return 0;
  return Math.max(0, weeklyRemainingPct) / windowsLeft;
}

/**
 * `paceRatio = spentThisWindow / (fairShare * windowElapsed)`. Zero elapsed
 * time or zero fair share makes the denominator zero: no spend yet reads as
 * exactly on pace (0), any spend against no runway reads as unboundedly over
 * (Infinity, correctly classified as "throttle" by classifyPaceAction).
 */
export function computePaceRatio(spentThisWindowPct: number, fairSharePct: number, windowElapsed: number): number {
  const denom = fairSharePct * windowElapsed;
  if (denom <= 0) return spentThisWindowPct > 0 ? Infinity : 0;
  return spentThisWindowPct / denom;
}

/** `< 0.8 and windowElapsed > 0.6` accelerates, `> 1.2` throttles, else hold. */
export function classifyPaceAction(paceRatio: number, windowElapsed: number, config: ResolvedPacingConfig): PacingAction {
  if (paceRatio > config.throttleAbovePace) return "throttle";
  if (paceRatio < config.accelerateBelowPace && windowElapsed > config.accelerateAfterWindowElapsed) return "accelerate";
  return "hold";
}

/** Never start a unit that would cross the soft ceiling. */
export function wouldCrossSoftCeiling(fiveHourUsedPct: number, estimatedUnitPct: number, ceilingPct: number = PACING_SOFT_CEILING_PCT): boolean {
  return fiveHourUsedPct + Math.max(0, estimatedUnitPct) >= ceilingPct;
}

export interface PacingLadderPosition {
  effort: string;
  fanoutDegree: FanoutDegree;
}

/**
 * One ladder step for the given action. Accelerate exhausts the effort ladder
 * (medium→high→xhigh) before touching fan-out (1→2→3); throttle unwinds
 * fan-out (3→2→1) before cutting effort (xhigh→…→low) — symmetric, because
 * concurrency carries the risk and comes off first. `fanoutAllowed=false`
 * (past the 85%-window-elapsed hard floor) removes fan-out from the ladder
 * entirely: acceleration must express as effort alone, per the endgame
 * refinement in 08-pacing-controller.md.
 */
export function stepPacingLadder(
  action: PacingAction,
  current: PacingLadderPosition,
  effortLadder: readonly string[],
  fanoutAllowed: boolean,
): PacingLadderPosition {
  const index = effortLadder.indexOf(current.effort);
  const effortIndex = index === -1 ? effortLadder.indexOf("medium") : index;

  if (action === "accelerate") {
    if (effortIndex >= 0 && effortIndex < effortLadder.length - 1) {
      return { effort: effortLadder[effortIndex + 1], fanoutDegree: current.fanoutDegree };
    }
    if (fanoutAllowed && current.fanoutDegree < 3) {
      return { effort: current.effort, fanoutDegree: (current.fanoutDegree + 1) as FanoutDegree };
    }
    return { ...current };
  }

  if (action === "throttle") {
    if (current.fanoutDegree > 1) {
      return { effort: current.effort, fanoutDegree: (current.fanoutDegree - 1) as FanoutDegree };
    }
    if (effortIndex > 0) {
      return { effort: effortLadder[effortIndex - 1], fanoutDegree: current.fanoutDegree };
    }
    return { ...current };
  }

  return { ...current };
}

export interface PacingTelemetry {
  now?: Date;
  fiveHourUsedPct: number;
  fiveHourResetsAt: string;
  sevenDayUsedPct: number;
  sevenDayResetsAt: string;
  /** `sevenDay.used%` recorded at the start of the CURRENT 5-hour window —
   *  shared/session-telemetry.ts's window-boundary log. */
  sevenDayUsedPctAtWindowStart: number;
}

export interface PacingDecision {
  mode: PacingMode;
  windowElapsed: number;
  weekElapsed: number;
  fairShare: number;
  spentThisWindow: number;
  paceRatio: number;
  action: PacingAction;
  /** False past `noFanoutAfterWindowElapsed` — the hard floor that holds in
   *  every mode, independent of `action`. */
  fanoutAllowed: boolean;
  next: PacingLadderPosition;
  reason: string;
}

function formatReason(action: PacingAction, paceRatio: number, next: PacingLadderPosition, windowElapsed: number, fanoutAllowed: boolean): string {
  const fanoutLabel = next.fanoutDegree === 1 ? "sequential" : `fan-out ×${next.fanoutDegree}`;
  if (!fanoutAllowed && next.fanoutDegree === 1) {
    return `Sequential — ${Math.round(windowElapsed * 100)}% of window elapsed, too late to fan out · effort ${next.effort}`;
  }
  if (action === "throttle") {
    return `Throttling — ${paceRatio.toFixed(1)}x weekly budget rate · effort ${next.effort} · ${fanoutLabel}`;
  }
  if (action === "accelerate") {
    const unusedPct = Math.max(0, Math.round((1 - Math.min(paceRatio, 1)) * 100));
    return `Accelerating — ${unusedPct}% of window budget unused · effort ${next.effort} · ${fanoutLabel}`;
  }
  return `On pace · effort ${next.effort} · ${fanoutLabel}`;
}

/**
 * The full pacing decision for one telemetry sample: compute `paceRatio`,
 * classify accelerate/hold/throttle, apply the eager-mode weekly brake and
 * the soft ceiling, then step the ladder exactly once. Pure — the caller owns
 * `current` (the session's live effort + fan-out degree) and re-evaluates on
 * every telemetry write, so repeated calls converge one rung at a time
 * instead of this function ever jumping straight to an extreme.
 */
export function evaluatePacing(
  telemetry: PacingTelemetry,
  current: PacingLadderPosition,
  config: PacingConfig | undefined,
  estimatedNextUnitPct = 0,
): PacingDecision {
  const resolved = resolvePacingConfig(config);
  const now = telemetry.now ?? new Date();
  const windowElapsed = fractionElapsed(telemetry.fiveHourResetsAt, FIVE_HOUR_MS, now);
  const weekElapsed = fractionElapsed(telemetry.sevenDayResetsAt, SEVEN_DAY_MS, now);

  const weeklyRemaining = Math.max(0, 100 - telemetry.sevenDayUsedPct);
  const fairShare = computeFairShare(weeklyRemaining, windowsLeftInWeek(telemetry.sevenDayResetsAt, now));
  const spentThisWindow = Math.max(0, telemetry.sevenDayUsedPct - telemetry.sevenDayUsedPctAtWindowStart);
  const paceRatio = computePaceRatio(spentThisWindow, fairShare, windowElapsed);

  let action = classifyPaceAction(paceRatio, windowElapsed, resolved);

  // eager: ignore weekly pacing (never throttle on paceRatio) below the brake,
  // then hard-throttle above it regardless of paceRatio.
  if (resolved.mode === "eager") {
    if (telemetry.sevenDayUsedPct > resolved.eagerModeWeeklyBrake) {
      action = "throttle";
    } else if (action === "throttle") {
      action = "hold";
    }
  }

  if (action === "accelerate" && wouldCrossSoftCeiling(telemetry.fiveHourUsedPct, estimatedNextUnitPct)) {
    action = "hold";
  }

  // Hard floor in every mode: never fan out past this window-elapsed line,
  // regardless of action, mode, or how favorable the pace is.
  const fanoutAllowed = windowElapsed <= resolved.noFanoutAfterWindowElapsed;
  const stepped = stepPacingLadder(action, current, resolved.effortLadder, fanoutAllowed);
  const next: PacingLadderPosition = fanoutAllowed ? stepped : { effort: stepped.effort, fanoutDegree: 1 };

  return {
    mode: resolved.mode,
    windowElapsed,
    weekElapsed,
    fairShare,
    spentThisWindow,
    paceRatio,
    action,
    fanoutAllowed,
    next,
    reason: formatReason(action, paceRatio, next, windowElapsed, fanoutAllowed),
  };
}
