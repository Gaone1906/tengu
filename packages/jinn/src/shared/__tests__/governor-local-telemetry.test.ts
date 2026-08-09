/**
 * readLocalGovernorTelemetry() (D25) — the free/local statusline-snapshot
 * reader the enforcement seam (gateway/api.ts) actually calls before a
 * session spawn. Pins that it reads the general and Opus buckets from
 * SEPARATE snapshot files (one session on Opus, another on Sonnet, running
 * concurrently) rather than picking one "freshest file overall" and losing
 * whichever bucket that file wasn't reporting.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let JINN_HOME_TMP: string;
let CLAUDE_DIR: string;
let readLocalGovernorTelemetry: () => import("../governor.js").GovernorTelemetry;

beforeAll(async () => {
  JINN_HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-governor-local-telemetry-"));
  process.env.JINN_HOME = JINN_HOME_TMP;
  const pathsModule = await import("../paths.js");
  CLAUDE_DIR = pathsModule.CLAUDE_LIMITS_DIR;
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  ({ readLocalGovernorTelemetry } = await import("../governor.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  fs.rmSync(JINN_HOME_TMP, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
});

function writeSnapshot(sessionId: string, body: Record<string, unknown>, ageMs = 60_000) {
  const file = path.join(CLAUDE_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
}

function snapshotBody(model: unknown, fiveHourPct: number, sevenDayPct: number): Record<string, unknown> {
  return {
    captured_at: new Date().toISOString(),
    model,
    rate_limits: {
      five_hour: { used_percentage: fiveHourPct, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: sevenDayPct, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  };
}

describe("readLocalGovernorTelemetry — per-bucket snapshot selection", () => {
  it("reads the Opus bucket from an Opus session's snapshot and the general bucket from a Sonnet session's, concurrently", () => {
    writeSnapshot("sonnet-session", snapshotBody({ id: "claude-sonnet-4-5", display_name: "Sonnet" }, 20, 10), 5_000);
    writeSnapshot("opus-session", snapshotBody({ id: "claude-opus-4-1", display_name: "Opus" }, 85, 40), 1_000);

    const telemetry = readLocalGovernorTelemetry();
    expect(telemetry.fiveHourUsedPct).toBe(20);
    expect(telemetry.sevenDayUsedPct).toBe(10);
    expect(telemetry.opusFiveHourUsedPct).toBe(85);
    expect(telemetry.opusSevenDayUsedPct).toBe(40);
  });

  it("omits Opus fields entirely when no session has reported on an Opus model", () => {
    writeSnapshot("sonnet-session", snapshotBody({ id: "claude-sonnet-4-5", display_name: "Sonnet" }, 30, 15));

    const telemetry = readLocalGovernorTelemetry();
    expect(telemetry.fiveHourUsedPct).toBe(30);
    expect(telemetry.opusFiveHourUsedPct).toBeUndefined();
    expect(telemetry.opusSevenDayUsedPct).toBeUndefined();
  });

  it("folds a snapshot with no model field into the general bucket (pre-D25 behavior for unclassifiable data)", () => {
    writeSnapshot("legacy-session", {
      captured_at: new Date().toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 55, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 33, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    });

    const telemetry = readLocalGovernorTelemetry();
    expect(telemetry.fiveHourUsedPct).toBe(55);
    expect(telemetry.opusFiveHourUsedPct).toBeUndefined();
  });

  it("returns {} when no snapshot exists yet", () => {
    expect(readLocalGovernorTelemetry()).toEqual({});
  });
});
