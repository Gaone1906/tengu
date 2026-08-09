import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB — off the live DB. Set BEFORE importing the store
// (SESSIONS_DB is resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-profile-phase-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Profiles = typeof import("../profiles.js");
type Phases = typeof import("../phases.js");
let store: Store;
let profiles: Profiles;
let phases: Phases;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  profiles = await import("../profiles.js");
  phases = await import("../phases.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("profile — root-only overlay (D22)", () => {
  it("creating a root with a profileId stores and reads it back", () => {
    const profile = profiles.resolveProfile(db, "personal", "Personal", "#22cc88");
    expect(profile.slug).toBe("personal");
    expect(profile.name).toBe("Personal");
    expect(profile.color).toBe("#22cc88");
    expect(profile.id).toMatch(/^prf_[0-9a-f]{12}$/);

    const root = store.createWorkItem({ title: "side project", profileId: profile.id });
    expect(root.depth).toBe(0);
    expect(root.profileId).toBe(profile.id);

    const fetched = store.getWorkItem(root.id);
    expect(fetched?.profileId).toBe(profile.id);
  });

  it("creating a non-root with profileId throws", () => {
    const profile = profiles.resolveProfile(db, "work", "Work");
    const root = store.createWorkItem({ title: "root for sub-task profile test" });
    expect(() =>
      store.createWorkItem({ title: "sub-task", parentId: root.id, profileId: profile.id }),
    ).toThrow(/profileId can only be set on a root Todo/);
  });

  it("resolveProfile is get-or-create: a repeat slug returns the same row", () => {
    const first = profiles.resolveProfile(db, "hobby", "Hobby");
    const second = profiles.resolveProfile(db, "hobby", "Ignored on a cache hit");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Hobby");
  });

  it("listProfiles returns every registered profile, ordered by slug", () => {
    const slugs = profiles.listProfiles(db).map((p) => p.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toContain("personal");
    expect(slugs).toContain("work");
    expect(slugs).toContain("hobby");
  });
});

describe("phase registry — CRUD for a project (D21)", () => {
  it("resolvePhase registers a phase for a root and defaults sequenceOrder", () => {
    const root = store.createWorkItem({ title: "phase registry project" });
    const design = phases.resolvePhase(db, root.id, "design");
    expect(design.rootId).toBe(root.id);
    expect(design.slug).toBe("design");
    expect(design.sequenceOrder).toBe(0);

    const build = phases.resolvePhase(db, root.id, "build");
    expect(build.sequenceOrder).toBe(1);
  });

  it("listPhases reads a project's phases ordered by sequence", () => {
    const root = store.createWorkItem({ title: "phase list project" });
    phases.resolvePhase(db, root.id, "design");
    phases.resolvePhase(db, root.id, "build");
    phases.resolvePhase(db, root.id, "ship");

    const list = phases.listPhases(db, root.id);
    expect(list.map((p) => p.slug)).toEqual(["design", "build", "ship"]);
  });

  it("resolvePhase is get-or-create: a repeat slug keeps its original order", () => {
    const root = store.createWorkItem({ title: "phase reget project" });
    const first = phases.resolvePhase(db, root.id, "design");
    const second = phases.resolvePhase(db, root.id, "design", 99);
    expect(second.sequenceOrder).toBe(first.sequenceOrder);
  });

  it("reorderPhase updates an existing phase's sequence and throws for an unregistered one", () => {
    const root = store.createWorkItem({ title: "phase reorder project" });
    phases.resolvePhase(db, root.id, "design");
    const reordered = phases.reorderPhase(db, root.id, "design", 5);
    expect(reordered.sequenceOrder).toBe(5);
    expect(() => phases.reorderPhase(db, root.id, "unknown-phase", 1)).toThrow(/not registered/);
  });

  it("deletePhase removes a phase from the registry", () => {
    const root = store.createWorkItem({ title: "phase delete project" });
    phases.resolvePhase(db, root.id, "design");
    expect(phases.listPhases(db, root.id).map((p) => p.slug)).toEqual(["design"]);
    phases.deletePhase(db, root.id, "design");
    expect(phases.listPhases(db, root.id)).toEqual([]);
  });

  it("phases are scoped by rootId, not shared across projects", () => {
    const rootA = store.createWorkItem({ title: "project A" });
    const rootB = store.createWorkItem({ title: "project B" });
    phases.resolvePhase(db, rootA.id, "design");
    expect(phases.listPhases(db, rootB.id)).toEqual([]);
  });
});

describe("phase transitions — audited via work_item_events (D21)", () => {
  it("setWorkItemPhase records a phase_changed event and updates the column", () => {
    const item = store.createWorkItem({ title: "phase transition item" });
    expect(item.phase).toBeNull();

    const updated = store.setWorkItemPhase(item.id, "design", "operator");
    expect(updated.phase).toBe("design");

    const events = store.listWorkItemEvents(item.id);
    const phaseChanged = events.filter((e) => e.kind === "phase_changed");
    expect(phaseChanged).toHaveLength(1);
    expect(phaseChanged[0].detail).toEqual({ fromPhase: null, toPhase: "design" });
    expect(phaseChanged[0].actor).toBe("operator");

    // The registry gained the phase as a side effect of the transition.
    expect(phases.listPhases(db, item.rootId).map((p) => p.slug)).toContain("design");
  });

  it("a second transition records fromPhase as the prior value", () => {
    const item = store.createWorkItem({ title: "phase transition item 2", phase: "design" });
    store.setWorkItemPhase(item.id, "build", "operator");

    const phaseChanged = store.listWorkItemEvents(item.id).filter((e) => e.kind === "phase_changed");
    expect(phaseChanged).toHaveLength(1);
    expect(phaseChanged[0].detail).toEqual({ fromPhase: "design", toPhase: "build" });
  });

  it("setting the same phase again is a no-op that appends no event", () => {
    const item = store.createWorkItem({ title: "phase transition item 3", phase: "design" });
    const before = store.listWorkItemEvents(item.id).length;
    store.setWorkItemPhase(item.id, "design", "operator");
    expect(store.listWorkItemEvents(item.id).length).toBe(before);
  });

  it("createWorkItem inherits phase from the parent when not given explicitly", () => {
    const root = store.createWorkItem({ title: "phase inherit root", phase: "design" });
    const child = store.createWorkItem({ title: "phase inherit child", parentId: root.id });
    expect(child.phase).toBe("design");
  });
});
