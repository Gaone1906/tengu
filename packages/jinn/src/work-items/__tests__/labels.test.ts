import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-labels-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Labels = typeof import("../labels.js");
let store: Store;
let labels: Labels;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  labels = await import("../labels.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("createLabel", () => {
  it("normalizes names to lowercase kebab-case and stamps id/createdAt", () => {
    const label = labels.createLabel({ name: "  Deep Work  " });
    expect(label.id).toMatch(/^lbl_[0-9a-f]{12}$/);
    expect(label.name).toBe("deep-work");
    expect(label.color).toBeNull();
    expect(label.department).toBeNull();

    expect(labels.createLabel({ name: "Fix_Bugs NOW!" }).name).toBe("fix-bugs-now");
    expect(() => labels.createLabel({ name: "!!!" })).toThrow(/name/);
  });

  it("returns the existing label when the normalized name collides (UNIQUE race)", () => {
    const first = labels.createLabel({ name: "infra", color: "#00ff00" });
    const again = labels.createLabel({ name: "INFRA" });
    expect(again.id).toBe(first.id);
    expect(again.color).toBe("#00ff00"); // the original row wins; no overwrite
    expect(db.prepare("SELECT COUNT(*) FROM labels WHERE name = 'infra'").pluck().get()).toBe(1);
  });

  it("validates color and accepts a department scope", () => {
    expect(() => labels.createLabel({ name: "bad-color", color: "green" })).toThrow(/color/);
    const scoped = labels.createLabel({ name: "platform-only", color: "#A1B2C3", department: "platform" });
    expect(scoped.color).toBe("#A1B2C3");
    expect(scoped.department).toBe("platform");
  });
});

describe("setWorkItemLabels", () => {
  it("replaces the set by id or name, audits label_changed, and bumps the version", () => {
    const bug = labels.createLabel({ name: "bug" });
    labels.createLabel({ name: "perf" });
    const item = store.createWorkItem({ title: "labelled" });

    const set = labels.setWorkItemLabels(item.id, [bug.id, "perf"], "operator");
    expect(set.map((l) => l.name).sort()).toEqual(["bug", "perf"]);
    expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
    const event = store.listWorkItemEvents(item.id).find((e) => e.kind === "label_changed");
    expect(event?.detail?.labels).toEqual(["bug", "perf"]);

    const shrunk = labels.setWorkItemLabels(item.id, ["bug"], "operator");
    expect(shrunk.map((l) => l.name)).toEqual(["bug"]);
    expect(labels.getWorkItemLabels(item.id).map((l) => l.name)).toEqual(["bug"]);

    const cleared = labels.setWorkItemLabels(item.id, [], "operator");
    expect(cleared).toEqual([]);
  });

  it("is a no-op without an event when the set is unchanged", () => {
    labels.createLabel({ name: "steady" });
    const item = store.createWorkItem({ title: "steady item" });
    labels.setWorkItemLabels(item.id, ["steady"], "operator");
    const version = store.getWorkItem(item.id)!.version;

    // Same set again — by name, with duplicates, different order casing.
    labels.setWorkItemLabels(item.id, ["Steady", "steady"], "operator");
    expect(store.getWorkItem(item.id)!.version).toBe(version);
    const events = store.listWorkItemEvents(item.id).filter((e) => e.kind === "label_changed");
    expect(events).toHaveLength(1);
  });

  it("rejects an unknown label name listing the valid labels, and never creates implicitly", () => {
    const item = store.createWorkItem({ title: "strict item" });
    expect(() => labels.setWorkItemLabels(item.id, ["never-created-anywhere"], "operator")).toThrow(
      /never-created-anywhere.*valid labels/s,
    );
    expect(db.prepare("SELECT COUNT(*) FROM labels WHERE name = 'never-created-anywhere'").pluck().get()).toBe(0);
    expect(() => labels.setWorkItemLabels("ZZZ-999", [], "operator")).toThrow(/not found/);
  });
});

describe("labelSets", () => {
  it("answers many items in one batch with every requested id present", () => {
    labels.createLabel({ name: "batch-a" });
    labels.createLabel({ name: "batch-b" });
    const one = store.createWorkItem({ title: "one" });
    const two = store.createWorkItem({ title: "two" });
    const three = store.createWorkItem({ title: "three" });
    labels.setWorkItemLabels(one.id, ["batch-a", "batch-b"], "operator");
    labels.setWorkItemLabels(two.id, ["batch-b"], "operator");

    const sets = labels.labelSets([one.id, two.id, three.id]);
    expect(sets.get(one.id)!.map((l) => l.name)).toEqual(["batch-a", "batch-b"]);
    expect(sets.get(two.id)!.map((l) => l.name)).toEqual(["batch-b"]);
    expect(sets.get(three.id)).toEqual([]);
    expect(labels.labelSets([]).size).toBe(0);
  });
});

describe("list filter by label", () => {
  it("filters queryWorkItems by label name and by label id", () => {
    const urgent = labels.createLabel({ name: "urgent" });
    const tagged = store.createWorkItem({ title: "tagged" });
    const plain = store.createWorkItem({ title: "plain" });
    labels.setWorkItemLabels(tagged.id, ["urgent"], "operator");

    const byName = store.queryWorkItems({ label: "urgent" });
    expect(byName.workItems.map((w) => w.id)).toContain(tagged.id);
    expect(byName.workItems.map((w) => w.id)).not.toContain(plain.id);

    const byId = store.queryWorkItems({ label: urgent.id });
    expect(byId.workItems.map((w) => w.id)).toContain(tagged.id);
    expect(store.queryWorkItems({ label: "no-such-label" }).total).toBe(0);
  });
});

describe("listLabels", () => {
  it("lists all labels ordered by name", () => {
    const names = labels.listLabels().map((l) => l.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("bug");
    expect(names).toContain("urgent");
  });
});
