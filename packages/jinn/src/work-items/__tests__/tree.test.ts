import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-tree-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
  (await import("../../shared/db.js")).initDb();
});

describe("getWorkItemTree", () => {
  it("returns the nested subtree with status totals", () => {
    const root = store.createWorkItem({ title: "tree root" });
    const a = store.createWorkItem({ title: "a", parentId: root.id });
    const b = store.createWorkItem({ title: "b", parentId: root.id });
    const a1 = store.createWorkItem({ title: "a1", parentId: a.id });
    const tree = store.getWorkItemTree(root.id)!;
    expect(tree.root.id).toBe(root.id);
    expect(tree.root.children.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(tree.root.children.find((c) => c.id === a.id)!.children[0].id).toBe(a1.id);
    expect(tree.totals.backlog).toBe(4);
    expect(tree.spendUsd).toBe(0);
  });

  it("returns the subtree when asked for a mid-tree node", () => {
    const root = store.createWorkItem({ title: "r2" });
    const mid = store.createWorkItem({ title: "mid", parentId: root.id });
    store.createWorkItem({ title: "leaf", parentId: mid.id });
    const tree = store.getWorkItemTree(mid.id)!;
    expect(tree.root.id).toBe(mid.id);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.totals.backlog).toBe(2); // mid + leaf, not the root
  });
});

describe("new list filters", () => {
  it("rootsOnly and createdBy filter correctly", () => {
    const mine = store.createWorkItem({ title: "mine", createdBy: "operator" });
    store.createWorkItem({ title: "child of mine", parentId: mine.id, createdBy: "a-lead" });
    const roots = store.listWorkItems({ rootsOnly: true, createdBy: "operator", text: "mine" });
    expect(roots.some((i) => i.id === mine.id)).toBe(true);
    expect(roots.every((i) => i.parentId === null)).toBe(true);
  });
});
