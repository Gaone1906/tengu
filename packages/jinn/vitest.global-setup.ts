import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertIsolatedTestHome,
  ensureIsolatedTestHome,
} from './vitest.test-home.js';

const TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

function makeTestDirectoriesRemovable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    makeTestDirectoriesRemovable(path.join(root, entry.name));
  }
}

export default function setup(): () => void {
  const systemTempRoot = os.tmpdir();
  const result = ensureIsolatedTestHome();

  // Belt-and-suspenders: never continue if assignment/canonicalization did not
  // actually move the run away from the production or another non-temp home.
  assertIsolatedTestHome(process.env.JINN_HOME);

  fs.mkdirSync(result.home, { recursive: true });
  const runTempRoot = fs.mkdtempSync(path.join(result.home, 'tmp-'));
  const previousTempEnv = Object.fromEntries(
    TEMP_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof TEMP_ENV_KEYS)[number], string | undefined>;
  const previousSystemTempRoot = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;

  process.env.JINN_VITEST_SYSTEM_TEMP_ROOT = systemTempRoot;
  for (const key of TEMP_ENV_KEYS) process.env[key] = runTempRoot;

  return () => {
    for (const key of TEMP_ENV_KEYS) {
      const previous = previousTempEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    if (previousSystemTempRoot === undefined) {
      delete process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;
    } else {
      process.env.JINN_VITEST_SYSTEM_TEMP_ROOT = previousSystemTempRoot;
    }

    const cleanupRoot = result.created ? result.home : runTempRoot;
    makeTestDirectoriesRemovable(cleanupRoot);
    fs.rmSync(cleanupRoot, {
      recursive: true,
      force: true,
    });
  };
}
