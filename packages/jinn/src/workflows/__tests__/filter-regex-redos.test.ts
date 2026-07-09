import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkflowTriggerBinding,
  fireWorkflowEvent,
  hasCatastrophicRegexNesting,
  WorkflowTriggerStoreError,
} from '../custom-triggers.js';
import type { RunDriverDeps } from '../run-reconciler.js';

const now = () => '2026-07-06T09:00:00.000Z';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-redos-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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

describe('hasCatastrophicRegexNesting — conservative ReDoS detector', () => {
  it('flags classic exponential-backtracking shapes', () => {
    for (const p of ['(a+)+$', '(a*)*', '(a+)*', '(a|aa)+', '(a|a?)+', '([a-z]+)+', '((a+))+', '(?:a+)+', '(\\d+)+$']) {
      expect(hasCatastrophicRegexNesting(p), p).toBe(true);
    }
  });

  it('does not flag safe patterns', () => {
    for (const p of ['^trial-[0-9]+$', '(?:abc)+', '(abc)+', 'a+b+c+', '[a-z]+', '\\d{1,4}', 'foo|bar', '(cat|dog)s?', '\\(a\\+\\)\\+']) {
      expect(hasCatastrophicRegexNesting(p), p).toBe(false);
    }
  });
});

describe('webhook matches-filter ReDoS guards', () => {
  it('rejects a catastrophic pattern at creation', () => {
    expect(() => makeWebhookFilter('redos-create', '(a+)+$')).toThrow(WorkflowTriggerStoreError);
    expect(() => makeWebhookFilter('redos-create2', '(a+)+$')).toThrow(/catastrophic backtracking|ReDoS/i);
  });

  it('accepts a safe pattern at creation', () => {
    expect(() => makeWebhookFilter('safe-create', '^trial-[0-9]+$')).not.toThrow();
  });

  it('a bypass-stored catastrophic pattern cannot hang the fire path (runtime input cap + skip)', async () => {
    // Create a VALID binding, then hand-edit the stored filter to a catastrophic
    // pattern — simulating a binding file written outside the validated API.
    makeWebhookFilter('bypass', '^ok$');
    const file = path.join(root, 'workflow-triggers', 'triggers.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bindings = Array.isArray(raw) ? raw : raw.bindings ?? Object.values(raw);
    // Locate the filter value regardless of top-level shape and swap in the bomb.
    const json = fs.readFileSync(file, 'utf8').replace('^ok$', '(a+)+$');
    fs.writeFileSync(file, json);
    expect(bindings.length).toBeGreaterThan(0);

    // A classic catastrophic input: many 'a's then a non-match char.
    const evilInput = 'a'.repeat(5000) + '!';
    const start = performance.now();
    await fireWorkflowEvent(deps(), { event: 'inbound.event', payload: { kind: evilInput } }, { gatewayAuthorized: true });
    const elapsed = performance.now() - start;
    // Without the guard, (a+)+$ on this input backtracks effectively forever.
    expect(elapsed).toBeLessThan(50);
  });

  it('normal matching still works for safe patterns through the fire path', async () => {
    makeWebhookFilter('works', '^trial-[0-9]+$');
    const res = await fireWorkflowEvent(
      deps(),
      { event: 'inbound.event', payload: { kind: 'trial-42' } },
      { gatewayAuthorized: true },
    );
    // The binding matched (filter passed) → it reached the def lookup and reported
    // the missing workflow, proving the filter did not reject the event.
    expect(res.outcomes.some((o) => o.outcome === 'missing-workflow')).toBe(true);
  });
});
