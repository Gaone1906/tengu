import { describe, it, expect, beforeAll, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-checkpoint-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Checkpoint = typeof import("../checkpoint.js");
type Reconcile = typeof import("../reconcile.js");

let store: Store;
let checkpoint: Checkpoint;
let reconcile: Reconcile;

beforeAll(async () => {
  store = await import("../store.js");
  checkpoint = await import("../checkpoint.js");
  reconcile = await import("../reconcile.js");
  (await import("../../shared/db.js")).initDb();
});

const repos: string[] = [];

afterEach(() => {
  while (repos.length > 0) fs.rmSync(repos.pop()!, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repoFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-checkpoint-repo-"));
  repos.push(root);
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "README.md"], root);
  git(["commit", "-q", "-m", "init"], root);
  return root;
}

function subSubTask(overrides: Partial<Parameters<Store["createWorkItem"]>[0]> = {}) {
  const root = store.createWorkItem({ title: "root" });
  const task = store.createWorkItem({ title: "task", parentId: root.id });
  const subTask = store.createWorkItem({ title: "sub-task", parentId: task.id });
  const subSub = store.createWorkItem({ title: "sub-sub-task", parentId: subTask.id, ...overrides });
  return { root, task, subTask, subSub };
}

describe("verify field — depth-3 only", () => {
  it("attaches a verifyCommand at create time on a depth-3 item", () => {
    const { subSub } = subSubTask({ verifyCommand: "test -f README.md" });
    expect(subSub.depth).toBe(3);
    expect(subSub.verifyCommand).toBe("test -f README.md");
    expect(store.getWorkItem(subSub.id)!.verifyCommand).toBe("test -f README.md");
  });

  it("refuses a verifyCommand on anything shallower than depth 3", () => {
    const root = store.createWorkItem({ title: "root2" });
    expect(() => store.createWorkItem({ title: "task2", parentId: root.id, verifyCommand: "true" }))
      .toThrow(/depth-3/);
    expect(root.verifyCommand).toBeNull();
  });

  it("setVerifyCommand updates an existing depth-3 item and audits it, but refuses a shallower one", () => {
    const { task, subSub } = subSubTask();
    expect(subSub.verifyCommand).toBeNull();
    const updated = checkpoint.setVerifyCommand(subSub.id, "  echo ok  ", "planner");
    expect(updated).toBe("echo ok");
    expect(store.getWorkItem(subSub.id)!.verifyCommand).toBe("echo ok");
    const events = store.listWorkItemEvents(subSub.id);
    expect(events.some((e) => e.kind === "metadata_edited" && e.detail?.verifyCommand === "echo ok")).toBe(true);
    expect(() => checkpoint.setVerifyCommand(task.id, "true", "planner")).toThrow(/depth-3/);
  });
});

describe("runVerifyCommand — routed through evaluateCommandPolicy", () => {
  it("passes for a command that exits 0", () => {
    const root = repoFixture();
    const result = checkpoint.runVerifyCommand("test -f README.md", root);
    expect(result.outcome).toBe("passed");
  });

  it("fails for a command that exits non-zero, without throwing", () => {
    const root = repoFixture();
    const result = checkpoint.runVerifyCommand("test -f does-not-exist.md", root);
    expect(result.outcome).toBe("failed");
  });

  it("blocks a destructive command instead of ever running it", () => {
    const root = repoFixture();
    const result = checkpoint.runVerifyCommand("git reset --hard HEAD~1", root);
    expect(result.outcome).toBe("blocked");
    expect(result.blockedReason).toMatch(/reset --hard/);
    expect(git(["log", "--oneline"], root).split("\n")).toHaveLength(1); // untouched
  });
});

describe("landCheckpoint — commit first, then ledger status", () => {
  it("commits the work, runs verify, and only then marks the unit done", () => {
    const root = repoFixture();
    const { subSub } = subSubTask({ verifyCommand: "test -f note.txt" });
    fs.writeFileSync(path.join(root, "note.txt"), "done\n");
    git(["add", "note.txt"], root);

    const result = checkpoint.landCheckpoint(subSub.id, { cwd: root, actor: "engineer", summary: "add note" });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["log", "-1", "--pretty=%s"], root)).toBe(`${subSub.id}: add note`);
    expect(result.verify?.outcome).toBe("passed");
    expect(store.getWorkItem(subSub.id)!.status).toBe("done");
  });

  it("throws when verify fails after a successful commit — the commit still lands (safe to redo via reconcile)", () => {
    const root = repoFixture();
    const { subSub } = subSubTask({ verifyCommand: "test -f never-written.txt" });
    fs.writeFileSync(path.join(root, "unrelated.txt"), "x\n");
    git(["add", "unrelated.txt"], root);

    let threw: unknown;
    try {
      checkpoint.landCheckpoint(subSub.id, { cwd: root, actor: "engineer", summary: "attempt" });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(checkpoint.CheckpointError);
    expect((threw as InstanceType<Checkpoint["CheckpointError"]>).code).toBe("verify-failed");
    // The commit is durable even though the ledger write never happened.
    expect(git(["log", "-1", "--pretty=%s"], root)).toBe(`${subSub.id}: attempt`);
    expect(store.getWorkItem(subSub.id)!.status).not.toBe("done");
  });

  it("lands a unit with no verifyCommand on commit alone (no machine-checkable criterion — commit is the only gate)", () => {
    const root = repoFixture();
    const { subSub } = subSubTask();
    fs.writeFileSync(path.join(root, "docs.md"), "note\n");
    git(["add", "docs.md"], root);

    const result = checkpoint.landCheckpoint(subSub.id, { cwd: root, actor: "engineer", summary: "docs" });
    expect(result.verify).toBeUndefined();
    expect(store.getWorkItem(subSub.id)!.status).toBe("done");
  });
});

describe("reconcileCheckpointsOnResume — the crash-between-commit-and-status window", () => {
  it("marks a unit done via a passing verify, without redoing any work or spending a model call", () => {
    const root = repoFixture();
    const { subTask, subSub } = subSubTask({ verifyCommand: "test -f landed.txt" });
    // Simulate exactly the crash window: the work is committed, but the process
    // died before the transition() call that would have marked it done.
    fs.writeFileSync(path.join(root, "landed.txt"), "already here\n");
    git(["add", "landed.txt"], root);
    git(["commit", "-q", "-m", `${subSub.id}: landed before the crash`], root);
    expect(store.getWorkItem(subSub.id)!.status).not.toBe("done");

    const result = reconcile.reconcileCheckpointsOnResume(root, { rootId: subTask.rootId });

    expect(result.recovered).toBe(1);
    expect(store.getWorkItem(subSub.id)!.status).toBe("done");
    const events = store.listWorkItemEvents(subSub.id);
    expect(events.some((e) => e.actor === "reconciler" && e.toStatus === "done")).toBe(true);
  });

  it("leaves a not-yet-finished unit exactly where it was", () => {
    const root = repoFixture();
    const { subTask, subSub } = subSubTask({ verifyCommand: "test -f still-missing.txt" });

    const result = reconcile.reconcileCheckpointsOnResume(root, { rootId: subTask.rootId });

    expect(result.recovered).toBe(0);
    expect(store.getWorkItem(subSub.id)!.status).not.toBe("done");
  });

  it("never touches a sub-sub-task without a verify command", () => {
    const root = repoFixture();
    const { subTask, subSub } = subSubTask();

    const result = reconcile.reconcileCheckpointsOnResume(root, { rootId: subTask.rootId });

    expect(result.checked).toBe(0);
    expect(result.recovered).toBe(0);
    expect(store.getWorkItem(subSub.id)!.status).not.toBe("done");
  });
});
