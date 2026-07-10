import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkflowTriggerBinding,
  fireWorkflowEvent,
  hasCatastrophicRegexNesting,
  WorkflowTriggerStoreError,
} from '../custom-triggers.js';
import { shutdownRegexEvalWorker } from '../regex-eval.js';
import type { RunDriverDeps } from '../run-reconciler.js';

const now = () => '2026-07-06T09:00:00.000Z';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-redos-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  shutdownRegexEvalWorker();
});

function deps(): RunDriverDeps {
  return {
    root,
    getDefinition: () => null, // filter matching runs before the def lookup
    probeStepSession: () => ({ found: false }),
    spawnStep: async () => ({ sessionId: 'sess' }),
    now,
  };
}

function makeWebhookFilter(name: string, value: string) {
  return createWorkflowTriggerBinding(root, {
    kind: 'webhook',
    name,
    event: 'inbound.event',
    targetWorkflowId: 'wf',
    filter: [{ path: 'payload.kind', op: 'matches', value }],
  }, { now });
}

/** Store a valid binding, then hand-edit triggers.json to inject `pattern` —
 *  simulating a filter written outside the validated create/update API. */
function plantBypassPattern(name: string, pattern: string): void {
  makeWebhookFilter(name, '^placeholder$');
  const file = path.join(root, 'workflow-triggers', 'triggers.json');
  const json = fs.readFileSync(file, 'utf8').replace('^placeholder$', pattern.replace(/\\/g, '\\\\'));
  fs.writeFileSync(file, json);
}

async function fire(kind: string) {
  return fireWorkflowEvent(deps(), { event: 'inbound.event', payload: { kind } }, { gatewayAuthorized: true });
}

describe('hasCatastrophicRegexNesting — creation-time UX detector', () => {
  it('flags classic exponential-backtracking shapes', () => {
    for (const p of ['(a+)+$', '(a*)*', '(a+)*', '(a|aa)+', '(a|a?)+', '([a-z]+)+', '((a+))+', '(?:a+)+', '(\\d+)+$']) {
      expect(hasCatastrophicRegexNesting(p), p).toBe(true);
    }
  });

  it('does not flag safe patterns — nor the polynomial blowups only the worker catches', () => {
    for (const p of ['^trial-[0-9]+$', '(?:abc)+', '(abc)+', 'a+b+c+', '[a-z]+', '\\d{1,4}', 'foo|bar', '(cat|dog)s?', '\\(a\\+\\)\\+', '^a*a*a*a*$']) {
      expect(hasCatastrophicRegexNesting(p), p).toBe(false);
    }
  });
});

describe('webhook matches-filter — worker-isolated evaluation', () => {
  it('rejects an obvious exponential pattern at creation (UX fast-feedback)', () => {
    expect(() => makeWebhookFilter('redos-create', '(a+)+$')).toThrow(WorkflowTriggerStoreError);
    expect(() => makeWebhookFilter('redos-create2', '(a+)+$')).toThrow(/catastrophic backtracking|ReDoS/i);
  });

  it('accepts a safe pattern — and a polynomial one (the worker, not the detector, contains it)', () => {
    expect(() => makeWebhookFilter('safe-create', '^trial-[0-9]+$')).not.toThrow();
    expect(() => makeWebhookFilter('poly-create', '^a*a*a*a*$')).not.toThrow();
  });

  it('normal matching still works for safe patterns through the worker', async () => {
    makeWebhookFilter('works', '^trial-[0-9]+$');
    const res = await fire('trial-42');
    // Filter matched → reached the def lookup and reported the missing workflow.
    expect(res.outcomes.some((o) => o.outcome === 'missing-workflow')).toBe(true);
    // A non-matching input yields no candidate.
    const miss = await fire('nope-99');
    expect(miss.rejected).toBe('no-matching-binding');
  });

  it('a bypass-stored POLYNOMIAL pattern (^a*a*a*a*$) cannot hang the fire path', async () => {
    plantBypassPattern('poly-bypass', '^a*a*a*a*$');
    // Non-matching inputs that trigger O(n^4) backtracking on the main thread.
    for (const len of [256, 384]) {
      const start = performance.now();
      const res = await fire('a'.repeat(len) + '!');
      const elapsed = performance.now() - start;
      expect(res.rejected, `len ${len}`).toBe('no-matching-binding'); // failed closed
      expect(elapsed, `len ${len} elapsed`).toBeLessThan(150); // worker timeout ~50ms + boot
    }
  });

  it('oversize input fails CLOSED without truncation (no anchored false positive)', async () => {
    plantBypassPattern('poly-oversize', '^a*a*a*a*$');
    // 5000 > 4096 cap. The OLD truncate-then-match would slice the trailing "!"
    // and MATCH the all-'a' prefix (false positive). It must NOT match now.
    const res = await fire('a'.repeat(5000) + '!');
    expect(res.rejected).toBe('no-matching-binding');
  });

  it('worker timeout kills a bypass-stored exponential bomb and stays responsive after', async () => {
    plantBypassPattern('exp-bypass', '(a+)+$');
    const start = performance.now();
    const bomb = await fire('a'.repeat(5000) + '!'); // 5000 > cap → oversize fail-closed
    // Use an in-cap input to force the worker path + timeout for the bomb.
    const bomb2 = await fire('a'.repeat(40) + '!');
    const elapsed = performance.now() - start;
    expect(bomb.rejected).toBe('no-matching-binding');
    expect(bomb2.rejected).toBe('no-matching-binding');
    expect(elapsed).toBeLessThan(300);

    // A subsequent LEGIT filter still evaluates correctly (worker respawned).
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-redos-after-'));
    try {
      createWorkflowTriggerBinding(root2, {
        kind: 'webhook', name: 'after-bomb', event: 'inbound.event', targetWorkflowId: 'wf',
        filter: [{ path: 'payload.kind', op: 'matches', value: '^trial-[0-9]+$' }],
      }, { now });
      const ok = await fireWorkflowEvent(
        { ...deps(), root: root2 },
        { event: 'inbound.event', payload: { kind: 'trial-7' } },
        { gatewayAuthorized: true },
      );
      expect(ok.outcomes.some((o) => o.outcome === 'missing-workflow')).toBe(true);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});
