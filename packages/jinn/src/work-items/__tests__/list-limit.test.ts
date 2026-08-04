import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-limit-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
  dbModule.initDb();
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

  it("returns true totals and pages beyond the first 20 rows", () => {
    for (let i = 0; i < 27; i++) {
      store.createWorkItem({
        title: `paged backlog ${i}`,
        status: "backlog",
        department: "pagination-fixture",
        source: "human",
      });
    }
    for (let i = 0; i < 3; i++) {
      store.createWorkItem({
        title: `paged done ${i}`,
        status: "done",
        department: "pagination-fixture",
        source: "human",
      });
    }

    const allStatuses = store.queryWorkItems({ department: "pagination-fixture", limit: 20 });
    expect(allStatuses.total).toBe(30);
    expect(allStatuses.totals.backlog).toBe(27);
    expect(allStatuses.totals.done).toBe(3);

    const first = store.queryWorkItems({
      status: "backlog",
      department: "pagination-fixture",
      limit: 20,
      offset: 0,
    });
    expect(first.workItems).toHaveLength(20);
    expect(first.total).toBe(27);
    expect(first.totals.backlog).toBe(27);
    expect(first.nextOffset).toBe(20);

    const second = store.queryWorkItems({
      status: "backlog",
      department: "pagination-fixture",
      limit: 20,
      offset: 20,
    });
    expect(second.workItems).toHaveLength(7);
    expect(second.total).toBe(27);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.workItems, ...second.workItems].map((item) => item.id)).size).toBe(27);
  });

  it("AND-composes status, assignee, department, source, text, and inclusive date filters", () => {
    const match = store.createWorkItem({
      title: "filter-needle title",
      body: "matching body",
      status: "assigned",
      assignee: "filter-person",
      department: "filter-department",
      source: "connector",
    });
    const bodyMatch = store.createWorkItem({
      title: "body-only candidate",
      body: "contains filter-needle here",
      status: "assigned",
      assignee: "other-person",
      department: "other-department",
      source: "connector",
    });
    const outsideWindow = store.createWorkItem({
      title: "filter-needle outside",
      status: "assigned",
      assignee: "filter-person",
      department: "filter-department",
      source: "connector",
    });
    const db = dbModule.initDb();
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2031-04-10T12:00:00.000Z", match.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2031-04-11T12:00:00.000Z", bodyMatch.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2031-05-01T12:00:00.000Z", outsideWindow.id);

    expect(store.queryWorkItems({ status: "assigned", limit: 100 }).workItems.every((item) => item.status === "assigned")).toBe(true);
    expect(store.queryWorkItems({ assignee: "filter-person", limit: 100 }).workItems.every((item) => item.assignee === "filter-person")).toBe(true);
    expect(store.queryWorkItems({ department: "filter-department", limit: 100 }).workItems.every((item) => item.department === "filter-department")).toBe(true);
    expect(store.queryWorkItems({ source: "connector", limit: 100 }).workItems.every((item) => item.source === "connector")).toBe(true);
    expect(new Set(store.queryWorkItems({ text: "filter-needle", source: "connector", limit: 100 }).workItems.map((item) => item.id))).toEqual(
      new Set([match.id, bodyMatch.id, outsideWindow.id]),
    );

    const composed = store.queryWorkItems({
      status: "assigned",
      assignee: "filter-person",
      department: "filter-department",
      source: "connector",
      text: "filter-needle",
      since: "2031-04-10T12:00:00.000Z",
      until: "2031-04-30T23:59:59.999Z",
      limit: 20,
    });
    expect(composed.workItems.map((item) => item.id)).toEqual([match.id]);
    expect(composed.total).toBe(1);
  });

  it("the ordered read is index-backed (LIMIT does not sort the whole table)", () => {
    const db = dbModule.initDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM work_items WHERE status = ? ORDER BY (rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC LIMIT ? OFFSET ?",
      )
      .all("backlog", 5, 0) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join("\n");
    expect(text).toContain("idx_work_items_manual_order");
    expect(text).not.toContain("TEMP B-TREE");
  });

  it("the default no-filter page is index-backed", () => {
    const db = dbModule.initDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM work_items ORDER BY (rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC LIMIT ? OFFSET ?",
      )
      .all(20, 0) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join("\n");
    expect(text).toContain("idx_work_items_default_order");
    expect(plan.some((r) => /SCAN work_items$/.test(r.detail))).toBe(false);
    expect(text).not.toContain("TEMP B-TREE");
  });
});
