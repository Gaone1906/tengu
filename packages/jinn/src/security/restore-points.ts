import { execFileSync } from "node:child_process";
import { logger } from "../shared/logger.js";

export interface RestorePoint {
  sessionId: string;
  ref: string;
  sha: string;
}

function refName(sessionId: string): string {
  return `refs/jinn/${sessionId}`;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
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

// git stash create builds a commit from tracked changes without touching the working tree or stash list; untracked files are not captured.
export function ensureRestorePoint(cwd: string, sessionId: string): RestorePoint | undefined {
  if (!sessionId) return undefined;
  if (!isGitRepo(cwd)) {
    logger.warn(`security/restore-points: ${cwd} is not a git repo, skipping restore point for session ${sessionId}`);
    return undefined;
  }
  const ref = refName(sessionId);
  const existing = refSha(cwd, ref);
  if (existing) return { sessionId, ref, sha: existing };

  const dirty = git(["status", "--porcelain"], cwd).length > 0;
  let sha: string | undefined;
  if (dirty) {
    try {
      sha = git(["stash", "create"], cwd) || undefined;
    } catch (err) {
      logger.warn(`security/restore-points: git stash create failed for session ${sessionId}: ${(err as Error).message}`);
    }
  }
  if (!sha) sha = git(["rev-parse", "HEAD"], cwd);

  git(["update-ref", ref, sha], cwd);
  logger.info(`security/restore-points: recorded ${ref} at ${sha} for session ${sessionId} (dirty=${dirty})`);
  return { sessionId, ref, sha };
}

export function restoreFromRestorePoint(cwd: string, sessionId: string): boolean {
  const ref = refName(sessionId);
  const sha = refSha(cwd, ref);
  if (!sha) {
    logger.warn(`security/restore-points: no restore point ${ref} to restore`);
    return false;
  }
  git(["reset", "--hard", sha], cwd);
  logger.info(`security/restore-points: restored ${cwd} to ${ref} (${sha}) for session ${sessionId}`);
  return true;
}

export function deleteRestorePoint(cwd: string, sessionId: string): void {
  const ref = refName(sessionId);
  if (refSha(cwd, ref)) {
    git(["update-ref", "-d", ref], cwd);
  }
}
