import { describe, it, expect } from "vitest";
import {
  allowFanout,
  costPerTodoRegressed,
  resolveFanoutConfig,
  tripCircuitBreakerForCostRegression,
  tripCircuitBreakerForHaltedMember,
  tripCircuitBreakerForMergeConflict,
  tripCircuitBreakerForPaceOverBudget,
  resetCircuitBreakerForNewWindow,
  resetCircuitBreakerForNewWeek,
  clearCircuitBreakerReview,
  NO_CIRCUIT_BREAKER_TRIPS,
  type AllowFanoutHistory,
  type AllowFanoutTelemetry,
} from "../fanout-policy.js";
import type { FanoutConfig } from "../types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(msFromNow: number, now = Date.now()): string {
  return new Date(now + msFromNow).toISOString();
}

/** Comfortably inside every gate: plenty of history, low usage, on pace,
 *  plenty of runway. `sevenDayResetsAt` sits at week-midpoint so paceRatio
 *  stays well under 1.0 for every usage% these tests exercise. Individual
 *  tests override one field to trip one gate. */
function comfortableTelemetry(overrides: Partial<AllowFanoutTelemetry> = {}): AllowFanoutTelemetry {
  const now = Date.now();
  return {
    now: new Date(now),
    fiveHourUsedPct: 5,
    fiveHourResetsAt: iso(4 * HOUR, now),
    sevenDayUsedPct: 10,
    sevenDayResetsAt: iso(3.5 * DAY, now),
    ...overrides,
  };
}

const comfortableHistory: AllowFanoutHistory = {
  completedSamples: 40,
  medianTaskMinutes: 15,
  medianTaskPctOfWindow: 2,
};

describe("resolveFanoutConfig", () => {
  it("fills in the documented defaults", () => {
    expect(resolveFanoutConfig(undefined)).toEqual({
      enabled: true,
      maxDegree: 3,
      fiveHourMaxPct: 30,
      sevenDayMaxPct: 50,
      pacingRatioMax: 1.0,
      projectedCeilingPct: 60,
      minWindowMinutesRemaining: 90,
      requireHistorySamples: 20,
    });
  });

  it("clamps maxDegree into 1..3", () => {
    expect(resolveFanoutConfig({ maxDegree: 7 } as FanoutConfig).maxDegree).toBe(3);
    expect(resolveFanoutConfig({ maxDegree: 0 } as FanoutConfig).maxDegree).toBe(3); // non-positive falls back to default
  });
});

describe("allowFanout — gates fail closed, in the documented order", () => {
  it("comfortable conditions earn the top of the ladder", () => {
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined);
    expect(decision.degree).toBe(3);
  });

  it("disabled config always returns sequential", () => {
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, { enabled: false });
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/disabled/);
  });

  it("a fan-out already in flight returns sequential", () => {
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { fanoutAlreadyInFlight: true });
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/already in flight/);
  });

  it("below 20 completed samples is sequential by construction — week one has no history", () => {
    const decision = allowFanout(comfortableTelemetry(), { ...comfortableHistory, completedSamples: 19 }, undefined);
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/19 completed todos/);
  });

  it("exactly 20 completed samples clears the history gate", () => {
    const decision = allowFanout(comfortableTelemetry(), { ...comfortableHistory, completedSamples: 20 }, undefined);
    expect(decision.degree).toBeGreaterThan(1);
  });

  it("a window-tripped circuit breaker returns sequential", () => {
    const breaker = tripCircuitBreakerForHaltedMember(NO_CIRCUIT_BREAKER_TRIPS);
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { circuitBreaker: breaker });
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/tripped this window/);
  });

  it("a week-tripped circuit breaker (pace over budget) returns sequential", () => {
    const breaker = tripCircuitBreakerForPaceOverBudget(NO_CIRCUIT_BREAKER_TRIPS, 1.4);
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { circuitBreaker: breaker });
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/tripped this week/);
  });

  it("a merge-conflict trip is week-scoped too", () => {
    const breaker = tripCircuitBreakerForMergeConflict(NO_CIRCUIT_BREAKER_TRIPS);
    expect(breaker.trippedThisWeek).toBe(true);
  });

  it("a cost-regression auto-disable overrides everything, including a fresh window/week", () => {
    let breaker = tripCircuitBreakerForCostRegression(NO_CIRCUIT_BREAKER_TRIPS);
    breaker = resetCircuitBreakerForNewWeek(breaker);
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { circuitBreaker: breaker });
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/pending review/);
    expect(clearCircuitBreakerReview(breaker).autoDisabledPendingReview).toBe(false);
  });

  it("resetCircuitBreakerForNewWindow clears only the window trip", () => {
    let breaker = tripCircuitBreakerForHaltedMember(NO_CIRCUIT_BREAKER_TRIPS);
    breaker = tripCircuitBreakerForMergeConflict(breaker);
    const afterWindow = resetCircuitBreakerForNewWindow(breaker);
    expect(afterWindow.trippedThisWindow).toBe(false);
    expect(afterWindow.trippedThisWeek).toBe(true);
  });

  it("weekly pace ratio above 1.0 returns sequential even with an empty window", () => {
    // day 3 of 7 (weekElapsedFraction ~0.43) at 60% used -> paceRatio ~1.4
    const telemetry = comfortableTelemetry({
      fiveHourUsedPct: 2,
      sevenDayUsedPct: 60,
      sevenDayResetsAt: iso(4 * DAY, Date.now()),
    });
    const decision = allowFanout(telemetry, comfortableHistory, undefined);
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/weekly pace/);
  });

  it("7-day usage above the sevenDayMaxPct ceiling returns sequential", () => {
    // weekElapsedFraction ~0.57 keeps paceRatio (~0.96) under the pacing gate
    // so the sevenDayMaxPct ceiling is what actually trips.
    const telemetry = comfortableTelemetry({ sevenDayUsedPct: 55, sevenDayResetsAt: iso(3 * DAY, Date.now()) });
    const decision = allowFanout(telemetry, comfortableHistory, undefined);
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/exceeds the 50% fan-out ceiling/);
  });

  it("insufficient window runway (< 90 min) returns sequential", () => {
    const telemetry = comfortableTelemetry({ fiveHourResetsAt: iso(45 * 60 * 1000, Date.now()) });
    const decision = allowFanout(telemetry, comfortableHistory, undefined);
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/too short to fan out/);
  });

  it("runway requirement pads the median task estimate 1.5x when it exceeds the 90-minute floor", () => {
    const telemetry = comfortableTelemetry({ fiveHourResetsAt: iso(100 * 60 * 1000, Date.now()) });
    const history: AllowFanoutHistory = { ...comfortableHistory, medianTaskMinutes: 80 }; // 1.5x = 120 min
    const decision = allowFanout(telemetry, history, undefined);
    expect(decision.degree).toBe(1);
    expect(decision.reason).toMatch(/need 120/);
  });

  it("projected 5-hour spend over the ceiling downgrades the degree instead of failing closed entirely", () => {
    const telemetry = comfortableTelemetry({ fiveHourUsedPct: 5 });
    // degree 3 -> 5 + 3*20 = 65 > 60; degree 2 -> 5 + 2*20 = 45 <= 60
    const history: AllowFanoutHistory = { ...comfortableHistory, medianTaskPctOfWindow: 20 };
    const decision = allowFanout(telemetry, history, undefined);
    expect(decision.degree).toBe(2);
  });

  it("degree ladder: <15%/<30% usage earns 3", () => {
    const decision = allowFanout(comfortableTelemetry({ fiveHourUsedPct: 10, sevenDayUsedPct: 25 }), comfortableHistory, undefined);
    expect(decision.degree).toBe(3);
  });

  it("degree ladder: <30%/<50% usage earns 2", () => {
    const decision = allowFanout(comfortableTelemetry({ fiveHourUsedPct: 20, sevenDayUsedPct: 45 }), comfortableHistory, undefined);
    expect(decision.degree).toBe(2);
  });

  it("degree ladder: otherwise sequential", () => {
    const decision = allowFanout(comfortableTelemetry({ fiveHourUsedPct: 32, sevenDayUsedPct: 49 }), comfortableHistory, undefined);
    expect(decision.degree).toBe(1);
  });
});

describe("allowFanout — runtime can only downgrade what planning time allowed", () => {
  it("caps the ladder-earned degree at the planner's parallelGroup ceiling", () => {
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { planningAllowedDegree: 2 });
    expect(decision.degree).toBe(2);
  });

  it("never raises degree above what planning time allowed, even at 1", () => {
    const decision = allowFanout(comfortableTelemetry(), comfortableHistory, undefined, { planningAllowedDegree: 1 });
    expect(decision.degree).toBe(1);
  });
});

describe("costPerTodoRegressed", () => {
  it("false below 10 samples regardless of the numbers", () => {
    const samples = Array.from({ length: 9 }, () => ({ fanoutCostPerTodo: 10, sequentialCostPerTodo: 1 }));
    expect(costPerTodoRegressed(samples)).toBe(false);
  });

  it("true once 10 samples average worse than sequential", () => {
    const samples = Array.from({ length: 10 }, () => ({ fanoutCostPerTodo: 5, sequentialCostPerTodo: 3 }));
    expect(costPerTodoRegressed(samples)).toBe(true);
  });

  it("false when fan-out is cheaper or equal over the last 10", () => {
    const samples = Array.from({ length: 10 }, () => ({ fanoutCostPerTodo: 2, sequentialCostPerTodo: 3 }));
    expect(costPerTodoRegressed(samples)).toBe(false);
  });

  it("only looks at the last 10 samples", () => {
    const bad = Array.from({ length: 15 }, () => ({ fanoutCostPerTodo: 10, sequentialCostPerTodo: 1 }));
    const good = Array.from({ length: 10 }, () => ({ fanoutCostPerTodo: 1, sequentialCostPerTodo: 5 }));
    expect(costPerTodoRegressed([...bad, ...good])).toBe(false);
  });
});
