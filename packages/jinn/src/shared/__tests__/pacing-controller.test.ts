import { describe, it, expect } from "vitest";
import {
  computeFairShare,
  computePaceRatio,
  classifyPaceAction,
  evaluatePacing,
  resolvePacingConfig,
  stepPacingLadder,
  windowsLeftInWeek,
  wouldCrossSoftCeiling,
  fractionElapsed,
  type PacingLadderPosition,
  type PacingTelemetry,
} from "../pacing-controller.js";
import type { PacingConfig } from "../types.js";

/** Step 9 verification (03-implementation-plan.md): "unit-test paceRatio
 *  across window/week positions; confirm the effort ladder moves before
 *  fan-out and that no fan-out occurs past 85% window elapsed." */

const DEFAULT = resolvePacingConfig(undefined);

function iso(msFromNow: number, now = Date.now()): string {
  return new Date(now + msFromNow).toISOString();
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("resolvePacingConfig", () => {
  it("fills in the documented defaults", () => {
    expect(resolvePacingConfig(undefined)).toEqual({
      mode: "balanced",
      accelerateBelowPace: 0.8,
      throttleAbovePace: 1.2,
      accelerateAfterWindowElapsed: 0.6,
      noFanoutAfterWindowElapsed: 0.85,
      effortLadder: ["low", "medium", "high", "xhigh"],
      eagerModeWeeklyBrake: 70,
    });
  });

  it("keeps explicit values and falls back for non-positive ones", () => {
    const config: PacingConfig = { accelerateBelowPace: 0.5, throttleAbovePace: -1, mode: "eager" };
    const resolved = resolvePacingConfig(config);
    expect(resolved.accelerateBelowPace).toBe(0.5);
    expect(resolved.throttleAbovePace).toBe(1.2);
    expect(resolved.mode).toBe("eager");
  });
});

describe("computePaceRatio across a spread of window/week positions", () => {
  const cases: Array<{ name: string; spent: number; fairShare: number; windowElapsed: number; expected: number }> = [
    { name: "exactly on pace mid-window", spent: 5, fairShare: 10, windowElapsed: 0.5, expected: 1.0 },
    { name: "under-spending early in window", spent: 1, fairShare: 10, windowElapsed: 0.2, expected: 0.5 },
    { name: "under-spending late in window (the destroyed-capacity case)", spent: 4, fairShare: 10, windowElapsed: 0.9, expected: 4 / 9 },
    { name: "over-spending early in window", spent: 8, fairShare: 10, windowElapsed: 0.2, expected: 4.0 },
    { name: "over-spending late in window", spent: 13, fairShare: 10, windowElapsed: 0.95, expected: 13 / 9.5 },
    { name: "zero spend, zero elapsed reads as on pace", spent: 0, fairShare: 10, windowElapsed: 0, expected: 0 },
    { name: "zero fair share with real spend is unboundedly over", spent: 1, fairShare: 0, windowElapsed: 0.5, expected: Infinity },
    { name: "window just opened with real spend is unboundedly over", spent: 1, fairShare: 10, windowElapsed: 0, expected: Infinity },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(computePaceRatio(c.spent, c.fairShare, c.windowElapsed)).toBeCloseTo(c.expected, 6);
    });
  }
});

describe("classifyPaceAction", () => {
  it("< 0.8 with windowElapsed > 0.6 accelerates", () => {
    expect(classifyPaceAction(0.5, 0.7, DEFAULT)).toBe("accelerate");
  });

  it("< 0.8 but windowElapsed <= 0.6 just holds (not yet urgent)", () => {
    expect(classifyPaceAction(0.5, 0.4, DEFAULT)).toBe("hold");
  });

  it("0.8-1.2 holds regardless of window position", () => {
    expect(classifyPaceAction(0.8, 0.1, DEFAULT)).toBe("hold");
    expect(classifyPaceAction(1.0, 0.9, DEFAULT)).toBe("hold");
    expect(classifyPaceAction(1.2, 0.9, DEFAULT)).toBe("hold");
  });

  it("> 1.2 throttles regardless of window position", () => {
    expect(classifyPaceAction(1.21, 0.1, DEFAULT)).toBe("throttle");
    expect(classifyPaceAction(3.0, 0.95, DEFAULT)).toBe("throttle");
  });
});

describe("computeFairShare / windowsLeftInWeek", () => {
  it("divides weekly remaining by windows left", () => {
    expect(computeFairShare(50, 10)).toBe(5);
  });

  it("clamps negative remaining to zero", () => {
    expect(computeFairShare(-10, 10)).toBe(0);
  });

  it("derives windows left from hours until weekly reset / 5", () => {
    const now = Date.now();
    expect(windowsLeftInWeek(iso(10 * HOUR, now), new Date(now))).toBeCloseTo(2, 6);
  });

  it("never returns zero/negative even for an overdue reset", () => {
    const now = Date.now();
    expect(windowsLeftInWeek(iso(-HOUR, now), new Date(now))).toBeGreaterThan(0);
  });
});

describe("fractionElapsed", () => {
  it("clamps to [0, 1] for future and overdue resets", () => {
    const now = Date.now();
    expect(fractionElapsed(iso(5 * HOUR, now), 5 * HOUR, new Date(now))).toBeCloseTo(0, 6);
    expect(fractionElapsed(iso(0, now), 5 * HOUR, new Date(now))).toBeCloseTo(1, 6);
    expect(fractionElapsed(iso(-HOUR, now), 5 * HOUR, new Date(now))).toBe(1);
  });
});

describe("wouldCrossSoftCeiling", () => {
  it("flags a unit that would cross 80%", () => {
    expect(wouldCrossSoftCeiling(75, 6)).toBe(true);
    expect(wouldCrossSoftCeiling(75, 4)).toBe(false);
  });
});

describe("stepPacingLadder — effort moves before fan-out", () => {
  it("accelerate raises effort one rung before ever touching fan-out", () => {
    const start: PacingLadderPosition = { effort: "medium", fanoutDegree: 1 };
    const step1 = stepPacingLadder("accelerate", start, DEFAULT.effortLadder, true);
    expect(step1).toEqual({ effort: "high", fanoutDegree: 1 });
    const step2 = stepPacingLadder("accelerate", step1, DEFAULT.effortLadder, true);
    expect(step2).toEqual({ effort: "xhigh", fanoutDegree: 1 });
  });

  it("only raises fan-out once effort is already maxed", () => {
    const maxed: PacingLadderPosition = { effort: "xhigh", fanoutDegree: 1 };
    const step = stepPacingLadder("accelerate", maxed, DEFAULT.effortLadder, true);
    expect(step).toEqual({ effort: "xhigh", fanoutDegree: 2 });
  });

  it("accelerate is a no-op at the top of both ladders", () => {
    const top: PacingLadderPosition = { effort: "xhigh", fanoutDegree: 3 };
    expect(stepPacingLadder("accelerate", top, DEFAULT.effortLadder, true)).toEqual(top);
  });

  it("accelerate cannot raise fan-out when fan-out is disallowed, even at max effort", () => {
    const maxed: PacingLadderPosition = { effort: "xhigh", fanoutDegree: 1 };
    expect(stepPacingLadder("accelerate", maxed, DEFAULT.effortLadder, false)).toEqual(maxed);
  });

  it("throttle unwinds fan-out one rung before ever cutting effort", () => {
    const start: PacingLadderPosition = { effort: "high", fanoutDegree: 3 };
    const step1 = stepPacingLadder("throttle", start, DEFAULT.effortLadder, true);
    expect(step1).toEqual({ effort: "high", fanoutDegree: 2 });
    const step2 = stepPacingLadder("throttle", step1, DEFAULT.effortLadder, true);
    expect(step2).toEqual({ effort: "high", fanoutDegree: 1 });
  });

  it("only cuts effort once fan-out is already sequential", () => {
    const sequential: PacingLadderPosition = { effort: "high", fanoutDegree: 1 };
    const step = stepPacingLadder("throttle", sequential, DEFAULT.effortLadder, true);
    expect(step).toEqual({ effort: "medium", fanoutDegree: 1 });
  });

  it("throttle is a no-op at the bottom of both ladders", () => {
    const bottom: PacingLadderPosition = { effort: "low", fanoutDegree: 1 };
    expect(stepPacingLadder("throttle", bottom, DEFAULT.effortLadder, true)).toEqual(bottom);
  });

  it("hold never moves either ladder", () => {
    const pos: PacingLadderPosition = { effort: "medium", fanoutDegree: 2 };
    expect(stepPacingLadder("hold", pos, DEFAULT.effortLadder, true)).toEqual(pos);
  });
});

function telemetryAt(opts: {
  windowElapsedFraction: number;
  sevenDayUsedPct?: number;
  sevenDayUsedPctAtWindowStart?: number;
  weekElapsedFraction?: number;
  fiveHourUsedPct?: number;
}): PacingTelemetry {
  const now = Date.now();
  const fiveHourWindowMs = 5 * HOUR;
  const fiveHourResetsAt = iso(fiveHourWindowMs * (1 - opts.windowElapsedFraction), now);
  const sevenDayResetsAt = iso(7 * DAY * (1 - (opts.weekElapsedFraction ?? 0.5)), now);
  return {
    now: new Date(now),
    fiveHourUsedPct: opts.fiveHourUsedPct ?? 20,
    fiveHourResetsAt,
    sevenDayUsedPct: opts.sevenDayUsedPct ?? 40,
    sevenDayResetsAt,
    sevenDayUsedPctAtWindowStart: opts.sevenDayUsedPctAtWindowStart ?? (opts.sevenDayUsedPct ?? 40) - 5,
  };
}

describe("evaluatePacing — no fan-out occurs past 85% window elapsed, regardless of other conditions", () => {
  const favorable: PacingLadderPosition = { effort: "xhigh", fanoutDegree: 1 };

  it("blocks fan-out at exactly the 85% line even under a strong accelerate signal", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.86,
      sevenDayUsedPct: 10,
      sevenDayUsedPctAtWindowStart: 9.9,
      weekElapsedFraction: 0.9,
    });
    const decision = evaluatePacing(telemetry, favorable, undefined);
    expect(decision.fanoutAllowed).toBe(false);
    expect(decision.next.fanoutDegree).toBe(1);
  });

  it("forces an already-fanned-out session back to sequential once past 85%", () => {
    const telemetry = telemetryAt({ windowElapsedFraction: 0.95, sevenDayUsedPct: 5, weekElapsedFraction: 0.99 });
    const alreadyFannedOut: PacingLadderPosition = { effort: "xhigh", fanoutDegree: 3 };
    const decision = evaluatePacing(telemetry, alreadyFannedOut, undefined);
    expect(decision.next.fanoutDegree).toBe(1);
  });

  it("holds even at 100% window elapsed", () => {
    const telemetry = telemetryAt({ windowElapsedFraction: 1, sevenDayUsedPct: 1, weekElapsedFraction: 0.99 });
    const decision = evaluatePacing(telemetry, favorable, undefined);
    expect(decision.next.fanoutDegree).toBe(1);
  });

  it("stays allowed just below the line, all else favorable", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.84,
      sevenDayUsedPct: 10,
      sevenDayUsedPctAtWindowStart: 9.9,
      weekElapsedFraction: 0.9,
    });
    const decision = evaluatePacing(telemetry, favorable, undefined);
    expect(decision.fanoutAllowed).toBe(true);
  });
});

describe("evaluatePacing — end to end", () => {
  it("accelerates under-pace late in window, effort before fan-out", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.7,
      sevenDayUsedPct: 20,
      sevenDayUsedPctAtWindowStart: 19,
      weekElapsedFraction: 0.3,
      fiveHourUsedPct: 10,
    });
    const decision = evaluatePacing(telemetry, { effort: "medium", fanoutDegree: 1 }, undefined);
    expect(decision.action).toBe("accelerate");
    expect(decision.next).toEqual({ effort: "high", fanoutDegree: 1 });
  });

  it("throttles over-pace regardless of window position", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.2,
      sevenDayUsedPct: 60,
      sevenDayUsedPctAtWindowStart: 40,
      weekElapsedFraction: 0.2,
    });
    const decision = evaluatePacing(telemetry, { effort: "high", fanoutDegree: 2 }, undefined);
    expect(decision.action).toBe("throttle");
    expect(decision.next).toEqual({ effort: "high", fanoutDegree: 1 });
  });

  it("holds on pace and reports it in the reason string", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.5,
      sevenDayUsedPct: 66.4,
      sevenDayUsedPctAtWindowStart: 65.4,
      weekElapsedFraction: 0.5,
    });
    const decision = evaluatePacing(telemetry, { effort: "medium", fanoutDegree: 1 }, undefined);
    expect(decision.action).toBe("hold");
    expect(decision.reason).toMatch(/^On pace/);
  });

  it("suppresses acceleration when the next unit would cross the 80% soft ceiling", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.7,
      sevenDayUsedPct: 20,
      sevenDayUsedPctAtWindowStart: 19,
      weekElapsedFraction: 0.3,
      fiveHourUsedPct: 76,
    });
    const decision = evaluatePacing(telemetry, { effort: "medium", fanoutDegree: 1 }, undefined, 6);
    expect(decision.action).toBe("hold");
    expect(decision.next).toEqual({ effort: "medium", fanoutDegree: 1 });
  });

  it("eager mode ignores weekly pacing below the brake", () => {
    const telemetry = telemetryAt({
      windowElapsedFraction: 0.2,
      sevenDayUsedPct: 60,
      sevenDayUsedPctAtWindowStart: 40,
      weekElapsedFraction: 0.2,
    });
    const decision = evaluatePacing(telemetry, { effort: "medium", fanoutDegree: 1 }, { mode: "eager" });
    expect(decision.action).not.toBe("throttle");
  });

  it("eager mode hard-throttles above the weekly brake", () => {
    const telemetry = telemetryAt({ windowElapsedFraction: 0.2, sevenDayUsedPct: 75, weekElapsedFraction: 0.5 });
    const decision = evaluatePacing(telemetry, { effort: "high", fanoutDegree: 2 }, { mode: "eager" });
    expect(decision.action).toBe("throttle");
  });
});
