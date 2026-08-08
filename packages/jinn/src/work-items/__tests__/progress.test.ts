import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-progress-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Progress = typeof import("../progress.js");
let store: Store;
let transitions: Transitions;
let progress: Progress;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  progress = await import("../progress.js");
  (await import("../../shared/db.js")).initDb();
});

describe("computeRootProgress", () => {
  it("counts completed/in-flight/total over the whole rootId family, root included", () => {
    const root = store.createWorkItem({ title: "epic", department: "core", assignee: "engineer" });
    const a = store.createWorkItem({ title: "a", parentId: root.id });
    const b = store.createWorkItem({ title: "b", parentId: root.id, assignee: "engineer" });
    const c = store.createWorkItem({ title: "c", parentId: root.id, assignee: "reviewer" });
    const c1 = store.createWorkItem({ title: "c1", parentId: c.id, assignee: "engineer" });
    const c2 = store.createWorkItem({ title: "c2", parentId: c.id, assignee: "reviewer" });

    transitions.transition(a.id, "done", "operator", { human: true });
    transitions.transition(b.id, "executing", "operator", {});
    transitions.transition(c1.id, "done", "operator", { human: true });
    // root, c, c2 stay backlog

    const result = progress.computeRootProgress(root.id);
    expect(result.rootId).toBe(root.id);
    expect(result.total).toBe(6); // root + a + b + c + c1 + c2
    expect(result.completed).toBe(2); // a, c1
    expect(result.inFlight).toBe(1); // b
    expect(result.completedPct).toBeCloseTo(33.3, 1);
  });

  it("treats cancelled as completed alongside done (transitions.ts TERMINAL_STATUSES)", () => {
    const root = store.createWorkItem({ title: "epic2" });
    const child = store.createWorkItem({ title: "child", parentId: root.id });
    transitions.transition(child.id, "cancelled", "operator", { human: true });

    const result = progress.computeRootProgress(root.id);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.inFlight).toBe(0);
  });

  it("does not leak items from a sibling tree with a different rootId", () => {
    const rootOne = store.createWorkItem({ title: "tree one" });
    store.createWorkItem({ title: "one child", parentId: rootOne.id });
    const rootTwo = store.createWorkItem({ title: "tree two" });
    store.createWorkItem({ title: "two child a", parentId: rootTwo.id });
    store.createWorkItem({ title: "two child b", parentId: rootTwo.id });

    expect(progress.computeRootProgress(rootOne.id).total).toBe(2);
    expect(progress.computeRootProgress(rootTwo.id).total).toBe(3);
  });

  it("scopes to one department when given, matching the stand-up's per-department view", () => {
    const root = store.createWorkItem({ title: "dept epic", department: "core" });
    store.createWorkItem({ title: "core child", parentId: root.id });
    const other = store.createWorkItem({ title: "other child", parentId: root.id, department: "billing" });

    const scoped = progress.computeRootProgress(root.id, { department: "billing" });
    expect(scoped.total).toBe(1);
    expect(scoped.rootId).toBe(root.id);
    expect(scoped.total).not.toBe(progress.computeRootProgress(root.id).total);
    void other;
  });

  it("returns zeros (not NaN) for a Todo with no descendants beyond itself", () => {
    const solo = store.createWorkItem({ title: "solo" });
    const result = progress.computeRootProgress(solo.id);
    expect(result).toMatchObject({ total: 1, completed: 0, inFlight: 0, completedPct: 0 });
  });
});

describe("computeEmployeeProgress", () => {
  it("groups completed/total/in-flight per assignee across the ledger, excluding unassigned items", () => {
    const alpha = store.createWorkItem({ title: "alpha task 1", assignee: "emp-alpha" });
    const alpha2 = store.createWorkItem({ title: "alpha task 2", assignee: "emp-alpha" });
    const alpha3 = store.createWorkItem({ title: "alpha task 3", assignee: "emp-alpha" });
    store.createWorkItem({ title: "beta task", assignee: "emp-beta" });
    store.createWorkItem({ title: "no owner" }); // unassigned — must not appear

    transitions.transition(alpha.id, "done", "operator", { human: true });
    transitions.transition(alpha2.id, "executing", "operator", {});
    // alpha3 stays backlog

    const rows = progress.computeEmployeeProgress();
    const alphaRow = rows.find((r) => r.assignee === "emp-alpha");
    const betaRow = rows.find((r) => r.assignee === "emp-beta");

    expect(alphaRow).toEqual({ assignee: "emp-alpha", total: 3, completed: 1, inFlight: 1 });
    expect(betaRow).toEqual({ assignee: "emp-beta", total: 1, completed: 0, inFlight: 0 });
    expect(rows.some((r) => r.assignee === "")).toBe(false);
  });

  it("scopes to one department when given", () => {
    store.createWorkItem({ title: "gamma core", assignee: "emp-gamma", department: "core" });
    store.createWorkItem({ title: "gamma billing", assignee: "emp-gamma", department: "billing" });

    const coreRows = progress.computeEmployeeProgress({ department: "core" });
    const gammaRow = coreRows.find((r) => r.assignee === "emp-gamma");
    expect(gammaRow?.total).toBe(1);
  });
});
