import { describe, it, expect } from "vitest";
import { evaluateGovernor, resolveGovernorConfig, type GovernorTelemetry } from "../governor.js";
import type { GovernorConfig } from "../types.js";

/** Step 4 verification (03-implementation-plan.md): "unit-test at 79/80/81%.
 *  Force it by setting fiveHourStopPct: 5 — don't wait for a real 80%." Every
 *  test here forces the boundary through config, never a live usage state. */

describe("resolveGovernorConfig", () => {
  it("defaults all three thresholds to 80 when unset", () => {
    expect(resolveGovernorConfig(undefined)).toEqual({
      fiveHourStopPct: 80,
      sevenDayStopPct: 80,
      contextCompactPct: 80,
    });
  });

  it("keeps explicit positive values and falls back to 80 for non-positive ones", () => {
    const config: GovernorConfig = { fiveHourStopPct: 50, sevenDayStopPct: 0, contextCompactPct: -5 };
    expect(resolveGovernorConfig(config)).toEqual({
      fiveHourStopPct: 50,
      sevenDayStopPct: 80,
      contextCompactPct: 80,
    });
  });
});

describe("evaluateGovernor — 5-hour window at the default 80% threshold", () => {
  it("79% runs", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 79 };
    expect(evaluateGovernor(telemetry, undefined).action).toBe("run");
  });

  it("80% halts", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 80, fiveHourResetsAt: "2026-08-08T18:00:00.000Z" };
    const decision = evaluateGovernor(telemetry, undefined);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toMatch(/5-hour/);
    expect(decision.resumeAt).toBe("2026-08-08T18:00:00.000Z");
  });

  it("81% halts", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 81 };
    expect(evaluateGovernor(telemetry, undefined).action).toBe("halt");
  });
});

describe("evaluateGovernor — 7-day window at the default 80% threshold", () => {
  it("79% runs", () => {
    const telemetry: GovernorTelemetry = { sevenDayUsedPct: 79 };
    expect(evaluateGovernor(telemetry, undefined).action).toBe("run");
  });

  it("80% halts", () => {
    const telemetry: GovernorTelemetry = { sevenDayUsedPct: 80, sevenDayResetsAt: "2026-08-12T00:00:00.000Z" };
    const decision = evaluateGovernor(telemetry, undefined);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toMatch(/7-day/);
    expect(decision.resumeAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("81% halts", () => {
    const telemetry: GovernorTelemetry = { sevenDayUsedPct: 81 };
    expect(evaluateGovernor(telemetry, undefined).action).toBe("halt");
  });
});

describe("evaluateGovernor — thresholds forced via config, not a live 80% state", () => {
  it("79/80/81% against a forced fiveHourStopPct: 5", () => {
    const config: GovernorConfig = { fiveHourStopPct: 5 };
    expect(evaluateGovernor({ fiveHourUsedPct: 4 }, config).action).toBe("run");
    expect(evaluateGovernor({ fiveHourUsedPct: 5 }, config).action).toBe("halt");
    expect(evaluateGovernor({ fiveHourUsedPct: 6 }, config).action).toBe("halt");
  });

  it("79/80/81% against a forced sevenDayStopPct: 5", () => {
    const config: GovernorConfig = { sevenDayStopPct: 5 };
    expect(evaluateGovernor({ sevenDayUsedPct: 4 }, config).action).toBe("run");
    expect(evaluateGovernor({ sevenDayUsedPct: 5 }, config).action).toBe("halt");
    expect(evaluateGovernor({ sevenDayUsedPct: 6 }, config).action).toBe("halt");
  });
});

describe("evaluateGovernor — the 7-day cap is the harder stop", () => {
  it("wins the reported reason when both windows are simultaneously over threshold", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 95, sevenDayUsedPct: 90 };
    const decision = evaluateGovernor(telemetry, undefined);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toMatch(/7-day/);
  });

  it("still halts on 5-hour alone when 7-day is under threshold", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 85, sevenDayUsedPct: 40 };
    const decision = evaluateGovernor(telemetry, undefined);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toMatch(/5-hour/);
  });
});

describe("evaluateGovernor — context usage triggers handoff, not halt", () => {
  it("79% runs", () => {
    expect(evaluateGovernor({ contextUsedPct: 79 }, undefined).action).toBe("run");
  });

  it("80% signals handoff, with no resumeAt", () => {
    const decision = evaluateGovernor({ contextUsedPct: 80 }, undefined);
    expect(decision.action).toBe("handoff");
    expect(decision.reason).toMatch(/context/);
    expect(decision.resumeAt).toBeUndefined();
  });

  it("81% signals handoff", () => {
    expect(evaluateGovernor({ contextUsedPct: 81 }, undefined).action).toBe("handoff");
  });

  it("a usage halt takes priority over a simultaneous context handoff", () => {
    const telemetry: GovernorTelemetry = { fiveHourUsedPct: 85, contextUsedPct: 90 };
    expect(evaluateGovernor(telemetry, undefined).action).toBe("halt");
  });
});

describe("evaluateGovernor — no telemetry means run", () => {
  it("empty telemetry (no snapshot captured yet) runs", () => {
    expect(evaluateGovernor({}, undefined).action).toBe("run");
  });
});
