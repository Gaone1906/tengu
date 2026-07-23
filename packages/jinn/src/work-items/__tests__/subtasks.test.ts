import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-sub-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
  (await import("../../sessions/registry.js")).initDb();
});

describe("sub-tasks", () => {
  it("creates a child under a parent with inherited department, depth+1, shared root, and a child_created event", () => {
    const root = store.createWorkItem({ title: "epic", department: "platform" });
    const child = store.createWorkItem({ title: "part 1", parentId: root.id, createdBy: "a-lead" });
    expect(child.parentId).toBe(root.id);
    expect(child.rootId).toBe(root.id);
    expect(child.depth).toBe(1);
    expect(child.department).toBe("platform");
    expect(child.id.slice(0, 3)).toBe(root.id.slice(0, 3)); // same dept → same prefix
    const events = store.listWorkItemEvents(root.id);
    expect(events.some((e) => e.kind === "child_created" && e.detail?.childId === child.id)).toBe(true);
  });

  it("lets a child override the department and mints under that department's prefix", () => {
    const root = store.createWorkItem({ title: "epic2", department: "platform" });
    const child = store.createWorkItem({ title: "marketing part", parentId: root.id, department: "marketing" });
    expect(child.rootId).toBe(root.id);
    expect(child.id.slice(0, 3)).not.toBe(root.id.slice(0, 3));
  });

  it("enforces the depth cap of 3", () => {
    const d0 = store.createWorkItem({ title: "d0" });
    const d1 = store.createWorkItem({ title: "d1", parentId: d0.id });
    const d2 = store.createWorkItem({ title: "d2", parentId: d1.id });
    const d3 = store.createWorkItem({ title: "d3", parentId: d2.id });
    expect(d3.depth).toBe(3);
    expect(() => store.createWorkItem({ title: "d4", parentId: d3.id }))
      .toThrow(/depth/);
  });

  it("rejects an unknown parent", () => {
    expect(() => store.createWorkItem({ title: "orphan", parentId: "ZZZ-999" })).toThrow(/not found/);
  });
});
