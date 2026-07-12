import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpTempSandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
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
