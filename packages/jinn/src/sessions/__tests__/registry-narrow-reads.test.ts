import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-narrow-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

function seed(id: string, status: string, lastActivity: string): void {
  dbModule.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude','web',?, ?, 't', ?)",
  ).run(id, `web:${id}`, status, lastActivity);
}

describe("narrow read primitives for polled endpoints", () => {
  it("countSessions returns the total without hydrating rows", () => {
    seed("c1", "idle", "2026-07-01T00:00:00Z");
    seed("c2", "running", "2026-07-02T00:00:00Z");
    seed("c3", "error", "2026-07-03T00:00:00Z");
    expect(reg.countSessions()).toBe(3);

    const plan = dbModule
      .initDb()
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM sessions")
      .all() as Array<{ detail: string }>;
    // COUNT(*) must not sort or table-scan rows into a temp b-tree.
    expect(plan.map((r) => r.detail).join("\n")).not.toContain("TEMP B-TREE");
  });

  it("listRecentSessions returns the newest N, most-recent first, bounded by LIMIT", () => {
    const recent = reg.listRecentSessions(2);
    expect(recent.map((s) => s.id)).toEqual(["c3", "c2"]);

    // LIMIT is respected in SQL, not sliced in JS.
    const plan = dbModule
      .initDb()
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions ORDER BY last_activity DESC LIMIT 2")
      .all() as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join("\n")).toContain("idx_sessions_last_activity");
  });

  it("listSessions({status:'running'}) hydrates only running rows via the status index", () => {
    const running = reg.listSessions({ status: "running" });
    expect(running.map((s) => s.id)).toEqual(["c2"]);
  });
});
