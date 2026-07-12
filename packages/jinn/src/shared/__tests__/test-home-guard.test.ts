import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertIsolatedTestHome,
  canonicalPath,
  ensureIsolatedTestHome,
  isTempPath,
} from '../../../vitest.test-home.js';
import vitestConfig from '../../../vitest.config.js';
import setupVitest from '../../../vitest.global-setup.js';
import { JINN_HOME, SESSIONS_DB } from '../paths.js';
import { initDb } from '../../sessions/registry.js';
import { createWorkItem } from '../../work-items/store.js';

const createdHomes: string[] = [];

afterEach(() => {
  for (const home of createdHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('Vitest JINN_HOME guard', () => {
  it('runs both the pre-worker redirect and the per-worker assertion', () => {
    const config = vitestConfig as { test?: { globalSetup?: string; setupFiles?: string[] } };

    expect(config.test?.globalSetup).toBe('./vitest.global-setup.ts');
    expect(config.test?.setupFiles).toEqual(['./vitest.setup.ts']);
  });

  it('loudly rejects the default production home', () => {
    expect(() => assertIsolatedTestHome(path.join(os.homedir(), '.jinn')))
      .toThrow('refusing to run tests against prod JINN_HOME=~/.jinn');
  });

  it('redirects the default production home before workers launch', () => {
    const env: NodeJS.ProcessEnv = {
      JINN_HOME: path.join(os.homedir(), '.jinn'),
    };

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('redirects an unset home to a fresh directory under the OS temp root', () => {
    const env: NodeJS.ProcessEnv = {};

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('redirects a non-temp home instead of trusting it', () => {
    const env: NodeJS.ProcessEnv = {
      JINN_HOME: path.join(os.homedir(), '.jinn-test-unsafe'),
    };

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('routes generic test temp fixtures beneath the cleanup-owned home', () => {
    const relative = path.relative(
      canonicalPath(process.env.JINN_HOME!),
      canonicalPath(os.tmpdir()),
    );

    expect(relative).not.toBe('');
    expect(relative).not.toBe('..');
    expect(relative.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });

  it('removes read-only fixture directories during run cleanup', () => {
    const previousSystemTempRoot = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;
    const teardown = setupVitest();
    const runTempRoot = os.tmpdir();
    const lockedDir = path.join(runTempRoot, 'locked-fixture');
    const lockedFile = path.join(lockedDir, 'artifact');
    fs.mkdirSync(lockedDir);
    fs.writeFileSync(lockedFile, 'fixture');
    fs.chmodSync(lockedFile, 0o500);
    fs.chmodSync(lockedDir, 0o500);

    try {
      expect(() => teardown()).not.toThrow();
      expect(process.env.JINN_VITEST_SYSTEM_TEMP_ROOT).toBe(previousSystemTempRoot);
    } finally {
      if (fs.existsSync(lockedDir)) fs.chmodSync(lockedDir, 0o700);
      fs.rmSync(runTempRoot, { recursive: true, force: true });
    }
  });

  it('routes a real work-item write to the guarded temp registry', () => {
    expect(isTempPath(JINN_HOME)).toBe(true);
    expect(SESSIONS_DB).toBe(path.join(JINN_HOME, 'sessions', 'registry.db'));
    expect(SESSIONS_DB).not.toBe(
      path.join(os.homedir(), '.jinn', 'sessions', 'registry.db'),
    );

    const item = createWorkItem({ title: 'test-home guard integration' });
    const row = initDb()
      .prepare('SELECT title FROM work_items WHERE id = ?')
      .get(item.id);

    expect(row).toEqual({ title: 'test-home guard integration' });
    expect(fs.existsSync(SESSIONS_DB)).toBe(true);
  });
});
