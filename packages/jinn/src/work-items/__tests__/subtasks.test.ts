import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-sub-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
let store: Store;
let transitions: Transitions;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  (await import("../../shared/db.js")).initDb();
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

  it("refuses to create a child under a closed (done/cancelled) parent", () => {
    const doneParent = store.createWorkItem({ title: "done parent" });
    transitions.transition(doneParent.id, "done", "operator", { human: true });
    expect(() => store.createWorkItem({ title: "late child", parentId: doneParent.id })).toThrow(/closed/);

    const cancelledParent = store.createWorkItem({ title: "cancelled parent" });
    transitions.transition(cancelledParent.id, "cancelled", "operator", { human: true });
    expect(() => store.createWorkItem({ title: "late child 2", parentId: cancelledParent.id })).toThrow(/closed/);
  });

  it("allows creating a child under an escalated parent (decomposition is part of resolving it)", () => {
    const escalatedParent = store.createWorkItem({ title: "escalated parent" });
    transitions.transition(escalatedParent.id, "escalated", "operator");
    const child = store.createWorkItem({ title: "resolution step", parentId: escalatedParent.id });
    expect(child.parentId).toBe(escalatedParent.id);
    expect(child.depth).toBe(1);
  });
});
