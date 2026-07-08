import { describe, it, expect } from 'vitest';
import {
  advanceRun,
  markDispatching,
  markRunning,
  mintSequentialRun,
  stepSessionKey,
  type DispatchIntent,
  type StepSessionProbe,
} from '../advance.js';
import { impliedExecutionOrder } from '../order.js';
import { resolveExecutionPlan, type ExecutionPlan } from '../execution-plan.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import type { WorkflowCondition } from '../condition.js';
import type { WorkflowRun } from '../run-store.js';

/**
 * GRS-016c planner suite — switch routing, edge activity, skip propagation, the
 * join-with-skipped-branch semantics, fail nodes, and the frozen-route guarantee.
 */

const FIXED = '2026-07-05T09:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const switchNode = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'switch', label: 'Route', position: { x: 0, y: 0 }, ...over });
const failNode = (id: string, message = 'rejected by policy'): WorkflowNode =>
  ({ id, type: 'fail', label: 'Stop', position: { x: 0, y: 0 }, failMessage: message });
const approvalGate = (id: string): WorkflowNode =>
  ({ id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: `ap-${id}` } });

const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}

const verdictIs = (v: string): WorkflowCondition => ({ path: 'steps.review.outcome.fields.verdict', op: 'eq', value: v });

/** trigger→review→switch→(ship | stop-fail default). */
function reviewSwitchDef(over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('review'), switchNode('sw'), step('ship'), failNode('stop')],
    [e('trg', 'review'), e('review', 'sw'), e('sw', 'ship', { when: [verdictIs('ship')] }), e('sw', 'stop')],
    over,
  );
}

function plan(d: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(d);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

function mint(d: EditableWorkflowDefinition, runId = 'run-sw'): { run: WorkflowRun; p: ExecutionPlan } {
  const p = plan(d);
  const minted = mintSequentialRun(p, impliedExecutionOrder(d), runId, now);
  if (!minted.ok) throw new Error(`fixture failed to mint: ${JSON.stringify(minted.errors)}`);
  return { run: minted.run, p };
}

function probeMap(entries: Record<string, StepSessionProbe> = {}) {
  const map = new Map(Object.entries(entries));
  const probe = (key: string): StepSessionProbe => map.get(key) ?? { found: false };
  const idle = (runId: string, nodeId: string, text: string, attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: 'idle', finalAssistantText: text });
  };
  const status = (runId: string, nodeId: string, s: StepSessionProbe['status'], attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: s });
  };
  return { probe, map, idle, status };
}

function execute(run: WorkflowRun, intents: DispatchIntent[], reg: ReturnType<typeof probeMap>): WorkflowRun {
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

const handoffText = (fields: Record<string, unknown>, summary = 'did the work') =>
  `work done\n\n\`\`\`handoff\n${JSON.stringify({ summary, fields })}\n\`\`\`\n`;

/** Drive review to done with the given declared fields, returning the post-review advance. */
function runReviewTo(d: EditableWorkflowDefinition, fields: Record<string, unknown> | null) {
  const { run, p } = mint(d);
  const reg = probeMap();
  const first = advanceRun(run, p, reg.probe, now);
  expect(first.dispatches.map((x) => x.nodeId)).toEqual(['review']);
  let current = execute(first.run, first.dispatches, reg);
  reg.idle(current.runId, 'review', fields ? handoffText(fields) : 'plain output, no handoff block');
  const result = advanceRun(current, p, reg.probe, now);
  return { result, reg, p };
}

/* ── firstMatch routing ─────────────────────────────────────────────────────── */

describe('switch routing — firstMatch (the acceptance shape)', () => {
  it('verdict=ship routes to the ship branch; the fail branch settles skipped; run completes', () => {
    const { result, reg, p } = runReviewTo(reviewSwitchDef(), { verdict: 'ship' });
    const sw = receiptOf(result.run, 'sw')!;
    expect(sw.status).toBe('routed');
    expect(sw.route).toEqual(['e_sw__ship']);
    expect(sw.detail).toContain('e_sw__ship');
    expect(receiptOf(result.run, 'stop')!.status).toBe('skipped');
    expect(receiptOf(result.run, 'stop')!.detail).toBe('branch not taken');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['ship']);

    let current = execute(result.run, result.dispatches, reg);
    reg.idle(current.runId, 'ship', 'shipped it');
    const done = advanceRun(current, p, reg.probe, now);
    expect(done.run.status).toBe('completed');
    expect(receiptOf(done.run, 'ship')!.status).toBe('done');
  });

  it('verdict=reject falls to the default edge; the fail node fails the run with the authored message; ship settles skipped', () => {
    const { result } = runReviewTo(reviewSwitchDef(), { verdict: 'reject' });
    const sw = receiptOf(result.run, 'sw')!;
    expect(sw.status).toBe('routed');
    expect(sw.route).toEqual(['e_sw__stop']);
    expect(result.run.status).toBe('failed');
    expect(result.run.errors).toEqual([
      { code: 'authored-fail', message: 'rejected by policy', ref: 'stop' },
    ]);
    expect(receiptOf(result.run, 'stop')!.status).toBe('failed');
    expect(receiptOf(result.run, 'stop')!.detail).toBe('rejected by policy');
    expect(receiptOf(result.run, 'ship')!.status).toBe('skipped');
    expect(result.dispatches).toEqual([]);
  });

  it('a missing field takes the default edge (totality acceptance)', () => {
    const { result } = runReviewTo(reviewSwitchDef(), null); // no handoff block at all
    const sw = receiptOf(result.run, 'sw')!;
    expect(sw.route).toEqual(['e_sw__stop']);
    expect(sw.detail).toContain('default');
    expect(receiptOf(result.run, 'ship')!.status).toBe('skipped');
  });

  it('declaration order picks the FIRST passing rule', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), step('b')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [{ path: 'steps.review.outcome.fields.bugCount', op: 'lte', value: 10 }] }),
        e('sw', 'b', { when: [{ path: 'steps.review.outcome.fields.bugCount', op: 'lte', value: 5 }] }),
      ],
    );
    const { result } = runReviewTo(d, { bugCount: 3 }); // both rules pass
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__a']);
    expect(receiptOf(result.run, 'b')!.status).toBe('skipped');
  });

  it('the default edge is position-independent: declared first, it still loses to a passing rule', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('fallback'), step('a')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'fallback'), // default declared FIRST
        e('sw', 'a', { when: [verdictIs('ship')] }),
      ],
    );
    const { result } = runReviewTo(d, { verdict: 'ship' });
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__a']);
    expect(receiptOf(result.run, 'fallback')!.status).toBe('skipped');
  });

  it('no rule matched and no default: route is empty, every branch (and its exclusive descendants) skips, run completes', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), step('b'), step('after_a')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [verdictIs('ship')] }),
        e('sw', 'b', { when: [verdictIs('reject')] }),
        e('a', 'after_a'),
      ],
    );
    const { result } = runReviewTo(d, { verdict: 'unclear' });
    const sw = receiptOf(result.run, 'sw')!;
    expect(sw.route).toEqual([]);
    expect(sw.detail).toContain('no rule matched');
    for (const nodeId of ['a', 'b', 'after_a']) {
      expect(receiptOf(result.run, nodeId)!.status, nodeId).toBe('skipped');
    }
    expect(result.run.status).toBe('completed');
  });

  it('routes on a predecessor STATUS too (a failed-continue node steers the reject lane)', () => {
    const d = def(
      [trigger, step('review', { options: { onError: 'continue' } }), switchNode('sw'), step('ok'), step('cleanup')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'cleanup', { when: [{ path: 'steps.review.status', op: 'eq', value: 'failed' }] }),
        e('sw', 'ok'),
      ],
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg);
    reg.status(current.runId, 'review', 'error'); // engine ran and failed; onError continue
    const result = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(result.run, 'review')!.status).toBe('failed');
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__cleanup']);
    expect(receiptOf(result.run, 'ok')!.status).toBe('skipped');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['cleanup']);
  });
});

/* ── allMatches ─────────────────────────────────────────────────────────────── */

describe('switch routing — allMatches', () => {
  const allDef = (concurrency = 2) => def(
    [trigger, step('review'), switchNode('sw', { switchMode: 'allMatches' }), step('a'), step('b'), step('fallback')],
    [
      e('trg', 'review'), e('review', 'sw'),
      e('sw', 'a', { when: [{ path: 'steps.review.outcome.fields.bugCount', op: 'gte', value: 1 }] }),
      e('sw', 'b', { when: [{ path: 'steps.review.outcome.fields.bugCount', op: 'gte', value: 2 }] }),
      e('sw', 'fallback'),
    ],
    { concurrency },
  );

  it('every passing edge activates; the default stays inactive when anything matched', () => {
    const { result } = runReviewTo(allDef(), { bugCount: 5 });
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__a', 'e_sw__b']);
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['a', 'b']);
    expect(receiptOf(result.run, 'fallback')!.status).toBe('skipped');
  });

  it('no-when edges activate only when nothing else did', () => {
    const { result } = runReviewTo(allDef(), { bugCount: 0 });
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__fallback']);
    expect(receiptOf(result.run, 'a')!.status).toBe('skipped');
    expect(receiptOf(result.run, 'b')!.status).toBe('skipped');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['fallback']);
  });
});

/* ── Joins, cascades, and activity interplay ────────────────────────────────── */

describe('skip propagation × joins', () => {
  it('a join fed by a skipped branch and a live branch proceeds on the live path (skipped resolves instantly, never wedges)', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), step('b'), step('join')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [verdictIs('ship')] }),
        e('sw', 'b'),
        e('a', 'join'), e('b', 'join'),
      ],
      { concurrency: 2 },
    );
    const { result, reg, p } = runReviewTo(d, { verdict: 'ship' });
    expect(receiptOf(result.run, 'b')!.status).toBe('skipped');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['a']);
    let current = execute(result.run, result.dispatches, reg);
    reg.idle(current.runId, 'a', handoffText({}, 'a done'));
    const joined = advanceRun(current, p, reg.probe, now);
    // join dispatches on the live path alone — the skipped branch never gates it
    expect(joined.dispatches.map((x) => x.nodeId)).toEqual(['join']);
    current = execute(joined.run, joined.dispatches, reg);
    reg.idle(current.runId, 'join', 'joined');
    expect(advanceRun(current, p, reg.probe, now).run.status).toBe('completed');
  });

  it('a join whose in-edges are ALL inactive skips too (exclusive descendant)', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), step('b'), step('join'), step('other')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [verdictIs('ship')] }),
        e('sw', 'b', { when: [verdictIs('ship')] }),
        e('sw', 'other'),
        e('a', 'join'), e('b', 'join'),
      ],
      { concurrency: 2 },
    );
    const { result } = runReviewTo(d, { verdict: 'reject' });
    expect(receiptOf(result.run, 'a')!.status).toBe('skipped');
    expect(receiptOf(result.run, 'b')!.status).toBe('skipped');
    expect(receiptOf(result.run, 'join')!.status).toBe('skipped');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['other']);
  });

  it('a node fed by a not-taken branch AND an independent live path still runs', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), step('shared')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [verdictIs('ship')] }),
        e('sw', 'shared', { when: [verdictIs('never')] }), // branch not taken
        e('review', 'shared'),                              // independent live path
      ],
      { concurrency: 2 },
    );
    const { result } = runReviewTo(d, { verdict: 'ship' });
    expect(result.dispatches.map((x) => x.nodeId).sort()).toEqual(['a', 'shared']);
  });

  it('an OPTIONAL-absorption skip does NOT propagate inactivity (v2: the chain continues past it)', () => {
    const d = def(
      [trigger, step('a', { optional: true }), step('b')],
      [e('trg', 'a'), e('a', 'b')],
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    let current = execute(first.run, first.dispatches, reg);
    reg.status(current.runId, 'a', 'error'); // optional step errors → skipped
    const result = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(result.run, 'a')!.status).toBe('skipped');
    // b still dispatches — the optional skip keeps control flowing
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['b']);
  });

  it('a blocking approval gate on a not-taken branch settles skipped and never parks', () => {
    const d = def(
      [trigger, step('review'), switchNode('sw'), step('a'), approvalGate('hold'), step('gated')],
      [
        e('trg', 'review'), e('review', 'sw'),
        e('sw', 'a', { when: [verdictIs('ship')] }),
        e('sw', 'hold'),
        e('hold', 'gated'),
      ],
    );
    const { result } = runReviewTo(d, { verdict: 'ship' });
    expect(result.run.status).toBe('running');
    expect(result.run.parked).toBeNull();
    expect(receiptOf(result.run, 'hold')!.status).toBe('skipped');
    expect(receiptOf(result.run, 'gated')!.status).toBe('skipped');
    expect(result.dispatches.map((x) => x.nodeId)).toEqual(['a']);
  });
});

/* ── Frozen decisions + drain ───────────────────────────────────────────────── */

describe('routing decisions are frozen evidence', () => {
  it('evidence drift never re-routes: mutating the reviewed fields after the route is stamped changes nothing', () => {
    const { result, p, reg } = runReviewTo(reviewSwitchDef(), { verdict: 'ship' });
    expect(receiptOf(result.run, 'sw')!.route).toEqual(['e_sw__ship']);
    // hostile/corrupt drift: flip the frozen outcome on the record
    const drifted: WorkflowRun = {
      ...result.run,
      steps: result.run.steps.map((r) =>
        r.nodeId === 'review' ? { ...r, outcome: { ...r.outcome!, fields: { verdict: 'reject' } } } : { ...r },
      ),
    };
    const again = advanceRun(drifted, p, reg.probe, now);
    expect(receiptOf(again.run, 'sw')!.route).toEqual(['e_sw__ship']); // stamped, not re-derived
    expect(receiptOf(again.run, 'stop')!.status).toBe('skipped');     // still the not-taken branch
    expect(again.dispatches.map((x) => x.nodeId)).toEqual(['ship']);  // still the taken branch
  });

  it('a fail node reached with a sibling in flight drains honestly (stopping, then terminal)', () => {
    const d = def(
      [trigger, step('review'), step('slow'), switchNode('sw'), failNode('stop', 'authored stop')],
      [
        e('trg', 'review'),
        e('trg', 'slow'), // independent branch — in flight when the fail node fires
        e('review', 'sw'),
        e('sw', 'stop', { when: [verdictIs('reject')] }),
      ],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    const first = advanceRun(run, p, reg.probe, now);
    expect(first.dispatches.map((x) => x.nodeId).sort()).toEqual(['review', 'slow']);
    let current = execute(first.run, first.dispatches, reg);
    reg.idle(current.runId, 'review', handoffText({ verdict: 'reject' }));
    // pass: review settles; switch routes to the fail node while slow is live
    const second = advanceRun(current, p, reg.probe, now);
    expect(second.run.stopping).toMatchObject({ to: 'failed' });
    expect(second.run.status).toBe('running');
    expect(second.run.endedAt).toBeNull();
    expect(receiptOf(second.run, 'stop')!.status).toBe('failed');
    expect(second.dispatches).toEqual([]);
    // slow settles → terminal failed with the authored error folded in
    reg.idle(second.run.runId, 'slow', 'slow done');
    const final = advanceRun(second.run, p, reg.probe, now);
    expect(final.run.status).toBe('failed');
    expect(receiptOf(final.run, 'slow')!.status).toBe('done');
    expect(final.run.errors?.some((x) => x.code === 'authored-fail' && x.message === 'authored stop')).toBe(true);
  });
});

/* ── Loops: per-round routing + position rule ───────────────────────────────── */

describe('switch × loop — per-round routing under the position rule', () => {
  /** Body = review→sw→retry (loop retry→review, gate-less, 2 rounds); `ship` is a
   * switch-fed SIDE BRANCH outside the body — it executes at most once, and a
   * round's "not taken" is NOT final while the loop may still re-route to it. */
  const loopDef = () => def(
    [trigger, step('review'), switchNode('sw'), step('retry'), step('ship')],
    [
      e('trg', 'review'),
      e('review', 'sw'),
      e('sw', 'ship', { when: [verdictIs('ship')] }),
      e('sw', 'retry'),
      { id: 'loop', from: 'retry', to: 'review', kind: 'loop' },
    ],
    { loop: { maxRoundsPerRun: 2 }, concurrency: 2 },
  );

  /** Re-plan like driveRunLocked: a changed-but-dispatchless pass (a settle at an
   * undecided boundary, a splice, a loopExit stamp) re-advances immediately. */
  function drive(run: WorkflowRun, p: ExecutionPlan, reg: ReturnType<typeof probeMap>) {
    let result = advanceRun(run, p, reg.probe, now);
    for (let i = 0; i < 20; i++) {
      if (result.dispatches.length > 0 || !result.changed || result.run.status !== 'running') break;
      result = advanceRun(result.run, p, reg.probe, now);
    }
    return result;
  }

  function driveRound1(verdict: string) {
    const { run, p } = mint(loopDef());
    const reg = probeMap();
    const first = drive(run, p, reg);
    let current = execute(first.run, first.dispatches, reg);
    reg.idle(current.runId, 'review', handoffText({ verdict }));
    const result = drive(current, p, reg);
    return { result, reg, p, drive };
  }

  it('a side branch not taken by round 1 stays PENDING (not skipped) while the body switch may re-route in a later round', () => {
    const { result } = driveRound1('not-yet');
    expect(receiptOf(result.run, 'sw', 1)!.route).toEqual(['e_sw__retry']);
    // even with budget headroom (concurrency 2), ship must NOT settle "branch not
    // taken" off round 1's route — round 2 may take it
    expect(receiptOf(result.run, 'ship', 1)!.status).toBe('pending');
    expect(result.dispatches).toEqual([{ nodeId: 'retry', attempt: 1, round: 1 }]);
  });

  it('each round routes on ITS OWN round\'s predecessor; the final round\'s route decides the side branch', () => {
    const { result, reg, p } = driveRound1('not-yet');
    let current = execute(result.run, result.dispatches, reg);
    reg.idle(current.runId, 'retry', 'kicked review again');
    // boundary → round 2 splice → review@2 dispatches
    let r = drive(current, p, reg);
    expect(r.run.rounds).toBe(2);
    expect(r.dispatches).toEqual([{ nodeId: 'review', attempt: 1, round: 2 }]);
    current = execute(r.run, r.dispatches, reg);
    reg.idle(current.runId, 'review', handoffText({ verdict: 'ship' }), 1, 2);
    // round 2's switch reads round 2's review (position rule) and routes to ship;
    // the body-internal retry@2 skips per-round; the exhausted gate-less loop
    // stamps loopExit and the side branch dispatches off the FINAL round's route
    r = drive(current, p, reg);
    expect(receiptOf(r.run, 'sw', 2)!.route).toEqual(['e_sw__ship']);
    expect(receiptOf(r.run, 'retry', 2)!.status).toBe('skipped');
    expect(r.run.loopExit).toMatchObject({ round: 2, reason: 'max-rounds' });
    expect(r.dispatches).toEqual([{ nodeId: 'ship', attempt: 1, round: 1 }]);
    current = execute(r.run, r.dispatches, reg);
    reg.idle(current.runId, 'ship', 'shipped');
    expect(drive(current, p, reg).run.status).toBe('completed');
  });

  it('when no round ever routes to the side branch, it settles skipped after loopExit and the run completes', () => {
    const { result, reg, p } = driveRound1('not-yet');
    let current = execute(result.run, result.dispatches, reg);
    reg.idle(current.runId, 'retry', 'again');
    let r = drive(current, p, reg); // splice round 2 → review@2 dispatches
    current = execute(r.run, r.dispatches, reg);
    reg.idle(current.runId, 'review', handoffText({ verdict: 'still-not' }), 1, 2);
    r = drive(current, p, reg); // sw@2 routes retry again
    expect(receiptOf(r.run, 'sw', 2)!.route).toEqual(['e_sw__retry']);
    expect(r.dispatches).toEqual([{ nodeId: 'retry', attempt: 1, round: 2 }]);
    current = execute(r.run, r.dispatches, reg);
    reg.idle(current.runId, 'retry', 'again', 1, 2);
    r = drive(current, p, reg); // boundary → loopExit (max-rounds) → ship decided by the final route
    expect(r.run.loopExit).toMatchObject({ round: 2, reason: 'max-rounds' });
    expect(receiptOf(r.run, 'ship', 1)!.status).toBe('skipped');
    expect(r.run.status).toBe('completed');
  });
});
