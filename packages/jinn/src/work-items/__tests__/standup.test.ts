import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-standup-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Standup = typeof import("../standup.js");
type Progress = typeof import("../progress.js");
type Comments = typeof import("../comments.js");
let store: Store;
let transitions: Transitions;
let standup: Standup;
let progress: Progress;
let comments: Comments;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  standup = await import("../standup.js");
  progress = await import("../progress.js");
  comments = await import("../comments.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  standup.clearStandupNarrativeCache();
});

function makeProject(title: string, workspacePath: string) {
  return store.createWorkItem({ title, workspacePath });
}

describe("computeProjectStandup", () => {
  it("groups two synthetic projects x two departments, counts matching the underlying tree, blocked items surfaced", async () => {
    const projectA = makeProject("project alpha", "/repos/alpha");
    const aCoreDone = store.createWorkItem({ title: "a-core-1", parentId: projectA.id, department: "core" });
    const aCoreBlocked = store.createWorkItem({ title: "a-core-2", parentId: projectA.id, department: "core" });
    const aCoreExec = store.createWorkItem({ title: "a-core-3", parentId: projectA.id, department: "core" });
    const aBillingBacklog = store.createWorkItem({ title: "a-billing-1", parentId: projectA.id, department: "billing" });

    transitions.transition(aCoreDone.id, "done", "operator", { human: true });
    transitions.transition(aCoreBlocked.id, "blocked", "operator", {});
    transitions.transition(aCoreExec.id, "executing", "operator", {});
    void aBillingBacklog;

    const projectB = makeProject("project beta", "/repos/beta");
    const bCoreDone1 = store.createWorkItem({ title: "b-core-1", parentId: projectB.id, department: "core" });
    const bCoreDone2 = store.createWorkItem({ title: "b-core-2", parentId: projectB.id, department: "core" });
    const bBillingBlocked = store.createWorkItem({ title: "b-billing-1", parentId: projectB.id, department: "billing" });

    transitions.transition(bCoreDone1.id, "done", "operator", { human: true });
    transitions.transition(bCoreDone2.id, "done", "operator", { human: true });
    transitions.transition(bBillingBlocked.id, "blocked", "operator", {});

    const result = await standup.computeStandup();
    const alpha = result.find((p) => p.rootId === projectA.id)!;
    const beta = result.find((p) => p.rootId === projectB.id)!;

    expect(alpha.title).toBe("project alpha");
    expect(alpha.workspacePath).toBe("/repos/alpha");
    expect(alpha.departments.map((d) => d.department).sort()).toEqual(["billing", "core"]);

    const alphaCore = alpha.departments.find((d) => d.department === "core")!;
    expect(alphaCore.progress).toEqual(progress.computeRootProgress(projectA.id, { department: "core" }));
    expect(alphaCore.progress.total).toBe(3);
    expect(alphaCore.progress.completed).toBe(1);
    expect(alphaCore.progress.inFlight).toBe(1);
    expect(alphaCore.blocked.map((i) => i.id)).toEqual([aCoreBlocked.id]);

    const alphaBilling = alpha.departments.find((d) => d.department === "billing")!;
    expect(alphaBilling.progress.total).toBe(1);
    expect(alphaBilling.blocked).toEqual([]);

    const betaCore = beta.departments.find((d) => d.department === "core")!;
    expect(betaCore.progress.total).toBe(2);
    expect(betaCore.progress.completed).toBe(2);
    expect(betaCore.blocked).toEqual([]);

    const betaBilling = beta.departments.find((d) => d.department === "billing")!;
    expect(betaBilling.progress.total).toBe(1);
    expect(betaBilling.blocked.map((i) => i.id)).toEqual([bBillingBlocked.id]);
  });

  it("excludes roots with no workspacePath from the stand-up", async () => {
    const bare = store.createWorkItem({ title: "no identity yet" });
    store.createWorkItem({ title: "child", parentId: bare.id, department: "core" });

    const result = await standup.computeStandup();
    expect(result.some((p) => p.rootId === bare.id)).toBe(false);
  });

  it("rejects a non-root id", async () => {
    const root = makeProject("project gamma", "/repos/gamma");
    const child = store.createWorkItem({ title: "child", parentId: root.id, department: "core" });
    await expect(standup.computeProjectStandup(child.id)).rejects.toThrow(/root/i);
  });

  it("createWorkItem rejects workspacePath on a non-root create", () => {
    const root = makeProject("project delta", "/repos/delta");
    expect(() => store.createWorkItem({ title: "child", parentId: root.id, workspacePath: "/nope" })).toThrow();
  });
});

describe("stand-up narrative cache", () => {
  it("does not re-summarize an unchanged window, but does after a new event", async () => {
    const project = makeProject("project cache", "/repos/cache");
    const item = store.createWorkItem({ title: "cache-1", parentId: project.id, department: "core" });

    let calls = 0;
    const narrator = () => {
      calls += 1;
      return `narrated call #${calls}`;
    };

    const first = await standup.computeDepartmentStandup(project.id, "core", { narrator });
    expect(first.narrativeFromCache).toBe(false);
    expect(calls).toBe(1);

    const second = await standup.computeDepartmentStandup(project.id, "core", { narrator });
    expect(second.narrativeFromCache).toBe(true);
    expect(second.narrative).toBe(first.narrative);
    expect(calls).toBe(1);

    transitions.transition(item.id, "executing", "operator", {});

    const third = await standup.computeDepartmentStandup(project.id, "core", { narrator });
    expect(third.narrativeFromCache).toBe(false);
    expect(calls).toBe(2);
    expect(third.narrative).not.toBe(first.narrative);
  });

  it("caches independently per (project, department)", async () => {
    const project = makeProject("project cache2", "/repos/cache2");
    store.createWorkItem({ title: "core-item", parentId: project.id, department: "core" });
    store.createWorkItem({ title: "billing-item", parentId: project.id, department: "billing" });

    let calls = 0;
    const narrator = () => {
      calls += 1;
      return `call #${calls}`;
    };

    await standup.computeDepartmentStandup(project.id, "core", { narrator });
    await standup.computeDepartmentStandup(project.id, "billing", { narrator });
    expect(calls).toBe(2);

    await standup.computeDepartmentStandup(project.id, "core", { narrator });
    await standup.computeDepartmentStandup(project.id, "billing", { narrator });
    expect(calls).toBe(2);
  });
});

describe("security-block incidents", () => {
  it("surfaces a security-authored system comment as an incident", async () => {
    const project = makeProject("project sec", "/repos/sec");
    const item = store.createWorkItem({ title: "sec-1", parentId: project.id, department: "core" });
    comments.addComment({ workItemId: item.id, author: "security", authorKind: "system", body: "**Bash blocked** — git reset --hard denied" });

    const row = await standup.computeDepartmentStandup(project.id, "core");
    expect(row.incidents).toHaveLength(1);
    expect(row.incidents[0]).toMatchObject({ kind: "security-block", workItemId: item.id, actor: "security" });
    expect(row.incidents[0].summary).toContain("git reset --hard");
  });
});
