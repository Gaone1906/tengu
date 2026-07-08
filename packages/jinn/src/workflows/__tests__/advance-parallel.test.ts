import { describe, it, expect } from 'vitest';
import {
  advanceRun,
  markDispatching,
  markRunning,
  markSpawnFailure,
  mintSequentialRun,
  resolveParkedGate,
  stepSessionKey,
  type DispatchIntent,
  type StepSessionProbe,
} from '../advance.js';
import { impliedExecutionOrder } from '../order.js';
import { resolveExecutionPlan, type ExecutionPlan } from '../execution-plan.js';
import {
  MAX_WORKFLOW_CONCURRENCY,
  validateDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import type { WorkflowRun } from '../run-store.js';

/**
 * GRS-016a planner suite — parallel ready-set dispatch, wait-all join, concurrency
 * arithmetic, honest drain, parked probe-only mode, and the loop×parallel boundary.
 * Sequential (concurrency-1) behavior is pinned separately by advance.test.ts and the
 * parallel-compat golden suite; everything here exercises budget > 1.
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
  return { id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: `ap-${id}` } };
}

function def(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  over: Partial<EditableWorkflowDefinition> = {},
): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over,
  };
}

const e = (from: string, to: string, kind: WorkflowEdge['kind'] = 'sequence'): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind });

/** trigger→a→(b ∥ c)→d — the canonical fan-out/fan-in diamond. */
function diamond(over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('a'), step('b'), step('c'), step('d')],
    [e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
    over,
  );
}

function plan(d: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(d);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

function mint(d: EditableWorkflowDefinition, runId = 'run-par'): { run: WorkflowRun; p: ExecutionPlan } {
  const p = plan(d);
  const minted = mintSequentialRun(p, impliedExecutionOrder(d), runId, now);
  if (!minted.ok) throw new Error(`fixture failed to mint: ${JSON.stringify(minted.errors)}`);
  return { run: minted.run, p };
}

function probeMap(entries: Record<string, StepSessionProbe> = {}) {
  const map = new Map(Object.entries(entries));
  const probe = (key: string): StepSessionProbe => map.get(key) ?? { found: false };
  const idle = (runId: string, nodeId: string, attempt = 1, round = 1, text?: string) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: 'idle', finalAssistantText: text ?? `output of ${nodeId}@r${round}` });
  };
  const running = (runId: string, nodeId: string, attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: 'running' });
  };
  const status = (runId: string, nodeId: string, s: StepSessionProbe['status'], attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: s });
  };
  return { probe, map, idle, running, status };
}

/** Execute a batch of intents the way driveRunLocked does: mark dispatching, "spawn"
 * (register running in the probe map), mark running — strictly in intent order. */
function execute(run: WorkflowRun, intents: DispatchIntent[], reg: ReturnType<typeof probeMap>): WorkflowRun {
  let current = run;
  for (const { nodeId, attempt, round } of intents) {
    current = markDispatching(current, nodeId, attempt, now, round);
    reg.running(current.runId, nodeId, attempt, round);
    current = markRunning(current, nodeId, { sessionId: `s:${stepSessionKey(current.runId, nodeId, attempt, round)}` }, now, round);
  }
  return current;
}

const receiptOf = (run: WorkflowRun, nodeId: string, round = 1) =>
  run.steps.find((s) => s.nodeId === nodeId && (s.round ?? 1) === round);

/* ── Schema: concurrency validation + plan compilation ──────────────────────── */

describe('definition concurrency (GRS-016a) — validation + plan compilation', () => {
  it('accepts 1..MAX and absence; refuses non-integers and out-of-range values', () => {
    const base = diamond();
    expect(validateDefinition(base).ok).toBe(true);
    for (const ok of [1, 2, MAX_WORKFLOW_CONCURRENCY]) {
      expect(validateDefinition({ ...base, concurrency: ok }).ok).toBe(true);
    }
    for (const bad of [0, -1, MAX_WORKFLOW_CONCURRENCY + 1, 1.5, Number.NaN, '4' as unknown as number]) {
      const r = validateDefinition({ ...base, concurrency: bad });
      expect(r.ok).toBe(false);
      expect(r.errors.map((x) => x.code)).toContain('bad-concurrency');
    }
  });

  it('compiles concurrency (absent = 1, the sequential compat default) into the plan', () => {
    expect(plan(diamond()).concurrency).toBe(1);
    expect(plan(diamond({ concurrency: 3 })).concurrency).toBe(3);
  });

  it('compiles the edge-predecessor map: trigger excluded, loop edges excluded, deduped', () => {
    const d = diamond({ concurrency: 2 });
    d.edges.push({ id: 'dup', from: 'b', to: 'd', kind: 'handoff' }); // duplicate pair, different kind
    d.edges.push({ id: 'lp', from: 'd', to: 'a', kind: 'loop' });
    d.loop = { maxRoundsPerRun: 2 };
    expect(plan(d).predecessors).toEqual({
      a: [],           // fed only by the trigger — ready at run start
      b: ['a'],
      c: ['a'],
      d: ['b', 'c'],   // deduped; the loop back-edge d→a adds nothing to a
    });
  });
});

/* ── Ready-set dispatch + wait-all join ─────────────────────────────────────── */

describe('advanceRun — ready-set multi-dispatch (budget > 1)', () => {
  it('dispatches BOTH fan-out branches in one pass, in steps[] array order', () => {
    const { run, p } = mint(diamond({ concurrency: 2 }));
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(r.run, 'a')?.status).toBe('done');
    expect(r.dispatches).toEqual([
      { nodeId: 'b', attempt: 1, round: 1 },
      { nodeId: 'c', attempt: 1, round: 1 },
    ]);
    expect(r.dispatch).toEqual(r.dispatches[0]); // the sequential alias stays honest
    expect(receiptOf(r.run, 'd')?.status).toBe('pending'); // join not ready
  });

  it('bounds the ready set by the budget and dispatches the remainder as capacity frees', () => {
    // trigger→a→(b ∥ c ∥ x), budget 2: only two branches dispatch; the third follows
    // a settle.
    const d = def(
      [trigger, step('a'), step('b'), step('c'), step('x')],
      [e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('a', 'x')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    expect(r1.dispatches.map((i) => i.nodeId)).toEqual(['b', 'c']); // array order, budget-truncated
    current = execute(r1.run, r1.dispatches, reg);

    // Both slots full → nothing new.
    expect(advanceRun(current, p, reg.probe, now).dispatches).toEqual([]);

    // b settles → one slot frees → x dispatches.
    reg.idle(current.runId, 'b');
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(r2.run, 'b')?.status).toBe('done');
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['x']);
  });

  it('wait-all join: the fan-in node dispatches only after ALL edge predecessors settled', () => {
    const { run, p } = mint(diamond({ concurrency: 2 }));
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    current = execute(r1.run, r1.dispatches, reg); // b and c both in flight

    // b settles, c still running → d must NOT dispatch.
    reg.idle(current.runId, 'b');
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(r2.run, 'b')?.status).toBe('done');
    expect(r2.dispatches).toEqual([]);
    current = r2.run;

    // c settles → d dispatches; the run completes after d settles.
    reg.idle(current.runId, 'c');
    const r3 = advanceRun(current, p, reg.probe, now);
    expect(r3.dispatches).toEqual([{ nodeId: 'd', attempt: 1, round: 1 }]);
    current = execute(r3.run, r3.dispatches, reg);
    reg.idle(current.runId, 'd');
    expect(advanceRun(current, p, reg.probe, now).run.status).toBe('completed');
  });

  it('a skipped optional branch satisfies the join (wait-all counts settled, not successful)', () => {
    const d = diamond({ concurrency: 2 });
    d.nodes = d.nodes.map((n) => (n.id === 'c' ? { ...n, optional: true } : n));
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    current = execute(r1.run, r1.dispatches, reg);
    reg.idle(current.runId, 'b');
    reg.status(current.runId, 'c', 'error'); // optional branch dies
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(r2.run, 'c')?.status).toBe('skipped');
    expect(r2.dispatches).toEqual([{ nodeId: 'd', attempt: 1, round: 1 }]);
  });
});

/* ── Honest drain (`stopping`) ──────────────────────────────────────────────── */

describe('advanceRun — honest drain: a failing branch never freezes in-flight siblings', () => {
  function bothBranchesInFlight() {
    const { run, p } = mint(diamond({ concurrency: 2 }));
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r = advanceRun(current, p, reg.probe, now);
    current = execute(r.run, r.dispatches, reg); // b and c in flight
    return { current, p, reg };
  }

  it('required branch error with a sibling in flight → stopping (status stays running), no terminal yet', () => {
    const { current, p, reg } = bothBranchesInFlight();
    reg.status(current.runId, 'b', 'error');
    const r = advanceRun(current, p, reg.probe, now);
    expect(r.run.status).toBe('running'); // NOT failed — c is still live
    expect(r.run.endedAt).toBeNull();
    expect(r.run.stopping).toMatchObject({ to: 'failed', at: FIXED });
    expect(r.run.stopping?.errors.map((x) => x.code)).toEqual(['step-errored']);
    expect(receiptOf(r.run, 'b')?.status).toBe('failed');
    expect(receiptOf(r.run, 'c')?.status).toBe('running'); // never frozen inside a terminal
    expect(r.dispatches).toEqual([]); // a failing run starts no new work
    expect(r.run.errors).toBeUndefined(); // folded only at the drain terminal
  });

  it('the sibling settles honestly during the drain, then the terminal is written with errors folded', () => {
    const { current, p, reg } = bothBranchesInFlight();
    reg.status(current.runId, 'b', 'error');
    const draining = advanceRun(current, p, reg.probe, now).run;

    reg.idle(draining.runId, 'c', 1, 1, 'c finished its work');
    const r = advanceRun(draining, p, reg.probe, now);
    expect(receiptOf(r.run, 'c')?.status).toBe('done');
    expect(receiptOf(r.run, 'c')?.outcome?.finalMessage).toContain('c finished its work');
    expect(r.run.status).toBe('failed'); // drained — terminal is earned, not premature
    expect(r.run.endedAt).toBe(FIXED);
    expect(r.run.errors?.map((x) => x.code)).toEqual(['step-errored']);
    expect(r.run.stopping).toMatchObject({ to: 'failed' }); // kept as drain evidence
    expect(receiptOf(r.run, 'd')?.status).toBe('pending'); // downstream honestly untouched
  });

  it('an interrupted sibling is NOT respawned during a drain — no new work on a failing run', () => {
    const { current, p, reg } = bothBranchesInFlight();
    reg.status(current.runId, 'b', 'error');
    const draining = advanceRun(current, p, reg.probe, now).run;

    reg.status(draining.runId, 'c', 'interrupted');
    const r = advanceRun(draining, p, reg.probe, now);
    expect(r.dispatches).toEqual([]); // v2 would have respawned attempt 2
    expect(receiptOf(r.run, 'c')?.status).toBe('failed');
    expect(r.run.status).toBe('failed');
    expect(r.run.errors?.map((x) => x.code)).toEqual(['step-errored', 'step-interrupted']);
  });

  it('with NOTHING else in flight a required failure is the immediate v2 terminal — no stopping key', () => {
    const d = def([trigger, step('a'), step('b')], [e('trg', 'a'), e('a', 'b')], { concurrency: 2 });
    const { run, p } = mint(d);
    const reg = probeMap();
    const current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.status(current.runId, 'a', 'error');
    const r = advanceRun(current, p, reg.probe, now);
    expect(r.run.status).toBe('failed');
    expect(r.run.endedAt).toBe(FIXED);
    expect(r.run.stopping).toBeUndefined(); // the sequential path stays byte-identical
    expect(r.run.errors?.[0].code).toBe('step-errored');
  });

  it('markSpawnFailure drains too: a required spawn failure with a sibling in flight sets stopping', () => {
    const { run, p } = mint(diamond({ concurrency: 2 }));
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r = advanceRun(current, p, reg.probe, now);
    // b spawns fine; c's spawn fails while b is in flight.
    current = execute(r.run, [r.dispatches[0]], reg);
    current = markDispatching(current, 'c', 1, now);
    current = markSpawnFailure(current, p, 'c', 'engine exploded', now);
    expect(current.status).toBe('running');
    expect(current.stopping?.errors.map((x) => x.code)).toEqual(['spawn-failed']);
    expect(receiptOf(current, 'b')?.status).toBe('running');

    // b settles → drain terminal.
    reg.idle(current.runId, 'b');
    const final = advanceRun(current, p, reg.probe, now);
    expect(final.run.status).toBe('failed');
    expect(receiptOf(final.run, 'b')?.status).toBe('done');
    expect(final.run.errors?.map((x) => x.code)).toEqual(['spawn-failed']);
  });
});

/* ── Parked probe-only mode ─────────────────────────────────────────────────── */

describe('advanceRun — parked runs are probe-only: evidence stays truthful, nothing dispatches', () => {
  /** trigger→a→g(approval); trigger→c — the park fires while c is still in flight. */
  function parkedWithSiblingInFlight() {
    const d = def(
      [trigger, step('a'), approvalGate('g'), step('c')],
      [e('trg', 'a'), e('a', 'g'), e('trg', 'c')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg); // a and c spawn
    reg.idle(current.runId, 'a');
    const r = advanceRun(current, p, reg.probe, now);
    expect(r.run.status).toBe('parked');
    expect(r.run.parked?.nodeId).toBe('g');
    expect(receiptOf(r.run, 'c')?.status).toBe('running'); // parked WITH a live sibling
    return { parked: r.run, p, reg };
  }

  it('a clean sibling finish settles (done + outcome) while the run stays parked; no dispatches', () => {
    const { parked, p, reg } = parkedWithSiblingInFlight();
    reg.idle(parked.runId, 'c', 1, 1, 'c finished while parked');
    const r = advanceRun(parked, p, reg.probe, now);
    expect(r.changed).toBe(true);
    expect(r.dispatches).toEqual([]);
    expect(r.run.status).toBe('parked'); // probe-only never unparks
    expect(r.run.parked?.nodeId).toBe('g');
    expect(receiptOf(r.run, 'c')?.status).toBe('done');
    expect(receiptOf(r.run, 'c')?.outcome?.finalMessage).toContain('c finished while parked');
  });

  it('problematic outcomes (error/interrupted) are DEFERRED to resume, where full policy applies', () => {
    const { parked, p, reg } = parkedWithSiblingInFlight();
    reg.status(parked.runId, 'c', 'error');
    const r = advanceRun(parked, p, reg.probe, now);
    expect(r.changed).toBe(false); // left in place — failing a parked run is a resume decision
    expect(receiptOf(r.run, 'c')?.status).toBe('running');

    // Resume (approve) → the deferred error resolves with the normal policy.
    const resolved = resolveParkedGate(r.run, 'approve', now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const after = advanceRun(resolved.run, p, reg.probe, now);
    expect(receiptOf(after.run, 'c')?.status).toBe('failed');
    expect(after.run.status).toBe('failed');
  });

  it('adopts a crashed dispatching receipt (spawn happened) but never re-dispatches an unspawned one', () => {
    const { parked, p, reg } = parkedWithSiblingInFlight();
    // Simulate a crash mid-batch: c is back at `dispatching` with its session alive.
    const crashed: WorkflowRun = {
      ...parked,
      steps: parked.steps.map((s) => (s.nodeId === 'c' ? { ...s, status: 'dispatching' as const } : s)),
    };
    const r = advanceRun(crashed, p, reg.probe, now);
    expect(receiptOf(r.run, 'c')?.status).toBe('running'); // adopted, not duplicated
    expect(r.dispatches).toEqual([]);

    // Unspawned intent (no session under the key): stays dispatching until resume.
    const unspawned: WorkflowRun = {
      ...parked,
      steps: parked.steps.map((s) => (s.nodeId === 'c' ? { ...s, status: 'dispatching' as const } : s)),
    };
    const bare = probeMap(); // empty registry — the key was never used
    const r2 = advanceRun(unspawned, p, bare.probe, now);
    expect(receiptOf(r2.run, 'c')?.status).toBe('dispatching');
    expect(r2.dispatches).toEqual([]);
  });
});

/* ── Loop × parallel: membership by graph reachability (GRS-016a-fix) ───────── */

describe('advanceRun — loop membership is GRAPH reachability, never array position (GRS-016a-fix, Codex findings 1+2)', () => {
  /** Drive to terminal settling every spawned session immediately; records sessionKeys. */
  function driveSettleAll(d: EditableWorkflowDefinition) {
    const { run, p } = mint(d);
    const reg = probeMap();
    const spawned: string[] = [];
    let current = run;
    for (let guard = 0; guard < 60; guard++) {
      const r = advanceRun(current, p, reg.probe, now);
      current = r.run;
      if (current.status !== 'running') break;
      if (r.dispatches.length > 0) {
        for (const i of r.dispatches) spawned.push(stepSessionKey(current.runId, i.nodeId, i.attempt, i.round));
        current = execute(current, r.dispatches, reg);
        for (const i of r.dispatches) reg.idle(current.runId, i.nodeId, i.attempt, i.round);
        continue;
      }
      if (!r.changed) break;
    }
    return { final: current, spawned, p };
  }

  it('REGRESSION (Codex finding 1): an independent trigger-fed branch AFTER the loop source dispatches concurrently with round 1', () => {
    // trg→a→b, loop b→a, trg→x — x sits after the source in array order but has no
    // path through the loop; the old positional block suppressed it until loopExit.
    const d = def(
      [trigger, step('a'), step('b'), step('x')],
      [e('trg', 'a'), e('a', 'b'), { id: 'lp', from: 'b', to: 'a', kind: 'loop' }, e('trg', 'x')],
      { concurrency: 2, loop: { maxRoundsPerRun: 2 } },
    );
    const { run, p } = mint(d);
    expect(p.loop?.segmentNodeIds).toEqual(['a', 'b']); // the body: the a→b path only
    expect(p.loop?.postLoopNodeIds).toEqual([]);        // nothing follows the source
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((i) => i.nodeId)).toEqual(['a', 'x']); // Codex's exact failing assertion
  });

  it('REGRESSION (Codex finding 2): an unrelated node declared BETWEEN target and source is never spliced into later rounds', () => {
    // trg→a→b, loop b→a, trg→x — x DECLARED between a and b, so the old positional
    // window [target..source] conscripted it into every round.
    const d = def(
      [trigger, step('a'), step('x'), step('b')],
      [e('trg', 'a'), e('a', 'b'), { id: 'lp', from: 'b', to: 'a', kind: 'loop' }, e('trg', 'x')],
      { concurrency: 3, loop: { maxRoundsPerRun: 2 } },
    );
    const { final } = driveSettleAll(d);
    expect(final.status).toBe('completed');
    expect(final.rounds).toBe(2);
    expect(final.steps.filter((s) => s.nodeId === 'x')).toHaveLength(1); // Codex's exact failing assertion
    // The splice carried the BODY only, in place after the round-1 source.
    expect(final.steps.map((s) => `${s.nodeId}@${s.round ?? 1}`)).toEqual([
      'a@1', 'x@1', 'b@1', 'a@2', 'b@2',
    ]);
  });

  /** trg→a→(b ∥ c); b→d; loop d→a; d→post. Body by reachability = {a, b, d} (the
   * target→source path). c hangs OFF the body (target-fed, never rejoins): it runs
   * once, concurrently, and never gates the boundary. post follows the source. */
  function loopWithSideBranch(): EditableWorkflowDefinition {
    return def(
      [trigger, step('a'), step('b'), step('c'), step('d'), step('post')],
      [
        e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'),
        { id: 'lp', from: 'd', to: 'a', kind: 'loop' },
        e('d', 'post'),
      ],
      { concurrency: 4, loop: { maxRoundsPerRun: 2 } },
    );
  }

  it('a target-fed side branch executes ONCE and never gates the round boundary', () => {
    const { run, p } = mint(loopWithSideBranch());
    expect(p.loop?.segmentNodeIds).toEqual(['a', 'b', 'd']);
    expect(p.loop?.postLoopNodeIds).toEqual(['post']);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg); // a
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    expect(r1.dispatches.map((i) => i.nodeId)).toEqual(['b', 'c']);
    current = execute(r1.run, r1.dispatches, reg);

    reg.idle(current.runId, 'b');
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['d']); // intra-body parallelism
    current = execute(r2.run, r2.dispatches, reg);

    // The source settles while the SIDE BRANCH is still running: the body is settled
    // (a, b, d — c is not a member), so the boundary decides and round 2 splices the
    // body only, all while c keeps running.
    reg.idle(current.runId, 'd');
    const r3 = advanceRun(current, p, reg.probe, now);
    current = r3.run; // d settled; boundary decision is the next pass's pre-pass
    const r4 = advanceRun(current, p, reg.probe, now);
    expect(r4.run.rounds).toBe(2);
    expect(r4.dispatches).toEqual([{ nodeId: 'a', attempt: 1, round: 2 }]);
    expect(receiptOf(r4.run, 'c')?.status).toBe('running'); // side branch untouched, in flight
    expect(r4.run.steps.filter((s) => s.nodeId === 'c')).toHaveLength(1); // never re-spliced
    expect(r4.run.steps.map((s) => `${s.nodeId}@${s.round ?? 1}`)).toEqual([
      'a@1', 'b@1', 'c@1', 'd@1', 'a@2', 'b@2', 'd@2', 'post@1',
    ]);
  });

  it('true post-loop successors stay blocked until loopExit; round-2 sessions key with r2; side branch spawns once', () => {
    const { final, spawned } = driveSettleAll(loopWithSideBranch());
    expect(final.status).toBe('completed');
    expect(final.rounds).toBe(2);
    expect(final.loopExit).toEqual({ round: 2, at: FIXED, reason: 'max-rounds' });
    expect(spawned.filter((k) => k.includes(':c:'))).toEqual(['workflow-run:run-par:c:1']);
    expect(spawned.filter((k) => k.includes(':post:'))).toEqual(['workflow-run:run-par:post:1']);
    expect(spawned[spawned.length - 1]).toBe('workflow-run:run-par:post:1'); // post strictly last
    expect(spawned).toContain('workflow-run:run-par:a:r2:1');
  });

  it('a loop edge whose target cannot reach its source is refused (no body to repeat)', () => {
    // a and b are both trigger-fed and unconnected; b→a as a loop edge passes the
    // backwardness index check but there is no a→…→b path — the positional model
    // would have "repeated" whatever sat between them.
    const d = def(
      [trigger, step('a'), step('b')],
      [e('trg', 'a'), e('trg', 'b'), { id: 'lp', from: 'b', to: 'a', kind: 'loop' }],
      { loop: { maxRoundsPerRun: 2 } },
    );
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((x) => x.code)).toContain('invalid-loop-edge');
  });
});

/* ── Global park discards the pass's collected intents ──────────────────────── */

describe('advanceRun — a park is a GLOBAL dispatch freeze', () => {
  it('a ready blocking gate discards dispatch intents collected earlier in the same pass', () => {
    // trigger→b(step); trigger→g(approval). Array order [b, g]; both ready at start.
    const d = def(
      [trigger, step('b'), approvalGate('g')],
      [e('trg', 'b'), e('trg', 'g')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.run.status).toBe('parked');
    expect(r.run.parked?.nodeId).toBe('g');
    expect(r.dispatches).toEqual([]); // b's intent was collected first, then discarded by the park
    expect(receiptOf(r.run, 'b')?.status).toBe('pending'); // never spawned under a park
  });
});
