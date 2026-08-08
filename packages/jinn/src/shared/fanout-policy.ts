import type { FanoutConfig } from "./types.js";
import { fractionElapsed, SEVEN_DAY_MS, type FanoutDegree } from "./pacing-controller.js";

/**
 * Fan-out runtime gate (docs/tengu/07-fanout-policy.md, D8) — Gate 2 of two.
 * Gate 1 is the planner's `parallelSafe`/`parallelGroup` annotation
 * (work-items/store.ts), decided once at planning time. This gate is pure
 * arithmetic over telemetry, no model call, evaluated right beside the
 * pacing controller: any single failure resolves to `1` (sequential), and
 * the runtime can only ever DOWNGRADE what planning time allowed, never
 * upgrade past it.
 */

export type { FanoutDegree };

export type ResolvedFanoutConfig = Required<FanoutConfig>;

export const DEFAULT_FANOUT_CONFIG: ResolvedFanoutConfig = {
  enabled: true,
  maxDegree: 3,
  fiveHourMaxPct: 30,
  sevenDayMaxPct: 50,
  pacingRatioMax: 1.0,
  projectedCeilingPct: 60,
  minWindowMinutesRemaining: 90,
  requireHistorySamples: 20,
};

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveFanoutConfig(config: FanoutConfig | undefined): ResolvedFanoutConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_FANOUT_CONFIG.enabled,
    maxDegree: clampDegree(positiveNumber(config?.maxDegree, DEFAULT_FANOUT_CONFIG.maxDegree)),
    fiveHourMaxPct: positiveNumber(config?.fiveHourMaxPct, DEFAULT_FANOUT_CONFIG.fiveHourMaxPct),
    sevenDayMaxPct: positiveNumber(config?.sevenDayMaxPct, DEFAULT_FANOUT_CONFIG.sevenDayMaxPct),
    pacingRatioMax: positiveNumber(config?.pacingRatioMax, DEFAULT_FANOUT_CONFIG.pacingRatioMax),
    projectedCeilingPct: positiveNumber(config?.projectedCeilingPct, DEFAULT_FANOUT_CONFIG.projectedCeilingPct),
    minWindowMinutesRemaining: positiveNumber(config?.minWindowMinutesRemaining, DEFAULT_FANOUT_CONFIG.minWindowMinutesRemaining),
    requireHistorySamples: positiveNumber(config?.requireHistorySamples, DEFAULT_FANOUT_CONFIG.requireHistorySamples),
  };
}

function clampDegree(value: number): FanoutDegree {
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  return 1;
}

export interface FanoutCircuitBreakerState {
  /** A fan-out member was halted mid-flight — off for the rest of THIS window. */
  trippedThisWindow: boolean;
  /** Sustained pace > 1.0, or a merge conflict between members — off for the
   *  rest of THIS week. */
  trippedThisWeek: boolean;
  /** Cost-per-todo measured worse than sequential over 10 samples — off
   *  indefinitely, until a human reviews and clears it (not window/week
   *  scoped, so it survives resetCircuitBreakerForNewWindow/Week). */
  autoDisabledPendingReview: boolean;
  /** Human-readable trip history, most recent last — for the stand-up. */
  reasons: string[];
}

export const NO_CIRCUIT_BREAKER_TRIPS: FanoutCircuitBreakerState = {
  trippedThisWindow: false,
  trippedThisWeek: false,
  autoDisabledPendingReview: false,
  reasons: [],
};

function trip(state: FanoutCircuitBreakerState, patch: Partial<FanoutCircuitBreakerState>, reason: string): FanoutCircuitBreakerState {
  return { ...state, ...patch, reasons: [...state.reasons, reason] };
}

export function tripCircuitBreakerForHaltedMember(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return trip(state, { trippedThisWindow: true }, "a fan-out member was halted mid-flight — off for the rest of the window");
}

export function tripCircuitBreakerForPaceOverBudget(state: FanoutCircuitBreakerState, paceRatio: number): FanoutCircuitBreakerState {
  return trip(state, { trippedThisWeek: true }, `weekly pace ${paceRatio.toFixed(1)}x budget — off for the rest of the week`);
}

export function tripCircuitBreakerForMergeConflict(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return trip(state, { trippedThisWeek: true }, "a merge conflict between fan-out members — off for the rest of the week");
}

export function tripCircuitBreakerForCostRegression(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return trip(state, { autoDisabledPendingReview: true }, "fan-out cost-per-todo worse than sequential over 10 samples — auto-disabled, flagged for review");
}

/** New 5-hour window: the window trip clears, the week trip and the
 *  pending-review disable do not. */
export function resetCircuitBreakerForNewWindow(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return { ...state, trippedThisWindow: false };
}

/** New 7-day window: both time-scoped trips clear. The pending-review
 *  disable is NOT time-scoped — it stays until a human clears it explicitly. */
export function resetCircuitBreakerForNewWeek(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return { ...state, trippedThisWindow: false, trippedThisWeek: false };
}

export function clearCircuitBreakerReview(state: FanoutCircuitBreakerState): FanoutCircuitBreakerState {
  return { ...state, autoDisabledPendingReview: false };
}

export interface CostPerTodoSample {
  fanoutCostPerTodo: number;
  sequentialCostPerTodo: number;
}

/** True once the last 10 samples show fan-out averaging worse cost-per-todo
 *  than sequential — the measured check that closes the loop on D7's
 *  duplication-overhead estimate. False below 10 samples: nothing to measure yet. */
export function costPerTodoRegressed(samples: readonly CostPerTodoSample[]): boolean {
  if (samples.length < 10) return false;
  const last10 = samples.slice(-10);
  const avgFanout = last10.reduce((sum, s) => sum + s.fanoutCostPerTodo, 0) / 10;
  const avgSequential = last10.reduce((sum, s) => sum + s.sequentialCostPerTodo, 0) / 10;
  return avgFanout > avgSequential;
}

export interface AllowFanoutTelemetry {
  now?: Date;
  fiveHourUsedPct: number;
  fiveHourResetsAt: string;
  sevenDayUsedPct: number;
  sevenDayResetsAt: string;
}

export interface AllowFanoutHistory {
  /** Completed todos with real cost data. Below `requireHistorySamples`
   *  (default 20), degree is always 1 — the first week runs sequential by
   *  construction, not by convention. */
  completedSamples: number;
  medianTaskMinutes: number;
  medianTaskPctOfWindow: number;
}

export interface AllowFanoutOptions {
  fanoutAlreadyInFlight?: boolean;
  circuitBreaker?: FanoutCircuitBreakerState;
  /** Gate 1's ceiling (the planner's `parallelGroup` size / `parallelSafe`
   *  decision) — the runtime degree can never exceed this. */
  planningAllowedDegree?: FanoutDegree;
}

export interface FanoutDecision {
  degree: FanoutDegree;
  reason: string;
}

function ladderDegreeFromHeadroom(fiveHourUsedPct: number, sevenDayUsedPct: number, config: ResolvedFanoutConfig): FanoutDegree {
  if (fiveHourUsedPct < 15 && sevenDayUsedPct < 30) return 3;
  if (fiveHourUsedPct < config.fiveHourMaxPct && sevenDayUsedPct < config.sevenDayMaxPct) return 2;
  return 1;
}

/**
 * `allowFanout(telemetry, history, config) -> 1 | 2 | 3`. Gates compose: any
 * single failure returns sequential. Order follows 07-fanout-policy.md
 * exactly — enabled/in-flight/history/breakers, then weekly pace (the
 * primary brake), then window runway, then the degree ladder downgraded
 * until projected 5-hour spend clears the ceiling.
 */
export function allowFanout(
  telemetry: AllowFanoutTelemetry,
  history: AllowFanoutHistory,
  config: FanoutConfig | undefined,
  opts: AllowFanoutOptions = {},
): FanoutDecision {
  const resolved = resolveFanoutConfig(config);
  const now = telemetry.now ?? new Date();

  if (!resolved.enabled) return { degree: 1, reason: "Sequential — fan-out disabled" };
  if (opts.fanoutAlreadyInFlight) return { degree: 1, reason: "Sequential — a fan-out is already in flight" };
  if (history.completedSamples < resolved.requireHistorySamples) {
    return {
      degree: 1,
      reason: `Sequential — only ${history.completedSamples} completed todos of cost history (need ${resolved.requireHistorySamples})`,
    };
  }
  if (opts.circuitBreaker?.autoDisabledPendingReview) {
    return { degree: 1, reason: "Sequential — auto-disabled pending review (cost-per-todo regression)" };
  }
  if (opts.circuitBreaker?.trippedThisWindow) {
    return { degree: 1, reason: "Sequential — circuit breaker tripped this window" };
  }
  if (opts.circuitBreaker?.trippedThisWeek) {
    return { degree: 1, reason: "Sequential — circuit breaker tripped this week" };
  }

  // Weekly pacing is the primary brake: fraction of the week's BUDGET spent
  // (used% / 100) against the fraction of the week elapsed.
  const weekElapsedFraction = fractionElapsed(telemetry.sevenDayResetsAt, SEVEN_DAY_MS, now);
  const paceRatio = weekElapsedFraction > 0
    ? (telemetry.sevenDayUsedPct / 100) / weekElapsedFraction
    : (telemetry.sevenDayUsedPct > 0 ? Infinity : 0);
  if (paceRatio > resolved.pacingRatioMax) {
    return { degree: 1, reason: `Sequential — weekly pace ${paceRatio.toFixed(1)}x budget` };
  }
  if (telemetry.sevenDayUsedPct > resolved.sevenDayMaxPct) {
    return { degree: 1, reason: `Sequential — 7-day usage at ${telemetry.sevenDayUsedPct}% exceeds the ${resolved.sevenDayMaxPct}% fan-out ceiling` };
  }

  const fiveHourResetMs = Date.parse(telemetry.fiveHourResetsAt);
  const minutesLeft = Number.isFinite(fiveHourResetMs) ? Math.max(0, (fiveHourResetMs - now.getTime()) / 60_000) : 0;
  const estMinutes = history.medianTaskMinutes * 1.5;
  const minRunway = Math.max(resolved.minWindowMinutesRemaining, estMinutes);
  if (minutesLeft < minRunway) {
    return { degree: 1, reason: `Sequential — ${Math.round(minutesLeft)} min runway, too short to fan out (need ${Math.round(minRunway)})` };
  }

  let degree = ladderDegreeFromHeadroom(telemetry.fiveHourUsedPct, telemetry.sevenDayUsedPct, resolved);
  degree = Math.min(degree, resolved.maxDegree, opts.planningAllowedDegree ?? resolved.maxDegree) as FanoutDegree;

  // Projected 5-hour spend at the candidate degree must stay well under the
  // halt threshold — downgrade one rung at a time until it does.
  while (degree > 1) {
    const projected = telemetry.fiveHourUsedPct + degree * history.medianTaskPctOfWindow;
    if (projected <= resolved.projectedCeilingPct) break;
    degree = (degree - 1) as FanoutDegree;
  }

  if (degree === 1) return { degree: 1, reason: "Sequential — budget gates satisfied but no headroom for concurrency" };
  return {
    degree,
    reason: `Fan-out ×${degree} — ${Math.round(telemetry.fiveHourUsedPct)}%/${Math.round(telemetry.sevenDayUsedPct)}% window/week usage, weekly pace ${paceRatio.toFixed(2)}x`,
  };
}
