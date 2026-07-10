import { Worker } from 'node:worker_threads';
import { logger } from '../shared/logger.js';

/**
 * Hard-isolated evaluation of operator-authored `matches` filter regexes.
 *
 * A regex cannot be safely run on the gateway thread: catastrophic backtracking
 * (`(a+)+$`) AND merely polynomial patterns (`^a*a*a*a*$`, O(n^4)) both block the
 * event loop, and no static detector or input-truncation is a sound boundary —
 * truncation even changes match semantics on anchored patterns. So the pattern is
 * run in a `worker_threads` Worker with a wall-clock timeout; a Worker is a real
 * OS thread and `terminate()` kills it even mid-CPU-bound-regex, which the main
 * thread cannot do to itself. Timeout / worker error / oversize input all fail
 * CLOSED (non-match) with one warn line naming the trigger.
 *
 * One persistent worker, serialized (a terminate/respawn must not race a
 * concurrent evaluation), respawned lazily after a terminate. Unref'd so it never
 * keeps the process (or a test runner) alive.
 */

// The worker MUST be authored as ESM (`import`, not `require`): the package is
// "type": "module", so under the real dist/live launch the worker executes as an
// ES module and a CommonJS `require` throws "require is not defined" — which makes
// EVERY evaluation fail closed, breaking legit filters too. A `data:` URL worker
// is always loaded as an ES module regardless of the host launch shape (vitest
// source vs. built dist), so it needs no file-path resolution and behaves
// identically in both — the property a `{ eval: true }` string worker did not have.
const WORKER_SOURCE = `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (msg) => {
  let match = false;
  try { match = new RegExp(msg.pattern).test(msg.input); } catch { match = false; }
  parentPort.postMessage(match);
});
`;
const WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`);

export const DEFAULT_REGEX_EVAL_TIMEOUT_MS = 50;

let worker: Worker | null = null;
let chain: Promise<unknown> = Promise.resolve();

function spawnWorker(): Worker {
  const w = new Worker(WORKER_URL);
  // Never let the evaluation worker keep the event loop alive.
  w.unref();
  // Swallow async errors on a worker we may already have abandoned; each
  // evaluation attaches its own one-shot error handler for the live case.
  w.on('error', () => {});
  return w;
}

function getWorker(): Worker {
  if (!worker) worker = spawnWorker();
  return worker;
}

function killWorker(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}

/** Terminate the persistent worker (test cleanup / shutdown). Idempotent. */
export function shutdownRegexEvalWorker(): void {
  killWorker();
}

function runOne(pattern: string, input: string, timeoutMs: number, label?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const w = getWorker();
    let settled = false;
    const finish = (val: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      resolve(val);
    };
    const suffix = label ? ` (trigger "${label}")` : '';
    const onMessage = (val: unknown): void => finish(val === true);
    const onError = (): void => {
      killWorker();
      logger.warn(`[workflow-triggers] regex filter worker error — failing closed (non-match)${suffix}`);
      finish(false);
    };
    const onExit = (): void => {
      // Unexpected exit while we were waiting — worker is gone, fail closed.
      if (worker === w) worker = null;
      finish(false);
    };
    const timer = setTimeout(() => {
      killWorker(); // terminate() kills the thread even mid-backtracking
      logger.warn(`[workflow-triggers] regex filter exceeded ${timeoutMs}ms — terminated, failing closed (non-match)${suffix}`);
      finish(false);
    }, timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.postMessage({ pattern, input });
  });
}

export interface RegexEvalOptions {
  timeoutMs?: number;
  label?: string;
}

/**
 * Test `pattern` against `input` in the isolated worker. Resolves to the match
 * result, or `false` (fail-closed) on timeout / worker error. Evaluations are
 * serialized so a terminate/respawn can never race a concurrent call.
 */
export function evaluateRegexMatch(pattern: string, input: string, opts: RegexEvalOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REGEX_EVAL_TIMEOUT_MS;
  const result = chain.then(
    () => runOne(pattern, input, timeoutMs, opts.label),
    () => runOne(pattern, input, timeoutMs, opts.label),
  );
  // Keep the serialization chain alive regardless of individual outcomes.
  chain = result.catch(() => {});
  return result;
}
