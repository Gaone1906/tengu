import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../shared/logger.js";

/**
 * WIP rescue (docs/tengu/10-checkpointing.md): on a hard interruption — the
 * usage governor's 80% line cutting a sub-sub-task off mid-edit, before the
 * checkpoint pair (commit + status) ever lands — commit whatever is on disk to
 * a scratch ref, `refs/jinn/wip/<sessionId>`, so nothing is lost.
 *
 * Deliberately a SEPARATE namespace from `security/restore-points.ts`'s
 * `refs/jinn/<sessionId>` (a pre-mutation safety snapshot taken once per
 * session) rather than reusing it: a restore point is "what the tree looked
 * like before the agent touched it"; a WIP ref is "what the agent had built,
 * uncommitted, when the cut happened" — composing, not competing.
 *
 * Captures BOTH tracked and untracked changes without touching the real
 * working tree or index: a scratch index file (`GIT_INDEX_FILE`) builds the
 * tree, `commit-tree` makes the commit directly, and `update-ref` points the
 * ref at it. Ignored files stay excluded (`git add -A` still honors
 * .gitignore) — same posture as `ensureRestorePoint`'s stash-create path.
 */

export interface WipRescueResult {
  sessionId: string;
  ref: string;
  sha: string;
}

function refName(sessionId: string): string {
  return `refs/jinn/wip/${sessionId}`;
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 15_000, env: env ? { ...process.env, ...env } : undefined }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  } catch {
    return false;
  }
}

function refSha(cwd: string, ref: string): string | undefined {
  try {
    return git(["rev-parse", "--verify", "--quiet", ref], cwd);
  } catch {
    return undefined;
  }
}

/**
 * Commit on-disk edits (tracked AND untracked) to `refs/jinn/wip/<sessionId>`,
 * without touching the real working tree or the real index. Returns undefined
 * when there is nothing to rescue (a clean tree, or a non-git cwd) — a hard
 * halt with no in-flight edits is not an error, just nothing to do.
 */
export function commitWipRef(cwd: string, sessionId: string, message = "jinn wip rescue"): WipRescueResult | undefined {
  if (!sessionId) return undefined;
  if (!isGitRepo(cwd)) {
    logger.warn(`security/wip-rescue: ${cwd} is not a git repo, skipping WIP rescue for session ${sessionId}`);
    return undefined;
  }
  const parentSha = git(["rev-parse", "HEAD"], cwd);
  const parentTree = git(["rev-parse", `${parentSha}^{tree}`], cwd);
  const scratchIndex = path.join(os.tmpdir(), `jinn-wip-index-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: scratchIndex };
    git(["read-tree", parentSha], cwd, env);
    git(["add", "-A"], cwd, env);
    const treeSha = git(["write-tree"], cwd, env);
    if (treeSha === parentTree) {
      logger.info(`security/wip-rescue: nothing to rescue for session ${sessionId} (tree matches HEAD)`);
      return undefined;
    }
    const sha = git(["commit-tree", treeSha, "-p", parentSha, "-m", message], cwd);
    const ref = refName(sessionId);
    git(["update-ref", ref, sha], cwd);
    logger.info(`security/wip-rescue: rescued in-flight edits for session ${sessionId} to ${ref} (${sha})`);
    return { sessionId, ref, sha };
  } finally {
    fs.rmSync(scratchIndex, { force: true });
  }
}

/**
 * Hard-reset `cwd` to a session's WIP ref. Callers should decide whether the
 * rescued state is finishable (re-run `verify`) or should be discarded before
 * calling this — it overwrites the current working tree.
 */
export function restoreWipRef(cwd: string, sessionId: string): boolean {
  const ref = refName(sessionId);
  const sha = refSha(cwd, ref);
  if (!sha) {
    logger.warn(`security/wip-rescue: no WIP ref ${ref} to restore`);
    return false;
  }
  git(["reset", "--hard", sha], cwd);
  logger.info(`security/wip-rescue: restored ${cwd} to ${ref} (${sha}) for session ${sessionId}`);
  return true;
}

export function hasWipRef(cwd: string, sessionId: string): boolean {
  return refSha(cwd, refName(sessionId)) !== undefined;
}

export function deleteWipRef(cwd: string, sessionId: string): void {
  const ref = refName(sessionId);
  if (refSha(cwd, ref)) {
    git(["update-ref", "-d", ref], cwd);
  }
}
