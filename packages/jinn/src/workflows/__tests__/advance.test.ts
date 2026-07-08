import { describe, it, expect } from 'vitest';
import {
  advanceRun,
  markDispatching,
  markRunning,
  markSpawnFailure,
  mintSequentialRun,
  resolveParkedGate,
  stepSessionKey,
  type AdvanceOptions,
  type StepSessionProbe,
} from '../advance.js';
import { impliedExecutionOrder } from '../order.js';
import { resolveExecutionPlan, type ExecutionPlan } from '../execution-plan.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
  type WorkflowEdge,
} from '../definition.js';
import type { WorkflowRun } from '../run-store.js';

const FIXED = '2026-07-04T18:00:00.000Z';
const now = () => FIXED;

/* ── Fixture builders ───────────────────────────────────────────────────────── */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};

function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}

function approvalGate(id: string): WorkflowNode {
  return { id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: 'ap' } };
}

function artifactGate(id: string): WorkflowNode {
  return { id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'artifact', glob: 'reports/*.md', description: 'has report' } };
}

/** Chain nodes with sequence edges in declaration order. */
function chain(nodes: WorkflowNode[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  const edges: WorkflowEdge[] = nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const }));
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'wf', title: 'WF', version: 4, status: 'active', nodes, edges, ...over,
  };
}

function plan(def: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(def);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

/** Mint a fresh sequential run for a def, asserting success. */
function mint(def: EditableWorkflowDefinition, runId = 'run-fixed'): { run: WorkflowRun; p: ExecutionPlan } {
  const p = plan(def);
  const minted = mintSequentialRun(p, impliedExecutionOrder(def), runId, now);
  if (!minted.ok) throw new Error(`fixture failed to mint: ${JSON.stringify(minted.errors)}`);
  return { run: minted.run, p };
}

/** Probe stub over a mutable map keyed by sessionKey. Records the keys it was asked. */
function probeMap(entries: Record<string, StepSessionProbe> = {}) {
  const map = new Map(Object.entries(entries));
  const asked: string[] = [];
  const probe = (key: string): StepSessionProbe => {
    asked.push(key);
    return map.get(key) ?? { found: false };
  };
  return { probe, map, asked };
}

/* ── Minting ────────────────────────────────────────────────────────────────── */

describe('mintSequentialRun', () => {
  it('mints pending receipts in edge-implied topo order (trigger excluded) with attempt 0', () => {
    const def = chain([trigger, step('a'), artifactGate('g'), step('b', { actor: undefined })]);
    const { run } = mint(def);
    expect(run.schemaVersion).toBe(2);
    expect(run.status).toBe('running');
    expect(run.order).toEqual(['a', 'g', 'b']);
    expect(run.steps.map((s) => [s.nodeId, s.status, s.attempt])).toEqual([
      ['a', 'pending', 0],
      ['g', 'pending', 0],
      ['b', 'pending', 0],
    ]);
    expect(run.steps[0].actor).toEqual({ kind: 'engine', ref: 'codex' });
    expect(run.steps[1].actor).toBeNull(); // gate node
    expect(run.steps[2].actor).toBeNull(); // actorless step
    expect(run.endedAt).toBeNull();
  });

  it('materializes receipts in TOPO order when edges contradict declaration order', () => {
    // Declared [trg, a, b] but wired trg→b→a — the run must commit to [b, a].
    const def = chain([trigger, step('a'), step('b')]);
    def.edges = [
      { id: 'e0', from: 'trg', to: 'b', kind: 'sequence' },
      { id: 'e1', from: 'b', to: 'a', kind: 'sequence' },
    ];
    const { run } = mint(def);
    expect(run.order).toEqual(['b', 'a']);
    expect(run.steps.map((s) => s.nodeId)).toEqual(['b', 'a']);
    expect(run.orderWarning).toBeUndefined(); // v2 executes edges; nothing to warn about
  });

  it('refuses a cyclic graph (unsupported-cycle) until GRS-014e loops', () => {
    const def = chain([trigger, step('a'), step('b')]);
    def.edges = [
      { id: 'e0', from: 'trg', to: 'a', kind: 'sequence' },
      { id: 'e1', from: 'a', to: 'b', kind: 'sequence' },
      { id: 'e2', from: 'b', to: 'a', kind: 'sequence' },
    ];
    const p = plan(def);
    const minted = mintSequentialRun(p, impliedExecutionOrder(def), 'run-x', now);
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.errors[0].code).toBe('unsupported-cycle');
  });

  it('enforces the maxNodes cap', () => {
    const def = chain([trigger, step('a'), step('b')]);
    const p = plan(def);
    const minted = mintSequentialRun(p, impliedExecutionOrder(def), 'run-x', now, { maxNodes: 2 });
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.errors[0].code).toBe('max-nodes-exceeded');
  });
});

/* ── Advancement: dispatch + pass-throughs ──────────────────────────────────── */

describe('advanceRun — sequential dispatch', () => {
  it('dispatches ONLY the first actor step of a fresh run', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const { probe } = probeMap();
    const r = advanceRun(run, p, probe, now);
    expect(r.dispatch).toEqual({ nodeId: 'a', attempt: 1, round: 1 });
    // b stays pending — sequential engine, one step in flight at a time.
    expect(r.run.steps.find((s) => s.nodeId === 'b')?.status).toBe('pending');
  });

  it('settles pass-through nodes (inline + auto checkpoint) before dispatching the next actor step', () => {
    const def = chain([trigger, step('i', { actor: undefined }), artifactGate('g'), step('a')]);
    const { run, p } = mint(def);
    const { probe } = probeMap();
    const r = advanceRun(run, p, probe, now);
    expect(r.changed).toBe(true);
    expect(r.run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['i', 'inline'],
      ['g', 'checkpoint'],
      ['a', 'pending'],
    ]);
    expect(r.dispatch).toEqual({ nodeId: 'a', attempt: 1, round: 1 });
  });

  it('does nothing while the in-flight session is still running/waiting', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const dispatched = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    for (const status of ['running', 'waiting'] as const) {
      const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 's-a-1', status } });
      const r = advanceRun(dispatched, p, probe, now);
      expect(r.changed).toBe(false);
      expect(r.dispatch).toBeUndefined();
      expect(r.run.status).toBe('running');
    }
  });

  it('marks a settled (idle) session done and dispatches the NEXT step in the same pass', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const dispatched = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 's-a-1', status: 'idle', finalAssistantText: 'a is done' } });
    const r = advanceRun(dispatched, p, probe, now);
    const a = r.run.steps.find((s) => s.nodeId === 'a')!;
    expect(a.status).toBe('done');
    expect(a.settledAt).toBe(FIXED);
    expect(r.dispatch).toEqual({ nodeId: 'b', attempt: 1, round: 1 });
  });

  it('persists the extracted outcome on the receipt at settle time (GRS-014c)', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const dispatched = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    const text = 'Did the work.\n```handoff\n{ "summary": "widget shipped", "artifacts": ["src/w.ts"] }\n```';
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 's-a-1', status: 'idle', finalAssistantText: text } });
    const r = advanceRun(dispatched, p, probe, now);
    const a = r.run.steps.find((s) => s.nodeId === 'a')!;
    expect(a.status).toBe('done');
    expect(a.outcome).toMatchObject({
      sessionId: 's-a-1',
      summary: 'widget shipped',
      artifacts: ['src/w.ts'],
      extractedFrom: 'handoff-block',
    });
    expect(a.outcome?.finalMessage).toContain('Did the work.');
  });

  it('fails the run when a required step settles with NO output (forced-idle guard, GRS-014c)', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const dispatched = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    for (const finalAssistantText of [null, '', '   '] as const) {
      const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 's-a-1', status: 'idle', finalAssistantText } });
      const r = advanceRun(dispatched, p, probe, now);
      expect(r.run.status).toBe('failed');
      expect(r.run.errors?.[0].code).toBe('step-no-output');
      expect(r.run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
      expect(r.run.steps.find((s) => s.nodeId === 'b')?.status).toBe('pending');
    }
  });

  it('skips an OPTIONAL step that settles with no output and keeps advancing', () => {
    const { run, p } = mint(chain([trigger, step('a', { optional: true }), step('b')]));
    const dispatched = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 's-a-1', status: 'idle', finalAssistantText: null } });
    const r = advanceRun(dispatched, p, probe, now);
    expect(r.run.steps.find((s) => s.nodeId === 'a')?.status).toBe('skipped');
    expect(r.dispatch).toEqual({ nodeId: 'b', attempt: 1, round: 1 });
  });

  it('is a no-op on a non-running run', () => {
    const { run, p } = mint(chain([trigger, step('a')]));
    const parked = { ...run, status: 'parked' as const };
    const { probe, asked } = probeMap();
    const r = advanceRun(parked, p, probe, now);
    expect(r.changed).toBe(false);
    expect(r.dispatch).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

/* ── Advancement: failure + respawn policy ──────────────────────────────────── */

describe('advanceRun — failure and respawn-once (operator decision 2026-07-04)', () => {
  function runningAt(def: EditableWorkflowDefinition, nodeId: string, attempt: number) {
    const { run, p } = mint(def);
    const r = markRunning(markDispatching(run, nodeId, attempt, now), nodeId, { sessionId: `s-${nodeId}-${attempt}` }, now);
    return { run: r, p };
  }

  it('fails the run when a required step session ends in error (no respawn for errors)', () => {
    const { run, p } = runningAt(chain([trigger, step('a'), step('b')]), 'a', 1);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'error' } });
    const r = advanceRun(run, p, probe, now);
    expect(r.run.status).toBe('failed');
    expect(r.run.endedAt).toBe(FIXED);
    expect(r.run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
    expect(r.run.steps.find((s) => s.nodeId === 'b')?.status).toBe('pending'); // never reached
    expect(r.run.errors?.[0].code).toBe('step-errored');
    expect(r.dispatch).toBeUndefined();
  });

  it('skips an OPTIONAL step whose session errored and keeps advancing', () => {
    const { run, p } = runningAt(chain([trigger, step('a', { optional: true }), step('b')]), 'a', 1);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'error' } });
    const r = advanceRun(run, p, probe, now);
    expect(r.run.status).toBe('running');
    expect(r.run.steps.find((s) => s.nodeId === 'a')?.status).toBe('skipped');
    expect(r.dispatch).toEqual({ nodeId: 'b', attempt: 1, round: 1 });
  });

  it('respawns an interrupted step ONCE (attempt 2)', () => {
    const { run, p } = runningAt(chain([trigger, step('a')]), 'a', 1);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'interrupted' } });
    const r = advanceRun(run, p, probe, now);
    expect(r.run.status).toBe('running');
    expect(r.dispatch).toEqual({ nodeId: 'a', attempt: 2, round: 1 });
  });

  it('fails the run when attempt 2 is interrupted too (respawn-once exhausted)', () => {
    const { run, p } = runningAt(chain([trigger, step('a')]), 'a', 2);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 2)]: { found: true, status: 'interrupted' } });
    const r = advanceRun(run, p, probe, now);
    expect(r.run.status).toBe('failed');
    expect(r.run.errors?.[0].code).toBe('step-interrupted');
  });

  it('skips an OPTIONAL step whose respawn budget is exhausted', () => {
    const { run, p } = runningAt(chain([trigger, step('a', { optional: true }), step('b')]), 'a', 2);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 2)]: { found: true, status: 'interrupted' } });
    const r = advanceRun(run, p, probe, now);
    expect(r.run.steps.find((s) => s.nodeId === 'a')?.status).toBe('skipped');
    expect(r.dispatch).toEqual({ nodeId: 'b', attempt: 1, round: 1 });
  });

  it('treats a vanished session (running receipt, no session found) like an interruption', () => {
    const { run, p } = runningAt(chain([trigger, step('a')]), 'a', 1);
    const { probe } = probeMap(); // nothing found
    const r = advanceRun(run, p, probe, now);
    expect(r.dispatch).toEqual({ nodeId: 'a', attempt: 2, round: 1 });
  });
});

/* ── Advancement: mint-before-spawn recovery probe ──────────────────────────── */

describe('advanceRun — dispatching recovery (mint-before-spawn probe)', () => {
  it('ADOPTS the session when the crash landed after the spawn (key exists) and keeps resolving in the same pass', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const minted = markDispatching(run, 'a', 1, now); // persisted intent; crash before markRunning
    const { probe } = probeMap({
      [stepSessionKey('run-fixed', 'a', 1)]: { found: true, sessionId: 'adopted-1', status: 'idle', finalAssistantText: 'adopted work done' },
    });
    const r = advanceRun(minted, p, probe, now);
    const a = r.run.steps.find((s) => s.nodeId === 'a')!;
    expect(a.sessionId).toBe('adopted-1');
    expect(a.status).toBe('done'); // adopted AND already settled → resolved in one pass
    expect(r.dispatch).toEqual({ nodeId: 'b', attempt: 1, round: 1 }); // no duplicate spawn of a
  });

  it('re-dispatches the SAME attempt when the crash landed before the spawn (key unused)', () => {
    const { run, p } = mint(chain([trigger, step('a')]));
    const minted = markDispatching(run, 'a', 1, now);
    const { probe } = probeMap(); // key never used
    const r = advanceRun(minted, p, probe, now);
    expect(r.dispatch).toEqual({ nodeId: 'a', attempt: 1, round: 1 }); // same attempt — no duplicate possible
  });
});

/* ── Advancement: parking + terminals ───────────────────────────────────────── */

describe('advanceRun — mid-graph park and earned terminals', () => {
  it('parks on a mid-graph approval gate with downstream steps still pending', () => {
    const def = chain([trigger, step('a'), approvalGate('gate'), step('b')]);
    const { run, p } = mint(def);
    const afterA = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'idle', finalAssistantText: 'a settled' } });
    const r = advanceRun(afterA, p, probe, now);
    expect(r.run.status).toBe('parked');
    expect(r.run.parked).toMatchObject({ scope: 'gateNode', nodeId: 'gate', at: FIXED });
    expect(r.run.endedAt).toBeNull(); // parking is not terminal — resume is GRS-014e
    expect(r.run.steps.find((s) => s.nodeId === 'b')?.status).toBe('pending');
    expect(r.dispatch).toBeUndefined();
  });

  it('parks on a blocking runGate only after every step settled', () => {
    const def = chain([trigger, step('a')], { runGates: [{ kind: 'approval', description: 'final merge', approvalRef: 'ship' }] });
    const { run, p } = mint(def);
    const afterA = markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now);
    const { probe } = probeMap({ [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'idle', finalAssistantText: 'a settled' } });
    const r = advanceRun(afterA, p, probe, now);
    expect(r.run.status).toBe('parked');
    expect(r.run.parked?.scope).toBe('runGate');
  });

  it('completes ONLY when the last step session settled (the earned green)', () => {
    const { run, p } = mint(chain([trigger, step('a'), step('b')]));
    const afterBoth = markRunning(
      markDispatching(
        markRunning(markDispatching(run, 'a', 1, now), 'a', { sessionId: 's-a-1' }, now),
        'b', 1, now,
      ),
      'b', { sessionId: 's-b-1' }, now,
    );
    // a settled, b still running → NOT completed.
    const inFlight = probeMap({
      [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'idle', finalAssistantText: 'a settled' },
      [stepSessionKey('run-fixed', 'b', 1)]: { found: true, status: 'running' },
    });
    const mid = advanceRun(afterBoth, p, inFlight.probe, now);
    expect(mid.run.status).toBe('running');
    // b settles → completed with endedAt.
    const settled = probeMap({
      [stepSessionKey('run-fixed', 'a', 1)]: { found: true, status: 'idle', finalAssistantText: 'a settled' },
      [stepSessionKey('run-fixed', 'b', 1)]: { found: true, status: 'idle', finalAssistantText: 'b settled' },
    });
    const done = advanceRun(mid.run, p, settled.probe, now);
    expect(done.run.status).toBe('completed');
    expect(done.run.endedAt).toBe(FIXED);
    expect(done.run.steps.every((s) => s.status === 'done')).toBe(true);
  });
});

/* ── The sample-shaped branching fixture executes in topo order ─────────────── */

describe('advanceRun — sample-shaped branching graph (fan-out + fan-in) runs sequentially in topo order', () => {
  it('dispatches steps one at a time in the edge-implied order', () => {
    // Same topology class as the real sample-autonomy definition: a chain into a fan-out
    // (adversary → decide handoff + adversary → steer sequence) that fans back in.
    const def = chain([trigger, step('select'), step('implement'), step('adversary'), step('steer'), step('decide')]);
    def.edges = [
      { id: 'e0', from: 'trg', to: 'select', kind: 'sequence' },
      { id: 'e1', from: 'select', to: 'implement', kind: 'sequence' },
      { id: 'e2', from: 'implement', to: 'adversary', kind: 'sequence' },
      { id: 'e3', from: 'adversary', to: 'decide', kind: 'handoff' },
      { id: 'e4', from: 'adversary', to: 'steer', kind: 'sequence' },
      { id: 'e5', from: 'steer', to: 'decide', kind: 'sequence' },
    ];
    const { run, p } = mint(def);
    expect(run.order).toEqual(['select', 'implement', 'adversary', 'steer', 'decide']);

    // Drive to completion with an all-idle probe, capturing the dispatch sequence.
    const dispatches: string[] = [];
    let current = run;
    const probe = (key: string): StepSessionProbe => ({ found: true, sessionId: `s:${key}`, status: 'idle', finalAssistantText: `output of ${key}` });
    for (let guard = 0; guard < 20 && current.status === 'running'; guard++) {
      const r = advanceRun(current, p, probe, now);
      current = r.run;
      if (!r.dispatch) break;
      dispatches.push(r.dispatch.nodeId);
      current = markRunning(markDispatching(current, r.dispatch.nodeId, r.dispatch.attempt, now), r.dispatch.nodeId, { sessionId: 's' }, now);
    }
    const final = advanceRun(current, p, probe, now);
    expect(dispatches).toEqual(['select', 'implement', 'adversary', 'steer', 'decide']);
    expect(final.run.status).toBe('completed');
  });
});

/* ── Driver-side transition helpers ─────────────────────────────────────────── */

describe('transition helpers', () => {
  it('markDispatching persists the intent (status/attempt/dispatchedAt) before any spawn', () => {
    const { run } = mint(chain([trigger, step('a')]));
    const d = markDispatching(run, 'a', 2, now);
    const a = d.steps.find((s) => s.nodeId === 'a')!;
    expect(a.status).toBe('dispatching');
    expect(a.attempt).toBe(2);
    expect(a.dispatchedAt).toBe(FIXED);
    expect(a.detail).toMatch(/respawn \(attempt 2\)/);
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('pending'); // input untouched
  });

  it('markSpawnFailure fails the run for a required step and skips an optional one', () => {
    const requiredDef = chain([trigger, step('a')]);
    const { run: r1, p: p1 } = mint(requiredDef);
    const failed = markSpawnFailure(markDispatching(r1, 'a', 1, now), p1, 'a', 'engine exploded', now);
    expect(failed.status).toBe('failed');
    expect(failed.errors?.[0]).toMatchObject({ code: 'spawn-failed', ref: 'a' });

    const optionalDef = chain([trigger, step('a', { optional: true }), step('b')]);
    const { run: r2, p: p2 } = mint(optionalDef);
    const skipped = markSpawnFailure(markDispatching(r2, 'a', 1, now), p2, 'a', 'engine exploded', now);
    expect(skipped.status).toBe('running');
    expect(skipped.steps.find((s) => s.nodeId === 'a')?.status).toBe('skipped');
  });
});

/* ── GRS-014e: bounded loops ────────────────────────────────────────────────── */

/** trigger→a→b (+tail) with a loop back-edge b→a. */
function loopDef(
  maxRounds: number | undefined,
  gate?: { kind: 'artifact' | 'flag'; glob?: string; flag?: string; description: string },
  tail: WorkflowNode[] = [],
): EditableWorkflowDefinition {
  const def = chain([trigger, step('a'), step('b'), ...tail]);
  def.edges.push({ id: 'lp', from: 'b', to: 'a', kind: 'loop', ...(gate ? { gate } : {}) });
  if (maxRounds !== undefined) def.loop = { maxRoundsPerRun: maxRounds };
  return def;
}

/**
 * Mini-driver: advance → execute the (single) dispatch with a stub spawn → settle the
 * in-flight session as idle-with-output → re-advance, until the run leaves `running`
 * or quiesces. Mirrors driveRunLocked minus persistence.
 */
function driveToTerminal(def: EditableWorkflowDefinition, opts: AdvanceOptions = {}) {
  const { run: minted, p } = mint(def);
  const { probe, map } = probeMap();
  let run = minted;
  const spawnedKeys: string[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const r = advanceRun(run, p, probe, now, opts);
    run = r.run;
    if (run.status !== 'running') return { run, spawnedKeys, p };
    if (r.dispatch) {
      const { nodeId, attempt, round } = r.dispatch;
      run = markDispatching(run, nodeId, attempt, now, round);
      const key = stepSessionKey(run.runId, nodeId, attempt, round);
      spawnedKeys.push(key);
      map.set(key, { found: true, sessionId: `sess-${key}`, status: 'running' });
      run = markRunning(run, nodeId, { sessionId: `sess-${key}` }, now, round);
      continue;
    }
    if (r.changed) continue; // boundary settle / loop splice / exit stamp — re-plan (mirrors driveRunLocked)
    // quiescent in flight — settle the running receipt's session with output
    const inFlight = run.steps.find((s) => s.status === 'running');
    if (!inFlight) return { run, spawnedKeys, p }; // truly stuck (should not happen)
    const key = stepSessionKey(run.runId, inFlight.nodeId, inFlight.attempt ?? 1, inFlight.round ?? 1);
    map.set(key, { found: true, sessionId: `sess-${key}`, status: 'idle', finalAssistantText: `output of ${key}` });
  }
  throw new Error('driveToTerminal guard exceeded');
}

describe('advanceRun — bounded loops (GRS-014e)', () => {
  it('a gate-less loop runs EXACTLY maxRoundsPerRun rounds then completes (max-rounds is the declared count, not a failure)', () => {
    const { run, spawnedKeys } = driveToTerminal(loopDef(3));
    expect(run.status).toBe('completed');
    expect(run.rounds).toBe(3);
    expect(run.loopExit).toEqual({ round: 3, at: FIXED, reason: 'max-rounds' });
    // Per-round receipts, spliced IN PLACE: array order is execution order.
    expect(run.steps.map((s) => [s.nodeId, s.round ?? 1, s.status])).toEqual([
      ['a', 1, 'done'], ['b', 1, 'done'],
      ['a', 2, 'done'], ['b', 2, 'done'],
      ['a', 3, 'done'], ['b', 3, 'done'],
    ]);
    // Every receipt has its own outcome (honest per-iteration history).
    expect(run.steps.every((s) => s.outcome?.finalMessage)).toBe(true);
    // Session identity: round 1 keeps the 014b key shape; rounds ≥ 2 gain r<round>.
    expect(spawnedKeys).toEqual([
      'workflow-run:run-fixed:a:1', 'workflow-run:run-fixed:b:1',
      'workflow-run:run-fixed:a:r2:1', 'workflow-run:run-fixed:b:r2:1',
      'workflow-run:run-fixed:a:r3:1', 'workflow-run:run-fixed:b:r3:1',
    ]);
  });

  it('the exit gate short-circuits the loop: pass on round 2 → loopExit(gate-passed), rounds stays 2, run completes', () => {
    let evaluations = 0;
    const evaluateGate = () => {
      evaluations++;
      return evaluations >= 2; // round 1: not yet; round 2: passed
    };
    const { run } = driveToTerminal(loopDef(5, { kind: 'flag', flag: 'reviewer-happy', description: 'reviewer approved' }), { evaluateGate });
    expect(run.status).toBe('completed');
    expect(run.rounds).toBe(2);
    expect(run.loopExit).toEqual({ round: 2, at: FIXED, reason: 'gate-passed' });
    expect(run.steps.map((s) => [s.nodeId, s.round ?? 1])).toEqual([
      ['a', 1], ['b', 1], ['a', 2], ['b', 2],
    ]);
  });

  it('a GATED loop that exhausts its rounds FAILS honestly (loop-exhausted) with rounds === maxRoundsPerRun', () => {
    const { run } = driveToTerminal(loopDef(2, { kind: 'flag', flag: 'never', description: 'never passes' }), { evaluateGate: () => false });
    expect(run.status).toBe('failed');
    expect(run.rounds).toBe(2); // the acceptance evidence
    expect(run.errors?.map((e) => e.code)).toContain('loop-exhausted');
    expect(run.loopExit).toBeUndefined(); // it never exited — it ran out
    // Both rounds ran to completion before the exhaustion verdict.
    expect(run.steps.filter((s) => s.nodeId === 'b')).toHaveLength(2);
  });

  it('nodes AFTER the loop source dispatch only after the loop exits', () => {
    const { run, spawnedKeys } = driveToTerminal(loopDef(2, undefined, [step('c')]));
    expect(run.status).toBe('completed');
    // c spawns exactly once, LAST — never between rounds.
    expect(spawnedKeys.filter((k) => k.includes(':c:'))).toEqual(['workflow-run:run-fixed:c:1']);
    expect(spawnedKeys[spawnedKeys.length - 1]).toBe('workflow-run:run-fixed:c:1');
    expect(run.steps.map((s) => `${s.nodeId}@${s.round ?? 1}`)).toEqual(['a@1', 'b@1', 'a@2', 'b@2', 'c@1']);
  });

  it('a stamped loopExit is durable: evidence disappearing later never re-opens the loop', () => {
    // Gate passes on round 1 → loopExit stamped; later passes with the gate now
    // returning FALSE must not splice new rounds.
    const def = loopDef(5, { kind: 'flag', flag: 'ok', description: 'ok' }, [step('c')]);
    const { run: minted, p } = mint(def);
    const { probe, map } = probeMap();
    let run = minted;
    // Hand-settle round 1 (a and b done with outcomes) — the boundary is reached.
    run = {
      ...run,
      steps: run.steps.map((r) =>
        r.nodeId === 'c'
          ? r
          : { ...r, status: 'done' as const, attempt: 1, outcome: { sessionId: 'x', finalMessage: 'm', extractedFrom: 'final-message' as const } }),
    };
    // Gate TRUE at the boundary → exit stamped by the pre-pass.
    let r = advanceRun(run, p, probe, now, { evaluateGate: () => true });
    run = r.run;
    expect(run.loopExit).toEqual({ round: 1, at: FIXED, reason: 'gate-passed' });
    void map;
    // Gate now FALSE (evidence vanished) — the stamped exit must hold: no new rounds,
    // the walk proceeds to the post-loop step c.
    r = advanceRun(run, p, probe, now, { evaluateGate: () => false });
    expect(r.run.rounds ?? 1).toBe(1);
    expect(r.run.steps.filter((s) => s.nodeId === 'a')).toHaveLength(1);
    expect(r.dispatch?.nodeId).toBe('c');
  });
});

/* ── GRS-014e: gate resolution (pure transitions) ───────────────────────────── */

describe('resolveParkedGate', () => {
  function parkedOnGateNode() {
    const def = chain([trigger, step('a', { actor: undefined }), approvalGate('g'), step('b', { actor: undefined })]);
    const { run: minted, p } = mint(def);
    const r = advanceRun(minted, p, () => ({ found: false }), now);
    expect(r.run.status).toBe('parked');
    expect(r.run.parked?.scope).toBe('gateNode');
    return { run: r.run, p };
  }

  it('approve on a gate NODE settles its receipt with the deciding actor and resumes; the next pass moves past it', () => {
    const { run, p } = parkedOnGateNode();
    const resolved = resolveParkedGate(run, 'approve', now, { decidedBy: 'platform-manager' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.run.status).toBe('running');
    expect(resolved.run.parked).toBeNull();
    const gateReceipt = resolved.run.steps.find((s) => s.nodeId === 'g')!;
    expect(gateReceipt.status).toBe('checkpoint');
    expect(gateReceipt.detail).toBe('approved by platform-manager');
    // The settled receipt IS the durable approval — advancing completes the run.
    const next = advanceRun(resolved.run, p, () => ({ found: false }), now);
    expect(next.run.status).toBe('completed');
  });

  it('reject fails the run with a gate-rejected error and the deciding actor in receipts', () => {
    const { run } = parkedOnGateNode();
    const resolved = resolveParkedGate(run, 'reject', now, { decidedBy: 'platform-manager' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.run.status).toBe('failed');
    expect(resolved.run.endedAt).toBe(FIXED);
    expect(resolved.run.parked).toBeNull();
    expect(resolved.run.errors?.map((e) => e.code)).toContain('gate-rejected');
    const gateReceipt = resolved.run.steps.find((s) => s.nodeId === 'g')!;
    expect(gateReceipt.status).toBe('failed');
    expect(gateReceipt.detail).toBe('rejected by platform-manager');
    expect(resolved.run.errors?.find((e) => e.code === 'gate-rejected')?.message).toContain('platform-manager rejected');
    // Downstream stayed pending — honest partial history.
    expect(resolved.run.steps.find((s) => s.nodeId === 'b')!.status).toBe('pending');
  });

  it('approve on a workflow RUN gate records the key in resolvedRunGates so the terminal check cannot re-park', () => {
    const def = chain([trigger, step('a', { actor: undefined })], {
      runGates: [{ kind: 'approval', approvalRef: 'operator-ok', description: 'operator signs off' }],
    });
    const { run: minted, p } = mint(def);
    const parked = advanceRun(minted, p, () => ({ found: false }), now);
    expect(parked.run.status).toBe('parked');
    expect(parked.run.parked?.scope).toBe('runGate');

    const resolved = resolveParkedGate(parked.run, 'approve', now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.run.resolvedRunGates).toEqual(['operator-ok']);
    const done = advanceRun(resolved.run, p, () => ({ found: false }), now);
    expect(done.run.status).toBe('completed'); // no re-park loop
  });

  it('two runGates with distinct refs park twice — each declared gate needs its OWN approval (Codex GRS-014e finding 2)', () => {
    const def = chain([trigger, step('a', { actor: undefined })], {
      runGates: [
        { kind: 'approval', approvalRef: 'ok-1', description: 'first approval' },
        { kind: 'approval', approvalRef: 'ok-2', description: 'second approval' },
      ],
    });
    const { run: minted, p } = mint(def);
    const parked1 = advanceRun(minted, p, () => ({ found: false }), now);
    expect(parked1.run.status).toBe('parked');
    expect(parked1.run.parked?.ref).toBe('ok-1');

    const approved1 = resolveParkedGate(parked1.run, 'approve', now);
    expect(approved1.ok).toBe(true);
    if (!approved1.ok) return;
    // ONE approval never satisfies both gates — the run re-parks on the second.
    const parked2 = advanceRun(approved1.run, p, () => ({ found: false }), now);
    expect(parked2.run.status).toBe('parked');
    expect(parked2.run.parked?.ref).toBe('ok-2');

    const approved2 = resolveParkedGate(parked2.run, 'approve', now);
    expect(approved2.ok).toBe(true);
    if (!approved2.ok) return;
    const done = advanceRun(approved2.run, p, () => ({ found: false }), now);
    expect(done.run.status).toBe('completed');
    expect(done.run.resolvedRunGates).toEqual(['ok-1', 'ok-2']);
  });

  it('refuses to resolve a run that is not parked', () => {
    const def = chain([trigger, step('a', { actor: undefined })]);
    const { run } = mint(def);
    const r = resolveParkedGate(run, 'approve', now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not-parked');
  });
});
