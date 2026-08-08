import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-fanout-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
  (await import("../../shared/db.js")).initDb();
});

/** Gate 1 of fan-out (docs/tengu/07-fanout-policy.md, D8): the planner's
 *  `parallelSafe`/`parallelGroup` annotation, persisted on work-items/store.ts. */
describe("fan-out planning fields — parallelSafe / parallelGroup", () => {
  it("defaults to false/null for an item the planner never annotated", () => {
    const item = store.createWorkItem({ title: "untouched" });
    expect(item.parallelSafe).toBe(false);
    expect(item.parallelGroup).toBeNull();
    expect(store.getWorkItem(item.id)!.parallelSafe).toBe(false);
  });

  it("persists an explicit parallelSafe + parallelGroup set at create time", () => {
    const item = store.createWorkItem({ title: "safe", parallelSafe: true, parallelGroup: "svc-a" });
    expect(item.parallelSafe).toBe(true);
    expect(item.parallelGroup).toBe("svc-a");
    expect(store.getWorkItem(item.id)!.parallelGroup).toBe("svc-a");
  });

  it("survives a batch read (getWorkItems) the same as a single read", () => {
    const a = store.createWorkItem({ title: "a", parallelSafe: true, parallelGroup: "grp" });
    const b = store.createWorkItem({ title: "b" });
    const [batchA, batchB] = store.getWorkItems([a.id, b.id]);
    expect(batchA.parallelSafe).toBe(true);
    expect(batchA.parallelGroup).toBe("grp");
    expect(batchB.parallelSafe).toBe(false);
  });

  it("setWorkItemFanout updates an existing item and audits the change", () => {
    const item = store.createWorkItem({ title: "revise-me" });
    expect(item.parallelSafe).toBe(false);
    const stored = store.setWorkItemFanout(item.id, { parallelSafe: true, parallelGroup: "svc-b" }, "planner");
    expect(stored.parallelSafe).toBe(true);
    expect(stored.parallelGroup).toBe("svc-b");
    expect(store.getWorkItem(item.id)!.parallelSafe).toBe(true);
    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "metadata_edited" && e.detail?.parallelSafe === true && e.detail?.parallelGroup === "svc-b")).toBe(true);
  });

  it("setWorkItemFanout throws for an unknown item", () => {
    expect(() => store.setWorkItemFanout("NOPE-999", { parallelSafe: true }, "planner")).toThrow();
  });

  it("clearing parallelGroup back to null persists", () => {
    const item = store.createWorkItem({ title: "clear-me", parallelSafe: true, parallelGroup: "grp" });
    store.setWorkItemFanout(item.id, { parallelSafe: true, parallelGroup: null }, "planner");
    expect(store.getWorkItem(item.id)!.parallelGroup).toBeNull();
  });
});
