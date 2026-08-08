import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { commitWipRef, deleteWipRef, hasWipRef, restoreWipRef } from "../wip-rescue.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wip-rescue-"));
  roots.push(root);
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "Test"], root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n");
  git(["add", "tracked.txt"], root);
  git(["commit", "-q", "-m", "init"], root);
  return root;
}

describe("commitWipRef", () => {
  it("captures an in-progress edit (tracked + untracked) without touching the working tree or index", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "tracked.txt"), "mid-edit\n");
    fs.writeFileSync(path.join(root, "new-file.ts"), "export const x = 1;\n");

    const rescue = commitWipRef(root, "sess-wip-1");

    expect(rescue).toBeDefined();
    expect(git(["rev-parse", "refs/jinn/wip/sess-wip-1"], root)).toBe(rescue!.sha);
    // The working tree and index are untouched — the agent's mid-edit state
    // still looks exactly like it did before the rescue ran.
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf-8")).toBe("mid-edit\n");
    expect(git(["status", "--porcelain"], root)).not.toBe("");
    // The rescue commit itself carries both the tracked edit and the untracked file.
    const rescuedFiles = git(["ls-tree", "-r", "--name-only", rescue!.sha], root).split("\n");
    expect(rescuedFiles).toContain("tracked.txt");
    expect(rescuedFiles).toContain("new-file.ts");
    expect(git(["show", `${rescue!.sha}:tracked.txt`], root)).toBe("mid-edit");
    expect(git(["show", `${rescue!.sha}:new-file.ts`], root)).toBe("export const x = 1;");
  });

  it("returns undefined when there is nothing on disk to rescue", () => {
    const root = repoFixture();
    expect(commitWipRef(root, "sess-wip-clean")).toBeUndefined();
    expect(hasWipRef(root, "sess-wip-clean")).toBe(false);
  });

  it("is idempotent-ish: a second call with new edits moves the ref forward", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "tracked.txt"), "edit one\n");
    const first = commitWipRef(root, "sess-wip-2");
    fs.writeFileSync(path.join(root, "tracked.txt"), "edit two\n");
    const second = commitWipRef(root, "sess-wip-2");
    expect(second!.sha).not.toBe(first!.sha);
    expect(git(["show", `${second!.sha}:tracked.txt`], root)).toBe("edit two");
  });

  it("returns undefined for a non-git directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wip-rescue-nongit-"));
    roots.push(root);
    expect(commitWipRef(root, "sess-nogit")).toBeUndefined();
  });
});

describe("restoreWipRef", () => {
  it("hard-resets the working tree to the rescued state, recovering the mid-edit", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "tracked.txt"), "mid-edit\n");
    fs.writeFileSync(path.join(root, "new-file.ts"), "export const x = 1;\n");
    commitWipRef(root, "sess-wip-3");

    // Simulate the hard cut: the process dies, and a later cleanup or a fresh
    // checkout leaves the working tree looking like nothing happened.
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: root });
    fs.rmSync(path.join(root, "new-file.ts"));
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf-8")).toBe("original\n");

    const restored = restoreWipRef(root, "sess-wip-3");

    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf-8")).toBe("mid-edit\n");
    expect(fs.readFileSync(path.join(root, "new-file.ts"), "utf-8")).toBe("export const x = 1;\n");
  });

  it("returns false when there is no WIP ref for the session", () => {
    const root = repoFixture();
    expect(restoreWipRef(root, "sess-none")).toBe(false);
  });
});

describe("deleteWipRef", () => {
  it("removes the ref once the rescued state has been resolved", () => {
    const root = repoFixture();
    fs.writeFileSync(path.join(root, "tracked.txt"), "mid-edit\n");
    commitWipRef(root, "sess-wip-4");
    expect(hasWipRef(root, "sess-wip-4")).toBe(true);
    deleteWipRef(root, "sess-wip-4");
    expect(hasWipRef(root, "sess-wip-4")).toBe(false);
  });
});
