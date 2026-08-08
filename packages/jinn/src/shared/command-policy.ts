import { execFileSync } from "node:child_process";

export type CommandPolicyAction = "allow" | "block";

export interface CommandPolicyDecision {
  action: CommandPolicyAction;
  reason?: string;
}

const DESTRUCTIVE: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing destructive recursive removal of a home/root path" },
  { re: /(^|[;&|]\s*)sudo\s+rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\//i, reason: "Refusing sudo destructive removal" },
  { re: /(^|[;&|]\s*)(?:mkfs|dd\s+if=.*\sof=\/dev\/|diskutil\s+erase)/i, reason: "Refusing disk-destructive command" },
  { re: /(^|[;&|]\s*)git\s+reset\s+.*--hard\b/i, reason: "Refusing git reset --hard (discards uncommitted work; use --soft or --mixed)" },
  { re: /(^|[;&|]\s*)git\s+checkout\s+(?:\S+\s+)?--\s+\.(?:\s|$)/i, reason: "Refusing git checkout -- . (discards all local changes in the tree)" },
  { re: /(^|[;&|]\s*)git\s+clean\b(?=[^\n;&|]*-[A-Za-z]*f)(?=[^\n;&|]*-[A-Za-z]*d)/i, reason: "Refusing git clean -fd/-fdx (permanently deletes untracked files and directories)" },
  { re: /(^|[;&|]\s*)git\s+push\b[^\n;&|]*?(?:--force(?!-with-lease)\b|(?:^|\s)-f(?:\s|$))/i, reason: "Refusing git push --force (use --force-with-lease instead)" },
  // Case-sensitive on purpose: -D force-deletes an unmerged branch, -d (safe, merged-only) must stay allowed.
  { re: /(^|[;&|]\s*)git\s+branch\b[^\n;&|]*?(?:^|\s)-D(?:\s|$)/, reason: "Refusing git branch -D (force-deletes a branch, possibly losing unmerged commits)" },
  { re: /(^|[;&|]\s*)git\s+stash\s+(?:drop|clear)\b/i, reason: "Refusing git stash drop/clear (permanently discards stashed work)" },
  { re: /\bDROP\s+TABLE\b/i, reason: "Refusing DROP TABLE" },
  { re: /\bTRUNCATE\s+(?:TABLE\s+\S|\S+\s*;)/i, reason: "Refusing TRUNCATE" },
];

const SECRET_PATH = /(?:~\/\.ssh|\$HOME\/\.ssh|\.ssh\/id_[a-z0-9]+|~\/\.jinn\/secrets|\$HOME\/\.jinn\/secrets|\.env(?:\.[\w.-]+)?|auth\.json)/i;
const EXFIL = /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ftp|sftp|python\s+-m\s+http\.server)\b/i;

function hasUnsafeDeleteWithoutWhere(text: string): boolean {
  for (const statement of text.split(/[;\n]+/)) {
    if (/\bDELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) return true;
  }
  return false;
}

const REDIRECT_RE = /(?:^|[\s;&|])(?:[0-9]|&)?>(?!>)\s*("[^"]*"|'[^']*'|\S+)/g;
const NON_FILE_TARGET = /^(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr|&\d)$/;

function isTrackedFile(cwd: string, filePath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", filePath], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

function findTrackedFileTruncation(text: string, cwd: string): string | undefined {
  REDIRECT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REDIRECT_RE.exec(text))) {
    let target = match[1];
    if (target.length >= 2 && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) {
      target = target.slice(1, -1);
    }
    if (!target || NON_FILE_TARGET.test(target)) continue;
    if (isTrackedFile(cwd, target)) return target;
  }
  return undefined;
}

export function evaluateCommandPolicy(command: string, cwd: string = process.cwd()): CommandPolicyDecision {
  const text = String(command ?? "").trim();
  if (!text) return { action: "allow" };
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(text)) return { action: "block", reason: rule.reason };
  }
  if (hasUnsafeDeleteWithoutWhere(text)) {
    return { action: "block", reason: "Refusing DELETE FROM without a WHERE clause" };
  }
  const truncated = findTrackedFileTruncation(text, cwd);
  if (truncated) {
    return { action: "block", reason: `Refusing to truncate tracked file via '>': ${truncated}` };
  }
  if (SECRET_PATH.test(text) && EXFIL.test(text)) {
    return { action: "block", reason: "Refusing command that appears to exfiltrate secret files" };
  }
  return { action: "allow" };
}
