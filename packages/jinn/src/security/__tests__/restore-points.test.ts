import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { deleteRestorePoint, ensureRestorePoint, restoreFromRestorePoint } from "../restore-points.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restore-points-"));
  roots.push(root);
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "a.txt"), "original\n");
  git(["add", "a.txt"], root);
  git(["commit", "-q", "-m", "init"], root);
  return root;
}

describe("ensureRestorePoint", () => {
  it("records HEAD when the tree is clean", () => {
    const root = repoFixture();
    const head = git(["rev-parse", "HEAD"], root);
    const point = ensureRestorePoint(root, "sess-clean");
    expect(point?.sha).toBe(head);
    expect(git(["rev-parse", "refs/jinn/sess-clean"], root)).toBe(head);
  });

  it("records a stash-create snapshot when the tree is dirty, without touching the working tree or stash list", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "a.txt"), "modified\n");
    const point = ensureRestorePoint(root, "sess-dirty");
    expect(point).toBeDefined();
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("modified\n");
    expect(git(["stash", "list"], root)).toBe("");
    expect(git(["status", "--porcelain"], root)).not.toBe("");
  });

  it("is idempotent: a second call for the same session does not move the ref", () => {
    const root = repoFixture();
    const first = ensureRestorePoint(root, "sess-idem");
    fs.writeFileSync(path.join(root, "a.txt"), "changed again\n");
    const second = ensureRestorePoint(root, "sess-idem");
    expect(second?.sha).toBe(first?.sha);
  });

  it("returns undefined for a non-git directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restore-points-nongit-"));
    roots.push(root);
    expect(ensureRestorePoint(root, "sess-nogit")).toBeUndefined();
  });
});

describe("restoreFromRestorePoint", () => {
  it("restores a dirty tree back to its pre-session state", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "b.txt"), "should be reverted\n");
    fs.writeFileSync(path.join(root, "a.txt"), "changed before restore point\n");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "pre-session baseline"], root);

    fs.writeFileSync(path.join(root, "a.txt"), "dirty session edit\n");
    const point = ensureRestorePoint(root, "sess-restore");
    expect(point).toBeDefined();

    fs.writeFileSync(path.join(root, "a.txt"), "even more session edits\n");
    fs.writeFileSync(path.join(root, "b.txt"), "session touched this too\n");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "session work that must be undone"], root);

    const restored = restoreFromRestorePoint(root, "sess-restore");
    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("dirty session edit\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf-8")).toBe("should be reverted\n");
  });

  it("returns false when no restore point was recorded", () => {
    const root = repoFixture();
    expect(restoreFromRestorePoint(root, "never-recorded")).toBe(false);
  });
});

describe("deleteRestorePoint", () => {
  it("removes the ref so a later ensureRestorePoint call creates a fresh one", () => {
    const root = repoFixture();
    const first = ensureRestorePoint(root, "sess-delete");
    deleteRestorePoint(root, "sess-delete");
    fs.writeFileSync(path.join(root, "a.txt"), "new state\n");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "new baseline"], root);
    const second = ensureRestorePoint(root, "sess-delete");
    expect(second?.sha).not.toBe(first?.sha);
  });
});
