import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-gate-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Approvals = typeof import("../approvals.js");
let store: Store;
let transitions: Transitions;
let approvals: Approvals;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  approvals = await import("../approvals.js");
  (await import("../../shared/db.js")).initDb();
});

describe("roll-up close gate", () => {
  it("refuses done on a parent with an open child", () => {
    const parent = store.createWorkItem({ title: "gate parent" });
    store.createWorkItem({ title: "open child", parentId: parent.id });
    expect(() => transitions.transition(parent.id, "done", "operator", { human: true }))
      .toThrowError(/children-open|open children/);
  });

  it("allows done once all children are terminal", () => {
    const parent = store.createWorkItem({ title: "gate parent 2" });
    const child = store.createWorkItem({ title: "closing child", parentId: parent.id });
    transitions.transition(child.id, "done", "operator", { human: true });
    const result = transitions.transition(parent.id, "done", "operator", { human: true });
    expect(result.item.status).toBe("done");
  });

  it("cascade-cancels descendants depth-first under human authority", () => {
    const parent = store.createWorkItem({ title: "cascade parent" });
    const mid = store.createWorkItem({ title: "mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "leaf", parentId: mid.id });
    const archived = approvals.archiveWorkItem(parent.id, "operator", { human: true, cascade: true });
    expect(archived.status).toBe("cancelled");
    expect(store.getWorkItem(mid.id)!.status).toBe("cancelled");
    expect(store.getWorkItem(leaf.id)!.status).toBe("cancelled");
  });

  it("refuses archive on a parent with open children when cascade is not set", () => {
    const parent = store.createWorkItem({ title: "no-cascade parent" });
    store.createWorkItem({ title: "still open", parentId: parent.id });
    expect(() => approvals.archiveWorkItem(parent.id, "operator", { human: true })).toThrow();
  });
});
