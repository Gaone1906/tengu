import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import {
  saveRun,
  claimWorkflowRunInvocation,
  getWorkflowRunInvocationClaim,
  publishInitialWorkflowRun,
  getRun,
  listRuns,
  findRunByFire,
  findRunByTriggerFireRef,
  normalizeWorkflowTrigger,
  newRunId,
  WORKFLOW_RUN_SCHEMA_VERSION,
  WorkflowRunStoreError,
  type WorkflowRun,
} from '../run-store.js';
import {
  createWorkflowRunInvocationRequest,
  fingerprintWorkflowRunInvocationRequest,
  type WorkflowRunInvocationClaim,
} from '../run-idempotency.js';
import { WORKFLOW_DEFINITION_SCHEMA_VERSION, type EditableWorkflowDefinition } from '../definition.js';

function makeRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    revision: 1,
    runId: 'run-1',
    workflowId: 'wf',
    definitionVersion: 3,
    title: 'WF',
    trigger: { source: 'manual', event: 'workflow.manual_started', payload: {} },
    status: 'dispatched',
    startedAt: '2026-07-04T06:00:00.000Z',
    endedAt: '2026-07-04T06:00:01.000Z',
    steps: [],
    parked: null,
    ...over,
  };
}

/** Write a LEGACY v1 record by hand (no schemaVersion field — exactly what the v1
 * executor persisted, including the retired run-level 'passed'). */
function writeLegacyRun(root: string, workflowId: string, runId: string, status: string): string {
  const dir = path.join(root, 'reports', 'runs', workflowId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  const record = {
    runId,
    workflowId,
    definitionVersion: 1,
    title: 'Legacy WF',
    trigger: 'manual',
    status,
    startedAt: '2026-07-01T06:00:00.000Z',
    endedAt: '2026-07-01T06:00:01.000Z',
    steps: [
      { nodeId: 's1', label: 'S1', actor: { kind: 'engine', ref: 'codex' }, status: 'spawned', sessionId: 'sess-1', at: '2026-07-01T06:00:00.500Z' },
    ],
    parked: null,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return file;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runstore-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('saveRun / getRun', () => {
  it('round-trips a run at reports/runs/<wf>/<runId>.json', () => {
    saveRun(root, makeRun({ runId: 'run-a', workflowId: 'demo' }));
    const onDisk = path.join(root, 'reports', 'runs', 'demo', 'run-a.json');
    expect(fs.existsSync(onDisk)).toBe(true);
    const got = getRun(root, 'demo', 'run-a');
    expect(got?.runId).toBe('run-a');
    expect(got?.definitionVersion).toBe(3);
  });

  it('overwrites the same runId atomically (no torn file)', () => {
    saveRun(root, makeRun({ runId: 'run-x', status: 'running' }));
    saveRun(root, makeRun({ runId: 'run-x', status: 'parked', parked: { scope: 'runGate', nodeId: null, kind: 'approval', evaluator: 'human-approval', description: 'merge' } }));
    const got = getRun(root, 'wf', 'run-x');
    expect(got?.status).toBe('parked');
    expect(got?.parked?.scope).toBe('runGate');
    // no leftover temp files
    const files = fs.readdirSync(path.join(root, 'reports', 'runs', 'wf'));
    expect(files).toEqual(['run-x.json']);
  });

  it('returns null for a missing run', () => {
    expect(getRun(root, 'wf', 'nope')).toBeNull();
  });

  it('throws bad-input for a corrupt on-disk run', () => {
    const dir = path.join(root, 'reports', 'runs', 'wf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json', 'utf8');
    expect(() => getRun(root, 'wf', 'bad')).toThrow(WorkflowRunStoreError);
  });

  it('round-trips separate v3 parameters and invoking-session relation', () => {
    const current = makeRun({
      runId: 'run-v3-relation',
      parameters: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
      invocation: { sessionId: 'session-a', reportMode: 'resume' },
    });

    saveRun(root, current);

    expect(getRun(root, current.workflowId, current.runId)).toMatchObject({
      schemaVersion: 3,
      revision: 1,
      parameters: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
      invocation: { sessionId: 'session-a', reportMode: 'resume' },
    });
  });

  it('rejects an input-shaped invocation on a v3 record', () => {
    const dir = path.join(root, 'reports', 'runs', 'wf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad-v3-invocation.json'), JSON.stringify({
      ...makeRun({ runId: 'bad-v3-invocation' }),
      schemaVersion: 3,
      invocation: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
    }), 'utf8');

    expect(() => getRun(root, 'wf', 'bad-v3-invocation')).toThrow(/invocation/i);
  });
});

describe('workflow invocation claims', () => {
  it('fsyncs the exclusively created claim before reporting it claimed', () => {
    const definition: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'wf', title: 'WF', version: 1, status: 'active', nodes: [], edges: [],
    };
    const request = createWorkflowRunInvocationRequest({
      definition,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'durable-key' },
      principal: 'operator',
    });
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1, workflowId: 'wf', principal: 'operator', idempotencyKey: 'durable-key',
      runId: 'run-durable', fingerprint: fingerprintWorkflowRunInvocationRequest(request), request,
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    const fsync = vi.spyOn(fs, 'fsyncSync');
    try {
      expect(claimWorkflowRunInvocation(root, claim).outcome).toBe('claimed');
      expect(fsync).toHaveBeenCalled();
    } finally {
      fsync.mockRestore();
    }
  });

  it('exclusively claims a hashed namespace, replays exact intent, and fails changed intent closed', () => {
    const definition: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'wf', title: 'WF', version: 1, status: 'active', nodes: [], edges: [],
    };
    const request = createWorkflowRunInvocationRequest({
      definition,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'raw/key' },
      input: { ticket: 'ABC-42' },
      principal: 'employee:owner',
    });
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1,
      workflowId: 'wf',
      principal: 'employee:owner',
      idempotencyKey: 'raw/key',
      runId: 'run-claim',
      fingerprint: fingerprintWorkflowRunInvocationRequest(request),
      request,
      createdAt: '2026-07-12T00:00:00.000Z',
    };

    expect(claimWorkflowRunInvocation(root, claim).outcome).toBe('claimed');
    expect(claimWorkflowRunInvocation(root, { ...claim, runId: 'ignored-on-replay' })).toMatchObject({
      outcome: 'replay', claim: { runId: 'run-claim' },
    });
    const changedRequest = { ...request, input: { ticket: 'CHANGED' } };
    expect(claimWorkflowRunInvocation(root, {
      ...claim,
      request: changedRequest,
      fingerprint: fingerprintWorkflowRunInvocationRequest(changedRequest),
    })).toMatchObject({ outcome: 'conflict', claim: { runId: 'run-claim' } });
    expect(getWorkflowRunInvocationClaim(root, 'wf', 'employee:owner', 'raw/key')?.runId).toBe('run-claim');

    const filenames = fs.readdirSync(path.join(root, 'reports', 'run-idempotency'));
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(filenames[0]).not.toContain('raw');
  });

  it('allows exactly one claimant in a real cross-process wx race', async () => {
    const definition: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'wf', title: 'WF', version: 1, status: 'active', nodes: [], edges: [],
    };
    const request = createWorkflowRunInvocationRequest({
      definition,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'race-key' },
      principal: 'operator',
    });
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1, workflowId: 'wf', principal: 'operator', idempotencyKey: 'race-key',
      runId: 'run-race', fingerprint: fingerprintWorkflowRunInvocationRequest(request), request,
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    const digest = createHash('sha256')
      .update(JSON.stringify({ idempotencyKey: 'race-key', principal: 'operator', workflowId: 'wf' }))
      .digest('hex');
    const dir = path.join(root, 'reports', 'run-idempotency');
    const file = path.join(dir, `${digest}.json`);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawnChild(process.execPath, ['-e', `
      const fs = require('node:fs');
      const file = process.argv[1];
      const contents = process.argv[2];
      process.on('message', ({ at }) => {
        while (Date.now() < at) {}
        let outcome = 'claimed';
        let fd;
        const temporary = file + '.tmp-child-' + process.pid;
        try {
          fd = fs.openSync(temporary, 'wx', 0o600);
          fs.writeFileSync(fd, contents);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          fs.linkSync(temporary, file);
        } catch (error) {
          outcome = error && error.code === 'EEXIST' ? 'existing' : 'error';
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          try { fs.unlinkSync(temporary); } catch {}
        }
        process.send(outcome);
        process.exit(outcome === 'error' ? 1 : 0);
      });
    `, file, JSON.stringify(claim, null, 2) + '\n'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const childOutcome = new Promise<string>((resolve) => child.once('message', (value) => resolve(String(value))));
    const at = Date.now() + 75;
    child.send({ at });
    while (Date.now() < at) { /* align the two processes on the same instant */ }
    const parent = claimWorkflowRunInvocation(root, claim);
    const other = await childOutcome;

    expect([parent.outcome, other]).toContain('claimed');
    expect(parent.outcome === 'claimed' ? other : parent.outcome).toMatch(/^(existing|replay)$/);
    expect(fs.readdirSync(dir)).toEqual([`${digest}.json`]);
    expect(getWorkflowRunInvocationClaim(root, 'wf', 'operator', 'race-key')?.runId).toBe('run-race');
  });

  it('fails closed when an existing claim is corrupt', () => {
    const definition: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'wf', title: 'WF', version: 1, status: 'active', nodes: [], edges: [],
    };
    const request = createWorkflowRunInvocationRequest({
      definition,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'corrupt-key' },
      principal: 'operator',
    });
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1, workflowId: 'wf', principal: 'operator', idempotencyKey: 'corrupt-key',
      runId: 'run-corrupt', fingerprint: fingerprintWorkflowRunInvocationRequest(request), request,
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    const digest = createHash('sha256')
      .update(JSON.stringify({ idempotencyKey: 'corrupt-key', principal: 'operator', workflowId: 'wf' }))
      .digest('hex');
    const dir = path.join(root, 'reports', 'run-idempotency');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${digest}.json`), '{broken', 'utf8');

    const wait = vi.spyOn(Atomics, 'wait');
    try {
      expect(claimWorkflowRunInvocation(root, claim)).toEqual({ outcome: 'conflict', claim: null });
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
    }
  });
});

describe('exclusive initial run publication', () => {
  it('defaults a new v3 publication to revision 1 exactly once', () => {
    const candidate = makeRun({ runId: 'run-default-revision', revision: undefined });

    const publication = publishInitialWorkflowRun(root, candidate);

    expect(publication).toMatchObject({ outcome: 'published', run: { schemaVersion: 3, revision: 1 } });
    expect(getRun(root, 'wf', 'run-default-revision')).toMatchObject({ schemaVersion: 3, revision: 1 });
  });

  it('fsyncs the complete temp inode and final directory state before returning', () => {
    const run = makeRun({ runId: 'run-durable-publication', workflowId: 'wf' });
    const fsync = vi.spyOn(fs, 'fsyncSync');
    try {
      expect(publishInitialWorkflowRun(root, run).outcome).toBe('published');
      expect(fsync).toHaveBeenCalledTimes(2);
    } finally {
      fsync.mockRestore();
    }
  });

  it('allows exactly one complete run publication across competing processes', async () => {
    const run = makeRun({ runId: 'run-publish-race', workflowId: 'wf', status: 'running' });
    const dir = path.join(root, 'reports', 'runs', 'wf');
    const target = path.join(dir, 'run-publish-race.json');
    fs.mkdirSync(dir, { recursive: true });
    const child = spawnChild(process.execPath, ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const target = process.argv[1];
      const contents = process.argv[2];
      process.on('message', ({ at }) => {
        while (Date.now() < at) {}
        const temp = path.join(path.dirname(target), '.child-initial-' + process.pid + '.tmp');
        let outcome = 'published';
        let fd;
        try {
          fd = fs.openSync(temp, 'wx', 0o600);
          fs.writeFileSync(fd, contents);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          fs.linkSync(temp, target);
        } catch (error) {
          outcome = error && error.code === 'EEXIST' ? 'existing' : 'error';
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          try { fs.unlinkSync(temp); } catch {}
        }
        process.send(outcome);
        process.exit(outcome === 'error' ? 1 : 0);
      });
    `, target, JSON.stringify(run, null, 2) + '\n'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const childOutcome = new Promise<string>((resolve) => child.once('message', (value) => resolve(String(value))));
    const at = Date.now() + 75;
    child.send({ at });
    while (Date.now() < at) { /* align both publishers */ }
    const parent = publishInitialWorkflowRun(root, run);
    const other = await childOutcome;

    expect([parent.outcome, other].filter((outcome) => outcome === 'published')).toHaveLength(1);
    expect([parent.outcome, other].filter((outcome) => outcome === 'existing')).toHaveLength(1);
    expect(getRun(root, 'wf', 'run-publish-race')).toEqual(run);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed instead of overwriting a corrupt existing initial run', () => {
    const run = makeRun({ runId: 'run-corrupt-publication', workflowId: 'wf' });
    const dir = path.join(root, 'reports', 'runs', 'wf');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'run-corrupt-publication.json');
    fs.writeFileSync(target, '{broken', 'utf8');

    expect(() => publishInitialWorkflowRun(root, run)).toThrow(WorkflowRunStoreError);
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
  });
});

describe('listRuns', () => {
  it('returns summaries newest-first (startedAt desc) and marks parked', () => {
    saveRun(root, makeRun({ runId: 'r1', startedAt: '2026-07-04T06:00:00.000Z' }));
    saveRun(root, makeRun({ runId: 'r2', startedAt: '2026-07-04T07:00:00.000Z', status: 'parked' }));
    saveRun(root, makeRun({ runId: 'r3', startedAt: '2026-07-04T05:00:00.000Z' }));
    const runs = listRuns(root, 'wf');
    expect(runs.map((r) => r.runId)).toEqual(['r2', 'r1', 'r3']);
    expect(runs[0].parked).toBe(true);
    expect(runs[1].parked).toBe(false);
  });

  it('is empty and non-throwing for an unknown workflow', () => {
    expect(listRuns(root, 'ghost')).toEqual([]);
  });

  it('skips a corrupt run file rather than failing the whole list', () => {
    saveRun(root, makeRun({ runId: 'ok' }));
    const dir = path.join(root, 'reports', 'runs', 'wf');
    fs.writeFileSync(path.join(dir, 'corrupt.json'), 'nope', 'utf8');
    const runs = listRuns(root, 'wf');
    expect(runs.map((r) => r.runId)).toEqual(['ok']);
  });
});

describe('id safety', () => {
  it('rejects a traversing workflow id', () => {
    expect(() => saveRun(root, makeRun({ workflowId: '../evil' }))).toThrow(WorkflowRunStoreError);
    expect(() => getRun(root, '../evil', 'r')).toThrow(WorkflowRunStoreError);
  });
  it('rejects a traversing run id', () => {
    expect(() => saveRun(root, makeRun({ runId: '../../etc/passwd' }))).toThrow(WorkflowRunStoreError);
  });
  it('listRuns surfaces an invalid workflow id (not swallowed as empty)', () => {
    expect(() => listRuns(root, '../evil')).toThrow(WorkflowRunStoreError);
  });
});

describe('read-time legacy mapping (GRS-014a) — v1 passed → dispatched, no file rewrites', () => {
  it('normalizes the exact v2 invocation wire shape to parameters without rewriting evidence', () => {
    const dir = path.join(root, 'reports', 'runs', 'legacy-workflow');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'legacy-run.json');
    const rawV2 = {
      ...makeRun({ runId: 'legacy-run', workflowId: 'legacy-workflow' }),
      schemaVersion: 2,
      invocation: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
    };
    delete (rawV2 as { revision?: number }).revision;
    fs.writeFileSync(file, JSON.stringify(rawV2, null, 2) + '\n', 'utf8');
    const before = fs.readFileSync(file);

    const legacy = getRun(root, 'legacy-workflow', 'legacy-run')!;

    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.parameters).toEqual({ input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' });
    expect(legacy.invocation).toBeUndefined();
    expect(legacy.revision).toBe(0);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('invocation.input.ticket', 'ABC-42');
  });

  it("serves a v1 'passed' record as 'dispatched' and leaves the file byte-identical", () => {
    const file = writeLegacyRun(root, 'wf', 'legacy-passed', 'passed');
    const before = sha256(file);

    const got = getRun(root, 'wf', 'legacy-passed');
    expect(got?.status).toBe('dispatched');
    expect(got?.schemaVersion).toBeUndefined(); // legacy identity preserved in memory too

    const summaries = listRuns(root, 'wf');
    expect(summaries.find((r) => r.runId === 'legacy-passed')?.status).toBe('dispatched');

    // The mapping is read-time ONLY — the frozen evidence file was never rewritten.
    expect(sha256(file)).toBe(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).status).toBe('passed');
  });

  it("passes v1 'running' / 'parked' / 'failed' through unchanged (already honest)", () => {
    for (const status of ['running', 'parked', 'failed'] as const) {
      const file = writeLegacyRun(root, 'wf', `legacy-${status}`, status);
      const before = sha256(file);
      expect(getRun(root, 'wf', `legacy-${status}`)?.status).toBe(status);
      expect(sha256(file)).toBe(before);
    }
  });

  it('leaves v2 records untouched (no mapping applies at the current schema version)', () => {
    saveRun(root, makeRun({ runId: 'v2-disp', status: 'dispatched' }));
    saveRun(root, makeRun({ runId: 'v2-done', status: 'completed' }));
    expect(getRun(root, 'wf', 'v2-disp')?.status).toBe('dispatched');
    expect(getRun(root, 'wf', 'v2-done')?.status).toBe('completed');
    expect(getRun(root, 'wf', 'v2-done')?.schemaVersion).toBe(WORKFLOW_RUN_SCHEMA_VERSION);
  });

  it('round-trips an orderWarning on a v2 record', () => {
    saveRun(root, makeRun({
      runId: 'v2-warn',
      orderWarning: { code: 'order-warning', message: 'edges disagree with declaration order', impliedOrder: ['t', 'b', 'a'] },
    }));
    const got = getRun(root, 'wf', 'v2-warn');
    expect(got?.orderWarning?.code).toBe('order-warning');
    expect(got?.orderWarning?.impliedOrder).toEqual(['t', 'b', 'a']);
  });
});

describe('read-time trigger wrap (GRS-014d) — bare string → {kind}, no file rewrites', () => {
  it('wraps a legacy string trigger for get/list and leaves the file byte-identical', () => {
    const file = writeLegacyRun(root, 'wf', 'legacy-trig', 'passed'); // writes trigger:'manual' string
    const before = sha256(file);

    const got = getRun(root, 'wf', 'legacy-trig')?.trigger;
    expect(got).toEqual({ kind: 'manual' });
    expect(normalizeWorkflowTrigger(got)).toEqual({ source: 'manual', event: 'workflow.manual_started', payload: {} });
    expect(normalizeWorkflowTrigger(listRuns(root, 'wf').find((r) => r.runId === 'legacy-trig')?.trigger)).toEqual({
      source: 'manual',
      event: 'workflow.manual_started',
      payload: {},
    });
    expect(sha256(file)).toBe(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).trigger).toBe('manual'); // frozen evidence untouched
  });

  it("wraps an early-v2 string 'schedule' trigger too (any string is pre-014d)", () => {
    const dir = path.join(root, 'reports', 'runs', 'wf');
    fs.mkdirSync(dir, { recursive: true });
    const record = { ...makeRun({ runId: 'v2-str' }), trigger: 'schedule' };
    fs.writeFileSync(path.join(dir, 'v2-str.json'), JSON.stringify(record), 'utf8');
    expect(normalizeWorkflowTrigger(getRun(root, 'wf', 'v2-str')?.trigger)).toEqual({ source: 'schedule', event: 'schedule.fire', payload: {} });
  });

  it('passes a normalized trigger envelope through unchanged', () => {
    const trig = {
      source: 'schedule',
      event: 'schedule.fire',
      payload: { cronJobId: 'workflow:wf', fireIso: '2026-07-04T06:00:00.000Z' },
      fireRef: '2026-07-04T06:00:00.000Z',
    };
    saveRun(root, makeRun({ runId: 'v2-obj', trigger: trig }));
    expect(getRun(root, 'wf', 'v2-obj')?.trigger).toEqual(trig);
  });

  it('normalizes legacy object triggers into the uniform envelope and moves triggerTodoId into payload', () => {
    expect(normalizeWorkflowTrigger({ kind: 'manual' })).toEqual({ source: 'manual', event: 'workflow.manual_started', payload: {} });
    expect(normalizeWorkflowTrigger({ kind: 'schedule', cronJobId: 'workflow:wf', fireIso: '2026-07-04T06:00:00.000Z' })).toEqual({
      source: 'schedule',
      event: 'schedule.fire',
      payload: { cronJobId: 'workflow:wf', fireIso: '2026-07-04T06:00:00.000Z' },
      fireRef: '2026-07-04T06:00:00.000Z',
    });
    expect(normalizeWorkflowTrigger({ kind: 'todo-status-change', fireRef: 'wie_evt1' }, 'wi_1')).toEqual({
      source: 'todo-status-change',
      event: 'todo.status_changed',
      payload: { todoId: 'wi_1' },
      fireRef: 'wie_evt1',
    });
  });
});

describe('findRunByFire (GRS-014d) — the file-enforced one-run-per-fire scan', () => {
  it('finds the run claiming a fireIso and ignores manual runs and other fires', () => {
    saveRun(root, makeRun({ runId: 'r-manual' }));
    saveRun(root, makeRun({ runId: 'r-a', trigger: { source: 'schedule', event: 'schedule.fire', payload: { fireIso: '2026-07-04T06:00:00.000Z' }, fireRef: '2026-07-04T06:00:00.000Z' } }));
    saveRun(root, makeRun({ runId: 'r-b', trigger: { source: 'schedule', event: 'schedule.fire', payload: { fireIso: '2026-07-05T06:00:00.000Z' }, fireRef: '2026-07-05T06:00:00.000Z' } }));

    expect(findRunByFire(root, 'wf', '2026-07-04T06:00:00.000Z')?.runId).toBe('r-a');
    expect(findRunByFire(root, 'wf', '2026-07-05T06:00:00.000Z')?.runId).toBe('r-b');
    expect(findRunByFire(root, 'wf', '2026-07-06T06:00:00.000Z')).toBeNull();
    expect(findRunByFire(root, 'other-wf', '2026-07-04T06:00:00.000Z')).toBeNull();
    expect(findRunByTriggerFireRef(root, 'wf', 'schedule', 'schedule.fire', '2026-07-04T06:00:00.000Z')?.runId).toBe('r-a');
  });

  it('never matches a trigger without fireRef (route-started schedule runs)', () => {
    saveRun(root, makeRun({ runId: 'r-nofire', trigger: { source: 'schedule', event: 'schedule.fire', payload: {} } }));
    expect(findRunByFire(root, 'wf', '2026-07-04T06:00:00.000Z')).toBeNull();
    expect(findRunByTriggerFireRef(root, 'wf', 'schedule', 'schedule.fire', '2026-07-04T06:00:00.000Z')).toBeNull();
  });

  it('finds a todo-status-change run by fireRef using the same file-enforced dedupe scan', () => {
    saveRun(root, makeRun({ runId: 'r-todo', trigger: { source: 'todo-status-change', event: 'todo.status_changed', payload: { todoId: 'wi_1' }, fireRef: 'wie_evt1' } }));
    saveRun(root, makeRun({ runId: 'r-other', trigger: { source: 'todo-status-change', event: 'todo.status_changed', payload: { todoId: 'wi_2' }, fireRef: 'wie_evt2' } }));

    expect(findRunByFire(root, 'wf', 'wie_evt1')?.runId).toBe('r-todo');
    expect(findRunByFire(root, 'wf', 'wie_evt3')).toBeNull();
    expect(findRunByTriggerFireRef(root, 'wf', 'todo-status-change', 'todo.status_changed', 'wie_evt1')?.runId).toBe('r-todo');
    expect(findRunByTriggerFireRef(root, 'wf', 'schedule', 'schedule.fire', 'wie_evt1')).toBeNull();
  });
});

describe('newRunId', () => {
  it('is filename-safe and stamps the injected clock', () => {
    const id = newRunId(() => '2026-07-04T06:07:08.000Z');
    expect(id).toMatch(/^run-20260704060708-[0-9a-f]{8}$/);
    // safe as a filename segment
    expect(id.includes('/')).toBe(false);
    expect(id.includes(':')).toBe(false);
  });
});
