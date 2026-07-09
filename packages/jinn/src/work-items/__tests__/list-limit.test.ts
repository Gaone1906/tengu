import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-limit-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Reg = typeof import("../../sessions/registry.js");
let store: Store;
let reg: Reg;

beforeAll(async () => {
  store = await import("../store.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

describe("listWorkItems SQL LIMIT", () => {
  it("clamps rows in SQL, newest (updated_at DESC) first", () => {
    for (let i = 0; i < 25; i++) {
      store.createWorkItem({ title: `item ${i}`, source: "human" });
    }
    const all = store.listWorkItems();
    expect(all.length).toBe(25);

    const limited = store.listWorkItems({ limit: 5 });
    expect(limited.length).toBe(5);
    // Same order as the unlimited head — the LIMIT walks the ordered index tail,
    // it does not change ordering.
    expect(limited.map((w) => w.id)).toEqual(all.slice(0, 5).map((w) => w.id));
  });

  it("the ordered read is index-backed (LIMIT does not sort the whole table)", () => {
    const db = reg.initDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM work_items ORDER BY updated_at DESC, created_at DESC LIMIT ?",
      )
      .all(5) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join("\n");
    expect(text).toContain("idx_work_items_recent");
    expect(text).not.toContain("TEMP B-TREE");
  });
});
