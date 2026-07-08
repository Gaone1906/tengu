import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startWorkflowRun,
  sweepWorkflowRuns,
  resolveWorkflowRunGate,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { stepSessionKey, type SpawnContext, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import { getRun, listRuns } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016a integration tier — the parallel driver against a REAL run/definition store
 * (throwaway temp root) with a stubbed registry and spawner: two branches genuinely in
 * flight at once, the wait-all join receiving BOTH handoffs, the honest drain, and the
 * parked probe-only sweep. Mirrors run-reconciler.test.ts's harness so the two tiers
 * read the same.
 */

const FIXED = '2026-07-04T18:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
const e = (from: string, to: string): WorkflowEdge => ({ id: `e_${from}__${to}`, from, to, kind: 'sequence' });

/** trigger→a→(b ∥ c)→d with concurrency 2. */
function diamondDef(id: string, over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes: [trigger, step('a'), step('b'), step('c'), step('d')],
    edges: [e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
    concurrency: 2,
    ...over,
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-par-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const sessions = new Map<string, StepSessionProbe>();
  const spawnCalls: SpawnContext[] = [];
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      spawnCalls.push(ctx);
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `sess:${ctx.nodeId}:${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId };
    },
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
  return { deps, sessions, spawnCalls, settle };
}

describe('parallel fan-out through the real driver (GRS-016a)', () => {
  it('both branches are GENUINELY in flight at once, and one sweep settles + joins them', async () => {
    const def = createDefinition(root, diamondDef('par-diamond'), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running');
    settle(started.runId, 'a', 1, 'A done.\n```handoff\n{ "summary": "a shipped", "artifacts": ["src/a.ts"] }\n```');
    await sweepWorkflowRuns(deps);

    // BOTH branch sessions exist concurrently before either settles — the overlap
    // the operator asked for, impossible under v2.
    let run = getRun(root, 'par-diamond', started.runId)!;
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['a', 'done'], ['b', 'running'], ['c', 'running'], ['d', 'pending'],
    ]);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);

    // Both settle → ONE sweep resolves both receipts and dispatches the join.
    settle(started.runId, 'b', 1, 'B done.\n```handoff\n{ "summary": "b analyzed the left half" }\n```');
    settle(started.runId, 'c', 1, 'C done.\n```handoff\n{ "summary": "c analyzed the right half" }\n```');
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'par-diamond', started.runId)!;
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['a', 'done'], ['b', 'done'], ['c', 'done'], ['d', 'running'],
    ]);

    // The join's prompt carries BOTH branches' persisted handoffs (fan-in order = edge order).
    const dPrompt = spawnCalls.find((c) => c.nodeId === 'd')!.prompt;
    expect(dPrompt).toContain('b analyzed the left half');
    expect(dPrompt).toContain('c analyzed the right half');
    expect(dPrompt.indexOf('b analyzed')).toBeLessThan(dPrompt.indexOf('c analyzed'));

    settle(started.runId, 'd', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'par-diamond', started.runId)!.status).toBe('completed');
  });

  it('the same definition WITHOUT concurrency executes strictly sequentially (compat)', async () => {
    const def = createDefinition(root, diamondDef('seq-diamond', { concurrency: undefined }), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a']); // one at a time
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b']); // b alone — never b+c
    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);
    settle(started.runId, 'c', 1);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'd', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'seq-diamond', started.runId)!.status).toBe('completed');
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drain end-to-end: branch b fails, the run keeps running until c settles, then fails with folded errors', async () => {
    const def = createDefinition(root, diamondDef('drain-diamond'), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps); // b + c in flight

    settle(started.runId, 'b', 1, undefined, 'error');
    await sweepWorkflowRuns(deps);
    let run = getRun(root, 'drain-diamond', started.runId)!;
    expect(run.status).toBe('running'); // stopping — c is still live
    expect(run.stopping?.to).toBe('failed');
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['a', 'done'], ['b', 'failed'], ['c', 'running'], ['d', 'pending'],
    ]);

    // No new work while draining: sweep again, nothing spawns.
    await sweepWorkflowRuns(deps);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);

    settle(started.runId, 'c', 1, 'c finished honestly');
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'drain-diamond', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.endedAt).toBe(FIXED);
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('done'); // never frozen at running
    expect(run.errors?.map((x) => x.code)).toEqual(['step-errored']);
    expect(run.steps.find((s) => s.nodeId === 'd')?.status).toBe('pending');
  });

  it('drain LIVENESS via the boot-recovery backstop (Codex finding 3): a sibling stamped interrupted mid-drain reaches the failed terminal', async () => {
    // The drain deliberately has no timeout system of its own: it waits on the SAME
    // completion signals as any step, and those already have backstops — a gateway
    // restart stamps every running session `interrupted` (recoverStaleSessions), and
    // the status reconciler two-strikes heartbeat-dead sessions to `idle`. This test
    // proves the interrupted path converges the drain.
    const def = createDefinition(root, diamondDef('drain-interrupted'), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps); // b + c in flight
    settle(started.runId, 'b', 1, undefined, 'error');
    await sweepWorkflowRuns(deps); // drain begins; c still live
    expect(getRun(root, 'drain-interrupted', started.runId)!.status).toBe('running');

    // Gateway restart: recoverStaleSessions stamps c interrupted. The next sweep must
    // settle it (NO attempt-2 respawn during a drain) and write the terminal.
    settle(started.runId, 'c', 1, undefined, 'interrupted');
    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'drain-interrupted', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.endedAt).toBe(FIXED);
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('failed');
    expect(run.errors?.map((x) => x.code)).toEqual(['step-errored', 'step-interrupted']);
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1], ['b', 1], ['c', 1]]); // no respawn
  });

  it('drain LIVENESS via the status-reconciler backstop (Codex finding 3): a hung sibling forced idle-with-no-output reaches the failed terminal', async () => {
    // The status reconciler force-idles a session whose heartbeat died with no live
    // engine turn; the probe then reports idle with NO assistant output, which the
    // drain settles as an honest step-no-output failure — terminal follows.
    const def = createDefinition(root, diamondDef('drain-forced-idle'), { now });
    const { deps, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1, undefined, 'error');
    await sweepWorkflowRuns(deps); // draining
    settle(started.runId, 'c', 1, null); // forced idle, no output
    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'drain-forced-idle', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('failed');
    expect(run.errors?.map((x) => x.code)).toEqual(['step-errored', 'step-no-output']);
  });

  it('parked probe-only sweep: the sibling settles while the run stays parked and nothing dispatches', async () => {
    // trigger→a→g(approval); trigger→c — the park fires with c in flight.
    const def = createDefinition(root, {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'park-inflight', title: 'park-inflight', version: 1, status: 'active',
      nodes: [
        trigger, step('a'),
        { id: 'g', type: 'gate', label: 'G', position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: 'ap' } },
        step('c'),
      ],
      edges: [e('trg', 'a'), e('a', 'g'), e('trg', 'c')],
      concurrency: 2,
    }, { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    expect(spawnCalls.map((s) => s.nodeId)).toEqual(['a', 'c']);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    let run = getRun(root, 'park-inflight', started.runId)!;
    expect(run.status).toBe('parked');
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('running');
    expect(listRuns(root, 'park-inflight')[0].inFlight).toBe(true); // the sweep's probe-only signal

    // c settles → the PARKED run is probe-swept: receipt done, still parked, no dispatch.
    settle(started.runId, 'c', 1, 'c finished while the human decides');
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'park-inflight', started.runId)!;
    expect(run.status).toBe('parked');
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('done');
    expect(run.steps.find((s) => s.nodeId === 'c')?.outcome?.finalMessage).toContain('while the human decides');
    expect(spawnCalls.map((s) => s.nodeId)).toEqual(['a', 'c']); // probe-only: nothing new spawned

    // Quiet parked run (nothing in flight) is untouched by further sweeps.
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'park-inflight', started.runId)!.steps.find((s) => s.nodeId === 'c')?.status).toBe('done');

    // Resolve completes the run through the normal path.
    const resolved = await resolveWorkflowRunGate(deps, 'park-inflight', started.runId, 'approve');
    expect(resolved.outcome).toBe('resolved');
    expect((resolved as { run: { status: string } }).run.status).toBe('completed');
  });

  it('spawn failure on one branch drains instead of freezing the other mid-batch', async () => {
    const def = createDefinition(root, diamondDef('spawnfail-diamond'), { now });
    const { deps, settle, sessions } = harness();
    const failing: RunDriverDeps = {
      ...deps,
      spawnStep: async (ctx) => {
        if (ctx.nodeId === 'c') throw new Error('roster gone');
        const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
        sessions.set(key, { found: true, sessionId: `sess:${ctx.nodeId}`, status: 'running' });
        return { sessionId: `sess:${ctx.nodeId}` };
      },
    };

    const started = await startWorkflowRun(failing, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(failing); // b spawns; c's spawn throws with b in flight → drain

    let run = getRun(root, 'spawnfail-diamond', started.runId)!;
    expect(run.status).toBe('running');
    expect(run.stopping?.errors.map((x) => x.code)).toEqual(['spawn-failed']);
    expect(run.steps.find((s) => s.nodeId === 'b')?.status).toBe('running');
    expect(run.steps.find((s) => s.nodeId === 'c')?.status).toBe('failed');

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(failing);
    run = getRun(root, 'spawnfail-diamond', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'b')?.status).toBe('done');
    expect(run.errors?.map((x) => x.code)).toEqual(['spawn-failed']);
  });
});
