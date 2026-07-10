import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * DIST / ESM LIVE-SHAPE regression guard for the regex-eval worker.
 *
 * The vitest transform runs the source under a launch shape where a `{ eval:true }`
 * worker string happened to execute as CommonJS — so a `require('worker_threads')`
 * worker passed every unit test yet threw "require is not defined" under the REAL
 * gateway (built dist, package "type":"module" → the eval worker is ESM), failing
 * EVERY evaluation closed and breaking legit filters. Unit tests structurally
 * cannot catch that: they never run the built dist in a real node ESM process.
 *
 * This test does exactly that — it imports the BUILT dist module in a fresh
 * `node --input-type=module` process (the same way `node dist/bin/jinn.js` loads
 * it) and proves a legit filter MATCHES (the regression) and that a bomb dies by
 * the wall-clock TIMEOUT (not an instant worker error, which previously masked the
 * timeout path).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../../..'); // src/workflows/__tests__ → packages/jinn
const distModule = path.join(packageRoot, 'dist', 'src', 'workflows', 'regex-eval.js');

let result: { legit: boolean; nonMatch: boolean; bomb: boolean; bombMs: number };

beforeAll(() => {
  if (!existsSync(distModule)) {
    // Build once so the live-shape module exists (normal `pnpm test` builds first).
    execFileSync('pnpm', ['build'], { cwd: packageRoot, stdio: 'ignore', timeout: 180_000 });
  }
  const url = pathToFileURL(distModule).href;
  const script = `
import { evaluateRegexMatch, shutdownRegexEvalWorker } from ${JSON.stringify(url)};
const legit = await evaluateRegexMatch('^trial-[0-9]+$', 'trial-42');
const nonMatch = await evaluateRegexMatch('^trial-[0-9]+$', 'nope');
const t = Date.now();
const bomb = await evaluateRegexMatch('(a+)+$', 'a'.repeat(60) + '!', { timeoutMs: 50 });
const bombMs = Date.now() - t;
shutdownRegexEvalWorker();
process.stdout.write('<<RESULT>>' + JSON.stringify({ legit, nonMatch, bomb, bombMs }) + '<<END>>');
`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  // The module logs a warn line to stdout on timeout, so extract our sentinel-
  // wrapped JSON rather than parsing the whole stream.
  const match = out.match(/<<RESULT>>(.*)<<END>>/s);
  if (!match) throw new Error(`no result marker in subprocess output:\n${out}`);
  result = JSON.parse(match[1]);
}, 200_000);

describe('regex-eval worker — built dist / real node ESM shape', () => {
  it('a legit filter MATCHES in the live shape (regression: ESM worker must not require())', () => {
    // This is the assertion that would have caught 044cfa6's require() bug.
    expect(result.legit).toBe(true);
    expect(result.nonMatch).toBe(false);
  });

  it('a bomb dies by the wall-clock TIMEOUT (fail closed), not an instant worker error', () => {
    expect(result.bomb).toBe(false);
    // >= ~timeout proves the worker BOOTED and backtracked until terminate() —
    // an instant require/import error would resolve in a few ms.
    expect(result.bombMs).toBeGreaterThanOrEqual(40);
    expect(result.bombMs).toBeLessThan(1000);
  });
});
