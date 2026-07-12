import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpTempSandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export interface McpTempReaperOptions {
  nowMs?: number;
  staleAfterMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

const MCP_TEMP_NAME = /^jinn-mcp-(\d+)-[A-Za-z0-9]{6}$/;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove launcher-owned roots left behind when the launcher was killed abruptly. */
export function reapStaleMcpTempSandboxes(
  parent: string,
  opts: McpTempReaperOptions = {},
): number {
  const nowMs = opts.nowMs ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isProcessAlive = opts.isProcessAlive ?? processIsAlive;
  let removed = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const match = MCP_TEMP_NAME.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = path.join(parent, entry.name);
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (nowMs - stat.mtimeMs < staleAfterMs) continue;
      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || isProcessAlive(ownerPid)) continue;
      makeDirectoriesRemovable(root);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed += 1;
    } catch {
      // Best effort: a concurrent launcher may have removed or changed it.
    }
  }
  return removed;
}

/**
 * Give one external MCP process exclusive ownership of its temporary files.
 *
 * Some browser drivers create launch artifacts before their own cleanup has
 * been registered. Keeping those artifacts below one launcher-owned root lets
 * Jinn remove the whole tree when the MCP process exits instead of leaking
 * thousands of siblings into the machine-wide temporary directory.
 */
export function createMcpTempSandbox(env: NodeJS.ProcessEnv = process.env): McpTempSandbox {
  const parent = env.TMPDIR || env.TMP || env.TEMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  reapStaleMcpTempSandboxes(parent);
  const root = fs.mkdtempSync(path.join(parent, `jinn-mcp-${process.pid}-`));
  let cleaned = false;

  return {
    root,
    env: { ...env, TMPDIR: root, TMP: root, TEMP: root },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      makeDirectoriesRemovable(root);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

function makeDirectoriesRemovable(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  try { fs.chmodSync(root, 0o700); } catch { /* best-effort cleanup */ }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    makeDirectoriesRemovable(path.join(root, entry.name));
  }
}
