import { describe, it, expect } from 'vitest';
import {
  advanceRun,
  markDispatching,
  markFired,
  markRunning,
  markSpawnFailure,
  mintSequentialRun,
  stepSessionKey,
  type DispatchIntent,
  type StepSessionProbe,
} from '../advance.js';
import { impliedExecutionOrder } from '../order.js';
import { resolveExecutionPlan, type ExecutionPlan } from '../execution-plan.js';
import {
  MAX_WAIT_MINUTES,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import { IN_FLIGHT_STEP_STATUSES, SETTLED_STEP_STATUSES, type WorkflowRun } from '../run-store.js';

/**
 * GRS-016d planner suite — error-output lanes (activation flip on terminal
 * failure), output:'none' (`fired`: settled at spawn, never probed, completion-
 * independent), and the wait node (waiting + readyAt, sweep-clocked settle,
 * restart re-derivation, max-delay bound, drain cancellation).
 */

const T0 = '2026-07-05T09:00:00.000Z';
const t0ms = Date.parse(T0);
const isoAt = (offsetMs: number) => new Date(t0ms + offsetMs).toISOString();

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const waitNode = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'wait', label: 'Wait', position: { x: 0, y: 0 }, ...over });
const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}

function plan(d: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(d);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

function mint(d: EditableWorkflowDefinition, now: () => string, runId = 'run-016d'): { run: WorkflowRun; p: ExecutionPlan } {
  const p = plan(d);
  const minted = mintSequentialRun(p, impliedExecutionOrder(d), runId, now);
  if (!minted.ok) throw new Error(`fixture failed to mint: ${JSON.stringify(minted.errors)}`);
  return { run: minted.run, p };
}

function probeMap(entries: Record<string, StepSessionProbe> = {}) {
  const map = new Map(Object.entries(entries));
  const queried: string[] = [];
  const probe = (key: string): StepSessionProbe => {
    queried.push(key);
    return map.get(key) ?? { found: false };
  };
  const idle = (runId: string, nodeId: string, text: string, attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: 'idle', finalAssistantText: text });
  };
  const status = (runId: string, nodeId: string, s: StepSessionProbe['status'], attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: s });
  };
  return { probe, map, idle, status, queried };
}

function execute(run: WorkflowRun, intents: DispatchIntent[], reg: ReturnType<typeof probeMap>, now: () => string): WorkflowRun {
  let current = run;
  for (const { nodeId, attempt, round } of intents) {
    current = markDispatching(current, nodeId, attempt, now, round);
    reg.status(current.runId, nodeId, 'running', attempt, round);
    current = markRunning(current, nodeId, { sessionId: `s:${stepSessionKey(current.runId, nodeId, attempt, round)}` }, now, round);
  }
  return current;
}

const receiptOf = (run: WorkflowRun, nodeId: string, round = 1) =>
  run.steps.find((s) => s.nodeId === nodeId && (s.round ?? 1) === round);

/** trigger→a→(ok | rescue via error lane). */
function errorLaneDef(aOver: Partial<WorkflowNode> = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('a', { options: { onError: 'error-edge' }, ...aOver }), step('ok'), step('rescue')],
    [e('trg', 'a'), e('a', 'ok'), e('a', 'rescue', { lane: 'error' })],
  );
}

/* ── Error-output lanes ─────────────────────────────────────────────────────── */

describe('error-edge routing (GRS-016d §2.4)', () => {
  const now = () => T0;

  it('a terminal session error routes down the error lane: receipt stays failed, rescue dispatches, ok skips, run completes with NO run-level error', () => {
    const d = errorLaneDef();
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((x) => x.nodeId)).toEqual(['a']);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.status(current.runId, 'a', 'error');

    const routed = advanceRun(current, p, reg.probe, now);
    const a = receiptOf(routed.run, 'a')!;
    expect(a.status).toBe('failed'); // evidence never lies — the receipt stays failed
    expect(a.detail).toContain('routed to the error lane (onError: error-edge)');
    expect(routed.run.status).toBe('running'); // the run survives
    expect(receiptOf(routed.run, 'ok')!.status).toBe('skipped');
    expect(receiptOf(routed.run, 'ok')!.detail).toBe('branch not taken');
    expect(routed.dispatches.map((x) => x.nodeId)).toEqual(['rescue']);

    current = execute(routed.run, routed.dispatches, reg, now);
    reg.idle(current.runId, 'rescue', 'handled the failure');
    const done = advanceRun(current, p, reg.probe, now);
    expect(done.run.status).toBe('completed');
    expect(done.run.errors ?? []).toEqual([]); // the failed receipt IS the evidence
    expect(receiptOf(done.run, 'rescue')!.status).toBe('done');
  });

  it('a SUCCESSFUL error-edge node deactivates its error lane: rescue skips, ok runs', () => {
    const d = errorLaneDef();
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.idle(current.runId, 'a', 'all good');

    const next = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(next.run, 'a')!.status).toBe('done');
    expect(receiptOf(next.run, 'rescue')!.status).toBe('skipped');
    expect(receiptOf(next.run, 'rescue')!.detail).toBe('branch not taken');
    expect(next.dispatches.map((x) => x.nodeId)).toEqual(['ok']);
  });

  it('retry runs FIRST (the 016b precedence chain): a declared retry redispatches before the lane, the lane takes over on exhaustion', () => {
    const d = errorLaneDef({ options: { onError: 'error-edge', retry: { maxAttempts: 2, on: ['error'] } } });
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.status(current.runId, 'a', 'error');

    const retried = advanceRun(current, p, reg.probe, now);
    expect(retried.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]); // retry, not the lane
    expect(receiptOf(retried.run, 'a')!.status).toBe('running'); // not settled between attempts

    current = execute(retried.run, retried.dispatches, reg, now);
    reg.status(current.runId, 'a', 'error', 2);
    const exhausted = advanceRun(current, p, reg.probe, now);
    const a = receiptOf(exhausted.run, 'a')!;
    expect(a.status).toBe('failed');
    expect(a.attempt).toBe(2);
    expect(a.detail).toContain('retry exhausted');
    expect(a.detail).toContain('routed to the error lane (onError: error-edge)');
    expect(exhausted.dispatches.map((x) => x.nodeId)).toEqual(['rescue']);
  });

  it('a SPAWN failure on an error-edge node also routes the lane (the run continues)', () => {
    const d = errorLaneDef();
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = markDispatching(first.run, 'a', 1, now);
    current = markSpawnFailure(current, p, 'a', 'unknown model', now);
    expect(current.status).toBe('running');
    const a = receiptOf(current, 'a')!;
    expect(a.status).toBe('failed');
    expect(a.detail).toContain('spawn failed: unknown model');
    expect(a.detail).toContain('routed to the error lane (onError: error-edge)');

    const next = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(next.run, 'ok')!.status).toBe('skipped');
    expect(next.dispatches.map((x) => x.nodeId)).toEqual(['rescue']);
  });

  it('the error branch reaches a join fed by an independent live path too (one active in-edge suffices)', () => {
    // trigger→(a error-edge→rescue | b)→join; a fails, rescue and b both feed join.
    const d = def(
      [trigger, step('a', { options: { onError: 'error-edge' } }), step('b'), step('rescue'), step('join')],
      [e('trg', 'a'), e('trg', 'b'), e('a', 'rescue', { lane: 'error' }), e('a', 'join'), e('rescue', 'join'), e('b', 'join')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((x) => x.nodeId).sort()).toEqual(['a', 'b']);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.status(current.runId, 'a', 'error');
    reg.idle(current.runId, 'b', 'b done');

    const routed = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(routed.run, 'a')!.status).toBe('failed');
    expect(routed.dispatches.map((x) => x.nodeId)).toEqual(['rescue']);
    current = execute(routed.run, routed.dispatches, reg, now);
    reg.idle(current.runId, 'rescue', 'rescued');
    const joined = advanceRun(current, p, reg.probe, now);
    // join has 3 in-edges: a (normal — inactive), rescue (active), b (active) → runs
    expect(joined.dispatches.map((x) => x.nodeId)).toEqual(['join']);
  });

  it('during a DRAIN an error-edge failure settles without extending stopping.errors and dispatches nothing', () => {
    // concurrency 2: x (fail-run) and y (error-edge → rescue). x fails while y runs.
    const d = def(
      [trigger, step('x'), step('y', { options: { onError: 'error-edge' } }), step('rescue')],
      [e('trg', 'x'), e('trg', 'y'), e('y', 'rescue', { lane: 'error' })],
      { concurrency: 2 },
    );
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.status(current.runId, 'x', 'error');

    const draining = advanceRun(current, p, reg.probe, now);
    expect(draining.run.stopping).toBeTruthy(); // y still in flight
    expect(draining.run.status).toBe('running');

    reg.status(current.runId, 'y', 'error');
    const drained = advanceRun(draining.run, p, reg.probe, now);
    expect(drained.run.status).toBe('failed');
    expect(receiptOf(drained.run, 'y')!.status).toBe('failed');
    expect(drained.run.errors).toHaveLength(1); // only x's failure — y's lane failure is receipt evidence
    expect(drained.run.errors![0].ref).toBe('x');
    expect(receiptOf(drained.run, 'rescue')!.status).toBe('pending'); // drain never dispatches
  });
});

/* ── output:'none' → fired ──────────────────────────────────────────────────── */

describe("output:'none' — fired receipts (GRS-016d §2.1)", () => {
  const now = () => T0;
  const noneDef = def(
    [trigger, step('fire', { options: { output: 'none' } }), step('next')],
    [e('trg', 'fire'), e('fire', 'next')],
  );

  it("'fired' is a settled status; 'waiting' is neither settled nor in flight", () => {
    expect(SETTLED_STEP_STATUSES.has('fired')).toBe(true);
    expect(IN_FLIGHT_STEP_STATUSES.has('fired')).toBe(false);
    expect(SETTLED_STEP_STATUSES.has('waiting')).toBe(false);
    expect(IN_FLIGHT_STEP_STATUSES.has('waiting')).toBe(false);
  });

  it('markFired settles the receipt at spawn: sessionId recorded, settledAt stamped, no outcome', () => {
    const { run, p } = mint(noneDef, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((x) => x.nodeId)).toEqual(['fire']);
    let current = markDispatching(first.run, 'fire', 1, now);
    current = markFired(current, 'fire', { sessionId: 'sess-123' }, now);
    const fire = receiptOf(current, 'fire')!;
    expect(fire.status).toBe('fired');
    expect(fire.sessionId).toBe('sess-123');
    expect(fire.settledAt).toBe(T0);
    expect(fire.outcome).toBeUndefined();
  });

  it('the run proceeds and COMPLETES without ever probing the fired session', () => {
    const { run, p } = mint(noneDef, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = markDispatching(first.run, 'fire', 1, now);
    current = markFired(current, 'fire', { sessionId: 'sess-123' }, now);
    // The fired node's session is still RUNNING on the gateway — and irrelevant.
    reg.status(current.runId, 'fire', 'running');
    reg.queried.length = 0;

    const next = advanceRun(current, p, reg.probe, now);
    expect(next.dispatches.map((x) => x.nodeId)).toEqual(['next']); // successor ready immediately
    current = execute(next.run, next.dispatches, reg, now);
    reg.idle(current.runId, 'next', 'done after the fired one');
    const done = advanceRun(current, p, reg.probe, now);
    expect(done.run.status).toBe('completed'); // completion does NOT wait for the fired session
    const fireKey = stepSessionKey(run.runId, 'fire', 1);
    expect(reg.queried).not.toContain(fireKey); // never probed after settling
  });

  it('a crashed dispatch on a none node ADOPTS to fired (not running) when the probe finds the session', () => {
    const { run, p } = mint(noneDef, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    const current = markDispatching(first.run, 'fire', 1, now);
    reg.status(current.runId, 'fire', 'running'); // spawn happened, then crash before markFired persisted

    const recovered = advanceRun(current, p, reg.probe, now);
    const fire = receiptOf(recovered.run, 'fire')!;
    expect(fire.status).toBe('fired');
    expect(fire.sessionId).toBe(`s:${stepSessionKey(run.runId, 'fire', 1)}`);
    expect(recovered.dispatches.map((x) => x.nodeId)).toEqual(['next']);
  });

  it('a crashed dispatch with NO session re-dispatches the same attempt (mint-before-spawn unchanged)', () => {
    const { run, p } = mint(noneDef, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    const current = markDispatching(first.run, 'fire', 1, now);
    const recovered = advanceRun(current, p, reg.probe, now);
    expect(recovered.dispatches).toEqual([{ nodeId: 'fire', attempt: 1, round: 1 }]);
  });

  it('a spawn FAILURE on a none node routes the normal failure policy (nothing fired)', () => {
    const { run, p } = mint(noneDef, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = markDispatching(first.run, 'fire', 1, now);
    current = markSpawnFailure(current, p, 'fire', 'boom', now);
    expect(current.status).toBe('failed');
    expect(receiptOf(current, 'fire')!.status).toBe('failed');
    void reg;
  });
});

/* ── Wait node ──────────────────────────────────────────────────────────────── */

describe('wait node (GRS-016d §2.6)', () => {
  const waitDef = (waitOver: Partial<WorkflowNode>) =>
    def([trigger, waitNode('w', waitOver), step('b')], [e('trg', 'w'), e('w', 'b')]);

  it('activation stamps waiting + readyAt = now + minutes; nothing dispatches; the run stays running', () => {
    const now = () => T0;
    const { run, p } = mint(waitDef({ waitMinutes: 2 }), now);
    const reg = probeMap();
    const r = advanceRun(run, p, reg.probe, now);
    const w = receiptOf(r.run, 'w')!;
    expect(w.status).toBe('waiting');
    expect(w.readyAt).toBe(isoAt(2 * 60_000));
    expect(r.dispatches).toEqual([]);
    expect(r.run.status).toBe('running');
    expect(receiptOf(r.run, 'b')!.status).toBe('pending');
  });

  it('a sweep BEFORE the deadline changes nothing; a sweep AT/AFTER it settles checkpoint and unblocks the successor', () => {
    let clock = T0;
    const now = () => clock;
    const { run, p } = mint(waitDef({ waitMinutes: 2 }), now);
    const reg = probeMap();
    const armed = advanceRun(run, p, reg.probe, now);

    clock = isoAt(60_000); // 1 minute in — not yet
    const early = advanceRun(armed.run, p, reg.probe, now);
    expect(early.changed).toBe(false);
    expect(receiptOf(early.run, 'w')!.status).toBe('waiting');

    clock = isoAt(2 * 60_000 + 5_000); // past the deadline (sweep granularity)
    const due = advanceRun(early.run, p, reg.probe, now);
    const w = receiptOf(due.run, 'w')!;
    expect(w.status).toBe('checkpoint');
    expect(w.detail).toContain('wait elapsed');
    expect(due.dispatches.map((x) => x.nodeId)).toEqual(['b']);
  });

  it('restart re-derivation: a JSON round-trip of the waiting record settles identically (readyAt IS the durable state)', () => {
    let clock = T0;
    const now = () => clock;
    const { run, p } = mint(waitDef({ waitMinutes: 2 }), now);
    const reg = probeMap();
    const armed = advanceRun(run, p, reg.probe, now);

    // Simulate gateway restart: the run comes back from disk; no in-memory state.
    const reloaded = JSON.parse(JSON.stringify(armed.run)) as WorkflowRun;
    clock = isoAt(3 * 60_000);
    const resumed = advanceRun(reloaded, p, reg.probe, now);
    expect(receiptOf(resumed.run, 'w')!.status).toBe('checkpoint');
    expect(resumed.dispatches.map((x) => x.nodeId)).toEqual(['b']);
  });

  it('waitUntil: readyAt is the authored deadline verbatim; a PAST deadline settles immediately', () => {
    const now = () => T0;
    const future = isoAt(30 * 60_000);
    const { run, p } = mint(waitDef({ waitUntil: future }), now);
    const reg = probeMap();
    const r = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r.run, 'w')!.status).toBe('waiting');
    expect(receiptOf(r.run, 'w')!.readyAt).toBe(future);

    const past = waitDef({ waitUntil: isoAt(-60_000) });
    const minted = mint(past, now, 'run-016d-past');
    const settled = advanceRun(minted.run, minted.p, reg.probe, now);
    expect(receiptOf(settled.run, 'w')!.status).toBe('checkpoint');
    expect(settled.dispatches.map((x) => x.nodeId)).toEqual(['b']);
  });

  it(`waitUntil more than ${MAX_WAIT_MINUTES} minutes away at activation fails the run honestly (wait-too-long)`, () => {
    const now = () => T0;
    const farFuture = isoAt((MAX_WAIT_MINUTES + 10) * 60_000);
    const { run, p } = mint(waitDef({ waitUntil: farFuture }), now);
    const reg = probeMap();
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.run.status).toBe('failed');
    expect(r.run.errors?.[0].code).toBe('wait-too-long');
    expect(receiptOf(r.run, 'w')!.status).toBe('failed');
  });

  it('a waiting receipt with a corrupt readyAt fails the run honestly instead of waiting forever', () => {
    const now = () => T0;
    const { run, p } = mint(waitDef({ waitMinutes: 2 }), now);
    const reg = probeMap();
    const armed = advanceRun(run, p, reg.probe, now);
    const corrupted: WorkflowRun = {
      ...armed.run,
      steps: armed.run.steps.map((s) => (s.nodeId === 'w' ? { ...s, readyAt: 'garbage' } : s)),
    };
    const r = advanceRun(corrupted, p, reg.probe, now);
    expect(r.run.status).toBe('failed');
    expect(r.run.errors?.[0].code).toBe('invalid-wait-deadline');
  });

  it('a DRAIN cancels a waiting receipt (skipped) instead of holding the terminal for up to a week', () => {
    // concurrency 2: x (will fail) ∥ w (waiting 60m) → terminal must not wait on w.
    const d = def(
      [trigger, step('x'), waitNode('w', { waitMinutes: 60 }), step('b')],
      [e('trg', 'x'), e('trg', 'w'), e('w', 'b')],
      { concurrency: 2 },
    );
    const now = () => T0;
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((x) => x.nodeId)).toEqual(['x']);
    expect(receiptOf(first.run, 'w')!.status).toBe('waiting');
    let current = execute(first.run, first.dispatches, reg, now);
    reg.status(current.runId, 'x', 'error');

    const failed = advanceRun(current, p, reg.probe, now);
    // No session is in flight (waiting has none), so the terminal lands this pass
    // (possibly via an immediate re-derive) with the wait cancelled.
    const settled = failed.run.status === 'failed' ? failed : advanceRun(failed.run, p, reg.probe, now);
    expect(settled.run.status).toBe('failed');
    expect(receiptOf(settled.run, 'w')!.status).toBe('skipped');
    expect(receiptOf(settled.run, 'w')!.detail).toContain('run stopping');
  });

  it('a wait node on a branch not taken settles skipped like anything else', () => {
    const d = def(
      [
        trigger, step('review'),
        { id: 'sw', type: 'switch', label: 'SW', position: { x: 0, y: 0 } },
        waitNode('w', { waitMinutes: 5 }), step('b'), step('c'),
      ],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'w', { when: [{ path: 'steps.review.outcome.fields.go', op: 'eq', value: true }] }),
        e('w', 'b'),
        e('sw', 'c'),
      ],
    );
    const now = () => T0;
    const { run, p } = mint(d, now);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg, now);
    reg.idle(current.runId, 'review', 'plain reply, no fields'); // go missing → default edge c
    const routed = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(routed.run, 'w')!.status).toBe('skipped');
    expect(receiptOf(routed.run, 'b')!.status).toBe('skipped');
    expect(routed.dispatches.map((x) => x.nodeId)).toEqual(['c']);
  });
});
