import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceWorkflowRunById,
  cancelWorkflowRun,
  editPendingWorkflowStepPrompt,
  resolveWorkflowRunGate,
  startWorkflowRun,
  startWorkflowRunReconciler,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { markDispatching, sharedSessionKey, stepSessionKey, type SpawnContext, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition, updateDefinition, WorkflowStoreError } from '../definition-store.js';
import { claimWorkflowRunInvocation, getRun, publishInitialWorkflowRun, saveRun, type WorkflowRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
} from '../definition.js';
import {
  createWorkflowRunInvocationRequest,
  fingerprintWorkflowRunInvocationRequest,
  type WorkflowRunInvocationClaim,
} from '../run-idempotency.js';
import type { WorkflowReportingContext } from '../reporting.js';

/**
 * Integration tests for the GRS-014b run driver + reconciler against a REAL run/definition
 * store (throwaway temp root) with a stubbed session registry (probe map) and a stubbed
 * spawner. This is the design's "integration with stubbed registry" tier: it proves the
 * sweep + startup-recovery paths end-to-end minus real engines (Codex QA does the live
 * isolated-gateway restart proof).
 */

const FIXED = '2026-07-04T18:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
function approvalGate(id: string): WorkflowNode {
  return { id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: 'ap' } };
}
function chainDef(id: string, nodes: WorkflowNode[]): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const })),
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Deps harness: probe over a mutable map; spawner that records calls, registers the
 * spawned session in the probe map as `running`, and returns a deterministic id. */
function harness(overrides: Partial<RunDriverDeps> = {}) {
  const sessions = new Map<string, StepSessionProbe>();
  const spawnCalls: SpawnContext[] = [];
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      spawnCalls.push(ctx);
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `sess:${ctx.nodeId}:${ctx.round > 1 ? `r${ctx.round}:` : ''}${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId, detail: `spawned ${ctx.spec.actorKind} "${ctx.spec.actorRef}"` };
    },
    now,
    ...overrides,
  };
  const settle = (
    runId: string,
    nodeId: string,
    attempt: number,
    status: StepSessionProbe['status'] = 'idle',
    finalAssistantText?: string | null,
    round = 1,
  ) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    const existing = sessions.get(key);
    sessions.set(key, {
      found: true,
      sessionId: existing?.sessionId ?? `sess:${nodeId}:${attempt}`,
      status,
      // Settled sessions carry their final assistant message (GRS-014c); pass null
      // explicitly to model the settled-with-no-output case.
      ...(status === 'idle'
        ? { finalAssistantText: finalAssistantText === undefined ? `output of ${nodeId} attempt ${attempt}` : finalAssistantText }
        : {}),
    });
  };
  return { deps, sessions, spawnCalls, settle };
}

describe('startWorkflowRun + sweep — the sequential lifecycle', () => {
  it('gives exactly one interleaved full-start caller ownership of the initial spawn', async () => {
    const def = createDefinition(root, chainDef('publication-owner', [trigger, step('a')]), { now });
    const options = {
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'publication-key' } as const,
      parameters: { input: { ticket: 'ABC-42' } },
      invocation: { sessionId: 'session-owner', reportMode: 'resume' as const },
      principal: 'employee:owner',
      makeRunId: () => 'run-preallocated-owner',
    };
    const winner = harness();
    const loser = harness();
    const winnerDeps: RunDriverDeps = winner.deps;
    let winnerStart: Promise<WorkflowRun> | undefined;
    const loserDeps: RunDriverDeps = {
      ...loser.deps,
      publishInitialRun: (rootPath, candidate) => {
        winnerStart = startWorkflowRun(winnerDeps, def, options);
        return publishInitialWorkflowRun(rootPath, candidate);
      },
    };

    const losingResult = await startWorkflowRun(loserDeps, def, options);
    if (!winnerStart) throw new Error('publication interleaving was not reached');
    const winningResult = await winnerStart;

    expect(losingResult.runId).toBe(winningResult.runId);
    expect([...winner.spawnCalls, ...loser.spawnCalls]).toHaveLength(1);
  });

  it('returns the published failed snapshot to an interleaved loser without a spawn', async () => {
    const def = chainDef('failed-publication-owner', [trigger, step('a')]);
    def.edges = [{ id: 'broken', from: 'trg', to: 'missing', kind: 'sequence' }];
    const options = {
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'failed-publication-key' } as const,
      principal: 'employee:owner',
      makeRunId: () => 'run-preallocated-failed',
    };
    const winner = harness();
    const loser = harness();
    const winnerDeps: RunDriverDeps = winner.deps;
    let winnerStart: Promise<WorkflowRun> | undefined;
    const loserDeps: RunDriverDeps = {
      ...loser.deps,
      publishInitialRun: (rootPath, candidate) => {
        winnerStart = startWorkflowRun(winnerDeps, def, options);
        return publishInitialWorkflowRun(rootPath, candidate);
      },
    };

    const losingResult = await startWorkflowRun(loserDeps, def, options);
    if (!winnerStart) throw new Error('failed publication interleaving was not reached');
    const winningResult = await winnerStart;

    expect(winningResult.status).toBe('failed');
    expect(losingResult).toEqual(winningResult);
    expect([...winner.spawnCalls, ...loser.spawnCalls]).toHaveLength(0);
  });

  it('replays only exact canonical intent and rejects changed input before a second spawn', async () => {
    const def = createDefinition(root, chainDef('intent-bound', [trigger, step('a')]), { now });
    const { deps, spawnCalls } = harness();
    const runTrigger = {
      source: 'manual', event: 'workflow.manual_started', payload: { b: 2, a: 1 }, fireRef: 'request-42',
    } as const;
    const first = await startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42', nested: { b: 2, a: 1 } } },
      invocation: { sessionId: 'session-owner', reportMode: 'resume' },
      principal: 'employee:owner',
    });
    let replayed = false;
    const exact = await startWorkflowRun(deps, def, {
      trigger: { ...runTrigger, payload: { a: 1, b: 2 } },
      parameters: { input: { nested: { a: 1, b: 2 }, ticket: 'ABC-42' } },
      invocation: { sessionId: 'session-owner', reportMode: 'resume' },
      principal: 'employee:owner',
      onIdempotencyReplay: () => { replayed = true; },
    });

    expect(exact.runId).toBe(first.runId);
    expect(exact.parameters).toEqual(first.parameters);
    expect(exact.invocation).toEqual({ sessionId: 'session-owner', reportMode: 'resume' });
    expect(replayed).toBe(true);
    await expect(startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'CHANGED' } },
      invocation: { sessionId: 'session-owner', reportMode: 'resume' },
      principal: 'employee:owner',
    })).rejects.toMatchObject({
      code: 'workflow-run-idempotency-conflict', runId: first.runId,
    });
    await expect(startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42', nested: { a: 1, b: 2 } } },
      invocation: { sessionId: 'session-other', reportMode: 'resume' },
      principal: 'employee:owner',
    })).rejects.toMatchObject({
      code: 'workflow-run-idempotency-conflict', runId: first.runId,
    });
    await expect(startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42', nested: { a: 1, b: 2 } } },
      invocation: { sessionId: 'session-owner', reportMode: 'silent' },
      principal: 'employee:owner',
    })).rejects.toMatchObject({
      code: 'workflow-run-idempotency-conflict', runId: first.runId,
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it('resumes a crash-window claim without a run using its preallocated run id', async () => {
    const def = createDefinition(root, chainDef('claim-recovery', [trigger, step('a')]), { now });
    const { deps, spawnCalls } = harness();
    const runTrigger = {
      source: 'manual', event: 'workflow.manual_started', payload: { workflowId: def.id }, fireRef: 'recover-key',
    } as const;
    const request = createWorkflowRunInvocationRequest({
      definition: def,
      trigger: runTrigger,
      input: { ticket: 'ABC-42' },
      principal: 'employee:owner',
    });
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1,
      workflowId: def.id,
      principal: 'employee:owner',
      idempotencyKey: 'recover-key',
      runId: 'run-preallocated',
      fingerprint: fingerprintWorkflowRunInvocationRequest(request),
      request,
      createdAt: FIXED,
    };
    expect(claimWorkflowRunInvocation(root, claim).outcome).toBe('claimed');
    expect(getRun(root, def.id, claim.runId)).toBeNull();

    const recovered = await startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42' } },
      principal: 'employee:owner',
    });

    expect(recovered.runId).toBe('run-preallocated');
    expect(getRun(root, def.id, 'run-preallocated')?.runId).toBe('run-preallocated');
    expect(spawnCalls).toHaveLength(1);
  });

  it('compares replay intent with immutable initial overrides after the live run is edited', async () => {
    const def = createDefinition(root, chainDef('immutable-initial-overrides', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls } = harness();
    const runTrigger = {
      source: 'manual', event: 'workflow.manual_started', payload: {}, fireRef: 'override-key',
    } as const;
    const initialStepOverrides = { b: { prompt: 'Original run-local prompt.' } };
    const first = await startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42' } },
      stepOverrides: initialStepOverrides,
      principal: 'employee:owner',
    });
    const edited = await editPendingWorkflowStepPrompt(
      deps, def.id, first.runId, 'b', 'Later operator edit.', { actor: 'owner' },
    );
    expect(edited).toMatchObject({ outcome: 'edited', run: { stepOverrides: { b: { prompt: 'Later operator edit.' } } } });

    let replayed = false;
    const exact = await startWorkflowRun(deps, def, {
      trigger: runTrigger,
      parameters: { input: { ticket: 'ABC-42' } },
      stepOverrides: initialStepOverrides,
      principal: 'employee:owner',
      onIdempotencyReplay: () => { replayed = true; },
    });

    expect(exact.runId).toBe(first.runId);
    expect(exact.stepOverrides?.b?.prompt).toBe('Later operator edit.');
    expect(replayed).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  it('freezes structured per-run input and makes it available to the first phase prompt', async () => {
    const def = createDefinition(root, chainDef('parameterized', [trigger, step('a')]), { now });
    const { deps, spawnCalls } = harness();
    const input = {
      ticket: { id: 'ABC-42', constraints: ['preserve compatibility'] },
      dryRun: false,
    };

    const started = await startWorkflowRun(deps, def, {
      trigger: {
        source: 'manual',
        event: 'workflow.manual_started',
        payload: { workflowId: def.id, requestedBy: 'api' },
        fireRef: 'request-42',
      },
      parameters: { input, idempotencyKey: 'request-42' },
      invocation: { sessionId: 'session-a', reportMode: 'resume' },
    });

    expect(started.parameters).toEqual({ input, idempotencyKey: 'request-42' });
    expect(started.invocation).toEqual({ sessionId: 'session-a', reportMode: 'resume' });
    expect(getRun(root, def.id, started.runId)).toMatchObject({
      parameters: started.parameters,
      invocation: started.invocation,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].prompt).toContain('## Run input (data)');
    expect(spawnCalls[0].prompt).toContain('"id": "ABC-42"');
    expect(spawnCalls[0].prompt).toContain('"preserve compatibility"');
    expect(spawnCalls[0].prompt.indexOf('## Run input (data)')).toBeLessThan(
      spawnCalls[0].prompt.indexOf('## Your task'),
    );

    // The caller cannot mutate the persisted/promoted snapshot after invocation.
    input.ticket.id = 'MUTATED';
    expect(getRun(root, def.id, started.runId)?.parameters?.input).toMatchObject({ ticket: { id: 'ABC-42' } });
    expect(spawnCalls[0].prompt).not.toContain('MUTATED');
  });

  it('publishes revision 1 and increments exactly once for each persisted mutation', async () => {
    const def = createDefinition(root, chainDef('revisioned', [trigger, step('a')]), { now });
    const { deps } = harness();

    const started = await startWorkflowRun(deps, def, {
      parameters: { input: { ticket: 'ABC-42' } },
      invocation: { sessionId: 'session-a', reportMode: 'resume' },
    });

    expect(started.revision).toBe(3);
    expect(getRun(root, def.id, started.runId)?.revision).toBe(3);
  });

  it('uses a frozen per-phase prompt override only for the targeted pending phase', async () => {
    const def = createDefinition(root, chainDef('prompt-override', [
      trigger,
      step('plan', { instructions: 'Write the authored plan.' }),
      step('verify', { instructions: 'Run the authored verification.' }),
    ]), { now });
    const { deps, spawnCalls, settle } = harness();
    const input = { ticket: { id: 'ABC-42' } };
    const stepOverrides = { verify: { prompt: 'Verify only the migration safety checks.' } };

    const started = await startWorkflowRun(deps, def, {
      parameters: { input },
      stepOverrides,
    } as never);

    expect(spawnCalls[0].nodeId).toBe('plan');
    expect(spawnCalls[0].prompt).toContain('Write the authored plan.');
    expect(spawnCalls[0].prompt).not.toContain('Verify only the migration safety checks.');

    input.ticket.id = 'MUTATED-INPUT';
    stepOverrides.verify.prompt = 'MUTATED-OVERRIDE';
    settle(started.runId, 'plan', 1);
    await sweepWorkflowRuns(deps);

    const verifySpawn = spawnCalls.find((call) => call.nodeId === 'verify')!;
    expect(verifySpawn.prompt).toContain('Verify only the migration safety checks.');
    expect(verifySpawn.prompt).not.toContain('Run the authored verification.');
    expect(verifySpawn.prompt).not.toContain('MUTATED-OVERRIDE');
    const persisted = getRun(root, def.id, started.runId)!;
    expect(persisted.parameters?.input).toEqual({ ticket: { id: 'ABC-42' } });
    expect(persisted.stepOverrides).toEqual({
      verify: { prompt: 'Verify only the migration safety checks.' },
    });
  });

  it('applies an audited prompt edit only while a phase is pending', async () => {
    const def = createDefinition(root, chainDef('prompt-edit', [
      trigger,
      step('plan', { instructions: 'Write the plan.' }),
      step('verify', { instructions: 'Run the original checks.' }),
    ]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def, {
      parameters: { input: { ticket: 'ABC-42' } },
    });

    const edited = await editPendingWorkflowStepPrompt(
      deps,
      def.id,
      started.runId,
      'verify',
      'Run the revised migration checks.',
      { actor: 'release-manager' },
    );
    expect(edited.outcome).toBe('edited');
    if (edited.outcome !== 'edited') throw new Error(`unexpected edit outcome ${edited.outcome}`);
    expect(edited.run.stepPromptRevision).toBe(1);
    expect(edited.run.stepPromptEdits).toEqual([{
      revision: 1,
      nodeId: 'verify',
      actor: 'release-manager',
      at: FIXED,
      before: 'Run the original checks.',
      after: 'Run the revised migration checks.',
    }]);
    expect(edited.run.parameters?.input).toEqual({ ticket: 'ABC-42' });

    settle(started.runId, 'plan', 1);
    await sweepWorkflowRuns(deps);
    const verifySpawn = spawnCalls.find((call) => call.nodeId === 'verify')!;
    expect(verifySpawn.prompt).toContain('Run the revised migration checks.');
    expect(verifySpawn.prompt).not.toContain('Run the original checks.');

    const completedPhaseEdit = await editPendingWorkflowStepPrompt(
      deps, def.id, started.runId, 'plan', 'Rewrite the plan.', { actor: 'release-manager' },
    );
    expect(completedPhaseEdit).toMatchObject({ outcome: 'not-pending', status: 'done' });
    const runningPhaseEdit = await editPendingWorkflowStepPrompt(
      deps, def.id, started.runId, 'verify', 'Change while running.', { actor: 'release-manager' },
    );
    expect(runningPhaseEdit).toMatchObject({ outcome: 'not-pending', status: 'running' });

    settle(started.runId, 'verify', 1);
    await sweepWorkflowRuns(deps);
    const settledPhaseEdit = await editPendingWorkflowStepPrompt(
      deps, def.id, started.runId, 'verify', 'Change after completion.', { actor: 'release-manager' },
    );
    expect(settledPhaseEdit).toMatchObject({ outcome: 'not-pending', status: 'done' });
    const persisted = getRun(root, def.id, started.runId)!;
    expect(persisted.stepPromptEdits).toHaveLength(1);
    expect(persisted.parameters?.input).toEqual({ ticket: 'ABC-42' });
  });

  it('upgrades a raw active v2 run on its first real mutation without inventing an invocation relation', async () => {
    const def = createDefinition(root, chainDef('legacy-edit', [trigger, step('verify', { instructions: 'Run checks.' })]), { now });
    const { deps } = harness();
    const dir = path.join(root, 'reports', 'runs', def.id);
    const file = path.join(dir, 'legacy-run.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      runId: 'legacy-run',
      workflowId: def.id,
      definitionVersion: def.version,
      title: def.title,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: {} },
      invocation: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
      status: 'running',
      startedAt: FIXED,
      endedAt: null,
      steps: [{ nodeId: 'verify', label: 'VERIFY', actor: { kind: 'engine', ref: 'codex' }, status: 'pending', attempt: 0, at: FIXED }],
      parked: null,
      order: ['verify'],
      definitionSnapshot: def,
    }, null, 2) + '\n', 'utf8');

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 2, invocation: { input: { ticket: 'ABC-42' } } });
    expect(getRun(root, def.id, 'legacy-run')).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      parameters: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
    });

    const edited = await editPendingWorkflowStepPrompt(deps, def.id, 'legacy-run', 'verify', 'Run revised checks.', { actor: 'owner' });

    expect(edited).toMatchObject({ outcome: 'edited', run: { schemaVersion: 3, revision: 1 } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      revision: 1,
      parameters: { input: { ticket: 'ABC-42' }, idempotencyKey: 'request-42' },
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('invocation');
  });

  it('runs a two-step chain: B spawns ONLY after A settles; completed only after B settles', async () => {
    const def = createDefinition(root, chainDef('two-step', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();

    // Start: mints the durable record, dispatches ONLY step a.
    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running');
    expect(started.order).toEqual(['a', 'b']);
    expect(started.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'running'], ['b', 'pending']]);
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1]]);
    // The persisted file matches the returned snapshot.
    expect(getRun(root, 'two-step', started.runId)?.steps[0].sessionId).toBe('sess:a:1');

    // Sweep while a is still running → nothing changes, no new spawn.
    await sweepWorkflowRuns(deps);
    expect(spawnCalls).toHaveLength(1);

    // a settles → the sweep marks it done and dispatches b.
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    let run = getRun(root, 'two-step', started.runId)!;
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'done'], ['b', 'running']]);
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1], ['b', 1]]);

    // b settles → the run COMPLETES (earned terminal, endedAt set).
    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'two-step', started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.endedAt).toBe(FIXED);
  });

  it('spawns under the deterministic attempt-keyed sessionKey', async () => {
    const def = createDefinition(root, chainDef('keyed', [trigger, step('a')]), { now });
    const askedKeys: string[] = [];
    const { deps, settle } = harness();
    const probing: RunDriverDeps = {
      ...deps,
      probeStepSession: (key) => {
        askedKeys.push(key);
        return deps.probeStepSession(key);
      },
    };
    const started = await startWorkflowRun(probing, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(probing);
    expect(askedKeys.some((k) => k === `workflow-run:${started.runId}:a:1`)).toBe(true);
    expect(getRun(root, 'keyed', started.runId)?.status).toBe('completed');
  });

  it('parks mid-graph on an approval gate (downstream pending) and the sweep leaves parked runs alone', async () => {
    const def = createDefinition(root, chainDef('parky', [trigger, step('a'), approvalGate('gate'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    const examined1 = await sweepWorkflowRuns(deps);
    expect(examined1).toBe(1);

    const run = getRun(root, 'parky', started.runId)!;
    expect(run.status).toBe('parked');
    expect(run.parked).toMatchObject({ scope: 'gateNode', nodeId: 'gate' });
    expect(run.endedAt).toBeNull();
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'done'], ['gate', 'pending'], ['b', 'pending']]);
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a']); // b never spawned

    // Parked runs wait on a human — the next sweep examines nothing.
    const examined2 = await sweepWorkflowRuns(deps);
    expect(examined2).toBe(0);
    expect(spawnCalls).toHaveLength(1);
  });

  it('fails the run at start when the definition cannot compile (unknown engine, roster injected)', async () => {
    const def = createDefinition(root, chainDef('badactor', [trigger, step('a', { actor: { kind: 'engine', ref: 'ghost' } })]), { now });
    const { deps, spawnCalls } = harness();
    const run = await startWorkflowRun(deps, def, { knownEngines: ['codex'] });
    expect(run.status).toBe('failed');
    expect(run.errors?.some((e) => e.code === 'unknown-engine')).toBe(true);
    expect(spawnCalls).toHaveLength(0);
    expect(getRun(root, 'badactor', run.runId)?.status).toBe('failed'); // persisted
  });

  it('refuses a cyclic graph before persistence or start', () => {
    const cyclic = chainDef('cycly', [trigger, step('a'), step('b')]);
    cyclic.edges.push({ id: 'back', from: 'b', to: 'a', kind: 'sequence' });
    try {
      createDefinition(root, cyclic, { now });
      throw new Error('expected cyclic definition rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowStoreError);
      expect((error as WorkflowStoreError).code).toBe('validation');
      expect((error as WorkflowStoreError).errors?.some((item) => item.code === 'non-loop-cycle')).toBe(true);
    }
    expect(getDefinition(root, 'cycly')).toBeNull();
  });

  it('a failed spawn fails the run (required step) with the receipt preserved', async () => {
    const def = createDefinition(root, chainDef('boom', [trigger, step('a')]), { now });
    const { deps } = harness({
      spawnStep: async () => {
        throw new Error('engine exploded');
      },
    });
    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('failed');
    expect(run.errors?.[0]).toMatchObject({ code: 'spawn-failed', ref: 'a' });
    expect(run.steps[0].status).toBe('failed');
  });
});

describe('crash recovery — the restart story the startup sweep re-derives', () => {
  it('respawns an interrupted step ONCE (attempt 2) and completes after the retry settles', async () => {
    const def = createDefinition(root, chainDef('restarty', [trigger, step('a')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);

    // Gateway restart: recoverStaleSessions stamps the step session interrupted.
    settle(started.runId, 'a', 1, 'interrupted');
    await sweepWorkflowRuns(deps); // startup sweep equivalent
    let run = getRun(root, 'restarty', started.runId)!;
    expect(spawnCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1], ['a', 2]]);
    expect(run.steps[0]).toMatchObject({ status: 'running', attempt: 2, sessionId: 'sess:a:2' });
    expect(run.status).toBe('running'); // no duplicate under the OLD key — attempt 2 is a NEW key

    // A second interruption exhausts respawn-once → failed.
    settle(started.runId, 'a', 2, 'interrupted');
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'restarty', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.errors?.[0].code).toBe('step-interrupted');
    expect(spawnCalls).toHaveLength(2); // never a third spawn
  });

  it('ADOPTS an existing session for a dispatching receipt (crash after spawn) — no duplicate spawn', async () => {
    const def = createDefinition(root, chainDef('adopty', [trigger, step('a')]), { now });
    const { deps, sessions, spawnCalls } = harness();
    // Hand-persist the crash state: intent minted (dispatching, attempt 1), spawn already
    // happened (session exists under the deterministic key), markRunning never persisted.
    const started = await startWorkflowRun(deps, def);
    const crashed = markDispatching({ ...getRun(root, 'adopty', started.runId)!, steps: getRun(root, 'adopty', started.runId)!.steps.map((s) => ({ ...s, status: 'pending' as const, sessionId: undefined })) }, 'a', 1, now);
    saveRun(root, crashed);
    sessions.set(stepSessionKey(started.runId, 'a', 1), { found: true, sessionId: 'orphan-1', status: 'idle', finalAssistantText: 'orphan finished the work' });
    spawnCalls.length = 0;

    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'adopty', started.runId)!;
    expect(run.steps[0].sessionId).toBe('orphan-1'); // adopted, not respawned
    expect(run.status).toBe('completed');
    expect(spawnCalls).toHaveLength(0);
  });

  it('re-dispatches the SAME attempt for a dispatching receipt whose key was never used (crash before spawn)', async () => {
    const def = createDefinition(root, chainDef('minty', [trigger, step('a')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    // Rewind to the crash state: receipt dispatching attempt 1, session gone from the registry.
    const run = getRun(root, 'minty', started.runId)!;
    const crashed: WorkflowRun = {
      ...run,
      steps: run.steps.map((s) => ({ ...s, status: 'dispatching' as const, sessionId: undefined })),
    };
    saveRun(root, crashed);
    const { deps: freshDeps, spawnCalls: freshCalls, settle: freshSettle } = harness();
    void spawnCalls;
    void settle;

    await sweepWorkflowRuns(freshDeps);
    expect(freshCalls.map((c) => [c.nodeId, c.attempt])).toEqual([['a', 1]]); // SAME attempt
    freshSettle(started.runId, 'a', 1);
    await sweepWorkflowRuns(freshDeps);
    expect(getRun(root, 'minty', started.runId)?.status).toBe('completed');
  });

  it('closes a pre-sequential running record (no order) as failed instead of sweeping it forever', async () => {
    createDefinition(root, chainDef('legacy-wf', [trigger, step('a')]), { now });
    const legacy: WorkflowRun = {
      runId: 'run-legacy-stub', workflowId: 'legacy-wf', definitionVersion: 1, title: 'Legacy',
      trigger: { kind: 'manual' }, status: 'running', startedAt: FIXED, endedAt: null, steps: [], parked: null,
      schemaVersion: 2, // a 014a-era stub: v2 stamp but no order/receipts
    };
    saveRun(root, legacy);
    const { deps, spawnCalls } = harness();
    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'legacy-wf', 'run-legacy-stub')!;
    expect(run.status).toBe('failed');
    expect(run.errors?.[0].code).toBe('legacy-run-unrecoverable');
    expect(spawnCalls).toHaveLength(0);
  });

  it('fails a running LEGACY run (no snapshot) whose definition vanished (definition-missing)', async () => {
    const def = createDefinition(root, chainDef('ghosty', [trigger, step('a')]), { now });
    const { deps } = harness();
    const started = await startWorkflowRun(deps, def);
    // Strip the snapshot to model a pre-fix v2 record — only then is the store the
    // definition source, and its disappearance must fail the run honestly.
    const persisted = getRun(root, 'ghosty', started.runId)!;
    const { definitionSnapshot: _stripped, ...legacyShape } = persisted;
    saveRun(root, legacyShape as WorkflowRun);
    const noDef: RunDriverDeps = { ...deps, getDefinition: () => null };
    await sweepWorkflowRuns(noDef);
    const run = getRun(root, 'ghosty', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.errors?.some((e) => e.code === 'definition-missing')).toBe(true);
  });
});

describe('GRS-014c — the handoff contract flows A→B through real receipts', () => {
  it("injects A's persisted outcome + B's instructions into B's spawn prompt (the vision beat)", async () => {
    const nodes = [
      trigger,
      step('a', { instructions: 'Implement the widget feature.' }),
      step('b', {
        instructions: 'Adversarially review the implementation.',
        gates: [{ kind: 'artifact', glob: 'reports/review-*.md', description: 'a review report exists' }],
      }),
    ];
    const def = createDefinition(root, chainDef('handy', nodes), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    // A's own prompt carries ITS instructions and the handoff-block contract.
    expect(spawnCalls[0].prompt).toContain('Implement the widget feature.');
    expect(spawnCalls[0].prompt).toContain('```handoff');

    // A settles WITH a declared handoff block.
    settle(started.runId, 'a', 1, 'idle',
      'Implemented it.\n```handoff\n{ "summary": "widget implemented with tests", "artifacts": ["src/widget.ts"], "notes": "edge case: empty input" }\n```');
    await sweepWorkflowRuns(deps);

    // A's outcome is durable evidence on the receipt.
    const run = getRun(root, 'handy', started.runId)!;
    const aReceipt = run.steps.find((s) => s.nodeId === 'a')!;
    expect(aReceipt.outcome).toMatchObject({ summary: 'widget implemented with tests', extractedFrom: 'handoff-block' });

    // B's spawned prompt verifiably contains A's summary, A's artifact path,
    // B's own instructions, and B's gate description as acceptance criteria.
    const bSpawn = spawnCalls.find((c) => c.nodeId === 'b')!;
    expect(bSpawn.prompt).toContain('## Handoff from "A" (codex)');
    expect(bSpawn.prompt).toContain('widget implemented with tests');
    expect(bSpawn.prompt).toContain('- src/widget.ts');
    expect(bSpawn.prompt).toContain('edge case: empty input');
    expect(bSpawn.prompt).toContain('Adversarially review the implementation.');
    expect(bSpawn.prompt).toContain('- a review report exists');

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'handy', started.runId)?.status).toBe('completed');
  });

  it('falls back to the capped final message when A declares no handoff block', async () => {
    const def = createDefinition(root, chainDef('fally', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1, 'idle', 'Plain reply: the fix is in place, see the diff.');
    await sweepWorkflowRuns(deps);
    const aOutcome = getRun(root, 'fally', started.runId)!.steps[0].outcome!;
    expect(aOutcome.extractedFrom).toBe('final-message');
    const bSpawn = spawnCalls.find((c) => c.nodeId === 'b')!;
    expect(bSpawn.prompt).toContain('Plain reply: the fix is in place, see the diff.');
    expect(bSpawn.prompt).toContain('no declared handoff');
  });

  it('fails the run when a step session settles with no output (forced-idle guard, live path)', async () => {
    const def = createDefinition(root, chainDef('silent', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1, 'idle', null); // settled, zero assistant output
    await sweepWorkflowRuns(deps);
    const run = getRun(root, 'silent', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.errors?.[0].code).toBe('step-no-output');
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a']); // b never spawned
  });
});

describe('GRS-014b-fix (Codex finding 2) — the run executes its FROZEN definition snapshot', () => {
  it('a mid-run definition edit cannot change which actor a later step spawns', async () => {
    const def = createDefinition(root, chainDef('pinny', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    expect(started.definitionSnapshot?.version).toBe(1);

    // While A is in flight, the definition is edited: step b is reassigned to a
    // different engine (store version bumps to 2).
    const editedNodes = def.nodes.map((n) => (n.id === 'b' ? { ...n, actor: { kind: 'engine' as const, ref: 'other-engine' } } : n));
    const edited = updateDefinition(root, 'pinny', { nodes: editedNodes }, { now });
    expect(edited.version).toBe(2);

    // A settles → the sweep dispatches B — from the SNAPSHOT (codex), not the edit.
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    const bSpawn = spawnCalls.find((c) => c.nodeId === 'b');
    expect(bSpawn?.spec.actorRef).toBe('codex');
    // The run still claims — truthfully — the version it minted against.
    const run = getRun(root, 'pinny', started.runId)!;
    expect(run.definitionVersion).toBe(1);
    expect(run.definitionSnapshot?.version).toBe(1);

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'pinny', started.runId)?.status).toBe('completed');
  });

  it('a run survives its definition being deleted mid-run (the snapshot drives, not the store)', async () => {
    const def = createDefinition(root, chainDef('durably', [trigger, step('a')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    // The definition file vanishes mid-run — the snapshot keeps the run executable.
    const noStore: RunDriverDeps = {
      ...deps,
      getDefinition: () => {
        throw new Error('the sweep must not consult the store for a snapshotted run');
      },
    };
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(noStore);
    expect(getRun(root, 'durably', started.runId)?.status).toBe('completed');
  });
});

describe('concurrency + reconciler lifecycle', () => {
  it('the per-run advance lock serializes concurrent advancement (no double dispatch)', async () => {
    const def = createDefinition(root, chainDef('locky', [trigger, step('a'), step('b')]), { now });
    const { deps, spawnCalls, settle } = harness();
    // Slow spawner: makes the race window real.
    const slowDeps: RunDriverDeps = {
      ...deps,
      spawnStep: async (ctx) => {
        await new Promise((r) => setTimeout(r, 25));
        return deps.spawnStep(ctx);
      },
    };
    const started = await startWorkflowRun(slowDeps, def);
    settle(started.runId, 'a', 1);
    // Two concurrent advancement ticks race over "a is done, dispatch b".
    await Promise.all([
      advanceWorkflowRunById(slowDeps, 'locky', started.runId),
      advanceWorkflowRunById(slowDeps, 'locky', started.runId),
    ]);
    expect(spawnCalls.filter((c) => c.nodeId === 'b')).toHaveLength(1); // exactly one dispatch of b
  });

  it('startWorkflowRunReconciler sweeps immediately at startup and stops cleanly', async () => {
    const def = createDefinition(root, chainDef('booty', [trigger, step('a')]), { now });
    const { deps, spawnCalls, settle } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);

    // Long interval: only the immediate startup sweep can do the work below.
    const stop = startWorkflowRunReconciler(deps, { intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50)); // let the async startup sweep run
    stop();
    expect(getRun(root, 'booty', started.runId)?.status).toBe('completed');
    expect(spawnCalls).toHaveLength(1); // no extra spawns — just the settle observation
  });

  it('one broken run never kills the sweep for the others', async () => {
    const good = createDefinition(root, chainDef('good-wf', [trigger, step('a')]), { now });
    // A corrupt running record (missing plan node) in another workflow.
    createDefinition(root, chainDef('bad-wf', [trigger, step('x')]), { now });
    const bad: WorkflowRun = {
      schemaVersion: 2, runId: 'run-bad', workflowId: 'bad-wf', definitionVersion: 1, title: 'bad',
      trigger: { kind: 'manual' }, status: 'running', startedAt: FIXED, endedAt: null,
      steps: [{ nodeId: 'nonexistent', label: 'X', actor: null, status: 'pending', attempt: 0, at: FIXED }],
      parked: null, order: ['nonexistent'],
    };
    saveRun(root, bad);
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, good);
    settle(started.runId, 'a', 1);

    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'bad-wf', 'run-bad')?.status).toBe('failed'); // closed honestly (unknown-node)
    expect(getRun(root, 'good-wf', started.runId)?.status).toBe('completed'); // unaffected
  });
});

/* ── GRS-014e: loops + gate resolution through the REAL driver/store ─────────── */

describe('bounded loops through the driver (GRS-014e)', () => {
  function loopDef(id: string, maxRounds: number, gate?: { kind: 'artifact' | 'flag'; glob?: string; flag?: string; description: string }) {
    const d = chainDef(id, [trigger, step('a'), step('b')]);
    d.edges.push({ id: 'lp', from: 'b', to: 'a', kind: 'loop', ...(gate ? { gate } : {}) } as never);
    d.loop = { maxRoundsPerRun: maxRounds };
    return d;
  }

  it('re-executes the segment per round with per-round sessions/receipts, then completes at max rounds', async () => {
    const def = createDefinition(root, loopDef('loop-wf', 2), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    expect(started.rounds).toBe(1);

    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps); // boundary: splices round 2, dispatches a@r2 in the same drive
    let run = getRun(root, 'loop-wf', started.runId)!;
    expect(run.rounds).toBe(2);
    expect(run.steps.map((s) => [s.nodeId, s.round ?? 1, s.status])).toEqual([
      ['a', 1, 'done'], ['b', 1, 'done'], ['a', 2, 'running'], ['b', 2, 'pending'],
    ]);

    settle(started.runId, 'a', 1, 'idle', undefined, 2);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1, 'idle', undefined, 2);
    await sweepWorkflowRuns(deps);
    run = getRun(root, 'loop-wf', started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.rounds).toBe(2);
    expect(run.loopExit).toEqual({ round: 2, at: FIXED, reason: 'max-rounds' });
    // Distinct session identities per round.
    expect(spawnCalls.map((c) => `${c.nodeId}@r${c.round}`)).toEqual(['a@r1', 'b@r1', 'a@r2', 'b@r2']);
    // Every settled receipt kept its own outcome (per-iteration history).
    expect(run.steps.every((s) => s.outcome?.finalMessage)).toBe(true);
  });

  it("cross-round handoff: a@r2's prompt carries b@r1's declared outcome through the loop edge (Codex GRS-014e finding 1)", async () => {
    const def = createDefinition(root, loopDef('loop-handoff-wf', 2), { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    // Round 1 has nothing to hand a — b has not run yet.
    expect(spawnCalls[0].prompt).not.toContain('Handoffs from previous steps');

    // The review's exact live-grep scenario: settle a@r1, then b@r1 with the feedback
    // that MUST reach a's second iteration.
    settle(started.runId, 'a', 1, 'idle', 'did the work\n```handoff\n{ "summary": "A1-HANDOFF" }\n```');
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1, 'idle', 'reviewed\n```handoff\n{ "summary": "B1-FEEDBACK-MUST-REACH-A2", "artifacts": ["reports/b1-review.md"] }\n```');
    await sweepWorkflowRuns(deps); // boundary: splices round 2 + dispatches a@r2 in the same drive

    // The freshly spliced PENDING b@r2 receipt must not shadow the SETTLED b@r1 —
    // round N exists to act on round N−1's feedback.
    const a2 = spawnCalls.find((c) => c.nodeId === 'a' && c.round === 2);
    expect(a2).toBeDefined();
    expect(a2!.prompt).toContain('B1-FEEDBACK-MUST-REACH-A2');
    expect(a2!.prompt).toContain('reports/b1-review.md');

    // Same-round handoff inside round 2: b@r2 receives a@r2's outcome, never a@r1's.
    settle(started.runId, 'a', 1, 'idle', 'reworked\n```handoff\n{ "summary": "A2-HANDOFF" }\n```', 2);
    await sweepWorkflowRuns(deps);
    const b2 = spawnCalls.find((c) => c.nodeId === 'b' && c.round === 2);
    expect(b2).toBeDefined();
    expect(b2!.prompt).toContain('A2-HANDOFF');
    expect(b2!.prompt).not.toContain('A1-HANDOFF');
  });

  it("a post-loop successor receives its in-loop predecessor's FINAL round outcome", async () => {
    const d = chainDef('loop-post-wf', [trigger, step('a'), step('b'), step('c')]);
    d.edges.push({ id: 'lp', from: 'b', to: 'a', kind: 'loop' } as never);
    d.loop = { maxRoundsPerRun: 2 };
    const def = createDefinition(root, d, { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    for (const round of [1, 2]) {
      settle(started.runId, 'a', 1, 'idle', undefined, round);
      await sweepWorkflowRuns(deps);
      settle(started.runId, 'b', 1, 'idle', `b done\n\`\`\`handoff\n{ "summary": "B-ROUND-${round}-RESULT" }\n\`\`\``, round);
      await sweepWorkflowRuns(deps);
    }
    // The loop exhausted gate-less at max rounds → c dispatched with b's LAST word.
    const c1 = spawnCalls.find((c) => c.nodeId === 'c');
    expect(c1).toBeDefined();
    expect(c1!.prompt).toContain('B-ROUND-2-RESULT');
    expect(c1!.prompt).not.toContain('B-ROUND-1-RESULT');
  });

  it('a gated loop that never passes FAILS with loop-exhausted and rounds === maxRoundsPerRun', async () => {
    const def = createDefinition(root, loopDef('loop-fail-wf', 2, { kind: 'flag', flag: 'never', description: 'never passes' }), { now });
    const { deps, settle } = harness({ evaluateGate: () => false });

    const started = await startWorkflowRun(deps, def);
    for (const round of [1, 2]) {
      settle(started.runId, 'a', 1, 'idle', undefined, round);
      await sweepWorkflowRuns(deps);
      settle(started.runId, 'b', 1, 'idle', undefined, round);
      await sweepWorkflowRuns(deps);
    }
    const run = getRun(root, 'loop-fail-wf', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.rounds).toBe(2);
    expect(run.errors?.map((e) => e.code)).toContain('loop-exhausted');
  });

  it('the exit gate short-circuits through the injected evaluator', async () => {
    const def = createDefinition(root, loopDef('loop-exit-wf', 5, { kind: 'flag', flag: 'ok', description: 'reviewer happy' }), { now });
    let calls = 0;
    const { deps, settle, spawnCalls } = harness({ evaluateGate: () => ++calls >= 2 });

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps); // gate false → round 2
    settle(started.runId, 'a', 1, 'idle', undefined, 2);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'b', 1, 'idle', undefined, 2);
    await sweepWorkflowRuns(deps); // gate true → exit + complete

    const run = getRun(root, 'loop-exit-wf', started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.rounds).toBe(2);
    expect(run.loopExit?.reason).toBe('gate-passed');
    expect(spawnCalls).toHaveLength(4);
  });

  it("branches a plan → implement → verify loop on the verifier's declared handoff field", async () => {
    const d = chainDef('loop-verifier-field', [
      trigger,
      step('plan', { instructions: 'Plan once.' }),
      step('implement', { instructions: 'Implement the plan or reviewer feedback.' }),
      step('verify', { instructions: 'Verify the implementation.' }),
    ]);
    d.edges.push({
      id: 'lp',
      from: 'verify',
      to: 'implement',
      kind: 'loop',
      when: [{ path: 'steps.verify.outcome.fields.approved', op: 'eq', value: true }],
    } as never);
    d.loop = { maxRoundsPerRun: 3 };
    const def = createDefinition(root, d, { now });
    const { deps, spawnCalls, settle } = harness();

    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running');
    settle(started.runId, 'plan', 1);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'implement', 1);
    await sweepWorkflowRuns(deps);

    const verify1 = spawnCalls.find((call) => call.nodeId === 'verify' && call.round === 1)!;
    expect(verify1.prompt).toContain('"approved"');
    settle(started.runId, 'verify', 1, 'idle',
      'needs revision\n```handoff\n{ "summary": "retry", "fields": { "approved": false } }\n```');
    await sweepWorkflowRuns(deps);

    let run = getRun(root, def.id, started.runId)!;
    expect(run.rounds).toBe(2);
    expect(run.loopExit).toBeUndefined();
    expect(spawnCalls.map((call) => `${call.nodeId}@r${call.round}`)).toEqual([
      'plan@r1', 'implement@r1', 'verify@r1', 'implement@r2',
    ]);

    settle(started.runId, 'implement', 1, 'idle', undefined, 2);
    await sweepWorkflowRuns(deps);
    settle(started.runId, 'verify', 1, 'idle',
      'approved\n```handoff\n{ "summary": "ship", "fields": { "approved": true } }\n```', 2);
    await sweepWorkflowRuns(deps);

    run = getRun(root, def.id, started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.rounds).toBe(2);
    expect(run.loopExit).toEqual({ round: 2, at: FIXED, reason: 'gate-passed' });
    expect(spawnCalls.map((call) => `${call.nodeId}@r${call.round}`)).toEqual([
      'plan@r1', 'implement@r1', 'verify@r1', 'implement@r2', 'verify@r2',
    ]);
  });
});

describe('resolveWorkflowRunGate (GRS-014e) — the only unpark', () => {
  function parkedDef(id: string) {
    return chainDef(id, [trigger, step('a'), approvalGate('g'), step('b')]);
  }

  it('approve unparks and DRIVES the run forward through the normal driver path', async () => {
    const def = createDefinition(root, parkedDef('resolve-wf'), { now });
    const { deps, settle, spawnCalls } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    let run = getRun(root, 'resolve-wf', started.runId)!;
    expect(run.status).toBe('parked');
    expect(spawnCalls).toHaveLength(1); // b never spawned while parked

    const result = await resolveWorkflowRunGate(deps, 'resolve-wf', started.runId, 'approve');
    expect(result.outcome).toBe('resolved');
    run = (result as { run: typeof run }).run;
    // Approval settled the gate receipt AND the drive dispatched b immediately.
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'done'], ['g', 'checkpoint'], ['b', 'running']]);
    expect(run.steps[1].detail).toBe('approved by operator');
    expect(spawnCalls).toHaveLength(2);

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'resolve-wf', started.runId)!.status).toBe('completed');
  });

  it('reject fails the run terminally with the operator-rejection receipt; nothing further spawns', async () => {
    const def = createDefinition(root, parkedDef('reject-wf'), { now });
    const { deps, settle, spawnCalls } = harness();
    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);

    const result = await resolveWorkflowRunGate(deps, 'reject-wf', started.runId, 'reject');
    expect(result.outcome).toBe('resolved');
    const run = getRun(root, 'reject-wf', started.runId)!;
    expect(run.status).toBe('failed');
    expect(run.errors?.map((e) => e.code)).toContain('gate-rejected');
    expect(run.steps.find((s) => s.nodeId === 'g')!.detail).toBe('rejected by operator');
    expect(run.steps.find((s) => s.nodeId === 'b')!.status).toBe('pending'); // honest partial history
    expect(spawnCalls).toHaveLength(1);

    // A later sweep never resurrects a failed run.
    await sweepWorkflowRuns(deps);
    expect(getRun(root, 'reject-wf', started.runId)!.status).toBe('failed');
  });

  it('404s an unknown run and 409-shapes a non-parked run', async () => {
    const def = createDefinition(root, chainDef('np-wf', [trigger, step('a')]), { now });
    const { deps } = harness();
    expect((await resolveWorkflowRunGate(deps, 'np-wf', 'run-nope', 'approve')).outcome).toBe('not-found');

    const started = await startWorkflowRun(deps, def);
    const result = await resolveWorkflowRunGate(deps, 'np-wf', started.runId, 'approve');
    expect(result.outcome).toBe('not-parked');
    expect((result as { run: { status: string } }).run.status).toBe('running');
  });
});

describe('cancelWorkflowRun — native cancellation authority', () => {
  function parallelDef(id: string): EditableWorkflowDefinition {
    return {
      ...chainDef(id, [trigger, step('a'), step('b')]),
      concurrency: 2,
      edges: [
        { id: 'e-a', from: 'trg', to: 'a', kind: 'sequence' },
        { id: 'e-b', from: 'trg', to: 'b', kind: 'sequence' },
      ],
    };
  }

  function reportingHarness(reportMode: 'resume' | 'silent') {
    const claims = new Map<string, Parameters<WorkflowReportingContext['claimDelivery']>[0]>();
    const deliveries: string[] = [];
    const blocks: Array<{ sessionId: string; status: string }> = [];
    const reporting: WorkflowReportingContext = {
      sessionExists: () => true,
      applyBlock: (sessionId, envelope) => {
        blocks.push({ sessionId, status: envelope.block.status ?? '' });
      },
      claimDelivery: (input) => {
        const existing = claims.get(input.sourceAttempt);
        claims.set(input.sourceAttempt, existing ?? input);
        return {
          claimed: !existing,
          delivery: {
            ...(existing ?? input),
            id: `delivery-${input.sourceAttempt}`,
            status: existing ? 'accepted' : 'pending',
            messageId: existing ? 'message-1' : null,
            queueItemId: existing ? 'queue-1' : null,
            attemptCount: existing ? 1 : 0,
            nextAttemptAt: null,
            lastAttemptAt: null,
            lastError: null,
            deadLetteredAt: null,
            createdAt: FIXED,
            acceptedAt: existing ? FIXED : null,
          },
        };
      },
      deliverClaimed: async (deliveryId) => {
        deliveries.push(deliveryId);
        return 'accepted';
      },
    };
    return { reporting, claims, deliveries, blocks, reportMode };
  }

  it('stamps intent, stops every fresh run-owned phase, drains to cancelled, and reports once', async () => {
    const def = createDefinition(root, parallelDef('cancel-fresh'), { now });
    const stopStepSession = vi.fn<NonNullable<RunDriverDeps['stopStepSession']>>(async () => undefined);
    const report = reportingHarness('resume');
    const { deps, settle } = harness({ stopStepSession, reporting: report.reporting });
    const started = await startWorkflowRun(deps, def, {
      invocation: { sessionId: 'invoking-session', reportMode: report.reportMode },
    });
    expect(started.steps.filter((receipt) => receipt.status === 'running')).toHaveLength(2);

    const requested = await cancelWorkflowRun(deps, def.id, started.runId, {
      actor: 'release-manager',
      reason: 'superseded',
    });

    expect(requested).toMatchObject({
      outcome: 'cancelled',
      run: {
        status: 'running',
        cancellation: {
          requestedAt: FIXED,
          requestedBy: 'release-manager',
          reason: 'superseded',
        },
        stopping: { to: 'cancelled' },
      },
    });
    expect(stopStepSession).toHaveBeenCalledTimes(2);
    expect(stopStepSession.mock.calls.map(([stop]) => stop.sessionKey).sort()).toEqual([
      stepSessionKey(started.runId, 'a', 1, 1),
      stepSessionKey(started.runId, 'b', 1, 1),
    ]);

    settle(started.runId, 'a', 1, 'interrupted');
    settle(started.runId, 'b', 1, 'interrupted');
    await sweepWorkflowRuns(deps);
    const terminal = getRun(root, def.id, started.runId)!;
    expect(terminal.status).toBe('cancelled');
    expect(terminal.reportEpisodes?.filter((episode) => episode.outcome === 'cancelled')).toHaveLength(1);
    expect([...report.claims.values()].filter((claim) => claim.sourceOutcome === 'cancelled')).toHaveLength(1);
    await Promise.resolve();
    expect(report.deliveries).toHaveLength(1);

    const duplicate = await cancelWorkflowRun(deps, def.id, started.runId, {
      actor: 'release-manager',
      reason: 'superseded',
    });
    expect(duplicate).toEqual({ outcome: 'cancelled', run: terminal });
    expect(stopStepSession).toHaveBeenCalledTimes(2);
    expect([...report.claims.values()].filter((claim) => claim.sourceOutcome === 'cancelled')).toHaveLength(1);
    expect(report.deliveries).toHaveLength(1);
  });

  it('stops the shared run-owned Session but never an existing borrowed Session', async () => {
    const shared = createDefinition(root, chainDef('cancel-shared', [
      trigger,
      step('shared', { options: { session: { mode: 'workflow' } } }),
    ]), { now });
    const stopStepSession = vi.fn<NonNullable<RunDriverDeps['stopStepSession']>>(async () => undefined);
    let sharedSessionId = '';
    const deps: RunDriverDeps = {
      root,
      getDefinition,
      probeStepSession: (key) => key === sharedSessionKey('run-shared') && sharedSessionId
        ? { found: true, sessionId: sharedSessionId, status: 'running' }
        : { found: false },
      probeSessionTurn: ({ sessionId }) => ({ found: true, status: 'running', markerPosted: sessionId === sharedSessionId }),
      postStepFollowUp: async () => ({ outcome: 'posted', sessionId: sharedSessionId }),
      spawnStep: async () => {
        sharedSessionId = 'session-shared';
        return { sessionId: sharedSessionId };
      },
      sessionExists: () => true,
      stopStepSession,
      now,
    };
    const started = await startWorkflowRun(deps, shared, { makeRunId: () => 'run-shared' });
    await cancelWorkflowRun(deps, shared.id, started.runId, { actor: 'operator' });
    expect(stopStepSession).toHaveBeenCalledOnce();
    expect(stopStepSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: sharedSessionId,
      sessionKey: sharedSessionKey(started.runId),
    }));

    const borrowed = createDefinition(root, chainDef('cancel-borrowed', [
      trigger,
      step('borrowed', { options: { session: { mode: 'existing', sessionId: 'session-external' } } }),
    ]), { now });
    const borrowedStop = vi.fn<NonNullable<RunDriverDeps['stopStepSession']>>(async () => undefined);
    let borrowedTurnRunning = false;
    const borrowedDeps: RunDriverDeps = {
      ...deps,
      probeSessionTurn: () => ({
        found: true,
        status: borrowedTurnRunning ? 'running' : 'idle',
        markerPosted: borrowedTurnRunning,
      }),
      postStepFollowUp: async () => {
        borrowedTurnRunning = true;
        return { outcome: 'posted', sessionId: 'session-external' };
      },
      sessionExists: (id) => id === 'session-external',
      stopStepSession: borrowedStop,
    };
    const borrowedRun = await startWorkflowRun(borrowedDeps, borrowed);
    await cancelWorkflowRun(borrowedDeps, borrowed.id, borrowedRun.runId, { actor: 'operator' });
    expect(borrowedStop).not.toHaveBeenCalled();
  });

  it('cancels a parked run immediately, rejects completed/failed, and conflicts on changed duplicate intent', async () => {
    const parkedDef = createDefinition(root, chainDef('cancel-parked', [trigger, step('a'), approvalGate('g')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, parkedDef);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    expect(getRun(root, parkedDef.id, started.runId)?.status).toBe('parked');

    const parked = await cancelWorkflowRun(deps, parkedDef.id, started.runId, { actor: 'operator' });
    expect(parked).toMatchObject({ outcome: 'cancelled', run: { status: 'cancelled', parked: null } });
    const changed = await cancelWorkflowRun(deps, parkedDef.id, started.runId, {
      actor: 'operator',
      reason: 'different intent',
    });
    expect(changed).toMatchObject({ outcome: 'conflict', run: { status: 'cancelled' } });

    const completedDef = createDefinition(root, chainDef('cancel-completed', [trigger]), { now });
    const completed = await startWorkflowRun(deps, completedDef);
    expect((await cancelWorkflowRun(deps, completedDef.id, completed.runId, { actor: 'operator' })).outcome).toBe('already-terminal');

    const failedDef = createDefinition(root, chainDef('cancel-failed', [trigger, step('a')]), { now });
    const failedHarness = harness({ spawnStep: async () => { throw new Error('failed'); } });
    const failed = await startWorkflowRun(failedHarness.deps, failedDef);
    expect((await cancelWorkflowRun(failedHarness.deps, failedDef.id, failed.runId, { actor: 'operator' })).outcome).toBe('already-terminal');
  });

  it('persists bounded stop-failure evidence without resurrecting the cancelled terminal', async () => {
    const def = createDefinition(root, chainDef('cancel-stop-failure', [trigger, step('a')]), { now });
    const stopStepSession = vi.fn<NonNullable<RunDriverDeps['stopStepSession']>>(async () => { throw new Error('engine stop failed'); });
    const { deps, settle } = harness({ stopStepSession });
    const started = await startWorkflowRun(deps, def);

    const requested = await cancelWorkflowRun(deps, def.id, started.runId, { actor: 'operator' });
    expect(requested).toMatchObject({
      outcome: 'cancelled',
      run: {
        status: 'running',
        stopping: { errors: expect.arrayContaining([expect.objectContaining({ code: 'run-cancel-stop-failed', ref: 'a' })]) },
      },
    });
    settle(started.runId, 'a', 1, 'interrupted');
    await sweepWorkflowRuns(deps);
    const terminal = getRun(root, def.id, started.runId)!;
    expect(terminal.status).toBe('cancelled');
    expect(terminal.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'run-cancel-stop-failed',
      message: expect.stringContaining('engine stop failed'),
    })]));
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, started.runId)?.status).toBe('cancelled');
  });

  it('serializes cancellation with a racing settle and keeps one terminal episode', async () => {
    const def = createDefinition(root, chainDef('cancel-race', [trigger, step('a')]), { now });
    const report = reportingHarness('resume');
    let releaseStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    const { deps, settle } = harness({
      reporting: report.reporting,
      stopStepSession: async () => {
        markStopEntered();
        await stopStarted;
      },
    });
    const started = await startWorkflowRun(deps, def, {
      invocation: { sessionId: 'invoking-session', reportMode: report.reportMode },
    });
    const cancellation = cancelWorkflowRun(deps, def.id, started.runId, { actor: 'operator' });
    await stopEntered;
    settle(started.runId, 'a', 1, 'interrupted');
    const duplicate = cancelWorkflowRun(deps, def.id, started.runId, { actor: 'operator' });
    const conflicting = cancelWorkflowRun(deps, def.id, started.runId, { actor: 'operator', reason: 'changed' });
    const racingSettle = advanceWorkflowRunById(deps, def.id, started.runId);
    releaseStop();
    const [, duplicateResult, conflictingResult] = await Promise.all([
      cancellation,
      duplicate,
      conflicting,
      racingSettle,
    ]);

    const terminal = getRun(root, def.id, started.runId)!;
    expect(duplicateResult.outcome).toBe('cancelled');
    expect(conflictingResult.outcome).toBe('conflict');
    expect(terminal.status).toBe('cancelled');
    expect(terminal.reportEpisodes?.filter((episode) => episode.outcome === 'cancelled')).toHaveLength(1);
    expect([...report.claims.values()].filter((claim) => claim.sourceOutcome === 'cancelled')).toHaveLength(1);
    await Promise.resolve();
    expect(report.deliveries).toHaveLength(1);
  });

  it('silent mode still projects cancellation activity but never claims or delivers a report', async () => {
    const def = createDefinition(root, chainDef('cancel-silent', [trigger, step('a')]), { now });
    const report = reportingHarness('silent');
    const { deps, settle } = harness({
      reporting: report.reporting,
      stopStepSession: async () => undefined,
    });
    const started = await startWorkflowRun(deps, def, {
      invocation: { sessionId: 'invoking-session', reportMode: report.reportMode },
    });
    await cancelWorkflowRun(deps, def.id, started.runId, { actor: 'operator' });
    settle(started.runId, 'a', 1, 'interrupted');
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, started.runId)?.status).toBe('cancelled');
    expect(report.blocks.some((block) => block.status === 'error')).toBe(true);
    expect(report.claims.size).toBe(0);
    expect(report.deliveries).toHaveLength(0);
  });
});
