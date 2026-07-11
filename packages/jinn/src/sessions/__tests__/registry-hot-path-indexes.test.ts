import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-hotidx-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

function queryPlan(sql: string): string {
  const db = reg.initDb();
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join("\n");
}

// A bare full-table scan is a plan line "SCAN <table>" with no "USING ... INDEX".
// A covering-index scan ("SCAN messages USING COVERING INDEX ...") is fine — it
// only touches the small (partial) index, which is exactly the win we want.
function hasBareTableScan(plan: string): boolean {
  return plan
    .split("\n")
    .some((line) => /\bSCAN\b/.test(line) && !/USING\s+(COVERING\s+)?INDEX/.test(line));
}

describe("hot-path indexes (perf: no full-table scans on boot/turn/tick)", () => {
  it("messages WHERE partial=1 uses the partial index, not a bare full scan", () => {
    // Boot sweep primitive (clearAllPartialMessages).
    const plan = queryPlan("DELETE FROM messages WHERE partial = 1");
    expect(plan).toContain("idx_messages_partial_order");
    expect(hasBareTableScan(plan)).toBe(false);
  });

  it("messages WHERE session_id=? AND partial=1 uses the partial index", () => {
    // Per-turn-settle primitive (deletePartialMessages / getPartialMessages).
    const plan = queryPlan("DELETE FROM messages WHERE session_id = 's' AND partial = 1");
    expect(plan).toContain("idx_messages_partial_order");
    expect(hasBareTableScan(plan)).toBe(false);
  });

  it("sessions WHERE status='running' uses the status index, not a bare full scan", () => {
    // status-reconciler tick + recoverStaleSessions boot path.
    const plan = queryPlan("SELECT * FROM sessions WHERE status = 'running' ORDER BY last_activity DESC");
    expect(plan).toContain("idx_sessions_status");
    expect(hasBareTableScan(plan)).toBe(false);
  });
});
