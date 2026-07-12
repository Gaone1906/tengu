import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefinition, getDefinition } from '../definition-store.js';
import type { EditableWorkflowDefinition, WorkflowEdge, WorkflowNode } from '../definition.js';
import type { RunDriverDeps } from '../run-reconciler.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-poll-trigger-home-'));
process.env.JINN_HOME = tmpHome;

type Store = typeof import('../../work-items/store.js');
type Poll = typeof import('../poll-trigger.js');
type RunStore = typeof import('../run-store.js');
type CustomTriggers = typeof import('../custom-triggers.js');
let store: Store;
let poll: Poll;
let runStore: RunStore;
let customTriggers: CustomTriggers;

beforeAll(async () => {
  store = await import('../../work-items/store.js');
  poll = await import('../poll-trigger.js');
  runStore = await import('../run-store.js');
  customTriggers = await import('../custom-triggers.js');
  await import('../../sessions/registry.js').then((m) => m.initDb());
});

const FIXED = '2026-07-06T09:00:00.000Z';
const now = () => FIXED;
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

async function approveBinding(binding: import('../custom-triggers.js').PollWorkflowTriggerBinding) {
  return customTriggers.decidePollActivationApproval(root, binding.name, 'approve', 'coo', { now });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pinnableScript(name: string, body: string): string {
  const script = path.join(root, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(script, 0o700);
  return script;
}

function staticOutputScript(name: string, output: string): string {
  if (output.includes("'")) throw new Error('static poll test output cannot contain a single quote');
  return pinnableScript(name, `printf '%s' '${output}'`);
}

describe('workflow poll/check custom triggers', () => {
  it('executes with a native approved activation record and no Todo approval', async () => {
    createDefinition(root, def('poll-native-workflow', [trigger, step('a')]), { now });
    const created = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-native',
      event: 'poll.ready',
      targetWorkflowId: 'poll-native-workflow',
      command: staticOutputScript('poll-native', JSON.stringify({ fire: true, payload: { ready: true } })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding;
    const approved = await approveBinding(created);

    const result = await poll.runPollTriggerOnce(harness(), approved, { now });

    expect(result.outcome).toBe('fired');
    expect(result.run?.trigger).toMatchObject({ source: 'poll', payload: { ready: true } });
    expect(store.getWorkItemBySourceRef('workflow', 'workflow-trigger:poll-native:activation')).toBeUndefined();
  });

  it('revokes a native activation decision when the execution contract changes', async () => {
    const created = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-native-edit',
      event: 'poll.ready',
      targetWorkflowId: 'poll-native-workflow',
      command: staticOutputScript('poll-native-edit-original', JSON.stringify({ fire: false })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding;
    const approved = await approveBinding(created);

    const edited = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...approved,
      command: staticOutputScript('poll-native-edit-updated', JSON.stringify({ fire: false })),
    });

    expect(edited).toMatchObject({
      activation: 'pending_approval',
      approval: {
        state: 'pending',
        activationContractHash: expect.any(String),
        decidedBy: null,
        decidedAt: null,
      },
    });
  });

  it('migrates v1 Todo-backed poll approvals to native pending records once and requires reapproval', async () => {
    const command = staticOutputScript('poll-v1-migration', JSON.stringify({ fire: false }));
    const file = path.join(root, 'workflow-triggers', 'triggers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      triggers: [{
        schemaVersion: 1,
        kind: 'poll',
        source: 'poll',
        name: 'poll-v1-migration',
        event: 'poll.ready',
        targetWorkflowId: 'poll-native-workflow',
        activation: 'active',
        command,
        intervalSeconds: 60,
        timeoutMs: 1000,
        approvalWorkItemId: 'wi_historical_audit_only',
        createdAt: FIXED,
        updatedAt: FIXED,
      }],
    }, null, 2));

    await customTriggers.migrateWorkflowTriggerStore(root);
    const first = fs.readFileSync(file, 'utf8');
    await customTriggers.migrateWorkflowTriggerStore(root);
    const second = fs.readFileSync(file, 'utf8');

    expect(second).toBe(first);
    const migrated = JSON.parse(first) as { schemaVersion: number; triggers: Array<Record<string, unknown>> };
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.triggers[0]).not.toHaveProperty('approvalWorkItemId');
    expect(migrated.triggers[0]).toMatchObject({
      schemaVersion: 2,
      bindingRevision: expect.stringMatching(/^legacy-/),
      activation: 'pending_approval',
      activationContractHash: expect.any(String),
      approval: {
        state: 'pending',
        activationContractHash: expect.any(String),
        decidedBy: null,
        decidedAt: null,
      },
    });
  });

  it('rejects future store and binding schemas without rewriting or downgrading them', async () => {
    const file = path.join(root, 'workflow-triggers', 'triggers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const futureStore = JSON.stringify({ schemaVersion: 99, triggers: [] }, null, 2);
    fs.writeFileSync(file, futureStore);

    expect(() => customTriggers.listWorkflowTriggerBindings(root)).toThrow(/schemaVersion 99.*newer|newer.*99/i);
    await expect(customTriggers.migrateWorkflowTriggerStore(root)).rejects.toThrow(/schemaVersion 99.*newer|newer.*99/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(futureStore);

    const futureBinding = JSON.stringify({
      schemaVersion: 2,
      triggers: [{ schemaVersion: 99, kind: 'webhook', source: 'event-webhook', name: 'future', event: 'future', targetWorkflowId: 'future', activation: 'active' }],
    }, null, 2);
    fs.writeFileSync(file, futureBinding);
    expect(() => customTriggers.listWorkflowTriggerBindings(root)).toThrow(/binding.*schemaVersion 99.*newer|newer.*binding/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(futureBinding);
  });

  it('rolls back newly staged artifacts when a later migration artifact fails', async () => {
    const file = path.join(root, 'workflow-triggers', 'triggers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify({
      schemaVersion: 1,
      triggers: [
        {
          schemaVersion: 1,
          kind: 'poll', source: 'poll', name: 'artifact-first', event: 'poll.first', targetWorkflowId: 'first',
          activation: 'active', command: staticOutputScript('artifact-first', JSON.stringify({ fire: false })), intervalSeconds: 60,
          approvalWorkItemId: 'wi_historical_first', createdAt: FIXED, updatedAt: FIXED,
        },
        {
          schemaVersion: 1,
          kind: 'poll', source: 'poll', name: 'artifact-second', event: 'poll.second', targetWorkflowId: 'second',
          activation: 'active', command: path.join(root, 'missing-second.sh'), intervalSeconds: 60,
          approvalWorkItemId: 'wi_historical_second', createdAt: FIXED, updatedAt: FIXED,
        },
      ],
    }, null, 2);
    fs.writeFileSync(file, original);
    const stagingRoot = path.join(tmpHome, 'workflow-trigger-artifacts');
    const beforeArtifacts = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];

    await expect(customTriggers.migrateWorkflowTriggerStore(root)).rejects.toThrow(/fully pinnable/i);

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    const afterArtifacts = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];
    expect(afterArtifacts.filter((entry) => !beforeArtifacts.includes(entry))).toEqual([]);
  });

  it('rolls back staged artifacts and temp files when the migration store rename fails', async () => {
    const file = path.join(root, 'workflow-triggers', 'triggers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify({
      schemaVersion: 1,
      triggers: [{
        schemaVersion: 1,
        kind: 'poll', source: 'poll', name: 'write-failure', event: 'poll.write', targetWorkflowId: 'write',
        activation: 'active', command: staticOutputScript('write-failure', JSON.stringify({ fire: false })), intervalSeconds: 60,
        approvalWorkItemId: 'wi_historical_write', createdAt: FIXED, updatedAt: FIXED,
      }],
    }, null, 2);
    fs.writeFileSync(file, original);
    const stagingRoot = path.join(tmpHome, 'workflow-trigger-artifacts');
    const beforeArtifacts = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(to)) === path.resolve(file)) throw new Error('injected trigger-store rename failure');
      return rename(from, to);
    });
    try {
      await expect(customTriggers.migrateWorkflowTriggerStore(root)).rejects.toThrow(/injected trigger-store rename failure/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    const afterArtifacts = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).sort() : [];
    expect(afterArtifacts.filter((entry) => !beforeArtifacts.includes(entry))).toEqual([]);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('exports and applies the exact poll child environment policy', () => {
    expect(customTriggers.POLL_ENV_ALLOWLIST).toEqual(['PATH', 'HOME', 'JINN_HOME']);

    const previous = process.env.JINN_ENV_SENTINEL;
    process.env.JINN_ENV_SENTINEL = 'must-not-cross-child-boundary';
    try {
      const captureKeys = (env: NodeJS.ProcessEnv): string[] => JSON.parse(
        execFileSync(
          process.execPath,
          ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
          { env },
        ).toString('utf8'),
      ) as string[];
      const childEnv = poll.buildPollChildEnv();
      expect(Object.keys(childEnv).sort()).toEqual(['HOME', 'JINN_HOME', 'PATH']);

      // macOS may synthesize process metadata even for an empty environment;
      // subtract that baseline so this assertion covers inherited gateway vars.
      const platformKeys = new Set(captureKeys({}));
      const inheritedKeys = captureKeys(childEnv).filter((key) => !platformKeys.has(key));
      expect(inheritedKeys).toEqual(['HOME', 'JINN_HOME', 'PATH']);
      expect(inheritedKeys).not.toContain('JINN_ENV_SENTINEL');
    } finally {
      if (previous === undefined) delete process.env.JINN_ENV_SENTINEL;
      else process.env.JINN_ENV_SENTINEL = previous;
    }
  });

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
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-ok',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: staticOutputScript('poll-ok', JSON.stringify({ fire: true, payload: { ready: true, id: '42' } })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

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
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-dedupe',
      event: 'poll.ready',
      targetWorkflowId: 'poll-dedupe-workflow',
      command: staticOutputScript('poll-dedupe', JSON.stringify({ fire: true, payload: { ready: true, id: 'same' } })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

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
    const original = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-mutate',
      event: 'poll.ready',
      targetWorkflowId: 'poll-mutate-workflow',
      command: staticOutputScript('poll-mutate-original', JSON.stringify({ fire: true, payload: { id: 'original' } })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

    const mutated = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...original,
      command: staticOutputScript('poll-mutate-updated', JSON.stringify({ fire: true, payload: { id: 'mutated' } })),
    });
    expect(mutated.kind).toBe('poll');
    if (mutated.kind !== 'poll') throw new Error('expected poll binding');
    const result = await poll.runPollTriggerOnce(harness(), mutated, { now });
    const stored = customTriggers.getWorkflowTriggerBinding(root, 'poll-mutate');

    expect(result.outcome).toBe('not-approved');
    expect(runStore.listRuns(root, 'poll-mutate-workflow')).toHaveLength(0);
    expect(stored).toMatchObject({ activation: 'pending_approval' });
    expect(stored).toMatchObject({ approval: { state: 'pending', decidedBy: null, decidedAt: null } });
  });

  it('runs the staged approved bytes when the original script is replaced', async () => {
    createDefinition(root, def('poll-swap-workflow', [trigger, step('a')]), { now });
    const script = path.join(root, 'poll-swap.sh');
    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"approved"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-swap',
      event: 'poll.ready',
      targetWorkflowId: 'poll-swap-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"replaced"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(result.outcome).toBe('fired');
    expect(result.run?.trigger).toMatchObject({ payload: { id: 'approved' } });
    const stagedArtifacts = binding.activationContract?.executableArtifacts.filter((artifact) => artifact.role === 'executable') ?? [];
    expect(stagedArtifacts.every((artifact) => artifact.path !== fs.realpathSync(script))).toBe(true);
    for (const artifact of stagedArtifacts) {
      expect(fs.statSync(artifact.path).mode & 0o222).toBe(0);
    }
  });

  it('refuses approval for opaque inline interpreter code', async () => {
    createDefinition(root, def('poll-inline-workflow', [trigger, step('a')]), { now });
    const script = path.join(root, 'poll-inline.sh');
    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"approved"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);
    expect(() => poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-inline',
      event: 'poll.ready',
      targetWorkflowId: 'poll-inline-workflow',
      command: `/bin/sh -c ${JSON.stringify(script)}`,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now })).toThrow(/not a fully pinnable poll command.*use a single absolute path/i);

    expect(runStore.listRuns(root, 'poll-inline-workflow')).toHaveLength(0);
  });

  it('refuses approval when the complete executable input set cannot be proven', async () => {
    createDefinition(root, def('poll-unprovable-workflow', [trigger, step('a')]), { now });
    const helper = path.join(root, 'poll-unprovable-helper.sh');
    const wrapper = path.join(root, 'poll-unprovable-wrapper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"helper"}}\'\n', 'utf8');
    fs.writeFileSync(wrapper, `#!/bin/sh\n${helper}\n`, 'utf8');
    fs.chmodSync(helper, 0o700);
    fs.chmodSync(wrapper, 0o700);
    const attempt = (name: string, command: string) => () => poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name,
      event: 'poll.ready',
      targetWorkflowId: 'poll-unprovable-workflow',
      command,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now });

    expect(attempt('poll-unprovable-wrapper', wrapper))
      .toThrow(/not a fully pinnable poll command.*use a single absolute path/i);
    expect(attempt('poll-unprovable-delegator', `/usr/bin/env ${wrapper}`))
      .toThrow(/not a fully pinnable poll command.*use a single absolute path/i);
  });

  it('approves and runs a fully pinnable poll command', async () => {
    createDefinition(root, def('poll-pinnable-workflow', [trigger, step('a')]), { now });
    const script = path.join(root, 'poll-pinnable.sh');
    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\' \'{"fire":true,"payload":{"id":"pinned"}}\'\n', 'utf8');
    fs.chmodSync(script, 0o700);
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-pinnable',
      event: 'poll.ready',
      targetWorkflowId: 'poll-pinnable-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(binding.activationContract?.executableArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'executable', path: expect.stringContaining('workflow-trigger-artifacts'), sha256: expect.any(String) }),
      expect.objectContaining({ role: 'interpreter', path: fs.realpathSync('/bin/sh'), sha256: expect.any(String) }),
    ]));
    expect(result.outcome).toBe('fired');
    expect(result.run?.trigger).toMatchObject({ payload: { id: 'pinned' } });
  });

  it('does not execute a poll binding until its native approval is decided', async () => {
    createDefinition(root, def('poll-legacy-workflow', [trigger, step('a')]), { now });
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-legacy',
      event: 'poll.ready',
      targetWorkflowId: 'poll-legacy-workflow',
      command: staticOutputScript('poll-legacy', JSON.stringify({ fire: true, payload: { id: 'legacy' } })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding;

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });
    const stored = customTriggers.getWorkflowTriggerBinding(root, 'poll-legacy');

    expect(result.outcome).toBe('not-approved');
    expect(runStore.listRuns(root, 'poll-legacy-workflow')).toHaveLength(0);
    expect(stored).toMatchObject({ activationContractHash: expect.any(String), approval: { state: 'pending' } });
  });

  it('treats fire:false, missing fire, and non-boolean fire as no-ops', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const mk = (name: string, stdoutObject: Record<string, unknown>) => approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name,
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: staticOutputScript(name, JSON.stringify(stdoutObject)),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

    await expect(poll.runPollTriggerOnce(harness(), await mk('poll-fire-false', { fire: false, payload: { ready: true } }), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });
    await expect(poll.runPollTriggerOnce(harness(), await mk('poll-fire-absent', { payload: { ready: true } }), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });
    await expect(poll.runPollTriggerOnce(harness(), await mk('poll-fire-string', { fire: 'true', payload: { ready: true } }), { now }))
      .resolves.toMatchObject({ outcome: 'no-fire' });

    const fired = await poll.runPollTriggerOnce(harness(), await mk('poll-fire-true', { fire: true, payload: { ready: true } }), { now });
    expect(fired.outcome).toBe('fired');
    expect(fired.run?.trigger).toMatchObject({
      source: 'poll',
      event: 'poll.ready',
      payload: { ready: true },
    });
  });

  it('does not run until the native activation approval is approved', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const binding = poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-pending',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: staticOutputScript('poll-pending', JSON.stringify({ ready: true })),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding;

    const result = await poll.runPollTriggerOnce(harness(), binding, { now });

    expect(result.outcome).toBe('not-approved');
  });

  it('does not fire on nonzero exit or invalid JSON', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const nonzero = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-nonzero',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: pinnableScript('poll-nonzero', 'exit 2'),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);
    const invalid = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-invalid',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: staticOutputScript('poll-invalid', 'not json'),
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now }).binding);

    await expect(poll.runPollTriggerOnce(harness(), nonzero, { now })).resolves.toMatchObject({ outcome: 'nonzero' });
    await expect(poll.runPollTriggerOnce(harness(), invalid, { now })).resolves.toMatchObject({ outcome: 'invalid-json' });
  });

  it('kills a hung script on timeout and refuses oversized output', async () => {
    createDefinition(root, def('poll-workflow', [trigger, step('a')]), { now });
    const hung = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-hung',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: pinnableScript('poll-hung', 'while :; do :; done'),
      intervalSeconds: 60,
      timeoutMs: 50,
    }, { now }).binding);
    const noisy = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-noisy',
      event: 'poll.ready',
      targetWorkflowId: 'poll-workflow',
      command: staticOutputScript('poll-noisy', 'x'.repeat(1000)),
      intervalSeconds: 60,
      timeoutMs: 1000,
      stdoutMaxBytes: 32,
    }, { now }).binding);

    await expect(poll.runPollTriggerOnce(harness(), hung, { now })).resolves.toMatchObject({ outcome: 'timeout' });
    await expect(poll.runPollTriggerOnce(harness(), noisy, { now })).resolves.toMatchObject({ outcome: 'output-too-large' });
  });

  it('rejects multi-process shell commands before approval', async () => {
    createDefinition(root, def('poll-timeout-group-workflow', [trigger, step('a')]), { now });
    const first = staticOutputScript('poll-first', JSON.stringify({ fire: false }));
    const second = staticOutputScript('poll-second', JSON.stringify({ fire: false }));
    expect(() => poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-timeout-group',
      event: 'poll.ready',
      targetWorkflowId: 'poll-timeout-group-workflow',
      command: `${first} & ${second}`,
      intervalSeconds: 60,
      timeoutMs: 50,
    }, { now })).toThrow(/not a fully pinnable poll command/i);
  });

  it('deleting an in-flight poll binding aborts and awaits the command before returning', async () => {
    createDefinition(root, def('poll-delete-workflow', [trigger, step('a')]), { now });
    const script = pinnableScript('delete-in-flight', 'while :; do :; done');
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-delete-in-flight',
      event: 'poll.ready',
      targetWorkflowId: 'poll-delete-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 5_000,
    }, { now }).binding);
    const stagedPaths = binding.activationContract?.executableArtifacts
      .filter((artifact) => artifact.role === 'executable')
      .map((artifact) => artifact.path) ?? [];

    const execution = poll.runPollTriggerOnce(harness(), binding, { now });
    await wait(20);
    const deleted = await customTriggers.deleteWorkflowTriggerBinding(root, binding.name);
    const result = await execution;

    expect(deleted).toBe(true);
    expect(result).toMatchObject({ outcome: 'revoked' });
    expect(runStore.listRuns(root, 'poll-delete-workflow')).toHaveLength(0);
    expect(stagedPaths).not.toHaveLength(0);
    expect(stagedPaths.every((artifactPath) => !fs.existsSync(artifactPath))).toBe(true);
  });

  it('disabling an in-flight poll binding aborts and awaits the command before returning', async () => {
    createDefinition(root, def('poll-disable-workflow', [trigger, step('a')]), { now });
    const script = pinnableScript('disable-in-flight', 'while :; do :; done');
    const binding = await approveBinding(poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-disable-in-flight',
      event: 'poll.ready',
      targetWorkflowId: 'poll-disable-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 5_000,
    }, { now }).binding);

    const execution = poll.runPollTriggerOnce(harness(), binding, { now });
    await wait(20);
    const disabled = await customTriggers.updateWorkflowTriggerBinding(root, {
      ...binding,
      activation: 'disabled',
    });
    const result = await execution;

    expect(disabled).toMatchObject({ activation: 'disabled' });
    expect(result).toMatchObject({ outcome: 'revoked' });
    expect(runStore.listRuns(root, 'poll-disable-workflow')).toHaveLength(0);
  });

  it('rejects poll scripts that dynamically resolve environment inputs', async () => {
    createDefinition(root, def('poll-env-workflow', [trigger, step('a')]), { now });
    const script = pinnableScript('poll-env', `printf '%s' "$JINN_TEST_SECRET"`);

    expect(() => poll.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'poll-env',
      event: 'poll.ready',
      targetWorkflowId: 'poll-env-workflow',
      command: script,
      intervalSeconds: 60,
      timeoutMs: 1000,
    }, { now })).toThrow(/not a fully pinnable poll command/i);
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
