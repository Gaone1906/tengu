import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefinition, getDefinition } from '../definition-store.js';
import type { EditableWorkflowDefinition, WorkflowEdge, WorkflowNode } from '../definition.js';
import type { RunDriverDeps } from '../run-reconciler.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-poll-trigger-home-'));
process.env.JINN_HOME = tmpHome;

type Store = typeof import('../../work-items/store.js');
type Approvals = typeof import('../../work-items/approvals.js');
type Poll = typeof import('../poll-trigger.js');
type RunStore = typeof import('../run-store.js');
type CustomTriggers = typeof import('../custom-triggers.js');
let store: Store;
let approvals: Approvals;
let poll: Poll;
let runStore: RunStore;
let customTriggers: CustomTriggers;

beforeAll(async () => {
  store = await import('../../work-items/store.js');
  approvals = await import('../../work-items/approvals.js');
  poll = await import('../poll-trigger.js');
  runStore = await import('../run-store.js');
  customTriggers = await import('../custom-triggers.js');
  await import('../../sessions/registry.js').then((m) => m.initDb());
});

const FIXED = '2026-07-06T09:00:00.000Z';
const now = () => FIXED;
const nodeBin = process.execPath;
const trigger: WorkflowNode = { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } };

function step(id: string): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 } };
}

function edges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const }));
}

function def(id: string, nodes: WorkflowNode[]): EditableWorkflowDefinition {
  return {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes,
    edges: edges(nodes),
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-poll-trigger-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness(): RunDriverDeps {
  return {
    root,
    getDefinition,
    probeStepSession: () => ({ found: false }),
    spawnStep: async (ctx) => ({ sessionId: `sess-${ctx.nodeId}` }),
    now,
  };
}

async function approvedWorkItem(name: string): Promise<string> {
  const item = store.createWorkItem({ title: `Approve ${name}`, status: 'backlog', source: 'workflow', sourceRef: `workflow-trigger:${name}` });
  approvals.requestApproval(item.id, { request: `Activate poll trigger ${name}`, target: 'coo' });
  const decided = await approvals.decideWorkItemApproval({ id: item.id, decision: 'approve', decidedBy: 'coo' }, {});
  expect(decided.ok).toBe(true);
  return item.id;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await wait(10);
  expect(fs.existsSync(file)).toBe(true);
}

describe('workflow poll/check custom triggers', () => {
  it('does not throw when the trigger store is corrupt at runner startup', () => {
    fs.mkdirSync(path.join(root, 'workflow-triggers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflow-triggers', 'triggers.json'), '{ bad json', 'utf8');
    const warnings: string[] = [];

    const stop = poll.startPollTriggerRunner(
      { ...harness(), log: (level, message) => warnings.push(`${level}:${message}`) },
      { tickMs: 10, now },
    );

    stop();
    expect(warnings.some((line) => line.includes('poll runner tick failed'))).toBe(true);
  });

  it('fires on exit 0 with stdout JSON payload and emits the uniform poll trigger shape', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-ok');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-ok',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{ready:true,id:'42'}}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(result.outcome).toBe('fired');
    expect(binding.activationContractHash).toEqual(expect.any(String));
    expect(result.run?.trigger).toMatchObject({
      source: 'poll',
      event: 'poll.ready',
      payload: { ready: true, id: '42' },
    });
    expect(result.run?.trigger).toHaveProperty('fireRef');
  });

  it('dedupes the same binding/output even when the poll script omits fireRef', async () => {
    createDefinition(root, def('poll-dedupe-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-dedupe');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-dedupe',
      event: 'poll.ready',
      targetWorkflowId: 'poll-dedupe-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{ready:true,id:'same'}}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    const first = await poll.runPollTriggerOnce(harness(), binding, { now });
    const second = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(first.outcome).toBe('fired');
    expect(second.outcome).toBe('fired');
    expect(second.run?.runId).toBe(first.run?.runId);
    expect(runStore.listRuns(root, 'poll-dedupe-workflow')).toHaveLength(1);
    expect(first.run?.trigger).toMatchObject({
      source: 'poll',
      event: 'poll.ready',
      payload: { ready: true, id: 'same' },
    });
    expect(first.run?.trigger).toHaveProperty('fireRef');
  });

  it('fails closed when executable poll fields changed after the approved activation contract', async () => {
    createDefinition(root, def('poll-mutate-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-mutate');
    const original = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-mutate',
      event: 'poll.ready',
      targetWorkflowId: 'poll-mutate-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{id:'original'}}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    const mutated = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...original,
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{id:'mutated'}}))"`,
    });
    expect(mutated.kind).toBe('poll');
    if (mutated.kind !== 'poll') throw new Error('expected poll binding');
    const result = await poll.runPollTriggerOnce(harness(), mutated, { now });
    const stored = customTriggers.getWorkflowTriggerBinding(root, 'poll-mutate');

    expect(result.outcome).toBe('not-approved');
    expect(runStore.listRuns(root, 'poll-mutate-workflow')).toHaveLength(0);
    expect(stored).toMatchObject({ activation: 'pending_approval' });
    expect((stored as { approvalWorkItemId?: string } | null)?.approvalWorkItemId).toBeUndefined();
  });

  it('fails closed when an approved script is replaced without changing the command', async () => {
    createDefinition(root, def('poll-swap-workflow', [trigger, step('a')]), { now });
    const script = path.join(root, 'poll-swap.sh');
    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"approved"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);
    const approvalWorkItemId = await approvedWorkItem('poll-swap');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-swap',
      event: 'poll.ready',
      targetWorkflowId: 'poll-swap-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"replaced"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(result).toMatchObject({ outcome: 'not-approved' });
    expect(result.detail).toMatch(/executable artifact changed/i);
    expect(runStore.listRuns(root, 'poll-swap-workflow')).toHaveLength(0);
  });

  it('does not auto-approve a legacy poll binding that has an approval item but no activation contract', async () => {
    createDefinition(root, def('poll-legacy-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-legacy');
    const created = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-legacy',
      event: 'poll.ready',
      targetWorkflowId: 'poll-legacy-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{id:'legacy'}}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding;

    const legacy = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...created,
      approvalWorkItemId,
      lastCheckedAt: FIXED,
    });
    if (legacy.kind !== 'poll') throw new Error('expected poll binding');
    const result = await poll.runPollTriggerOnce(harness(), legacy, { now });
    const stored = customTriggers.getWorkflowTriggerBinding(root, 'poll-legacy');

    expect(result.outcome).toBe('not-approved');
    expect(runStore.listRuns(root, 'poll-legacy-workflow')).toHaveLength(0);
    expect((stored as { activationContractHash?: string } | null)?.activationContractHash).toBeUndefined();
  });

  it('treats fire:false, missing fire, and non-boolean fire as no-ops', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-fire-flag');
    const mk = (name: string, stdoutObject: string) => poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name,
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify(${stdoutObject}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    await expect(poll.runPollTriggerOnce(harness(), mk('poll-fire-false', "{fire:false,payload:{ready:true}}"), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });
    await expect(poll.runPollTriggerOnce(harness(), mk('poll-fire-absent', "{payload:{ready:true}}"), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });
    await expect(poll.runPollTriggerOnce(harness(), mk('poll-fire-string', "{fire:'true',payload:{ready:true}}"), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });

    const fired = await poll.runPollTriggerOnce(harness(), mk('poll-fire-true', "{fire:true,payload:{ready:true}}"), { now });
    expect(fired.outcome).toBe('fired');
    expect(fired.run?.trigger).toMatchObject({
      source: 'poll',
      event: 'poll.ready',
      payload: { ready: true },
    });
  });

  it('does not run until the COO approval item is approved', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const item = store.createWorkItem({ title: 'Approve pending poll', status: 'backlog', source: 'workflow', sourceRef: 'workflow-trigger:poll-pending' });
    approvals.requestApproval(item.id, { request: 'Activate poll trigger poll-pending', target: 'coo' });
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-pending',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.stdout.write(JSON.stringify({ready:true}))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId: item.id,
    }, { now }).binding;

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(result.outcome).toBe('not-approved');
  });

  it('does not fire on nonzero exit or invalid JSON', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-bad');
    const nonzero = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-nonzero',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.exit(2)"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;
    const invalid = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-invalid',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.stdout.write('not json')"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      approvalWorkItemId,
    }, { now }).binding;

    await expect(poll.runPollTriggerOnce(harness(), nonzero, { now })).resolves.toMatchObject({ outcome: 'nonzero' });
    await expect(poll.runPollTriggerOnce(harness(), invalid, { now })).resolves.toMatchObject({ outcome: 'invalid-json' });
  });

  it('kills a hung script on timeout and refuses oversized output', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-bounds');
    const hung = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-hung',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "setTimeout(() => {}, 10000)"`,
      intervalSeconds: 60,
      timeoutMs: 50,
      approvalWorkItemId,
    }, { now }).binding;
    const noisy = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-noisy',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: `${nodeBin} -e "process.stdout.write('x'.repeat(1000))"`,
      intervalSeconds: 60,
      timeoutMs: 1000,
      stdoutMaxBytes: 32,
      approvalWorkItemId,
    }, { now }).binding;

    await expect(poll.runPollTriggerOnce(harness(), hung, { now })).resolves.toMatchObject({ outcome: 'timeout' });
    await expect(poll.runPollTriggerOnce(harness(), noisy, { now })).resolves.toMatchObject({ outcome: 'output-too-large' });
  });

  it.skipIf(process.platform === 'win32')('kills the poll command process group on timeout', async () => {
    createDefinition(root, def('poll-timeout-group-workflow', [trigger, step('a')]), { now });
    const marker = path.join(root, 'survived.txt');
    const writeLater = path.join(root, 'write-later.cjs');
    const sleepForever = path.join(root, 'sleep-forever.cjs');
    fs.writeFileSync(writeLater, `
const marker = process.argv[2];
setTimeout(() => {}, 10000);
setTimeout(() => require('node:fs').writeFileSync(marker, 'alive'), 250);
`, 'utf8');
    fs.writeFileSync(sleepForever, `
setTimeout(() => {}, 10000);
`, 'utf8');
    const approvalWorkItemId = await approvedWorkItem('poll-timeout-group');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-timeout-group',
      event: 'poll.ready',
      targetWorkflowId: 'poll-timeout-group-workflow',
      command: `${nodeBin} ${writeLater} ${marker} & ${nodeBin} ${sleepForever}`,
      intervalSeconds: 60,
      timeoutMs: 50,
      approvalWorkItemId,
    }, { now }).binding;

    await expect(poll.runPollTriggerOnce(harness(), binding, { now })).resolves.toMatchObject({ outcome: 'timeout' });
    await wait(500);

    expect(fs.existsSync(marker)).toBe(false);
  });

  it('deleting an in-flight poll binding aborts and awaits the command before returning', async () => {
    createDefinition(root, def('poll-delete-workflow', [trigger, step('a')]), { now });
    const started = path.join(root, 'delete-started.txt');
    const completed = path.join(root, 'delete-completed.txt');
    const script = path.join(root, 'delete-in-flight.cjs');
    fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(completed)}, 'completed');
  process.stdout.write(JSON.stringify({ fire: true, payload: { id: 'too-late' } }));
}, 500);
`, 'utf8');
    const approvalWorkItemId = await approvedWorkItem('poll-delete-in-flight');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-delete-in-flight',
      event: 'poll.ready',
      targetWorkflowId: 'poll-delete-workflow',
      command: `${nodeBin} ${script}`,
      intervalSeconds: 60,
      timeoutMs: 5_000,
      approvalWorkItemId,
    }, { now }).binding;

    const execution = poll.runPollTriggerOnce(harness(), binding, { now });
    await waitForFile(started);
    const deleted = await customTriggers.deleteWorkflowTriggerBinding(root, binding.name);
    const result = await execution;

    expect(deleted).toBe(true);
    expect(result).toMatchObject({ outcome: 'revoked' });
    expect(fs.existsSync(completed)).toBe(false);
    expect(runStore.listRuns(root, 'poll-delete-workflow')).toHaveLength(0);
  });

  it('disabling an in-flight poll binding aborts and awaits the command before returning', async () => {
    createDefinition(root, def('poll-disable-workflow', [trigger, step('a')]), { now });
    const started = path.join(root, 'disable-started.txt');
    const completed = path.join(root, 'disable-completed.txt');
    const script = path.join(root, 'disable-in-flight.cjs');
    fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(completed)}, 'completed');
  process.stdout.write(JSON.stringify({ fire: true, payload: { id: 'too-late' } }));
}, 500);
`, 'utf8');
    const approvalWorkItemId = await approvedWorkItem('poll-disable-in-flight');
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-disable-in-flight',
      event: 'poll.ready',
      targetWorkflowId: 'poll-disable-workflow',
      command: `${nodeBin} ${script}`,
      intervalSeconds: 60,
      timeoutMs: 5_000,
      approvalWorkItemId,
    }, { now }).binding;

    const execution = poll.runPollTriggerOnce(harness(), binding, { now });
    await waitForFile(started);
    const disabled = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...binding,
      activation: 'disabled',
    });
    const result = await execution;

    expect(disabled).toMatchObject({ activation: 'disabled' });
    expect(result).toMatchObject({ outcome: 'revoked' });
    expect(fs.existsSync(completed)).toBe(false);
    expect(runStore.listRuns(root, 'poll-disable-workflow')).toHaveLength(0);
  });

  it('runs the poll command with a scrubbed env — gateway secrets never leak, allowlisted vars survive', async () => {
    createDefinition(root, def('poll-env-workflow', [trigger, step('a')]), { now });
    const approvalWorkItemId = await approvedWorkItem('poll-env');
    process.env.JINN_TEST_SECRET = 'top-secret-token';
    try {
      const binding = poll.createWorkflowTriggerBinding(root, {
        kind: 'poll',
        name: 'poll-env',
        event: 'poll.ready',
        targetWorkflowId: 'poll-env-workflow',
        command: `${nodeBin} -e "process.stdout.write(JSON.stringify({fire:true,payload:{secret:process.env.JINN_TEST_SECRET ?? null,hasPath:!!process.env.PATH}}))"`,
        intervalSeconds: 60,
        timeoutMs: 1000,
        approvalWorkItemId,
      }, { now }).binding;

      const result = await poll.runPollTriggerOnce(harness(), binding, { now });
      expect(result.outcome).toBe('fired');
      // The gateway secret was NOT inherited by the child; an allowlisted var
      // (PATH) still is, so commands can find their tools.
      expect(result.run?.trigger).toMatchObject({ payload: { secret: null, hasPath: true } });
    } finally {
      delete process.env.JINN_TEST_SECRET;
    }
  });

  it('rejects an oversized or invalid webhook matches-filter regex at creation, accepts a safe one', () => {
    const mk = (name: string, value: string) => () => customTriggers.createWorkflowTriggerBinding(root, {
      kind: 'webhook',
      name,
      event: 'inbound.event',
      targetWorkflowId: 'poll-workflow',
      filter: [{ path: 'payload.kind', op: 'matches', value }],
    }, { now });

    expect(mk('wh-long', 'a'.repeat(257))).toThrow(/256 chars/);
    expect(mk('wh-bad', '([')).toThrow(/valid regular expression/);
    // A short, well-formed regex is accepted.
    expect(mk('wh-ok', '^trial-[0-9]+$')).not.toThrow();
  });
});
