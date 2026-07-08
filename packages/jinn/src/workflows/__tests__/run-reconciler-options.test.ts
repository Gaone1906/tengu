import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startWorkflowRun,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { advanceRun, stepSessionKey, type SpawnContext, type StepSessionProbe, type StopStepContext } from '../advance.js';
import { resolveExecutionPlan } from '../execution-plan.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import { getRun, saveRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016b integration tier — engine-node options through the REAL driver + stores:
 * model/effort riding the spawn spec into the spawner, the injected stopStepSession
 * executing timeout stops BEFORE any retry spawn, continue-failure notices in the
 * successor's prompt, and the handoff-block instruction suppressed for output:'full'.
 */

const FIXED = '2026-07-05T09:00:00.000Z';
let clock = FIXED;
const now = () => clock;
const tick = (ms: number) => { clock = new Date(Date.parse(FIXED) + ms).toISOString(); };
const MIN = 60_000;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
const e = (from: string, to: string): WorkflowEdge => ({ id: `e_${from}__${to}`, from, to, kind: 'sequence' });

function chainDef(id: string, aOver: Partial<WorkflowNode> = {}, over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes: [trigger, step('a', aOver), step('b')],
    edges: [e('trg', 'a'), e('a', 'b')],
    ...over,
  };
}

let root: string;
beforeEach(() => {
  clock = FIXED;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-opt-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness(opts: { withStop?: boolean; failSpawnOf?: string } = {}) {
  const sessions = new Map<string, StepSessionProbe>();
  const spawnCalls: SpawnContext[] = [];
  const stopCalls: StopStepContext[] = [];
  /** Interleaved event log — proves stop-before-respawn ordering. */
  const events: string[] = [];
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      if (opts.failSpawnOf === ctx.nodeId) throw new Error(`engine "codex" not available`);
      spawnCalls.push(ctx);
      events.push(`spawn:${ctx.nodeId}:${ctx.attempt}`);
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `sess:${ctx.nodeId}:${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId };
    },
    ...(opts.withStop === false ? {} : {
      stopStepSession: async (stop) => {
        stopCalls.push(stop);
        events.push(`stop:${stop.nodeId}:${stop.attempt}`);
        // A real stop forces the session out of its live state.
        sessions.set(stop.sessionKey, { found: true, sessionId: stop.sessionId ?? 'sess:?', status: 'idle', finalAssistantText: null });
      },
    }),
    now,
  };
  const settle = (runId: string, nodeId: string, attempt = 1, text?: string | null, status: StepSessionProbe['status'] = 'idle') => {
    const key = stepSessionKey(runId, nodeId, attempt, 1);
    const existing = sessions.get(key);
    sessions.set(key, {
      found: true,
      sessionId: existing?.sessionId ?? `sess:${nodeId}:${attempt}`,
      status,
      ...(status === 'idle' ? { finalAssistantText: text === undefined ? `output of ${nodeId}` : text } : {}),
    });
  };
  return { deps, sessions, spawnCalls, stopCalls, events, settle };
}

describe('GRS-016b options through the real driver', () => {
  it('model/effort overrides ride the spawn spec into the spawner', async () => {
    const def = createDefinition(root, chainDef('opt-spec', { options: { model: 'gpt-5.5', effort: 'xhigh' } }), { now });
    const { deps, spawnCalls } = harness();
    await startWorkflowRun(deps, def);
    expect(spawnCalls[0]?.nodeId).toBe('a');
    expect(spawnCalls[0]?.spec).toEqual({ actorKind: 'engine', actorRef: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('a timeout STOPS the live session via the injected dep, then retries under the next attempt key — stop strictly before respawn', async () => {
    const def = createDefinition(root, chainDef('opt-timeout-retry', {
      options: { timeoutMinutes: 1, retry: { maxAttempts: 2, on: ['timeout'] } },
    }), { now });
    const { deps, spawnCalls, stopCalls, events, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    tick(MIN + 5_000); // a@1 breaches its budget
    await sweepWorkflowRuns(deps);

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toMatchObject({
      nodeId: 'a',
      attempt: 1,
      runId: started.runId,
      workflowId: 'opt-timeout-retry',
      sessionKey: stepSessionKey(started.runId, 'a', 1),
    });
    expect(events).toEqual(['spawn:a:1', 'stop:a:1', 'spawn:a:2']); // stop BEFORE the respawn
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1], ['a', 2]]);

    // Attempt 2 finishes inside its own budget → done, successor proceeds.
    settle(started.runId, 'a', 2, 'A done on the second try.');
    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'opt-timeout-retry', started.runId)!;
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('done');
    expect(run.steps.find((s) => s.nodeId === 'a')?.attempt).toBe(2);
  });

  it('CRASH between stop and redispatch (Codex 016b finding 1): the durable dispatching@2 intent recovers to exactly ONE next attempt, never step-no-output', async () => {
    // The reviewer's window: attempt 1 times out, the session is STOPPED (its
    // evidence becomes idle-with-no-output), and the gateway dies before the
    // next-attempt spawn. Pre-fix the run still said running@1, so the next sweep
    // misrouted the stopped session as step-no-output — losing the configured
    // timeout retry. Post-fix the retry decision itself is the durable write
    // (dispatching@2, persisted BEFORE the stop), so recovery is the ordinary
    // mint-before-spawn probe: key a:2 missing → re-dispatch the SAME attempt 2.
    const def = createDefinition(root, chainDef('opt-timeout-crash', {
      options: { timeoutMinutes: 1, retry: { maxAttempts: 2, on: ['timeout'] } },
    }), { now });
    const { deps, sessions, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def); // a@1 spawned + running
    tick(MIN + 5_000);

    // Reproduce the driver's exact pre-crash prefix by hand: plan → persist → stop.
    const plan = resolveExecutionPlan(def);
    if (!plan.ok) throw new Error('fixture plan failed');
    const persisted = getRun(root, 'opt-timeout-crash', started.runId)!;
    const pass = advanceRun(persisted, plan.plan, deps.probeStepSession, now);
    expect(pass.stops?.length).toBe(1);
    expect(pass.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    expect(pass.changed).toBe(true); // the durable intent exists BEFORE any side effect
    saveRun(root, pass.run); // driver persist (pre-stop)
    // The stop's irreversible effect on the old attempt's evidence:
    sessions.set(stepSessionKey(started.runId, 'a', 1), {
      found: true, sessionId: 'sess:a:1', status: 'idle', finalAssistantText: null,
    });
    // CRASH here — the dispatch batch never runs.

    // Recovery: the ordinary startup sweep on the persisted record.
    await sweepWorkflowRuns(deps);
    let run = getRun(root, 'opt-timeout-crash', started.runId)!;
    expect(run.status).toBe('running');
    const receipt = run.steps.find((s) => s.nodeId === 'a')!;
    expect(receipt.attempt).toBe(2); // exactly one next attempt — no a:3, no lost retry
    expect(receipt.status).toBe('running');
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1], ['a', 2]]);
    expect(JSON.stringify(run)).not.toContain('no output'); // the pre-fix misroute is dead

    // Convergence: attempt 2 finishes inside its own budget → done → successor runs.
    settle(started.runId, 'a', 2, 'recovered fine');
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'opt-timeout-crash', started.runId)!;
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('done');
    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'opt-timeout-crash', started.runId)!;
    expect(run.status).toBe('completed');
  });

  it('a timeout WITHOUT retry stops the session and fails the run; a missing stop dep degrades gracefully', async () => {
    const withStop = harness();
    const def1 = createDefinition(root, chainDef('opt-timeout-fail', { options: { timeoutMinutes: 1 } }), { now });
    const started1 = await startWorkflowRun(withStop.deps, def1);
    tick(MIN + 1_000);
    await sweepWorkflowRuns(withStop.deps);
    expect(withStop.stopCalls).toHaveLength(1);
    const run1 = getRun(root, 'opt-timeout-fail', started1.runId)!;
    expect(run1.status).toBe('failed');
    expect(run1.errors?.map((x) => x.code)).toEqual(['step-timeout']);

    // No stopStepSession injected (an older embedder): the settle still lands, no throw.
    clock = FIXED;
    const noStop = harness({ withStop: false });
    const def2 = createDefinition(root, chainDef('opt-timeout-nostop', { options: { timeoutMinutes: 1 } }), { now });
    const started2 = await startWorkflowRun(noStop.deps, def2);
    tick(MIN + 1_000);
    await sweepWorkflowRuns(noStop.deps);
    expect(getRun(root, 'opt-timeout-nostop', started2.runId)!.status).toBe('failed');
  });

  it('a continue-node failure puts an engine-generated failure NOTICE in the successor prompt — no fabricated handoff', async () => {
    const def = createDefinition(root, chainDef('opt-continue-notice', { options: { onError: 'continue' } }), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1, undefined, 'error');
    await sweepWorkflowRuns(deps);

    const run = getRun(root, 'opt-continue-notice', started.runId)!;
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'b')?.status).toBe('running');

    const bPrompt = spawnCalls.find((c) => c.nodeId === 'b')!.prompt;
    expect(bPrompt).toMatch(/FAILED/);
    expect(bPrompt).toMatch(/onError: continue/);
    expect(bPrompt).not.toContain('handoff-data'); // no fake outcome is fabricated
  });

  it('output:"full" suppresses the handoff-block instruction in the step\'s own prompt', async () => {
    const def = createDefinition(root, chainDef('opt-full-prompt', { options: { output: 'full' } }), { now });
    const { deps, spawnCalls } = harness();
    await startWorkflowRun(deps, def);
    const aPrompt = spawnCalls.find((c) => c.nodeId === 'a')!.prompt;
    expect(aPrompt).not.toContain('```handoff');

    // Control: a default node still gets the instruction.
    const def2 = createDefinition(root, chainDef('opt-default-prompt'), { now });
    const h2 = harness();
    await startWorkflowRun(h2.deps, def2);
    expect(h2.spawnCalls.find((c) => c.nodeId === 'a')!.prompt).toContain('```handoff');
  });

  it('a SPAWN failure on a continue node keeps the run alive and the successor still runs', async () => {
    const def = createDefinition(root, chainDef('opt-continue-spawnfail', { options: { onError: 'continue' } }), { now });
    const { deps, settle } = harness({ failSpawnOf: 'a' });
    const started = await startWorkflowRun(deps, def);

    let run = getRun(root, 'opt-continue-spawnfail', started.runId)!;
    expect(run.status).toBe('running');
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'b')?.status).toBe('running');

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'opt-continue-spawnfail', started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
  });
});
