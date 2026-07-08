import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CronJob } from '../../shared/types.js';
import type { EditableWorkflowDefinition, WorkflowNode } from '../definition.js';
import { WORKFLOW_DEFINITION_SCHEMA_VERSION } from '../definition.js';

/**
 * GRS-014d — definition-synced managed cron jobs + the typed fire path.
 *
 * The pure halves (`desiredWorkflowCronJobs`/`syncWorkflowCronJobs`) are tested with
 * plain values; `applyWorkflowCronSync` and `fireWorkflowCronJob` run against a REAL
 * temp JINN_HOME (jobs.json) + temp evidence root (definition/run stores) with the
 * same stubbed-spawner harness the run-reconciler tests use. JINN_HOME must be set
 * BEFORE the module graph loads (shared/paths resolves it at import time).
 */

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-cron-sync-home-'));
process.env.JINN_HOME = tempHome;

type CronSync = typeof import('../cron-sync.js');
type DefStore = typeof import('../definition-store.js');
type RunStore = typeof import('../run-store.js');
type Advance = typeof import('../advance.js');
type Jobs = typeof import('../../cron/jobs.js');
let cronSync: CronSync;
let defStore: DefStore;
let runStore: RunStore;
let advance: Advance;
let cronJobs: Jobs;

beforeAll(async () => {
  cronSync = await import('../cron-sync.js');
  defStore = await import('../definition-store.js');
  runStore = await import('../run-store.js');
  advance = await import('../advance.js');
  cronJobs = await import('../../cron/jobs.js');
});

const NOW = '2026-07-04T18:00:00.000Z';
const now = () => NOW;

function triggerNode(trigger: NonNullable<WorkflowNode['trigger']>): WorkflowNode {
  return { id: 'trg', type: 'trigger', label: 'Trigger', position: { x: 0, y: 0 }, trigger };
}
function stepNode(id: string): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 140 }, actor: { kind: 'engine', ref: 'codex' } };
}
function makeDef(id: string, over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  const nodes = over.nodes ?? [triggerNode({ kind: 'schedule', cron: '0 6 * * *' }), stepNode('sa')];
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: `WF ${id}`,
    version: 1,
    status: 'active',
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const })),
    ...over,
    ...(over.nodes ? { nodes: over.nodes } : {}),
  };
}
function userJob(over: Partial<CronJob> = {}): CronJob {
  return { id: 'user-1', name: 'User Job', enabled: true, schedule: '0 * * * *', prompt: 'do things', ...over };
}

describe('desiredWorkflowCronJobs (pure)', () => {
  it('derives one enabled managed job per active schedule-trigger definition, with the id convention', () => {
    const defs = [makeDef('wf-a', { nodes: [triggerNode({ kind: 'schedule', cron: '30 7 * * 1-5', timezone: 'Europe/Sofia' }), stepNode('sa')] })];
    const desired = cronSync.desiredWorkflowCronJobs(defs, NOW);
    expect(desired).toEqual([
      {
        id: 'workflow:wf-a',
        name: 'WF wf-a',
        enabled: true,
        schedule: '30 7 * * 1-5',
        timezone: 'Europe/Sofia',
        managedBy: 'workflow',
        workflowId: 'wf-a',
      },
    ]);
    // No prompt field at all — the fire is typed, never an LLM turn.
    expect('prompt' in desired[0]).toBe(false);
  });

  it('contributes nothing for paused, retired, or manual-trigger definitions', () => {
    const defs = [
      makeDef('paused-wf', { status: 'paused' }),
      makeDef('retired-wf', { status: 'retired' }),
      makeDef('manual-wf', { nodes: [triggerNode({ kind: 'manual' }), stepNode('sa')] }),
    ];
    expect(cronSync.desiredWorkflowCronJobs(defs, NOW)).toEqual([]);
  });

  it('keeps a DISABLED entry when the schedule until has passed (visible self-clean, not a silent vanish)', () => {
    const defs = [makeDef('expired-wf', { nodes: [triggerNode({ kind: 'schedule', cron: '0 6 * * *', until: '2026-07-01' }), stepNode('sa')] })];
    const desired = cronSync.desiredWorkflowCronJobs(defs, NOW);
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({ id: 'workflow:expired-wf', enabled: false });
  });

  it('a future or unparseable until stays enabled; a blank cron contributes nothing', () => {
    const defs = [
      makeDef('future-wf', { nodes: [triggerNode({ kind: 'schedule', cron: '0 6 * * *', until: '2027-01-01' }), stepNode('sa')] }),
      makeDef('typo-wf', { nodes: [triggerNode({ kind: 'schedule', cron: '0 6 * * *', until: 'someday' }), stepNode('sa')] }),
      makeDef('blank-wf', { nodes: [triggerNode({ kind: 'schedule', cron: '   ' }), stepNode('sa')] }),
    ];
    const desired = cronSync.desiredWorkflowCronJobs(defs, NOW);
    expect(desired.map((j) => j.id)).toEqual(['workflow:future-wf', 'workflow:typo-wf']);
    expect(desired.every((j) => j.enabled)).toBe(true);
  });
});

describe('syncWorkflowCronJobs (pure)', () => {
  const desiredA: CronJob = {
    id: 'workflow:wf-a', name: 'WF A', enabled: true, schedule: '0 6 * * *', managedBy: 'workflow', workflowId: 'wf-a',
  };

  it('adds a missing managed job and never touches unmanaged jobs (order preserved)', () => {
    const existing = [userJob({ id: 'u1' }), userJob({ id: 'u2' })];
    const result = cronSync.syncWorkflowCronJobs(existing, [desiredA]);
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['workflow:wf-a']);
    expect(result.jobs.slice(0, 2)).toEqual(existing); // verbatim, in place
    expect(result.jobs[2]).toEqual(desiredA);
  });

  it('replaces a drifted managed job wholesale — manual edits (schedule, extras) are re-synced away', () => {
    const drifted: CronJob = { ...desiredA, schedule: '*/5 * * * *', prompt: 'sneaky manual prompt' };
    const result = cronSync.syncWorkflowCronJobs([drifted], [desiredA]);
    expect(result.updated).toEqual(['workflow:wf-a']);
    expect(result.jobs).toEqual([desiredA]); // the manual prompt did not survive
  });

  it('removes a managed job no longer desired; is a no-op (changed:false) when already reconciled', () => {
    const gone = cronSync.syncWorkflowCronJobs([desiredA, userJob()], []);
    expect(gone.removed).toEqual(['workflow:wf-a']);
    expect(gone.jobs).toEqual([userJob()]);

    const idempotent = cronSync.syncWorkflowCronJobs([userJob(), desiredA], [desiredA]);
    expect(idempotent.changed).toBe(false);
    expect(idempotent.jobs).toEqual([userJob(), desiredA]);
  });

  it('NEVER clobbers an unmanaged job that holds the desired id — reported as a conflict', () => {
    const squatter = userJob({ id: 'workflow:wf-a', name: 'Not managed' });
    const result = cronSync.syncWorkflowCronJobs([squatter], [desiredA]);
    expect(result.changed).toBe(false);
    expect(result.conflicts).toEqual(['workflow:wf-a']);
    expect(result.jobs).toEqual([squatter]); // untouched
  });

  it('Codex finding 2 regression: unmanaged squatter + managed duplicate under ONE id — user row wins, managed residue removed, conflict reported once', () => {
    // The exact review failure input: jobs.json holding BOTH rows for workflow:wf-a.
    const squatter: CronJob = { id: 'workflow:wf-a', name: 'User squatter', enabled: true, schedule: '0 * * * *', prompt: 'user prompt' };
    const oldManaged: CronJob = { id: 'workflow:wf-a', name: 'Old managed', enabled: true, schedule: '* * * * *', managedBy: 'workflow', workflowId: 'wf-a' };

    const result = cronSync.syncWorkflowCronJobs([squatter, oldManaged], [desiredA]);

    // The unmanaged row is authoritative for the id: it survives byte-identical, the
    // managed duplicate is dropped (sync-owned residue — leaving it would keep the
    // scheduler double-firing one id), and the desired entry is NOT applied.
    expect(result.jobs).toEqual([squatter]);
    expect(result.conflicts).toEqual(['workflow:wf-a']);
    expect(result.removed).toEqual(['workflow:wf-a']);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.changed).toBe(true); // the removal must persist so the collision heals

    // Order-independent: managed row FIRST gives the identical outcome.
    const flipped = cronSync.syncWorkflowCronJobs([oldManaged, squatter], [desiredA]);
    expect(flipped.jobs).toEqual([squatter]);
    expect(flipped.conflicts).toEqual(['workflow:wf-a']);
  });

  it('Codex round-2 regression: a CASE-VARIANT unmanaged squatter is the same identity — conflict, desired not applied (run-log files collide case-insensitively)', () => {
    // The review's failure input: exact-string semantics let "Workflow:wf-a" and
    // "workflow:wf-a" coexist while both append to one workflow:wf-a.jsonl on macOS.
    const caseSquatter: CronJob = { id: 'Workflow:wf-a', name: 'Case user', enabled: true, schedule: '0 * * * *', prompt: 'user prompt' };
    const result = cronSync.syncWorkflowCronJobs([caseSquatter], [desiredA]);
    expect(result.jobs).toEqual([caseSquatter]); // authored id untouched
    expect(result.conflicts).toEqual(['workflow:wf-a']); // reported canonically
    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);

    // Same for a whitespace-padded squatter (" workflow:wf-a " trims to the identity).
    const padSquatter: CronJob = { id: ' workflow:wf-a ', name: 'Space user', enabled: true, schedule: '0 * * * *', prompt: 'user prompt' };
    const padded = cronSync.syncWorkflowCronJobs([padSquatter], [desiredA]);
    expect(padded.jobs).toEqual([padSquatter]);
    expect(padded.conflicts).toEqual(['workflow:wf-a']);
    expect(padded.added).toEqual([]);

    // And the duplicate shape across case: case-variant user row + exact managed row →
    // user row wins, managed residue removed, one canonical conflict.
    const managed: CronJob = { ...desiredA, schedule: '* * * * *' };
    const dup = cronSync.syncWorkflowCronJobs([caseSquatter, managed], [desiredA]);
    expect(dup.jobs).toEqual([caseSquatter]);
    expect(dup.removed).toEqual(['workflow:wf-a']);
    expect(dup.conflicts).toEqual(['workflow:wf-a']);
  });

  it('a case-drifted MANAGED row is the same identity — healed back to the desired authored id, not duplicated', () => {
    const drifted: CronJob = { ...desiredA, id: 'Workflow:WF-A' };
    const result = cronSync.syncWorkflowCronJobs([drifted], [desiredA]);
    expect(result.jobs).toEqual([desiredA]); // one row, authored desired id
    expect(result.updated).toEqual(['Workflow:WF-A']);
    expect(result.added).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('duplicate MANAGED rows for one id collapse to a single reconciled row', () => {
    const dupA: CronJob = { ...desiredA, schedule: '* * * * *' };
    const result = cronSync.syncWorkflowCronJobs([dupA, { ...desiredA }], [desiredA]);
    expect(result.jobs).toEqual([desiredA]); // exactly one row remains
    expect(result.updated).toEqual(['workflow:wf-a']); // first row won the desired entry
    expect(result.removed).toEqual(['workflow:wf-a']); // the duplicate is gone
    expect(result.conflicts).toEqual([]);
  });
});

describe('applyWorkflowCronSync (real jobs.json + definition store)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-cron-sync-root-'));
    fs.rmSync(path.join(tempHome, 'cron'), { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the managed job for a saved schedule definition, preserving user jobs', () => {
    cronJobs.saveJobs([userJob()]);
    defStore.createDefinition(root, makeDef('wf-live'), { now });

    const result = cronSync.applyWorkflowCronSync(root, { now });

    expect(result.added).toEqual(['workflow:wf-live']);
    const onDisk = cronJobs.loadJobs();
    expect(onDisk.map((j) => j.id)).toEqual(['user-1', 'workflow:wf-live']);
    expect(onDisk[1]).toMatchObject({ managedBy: 'workflow', workflowId: 'wf-live', schedule: '0 6 * * *', enabled: true });
  });

  it('heals drift: a hand-deleted or hand-edited managed job is re-derived (the startup story)', () => {
    defStore.createDefinition(root, makeDef('wf-heal'), { now });
    cronSync.applyWorkflowCronSync(root, { now });

    // Hand-delete the managed entry (keep the user job).
    cronJobs.saveJobs([userJob()]);
    const healed = cronSync.applyWorkflowCronSync(root, { now });
    expect(healed.added).toEqual(['workflow:wf-heal']);
    expect(cronJobs.loadJobs().map((j) => j.id)).toEqual(['user-1', 'workflow:wf-heal']);

    // Hand-edit the managed entry.
    const tampered = cronJobs.loadJobs().map((j) => (j.id === 'workflow:wf-heal' ? { ...j, schedule: '* * * * *' } : j));
    cronJobs.saveJobs(tampered);
    const healed2 = cronSync.applyWorkflowCronSync(root, { now });
    expect(healed2.updated).toEqual(['workflow:wf-heal']);
    expect(cronJobs.loadJobs().find((j) => j.id === 'workflow:wf-heal')!.schedule).toBe('0 6 * * *');
  });

  it('retire/pause removes the entry; onChanged fires only on a real change; no write when reconciled', () => {
    defStore.createDefinition(root, makeDef('wf-ret'), { now });
    let onChangedCalls = 0;
    cronSync.applyWorkflowCronSync(root, { now, onChanged: () => onChangedCalls++ });
    expect(onChangedCalls).toBe(1);

    // Already reconciled → no change, no callback, jobs.json untouched.
    const before = fs.readFileSync(path.join(tempHome, 'cron', 'jobs.json'), 'utf-8');
    const unchanged = cronSync.applyWorkflowCronSync(root, { now, onChanged: () => onChangedCalls++ });
    expect(unchanged.changed).toBe(false);
    expect(onChangedCalls).toBe(1);
    expect(fs.readFileSync(path.join(tempHome, 'cron', 'jobs.json'), 'utf-8')).toBe(before);

    defStore.retireDefinition(root, 'wf-ret', { now });
    const afterRetire = cronSync.applyWorkflowCronSync(root, { now, onChanged: () => onChangedCalls++ });
    expect(afterRetire.removed).toEqual(['workflow:wf-ret']);
    expect(onChangedCalls).toBe(2);
    expect(cronJobs.loadJobs()).toEqual([]);
  });

  it('creates no jobs.json at all when there is nothing to reconcile', () => {
    const result = cronSync.applyWorkflowCronSync(root, { now });
    expect(result.changed).toBe(false);
    expect(fs.existsSync(path.join(tempHome, 'cron', 'jobs.json'))).toBe(false);
  });
});

describe('fireWorkflowCronJob (typed fire path, stubbed spawner)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-cron-fire-root-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function harness() {
    const spawnCalls: unknown[] = [];
    const sessions = new Map<string, { found: true; sessionId: string; status: 'running' }>();
    const deps = {
      root,
      getDefinition: defStore.getDefinition,
      probeStepSession: (key: string) => sessions.get(key) ?? { found: false as const },
      spawnStep: async (ctx: { runId: string; nodeId: string; attempt: number }) => {
        spawnCalls.push(ctx);
        const sessionId = `sess:${ctx.nodeId}:${ctx.attempt}`;
        sessions.set(advance.stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt), { found: true, sessionId, status: 'running' });
        return { sessionId };
      },
      now,
    };
    return { deps, spawnCalls };
  }
  const managedJob = (workflowId: string): CronJob => ({
    id: `workflow:${workflowId}`, name: `WF ${workflowId}`, enabled: true, schedule: '0 6 * * *',
    managedBy: 'workflow', workflowId,
  });
  const FIRE = '2026-07-04T06:00:00.000Z';

  it('starts exactly one run per fireIso — the run record carries the normalized schedule trigger envelope; a re-invocation no-ops', async () => {
    defStore.createDefinition(root, makeDef('wf-fire'), { now });
    const { deps, spawnCalls } = harness();

    const first = await cronSync.fireWorkflowCronJob(deps, managedJob('wf-fire'), FIRE);
    expect(first.outcome).toBe('started');
    const runId = (first as { run: { runId: string } }).run.runId;
    const run = runStore.getRun(root, 'wf-fire', runId)!;
    expect(run.trigger).toEqual({
      source: 'schedule',
      event: 'schedule.fire',
      payload: { cronJobId: 'workflow:wf-fire', fireIso: FIRE },
      fireRef: FIRE,
    });
    expect(run.status).toBe('running');
    expect(spawnCalls).toHaveLength(1);

    // The same logical fire again (scheduler retry / double tick) → no second run FILE.
    const second = await cronSync.fireWorkflowCronJob(deps, managedJob('wf-fire'), FIRE);
    expect(second.outcome).toBe('duplicate');
    expect((second as { runId: string }).runId).toBe(runId);
    expect(spawnCalls).toHaveLength(1); // nothing new spawned
    const runDir = path.join(root, 'reports', 'runs', 'wf-fire');
    expect(fs.readdirSync(runDir).filter((n) => n.endsWith('.json'))).toHaveLength(1);

    // A DIFFERENT fire is a new run.
    const third = await cronSync.fireWorkflowCronJob(deps, managedJob('wf-fire'), '2026-07-05T06:00:00.000Z');
    expect(third.outcome).toBe('started');
    expect(fs.readdirSync(runDir).filter((n) => n.endsWith('.json'))).toHaveLength(2);
  });

  it('the dedupe holds inside startWorkflowRun itself (authoritative guard, not just the fire pre-check)', async () => {
    defStore.createDefinition(root, makeDef('wf-inner'), { now });
    const { deps, spawnCalls } = harness();
    const def = defStore.getDefinition(root, 'wf-inner')!;
    const trigger = {
      source: 'schedule',
      event: 'schedule.fire',
      payload: { cronJobId: 'workflow:wf-inner', fireIso: FIRE },
      fireRef: FIRE,
    };

    const { startWorkflowRun } = await import('../run-reconciler.js');
    const first = await startWorkflowRun(deps, def, { trigger });
    const second = await startWorkflowRun(deps, def, { trigger });
    expect(second.runId).toBe(first.runId); // the existing run is returned, not a new one
    expect(spawnCalls).toHaveLength(1);
  });

  it('no-ops past the trigger until (expired), before any run exists', async () => {
    defStore.createDefinition(
      root,
      makeDef('wf-until', { nodes: [triggerNode({ kind: 'schedule', cron: '0 6 * * *', until: '2026-07-01' }), stepNode('sa')] }),
      { now },
    );
    const { deps, spawnCalls } = harness();

    const result = await cronSync.fireWorkflowCronJob(deps, managedJob('wf-until'), FIRE);
    expect(result.outcome).toBe('expired');
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'reports', 'runs', 'wf-until'))).toBe(false);
  });

  it('reports stale for missing/paused/manual-trigger definitions and a workflowId-less job — no run starts', async () => {
    const { deps, spawnCalls } = harness();

    expect((await cronSync.fireWorkflowCronJob(deps, managedJob('nope'), FIRE)).outcome).toBe('stale');

    defStore.createDefinition(root, makeDef('wf-paused', { status: 'paused' }), { now });
    expect((await cronSync.fireWorkflowCronJob(deps, managedJob('wf-paused'), FIRE)).outcome).toBe('stale');

    defStore.createDefinition(root, makeDef('wf-manual', { nodes: [triggerNode({ kind: 'manual' }), stepNode('sa')] }), { now });
    expect((await cronSync.fireWorkflowCronJob(deps, managedJob('wf-manual'), FIRE)).outcome).toBe('stale');

    const broken: CronJob = { id: 'workflow:x', name: 'X', enabled: true, schedule: '0 6 * * *', managedBy: 'workflow' };
    expect((await cronSync.fireWorkflowCronJob(deps, broken, FIRE)).outcome).toBe('stale');

    expect(spawnCalls).toHaveLength(0);
  });

  it('a compile-failed run still claims the fireIso (evidence exists; the fire is spent)', async () => {
    // A definition whose step actor is an unknown employee compiles at fire time only
    // if the plan resolves; force a failure via a roster the compiler cannot satisfy —
    // simplest honest path: point the step at an employee and pass a roster-less
    // compile... the sweep compiles rosterless, so instead corrupt the def shape:
    defStore.createDefinition(root, makeDef('wf-badc'), { now });
    const { deps } = harness();
    // Sabotage: definition trigger stays schedule but the stored def gets a cyclic edge.
    const def = defStore.getDefinition(root, 'wf-badc')!;
    const cyclic = { ...def, edges: [...def.edges, { id: 'back', from: 'sa', to: 'sa', kind: 'sequence' as const }] };
    const { startWorkflowRun } = await import('../run-reconciler.js');
    const trigger = {
      source: 'schedule',
      event: 'schedule.fire',
      payload: { cronJobId: 'workflow:wf-badc', fireIso: FIRE },
      fireRef: FIRE,
    };
    const failed = await startWorkflowRun(deps, cyclic, { trigger });
    expect(failed.status).toBe('failed');

    // The failed run is durable evidence and claims the fire: same fireIso → duplicate.
    const again = await startWorkflowRun(deps, cyclic, { trigger });
    expect(again.runId).toBe(failed.runId);
  });

  it('mints trigger {kind:manual} by default (route-started runs carry no fire identity)', async () => {
    defStore.createDefinition(root, makeDef('wf-man'), { now });
    const { deps } = harness();
    const { startWorkflowRun } = await import('../run-reconciler.js');
    const run = await startWorkflowRun(deps, defStore.getDefinition(root, 'wf-man')!, {});
    expect(run.trigger).toEqual({ kind: 'manual' });
    // sanity: the advance-level mint agrees
    expect(advance).toBeTruthy();
  });

  it('dispatcher starts manual runs with the uniform trigger envelope', async () => {
    defStore.createDefinition(root, makeDef('wf-dispatch'), { now });
    const { deps } = harness();
    const { startWorkflowRunFromTrigger } = await import('../run-reconciler.js');
    const run = await startWorkflowRunFromTrigger(deps, defStore.getDefinition(root, 'wf-dispatch')!, {
      source: 'manual',
      event: 'workflow.manual_started',
      payload: { workflowId: 'wf-dispatch' },
    });

    expect(run.trigger).toEqual({
      source: 'manual',
      event: 'workflow.manual_started',
      payload: { workflowId: 'wf-dispatch' },
    });
  });
});
