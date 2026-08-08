/**
 * Per-session telemetry (Tengu step 1). Mirrors engine-limits.test.ts's fixture
 * style — fake statusline snapshot files + fs.utimes for staleness — joined
 * against real session-registry rows so the sessionId-to-session join and the
 * MAX-not-freshest account rollup are exercised against the real schema.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Employee, Session } from "../types.js";

let JINN_HOME_TMP: string;
let CLAUDE_DIR: string;
let createSession: (opts: {
  engine: string;
  source: string;
  sourceRef: string;
  employee?: string | null;
  model?: string;
}) => Session;
let collectSessionTelemetry: typeof import("../session-telemetry.js").collectSessionTelemetry;
let rollupAccountLimits: typeof import("../session-telemetry.js").rollupAccountLimits;
let recordSevenDayWindowSample: typeof import("../session-telemetry.js").recordSevenDayWindowSample;
let readSevenDayWindowLog: typeof import("../session-telemetry.js").readSevenDayWindowLog;

function writeSnapshot(sessionId: string, body: Record<string, unknown>, ageMs = 60_000): string {
  const file = path.join(CLAUDE_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return file;
}

function baseSnapshotBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    captured_at: new Date().toISOString(),
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: 4_102_444_800 },
      seven_day: { used_percentage: 20, resets_at: 4_102_444_800 },
    },
    context_window: { used_percentage: 55 },
    cost: { total_cost_usd: 1.23 },
    ...overrides,
  };
}

beforeAll(async () => {
  JINN_HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-telemetry-"));
  CLAUDE_DIR = path.join(JINN_HOME_TMP, "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = JINN_HOME_TMP;
  ({ createSession } = await import("../../sessions/registry.js"));
  (await import("../db.js")).initDb();
  ({ collectSessionTelemetry, rollupAccountLimits, recordSevenDayWindowSample, readSevenDayWindowLog } =
    await import("../session-telemetry.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  fs.rmSync(JINN_HOME_TMP, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
});

function makeSession(employee?: string, model = "claude-sonnet"): Session {
  return createSession({ engine: "claude", source: "web", sourceRef: `sref-${Math.random()}`, employee, model });
}

describe("collectSessionTelemetry", () => {
  it("joins a snapshot file to its session row by sessionId and emits the required fields", () => {
    const session = makeSession("engineer");
    writeSnapshot(session.id, baseSnapshotBody());

    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sessionId).toBe(session.id);
    expect(row.employee).toBe("engineer");
    expect(row.model).toBe("claude-sonnet");
    expect(row.contextUsedPct).toBe(55);
    expect(row.fiveHourUsedPct).toBe(40);
    expect(row.sevenDayUsedPct).toBe(20);
    expect(typeof row.fiveHourResetsAt).toBe("string");
    expect(row.costUsd).toBe(1.23);
    expect(row.stale).toBe(false);
  });

  it("marks a snapshot older than 30 minutes stale and a fresh one not stale", () => {
    const oldSession = makeSession("engineer");
    writeSnapshot(oldSession.id, baseSnapshotBody(), 45 * 60_000);
    const freshSession = makeSession("reviewer");
    writeSnapshot(freshSession.id, baseSnapshotBody(), 60_000);

    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    const oldRow = rows.find((r) => r.sessionId === oldSession.id)!;
    const freshRow = rows.find((r) => r.sessionId === freshSession.id)!;
    expect(oldRow.stale).toBe(true);
    expect(freshRow.stale).toBe(false);
  });

  it("skips a snapshot file with no matching session row instead of throwing", () => {
    writeSnapshot("no-such-session-id", baseSnapshotBody());
    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    expect(rows).toHaveLength(0);
  });

  it("degrades a malformed snapshot to stale-with-no-fields rather than throwing or leaking payload", () => {
    const session = makeSession("engineer");
    const marker = "SENSITIVE-MARKER-xyz";
    const file = path.join(CLAUDE_DIR, `${session.id}.json`);
    fs.writeFileSync(file, `${marker} {"rate_limits": broken}`);

    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.stale).toBe(true);
    expect(row.fiveHourUsedPct).toBeUndefined();
    expect(row.sevenDayUsedPct).toBeUndefined();
    expect(row.contextUsedPct).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(marker);
  });

  it("returns an empty list (not a throw) when the snapshot directory does not exist yet", () => {
    const rows = collectSessionTelemetry({ dir: path.join(JINN_HOME_TMP, "does-not-exist") });
    expect(rows).toEqual([]);
  });

  it("enriches employeeDisplayName from an injected employee roster, and omits it without one", () => {
    const session = makeSession("engineer");
    writeSnapshot(session.id, baseSnapshotBody());
    const engineer: Employee = {
      name: "engineer",
      displayName: "Engineer Bot",
      department: "core",
      rank: "employee",
      engine: "claude",
      model: "claude-sonnet",
      persona: "You are an engineer.",
    };
    const withRoster = collectSessionTelemetry({ dir: CLAUDE_DIR, employees: new Map([["engineer", engineer]]) });
    expect(withRoster[0].employeeDisplayName).toBe("Engineer Bot");

    const withoutRoster = collectSessionTelemetry({ dir: CLAUDE_DIR });
    expect(withoutRoster[0].employeeDisplayName).toBeUndefined();
  });
});

describe("rollupAccountLimits", () => {
  it("takes the MAX used percentage across concurrent live sessions, not the freshest file", () => {
    const fresherButLower = makeSession("engineer");
    writeSnapshot(fresherButLower.id, baseSnapshotBody({
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: 4_102_444_800 },
        seven_day: { used_percentage: 15, resets_at: 4_102_444_800 },
      },
    }), 1_000); // written most recently

    const olderButHigher = makeSession("reviewer");
    writeSnapshot(olderButHigher.id, baseSnapshotBody({
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: 4_102_444_800 },
        seven_day: { used_percentage: 48, resets_at: 4_102_444_800 },
      },
    }), 5 * 60_000); // written earlier — but higher usage

    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    const rollup = rollupAccountLimits(rows);
    expect(rollup.fiveHourUsedPct).toBe(62);
    expect(rollup.sevenDayUsedPct).toBe(48);
  });

  it("ignores stale snapshots when computing the rollup", () => {
    const stale = makeSession("engineer");
    writeSnapshot(stale.id, baseSnapshotBody({
      rate_limits: { five_hour: { used_percentage: 99, resets_at: 4_102_444_800 }, seven_day: { used_percentage: 90, resets_at: 4_102_444_800 } },
    }), 45 * 60_000);
    const live = makeSession("reviewer");
    writeSnapshot(live.id, baseSnapshotBody({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 4_102_444_800 }, seven_day: { used_percentage: 5, resets_at: 4_102_444_800 } },
    }), 60_000);

    const rows = collectSessionTelemetry({ dir: CLAUDE_DIR });
    const rollup = rollupAccountLimits(rows);
    expect(rollup.fiveHourUsedPct).toBe(10);
    expect(rollup.sevenDayUsedPct).toBe(5);
  });
});

describe("recordSevenDayWindowSample / readSevenDayWindowLog", () => {
  it("records one sample per 5-hour window boundary, deduped by resets_at", () => {
    const logFile = path.join(JINN_HOME_TMP, "seven-day-window-log.json");

    recordSevenDayWindowSample({ fiveHourResetsAt: "2026-08-08T05:00:00.000Z", sevenDayUsedPct: 20 }, logFile);
    recordSevenDayWindowSample({ fiveHourResetsAt: "2026-08-08T05:00:00.000Z", sevenDayUsedPct: 20 }, logFile);
    let log = readSevenDayWindowLog(logFile);
    expect(log).toHaveLength(1);

    recordSevenDayWindowSample({ fiveHourResetsAt: "2026-08-08T10:00:00.000Z", sevenDayUsedPct: 33 }, logFile);
    log = readSevenDayWindowLog(logFile);
    expect(log).toHaveLength(2);
    expect(log[1].sevenDayUsedPct).toBe(33);
    // The pacing controller's per-window delta is exactly this difference.
    expect(log[1].sevenDayUsedPct - log[0].sevenDayUsedPct).toBe(13);
  });

  it("is a no-op when the rollup carries no window boundary or usage figure", () => {
    const logFile = path.join(JINN_HOME_TMP, "seven-day-window-log-2.json");
    recordSevenDayWindowSample({}, logFile);
    expect(readSevenDayWindowLog(logFile)).toEqual([]);
  });

  it("reads back an empty list from a log file that has never been written", () => {
    const logFile = path.join(JINN_HOME_TMP, "never-written.json");
    expect(readSevenDayWindowLog(logFile)).toEqual([]);
  });
});
