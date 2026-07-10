import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceWorkflowRunById,
  resolveWorkflowRunGate,
  startWorkflowRun,
  startWorkflowRunReconciler,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { markDispatching, stepSessionKey, type SpawnContext, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition, updateDefinition } from '../definition-store.js';
import { getRun, saveRun, type WorkflowRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
} from '../definition.js';

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
      invocation: { input, idempotencyKey: 'request-42' },
    });

    expect(started.invocation).toEqual({ input, idempotencyKey: 'request-42' });
    expect(getRun(root, def.id, started.runId)?.invocation).toEqual(started.invocation);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].prompt).toContain('## Run input (data)');
    expect(spawnCalls[0].prompt).toContain('"id": "ABC-42"');
    expect(spawnCalls[0].prompt).toContain('"preserve compatibility"');
    expect(spawnCalls[0].prompt.indexOf('## Run input (data)')).toBeLessThan(
      spawnCalls[0].prompt.indexOf('## Your task'),
    );

    // The caller cannot mutate the persisted/promoted snapshot after invocation.
    input.ticket.id = 'MUTATED';
    expect(getRun(root, def.id, started.runId)?.invocation?.input).toMatchObject({ ticket: { id: 'ABC-42' } });
    expect(spawnCalls[0].prompt).not.toContain('MUTATED');
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

  it('refuses a cyclic graph at start (unsupported-cycle)', async () => {
    const cyclic = chainDef('cycly', [trigger, step('a'), step('b')]);
    cyclic.edges.push({ id: 'back', from: 'b', to: 'a', kind: 'sequence' });
    const def = createDefinition(root, cyclic, { now });
    const { deps, spawnCalls } = harness();
    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('failed');
    expect(run.errors?.[0].code).toBe('unsupported-cycle');
    expect(spawnCalls).toHaveLength(0);
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
