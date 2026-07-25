import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-turn-accounting-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

function seed(id: string, source: string): void {
  reg.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude', ?, ?, 'idle', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z')",
  ).run(id, source, `${source}:${id}`);
}

function totals(id: string): { cost: number; turns: number } {
  const row = reg.initDb()
    .prepare("SELECT total_cost AS cost, total_turns AS turns FROM sessions WHERE id = ?")
    .get(id) as { cost: number; turns: number };
  return row;
}

/**
 * Sessions started from the web UI recorded total_turns = 0 and total_cost = 0
 * forever, while cron/slack sessions recorded both. Cause: runWebSession has
 * three turn-completion sites that mirror manager.ts, and none of them called
 * the accounting helper — classic runWebSession/manager.ts drift.
 *
 * This matters beyond reporting: SUM(total_cost) backs employee budget
 * enforcement, and the overwhelming majority of turns are web-sourced, so the
 * caps were effectively unenforced.
 *
 * recordTurnAccounting is now the single entry point both runners share. These
 * tests pin its contract so a future edit to either runner can't silently drop
 * accounting again.
 */
describe("recordTurnAccounting", () => {
  it("records a turn's cost and turn count", () => {
    seed("web-1", "web");
    reg.recordTurnAccounting("web-1", { cost: 0.25, numTurns: 1 });
    expect(totals("web-1")).toEqual({ cost: 0.25, turns: 1 });
  });

  it("accumulates across turns rather than overwriting", () => {
    seed("web-2", "web");
    reg.recordTurnAccounting("web-2", { cost: 0.1, numTurns: 1 });
    reg.recordTurnAccounting("web-2", { cost: 0.2, numTurns: 2 });
    const t = totals("web-2");
    expect(t.cost).toBeCloseTo(0.3, 10);
    expect(t.turns).toBe(3);
  });

  it("counts a turn even when the engine reported no cost", () => {
    // A turn with no usable cost is still a turn — otherwise turn counts drift
    // from reality whenever cost reconstruction fails.
    seed("web-3", "web");
    reg.recordTurnAccounting("web-3", {});
    expect(totals("web-3")).toEqual({ cost: 0, turns: 1 });
  });

  it("treats an errored turn's missing cost as zero, not NaN", () => {
    seed("web-4", "web");
    reg.recordTurnAccounting("web-4", { cost: undefined, numTurns: 1 });
    const t = totals("web-4");
    expect(Number.isNaN(t.cost)).toBe(false);
    expect(t.cost).toBe(0);
  });

  it("accounts web sessions the same as cron sessions", () => {
    seed("cron-1", "cron");
    seed("web-5", "web");
    reg.recordTurnAccounting("cron-1", { cost: 0.5, numTurns: 1 });
    reg.recordTurnAccounting("web-5", { cost: 0.5, numTurns: 1 });
    expect(totals("web-5")).toEqual(totals("cron-1"));
  });
});

/**
 * Structural guard. The bug was not a wrong number — it was a MISSING CALL in
 * one of two parallel runners. A unit test on the helper can't catch that, so
 * assert both runners still call it, once per turn-completion site.
 */
describe("both session runners record accounting (drift guard)", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf-8");

  it("runWebSession accounts every turn-completion site", () => {
    const api = read("gateway/api.ts");
    // main turn + rate-limit retry + engine fallback
    expect((api.match(/recordTurnAccounting\(/g) ?? []).length).toBe(3);
  });

  it("manager.ts accounts every turn-completion site", () => {
    const manager = read("sessions/manager.ts");
    expect((manager.match(/recordTurnAccounting\(/g) ?? []).length).toBe(3);
  });

  it("neither runner bypasses the helper by calling accumulateSessionCost directly", () => {
    for (const rel of ["gateway/api.ts", "sessions/manager.ts"]) {
      expect(read(rel)).not.toMatch(/accumulateSessionCost\(/);
    }
  });
});
