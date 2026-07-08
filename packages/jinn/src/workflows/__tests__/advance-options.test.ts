import { describe, it, expect, beforeEach } from 'vitest';
import {
  advanceRun,
  markDispatching,
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
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type StepNodeOptions,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import type { WorkflowRun } from '../run-store.js';

/**
 * GRS-016b planner suite — per-node retry policy (attempt-dimension generalization
 * of respawn-once), sweep-enforced timeouts with STOP intents, onError:'continue'
 * (failed-but-resolved receipts), and output:'full' extraction. The option-less
 * defaults are pinned byte-identical by the parallel-compat golden suite; everything
 * here exercises DECLARED options.
 */

const FIXED = '2026-07-05T08:00:00.000Z';
let clock = FIXED;
const now = () => clock;
const tick = (ms: number) => { clock = new Date(Date.parse(FIXED) + ms).toISOString(); };
beforeEach(() => { clock = FIXED; });

const MIN = 60_000;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}
const e = (from: string, to: string, kind: WorkflowEdge['kind'] = 'sequence'): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind });

/** trigger→a→b with a's options injectable. */
function chain(options?: StepNodeOptions, aOver: Partial<WorkflowNode> = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('a', { ...(options ? { options } : {}), ...aOver }), step('b')],
    [e('trg', 'a'), e('a', 'b')],
  );
}

function plan(d: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(d);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

function mint(d: EditableWorkflowDefinition, runId = 'run-opt'): { run: WorkflowRun; p: ExecutionPlan } {
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
    map.set(key, { found: true, sessionId: `s:${key}`, status: 'idle', finalAssistantText: text ?? `output of ${nodeId}` });
  };
  const status = (runId: string, nodeId: string, s: StepSessionProbe['status'], attempt = 1, round = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, round);
    map.set(key, { found: true, sessionId: `s:${key}`, status: s });
  };
  return { probe, map, idle, status };
}

/** Execute a batch of intents the way driveRunLocked does. */
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

/** Dispatch a's attempt 1 and return the in-flight run. */
function inFlightA(d: EditableWorkflowDefinition): { run: WorkflowRun; p: ExecutionPlan; reg: ReturnType<typeof probeMap> } {
  const { run, p } = mint(d);
  const reg = probeMap();
  const r0 = advanceRun(run, p, reg.probe, now);
  expect(r0.dispatches.map((i) => i.nodeId)).toEqual(['a']);
  return { run: execute(run, r0.dispatches, reg), p, reg };
}

/* ── Retry cause routing ────────────────────────────────────────────────────── */

describe('per-node retry (GRS-016b) — cause routing along the attempt dimension', () => {
  it('retries an ERRORED session when the policy covers it, under attempt-keyed identity, until exhaustion', () => {
    let { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 3, on: ['error'] } }));

    reg.status(run.runId, 'a', 'error', 1);
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(r1.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    expect(receiptOf(r1.run, 'a')?.status).toBe('running'); // not settled between attempts
    run = execute(r1.run, r1.dispatches, reg);

    reg.status(run.runId, 'a', 'error', 2);
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(r2.dispatches).toEqual([{ nodeId: 'a', attempt: 3, round: 1 }]);
    run = execute(r2.run, r2.dispatches, reg);

    reg.status(run.runId, 'a', 'error', 3);
    const r3 = advanceRun(run, p, reg.probe, now);
    expect(r3.dispatches).toEqual([]);
    expect(receiptOf(r3.run, 'a')?.status).toBe('failed');
    expect(receiptOf(r3.run, 'a')?.detail).toMatch(/retry exhausted: 3 attempt/);
    expect(r3.run.status).toBe('failed');
    expect(r3.run.errors?.map((x) => x.code)).toEqual(['step-errored']);
  });

  it('an errored session with the DEFAULT policy fails immediately (v2 verbatim — error is not retried)', () => {
    const { run, p, reg } = inFlightA(chain());
    reg.status(run.runId, 'a', 'error', 1);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.dispatches).toEqual([]);
    expect(r.run.status).toBe('failed');
    expect(receiptOf(r.run, 'a')?.detail).toBe('step "a" session ended in error');
  });

  it('retries a NO-OUTPUT settle when covered, then succeeds on the fresh attempt', () => {
    let { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 2, on: ['no-output'] } }));
    reg.idle(run.runId, 'a', 1, 1, '   '); // settled with blank output
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(r1.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    run = execute(r1.run, r1.dispatches, reg);

    reg.idle(run.runId, 'a', 2, 1, 'real output this time');
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r2.run, 'a')?.status).toBe('done');
    expect(receiptOf(r2.run, 'a')?.attempt).toBe(2);
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['b']);
  });

  it('raises the interrupted respawn budget beyond v2\'s once (maxAttempts 4 → 3 respawns)', () => {
    let { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 4, on: ['interrupted'] } }));
    for (let attempt = 1; attempt <= 3; attempt++) {
      reg.status(run.runId, 'a', 'interrupted', attempt);
      const r = advanceRun(run, p, reg.probe, now);
      expect(r.dispatches).toEqual([{ nodeId: 'a', attempt: attempt + 1, round: 1 }]);
      run = execute(r.run, r.dispatches, reg);
    }
    reg.status(run.runId, 'a', 'interrupted', 4);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.run.status).toBe('failed');
    expect(receiptOf(r.run, 'a')?.detail).toMatch(/attempt 4 \(retry exhausted: 4 attempt/);
  });

  it('a DECLARED policy replaces the default wholesale: retry on [error] does NOT respawn an interruption', () => {
    const { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 3, on: ['error'] } }));
    reg.status(run.runId, 'a', 'interrupted', 1);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.dispatches).toEqual([]);
    expect(r.run.status).toBe('failed');
    expect(receiptOf(r.run, 'a')?.detail).toMatch(/retry does not cover interruptions/);
  });

  it('clamps a corrupt plan\'s maxAttempts at the hard ceiling (5) — planner totality', () => {
    const d = chain({ retry: { maxAttempts: 3, on: ['error'] } });
    const { run: minted, p } = mint(d);
    // Simulate a hand-built/corrupt plan that skipped validation.
    p.steps.find((s) => s.nodeId === 'a')!.retry = { maxAttempts: 99, on: ['error'] };
    const reg = probeMap();
    let run = execute(minted, advanceRun(minted, p, reg.probe, now).dispatches, reg);
    for (let attempt = 1; attempt <= 4; attempt++) {
      reg.status(run.runId, 'a', 'error', attempt);
      const r = advanceRun(run, p, reg.probe, now);
      expect(r.dispatches).toEqual([{ nodeId: 'a', attempt: attempt + 1, round: 1 }]);
      run = execute(r.run, r.dispatches, reg);
    }
    reg.status(run.runId, 'a', 'error', 5);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.dispatches).toEqual([]); // ceiling: attempt 5 is the last
    expect(r.run.status).toBe('failed');
  });

  it('retry runs BEFORE optional absorbs: an optional step retries, then skips on exhaustion', () => {
    let { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 2, on: ['error'] } }, { optional: true }));
    reg.status(run.runId, 'a', 'error', 1);
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(r1.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    run = execute(r1.run, r1.dispatches, reg);

    reg.status(run.runId, 'a', 'error', 2);
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r2.run, 'a')?.status).toBe('skipped');
    expect(r2.run.status).toBe('running'); // optional absorbed; b proceeds
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['b']);
  });
});

/* ── onError: continue ──────────────────────────────────────────────────────── */

describe('onError: continue (GRS-016b) — failed receipt, run proceeds', () => {
  it('settles the receipt FAILED yet the run continues; the successor dispatches and the run completes', () => {
    let { run, p, reg } = inFlightA(chain({ onError: 'continue' }));
    reg.status(run.runId, 'a', 'error', 1);
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r1.run, 'a')?.status).toBe('failed');
    expect(receiptOf(r1.run, 'a')?.detail).toMatch(/onError: continue/);
    expect(r1.run.status).toBe('running'); // no drain, no terminal
    expect(r1.run.stopping).toBeUndefined();
    expect(r1.dispatches.map((i) => i.nodeId)).toEqual(['b']); // failed pred counts resolved
    run = execute(r1.run, r1.dispatches, reg);

    reg.idle(run.runId, 'b');
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(r2.run.status).toBe('completed'); // run completes WITH a failed receipt
    expect(receiptOf(r2.run, 'a')?.status).toBe('failed');
    expect(r2.run.errors).toBeUndefined(); // the receipt is the evidence; the run did not fail
  });

  it('optional absorbs BEFORE onError: an optional continue step skips, not fails', () => {
    const { run, p, reg } = inFlightA(chain({ onError: 'continue' }, { optional: true }));
    reg.status(run.runId, 'a', 'error', 1);
    const r = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r.run, 'a')?.status).toBe('skipped');
  });

  it('composes with retry: exhaust the declared attempts, then continue instead of failing the run', () => {
    let { run, p, reg } = inFlightA(chain({ retry: { maxAttempts: 2, on: ['error'] }, onError: 'continue' }));
    reg.status(run.runId, 'a', 'error', 1);
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(r1.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    run = execute(r1.run, r1.dispatches, reg);
    reg.status(run.runId, 'a', 'error', 2);
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(receiptOf(r2.run, 'a')?.status).toBe('failed');
    expect(r2.run.status).toBe('running');
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['b']);
  });

  it('a spawn failure on a continue node keeps the run alive too', () => {
    const { run, p } = mint(chain({ onError: 'continue' }));
    const dispatched = markDispatching(run, 'a', 1, now);
    const failed = markSpawnFailure(dispatched, p, 'a', 'engine "codex" not available', now);
    expect(failed.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
    expect(failed.status).toBe('running');
    expect(failed.errors).toBeUndefined();
  });

  it('join readiness: a failed-continue branch resolves the wait-all join', () => {
    // trigger→a→(b ∥ c)→d, b continues on error.
    const d = def(
      [trigger, step('a'), step('b', { options: { onError: 'continue' } }), step('c'), step('d')],
      [e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    current = execute(r1.run, r1.dispatches, reg); // b ∥ c in flight

    reg.status(current.runId, 'b', 'error', 1);
    reg.idle(current.runId, 'c');
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(receiptOf(r2.run, 'b')?.status).toBe('failed');
    expect(receiptOf(r2.run, 'c')?.status).toBe('done');
    expect(r2.run.stopping).toBeUndefined();
    expect(r2.dispatches.map((i) => i.nodeId)).toEqual(['d']); // join resolved by failed+done
  });
});

/* ── Timeouts ───────────────────────────────────────────────────────────────── */

describe('timeoutMinutes (GRS-016b) — sweep-enforced, stop-intent + policy chain', () => {
  it('a session past its budget gets a STOP intent and fails the run under the default policy', () => {
    const { run, p, reg } = inFlightA(chain({ timeoutMinutes: 1 }));
    tick(MIN + 1_000); // 61s — budget breached
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.stops).toEqual([
      {
        nodeId: 'a', attempt: 1, round: 1,
        sessionId: `s:${stepSessionKey(run.runId, 'a', 1)}`,
        sessionKey: stepSessionKey(run.runId, 'a', 1),
        reason: expect.stringMatching(/step-timeout/),
      },
    ]);
    expect(receiptOf(r.run, 'a')?.status).toBe('failed');
    expect(receiptOf(r.run, 'a')?.detail).toMatch(/exceeded its 1-minute budget/);
    expect(r.run.status).toBe('failed');
    expect(r.run.errors?.map((x) => x.code)).toEqual(['step-timeout']);
  });

  it('a session UNDER its budget stays honestly in flight — no stop, no settle', () => {
    const { run, p, reg } = inFlightA(chain({ timeoutMinutes: 2 }));
    tick(MIN); // 60s of a 2-minute budget
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.stops).toBeUndefined();
    expect(receiptOf(r.run, 'a')?.status).toBe('running');
    expect(r.changed).toBe(false);
  });

  it('timeout is retryable ONLY as an explicit cause: DURABLE next-attempt intent + stop + fresh budget', () => {
    let { run, p, reg } = inFlightA(chain({ timeoutMinutes: 1, retry: { maxAttempts: 2, on: ['timeout'] } }));
    tick(MIN + 5_000);
    const r1 = advanceRun(run, p, reg.probe, now);
    expect(r1.stops?.length).toBe(1);
    expect(r1.dispatches).toEqual([{ nodeId: 'a', attempt: 2, round: 1 }]);
    // Mint-before-stop (GRS-016b-fix, Codex finding 1): the retry decision is a
    // DURABLE receipt transition in the same pass — dispatching @ attempt 2,
    // changed=true — persisted by the driver BEFORE the irreversible stop, so a
    // crash in the stop window leaves a recoverable intent, never a lost retry.
    expect(receiptOf(r1.run, 'a')?.status).toBe('dispatching');
    expect(receiptOf(r1.run, 'a')?.attempt).toBe(2);
    expect(r1.changed).toBe(true);
    run = execute(r1.run, r1.dispatches, reg); // dispatchedAt re-stamped at 65s

    tick(MIN + 30_000); // attempt 2 is only 25s old — inside ITS budget
    const r2 = advanceRun(run, p, reg.probe, now);
    expect(r2.stops).toBeUndefined();

    tick(3 * MIN); // attempt 2 now past its own budget → exhausted → fail
    const r3 = advanceRun(run, p, reg.probe, now);
    expect(r3.stops?.length).toBe(1);
    expect(r3.stops?.[0]?.attempt).toBe(2);
    expect(r3.run.status).toBe('failed');
    expect(r3.run.errors?.map((x) => x.code)).toEqual(['step-timeout']);
  });

  it('an OPTIONAL step\'s timeout degrades to skipped — with the session still stopped', () => {
    const { run, p, reg } = inFlightA(chain({ timeoutMinutes: 1 }, { optional: true }));
    tick(MIN + 1_000);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.stops?.length).toBe(1);
    expect(receiptOf(r.run, 'a')?.status).toBe('skipped');
    expect(receiptOf(r.run, 'a')?.detail).toMatch(/exceeded its 1-minute budget/);
    expect(r.run.status).toBe('running');
    expect(r.dispatches.map((i) => i.nodeId)).toEqual(['b']);
  });

  it('onError continue + timeout: receipt failed, session stopped, run proceeds', () => {
    const { run, p, reg } = inFlightA(chain({ timeoutMinutes: 1, onError: 'continue' }));
    tick(MIN + 1_000);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.stops?.length).toBe(1);
    expect(receiptOf(r.run, 'a')?.status).toBe('failed');
    expect(r.run.status).toBe('running');
    expect(r.dispatches.map((i) => i.nodeId)).toEqual(['b']);
  });

  it('a WAITING session times out like a running one', () => {
    const { run, p, reg } = inFlightA(chain({ timeoutMinutes: 1 }));
    reg.status(run.runId, 'a', 'waiting', 1);
    tick(MIN + 1_000);
    const r = advanceRun(run, p, reg.probe, now);
    expect(r.stops?.length).toBe(1);
    expect(r.run.status).toBe('failed');
  });

  it('bounds the DRAIN: a timed-out sibling settles during stopping and the terminal folds both errors', () => {
    // trigger→a→(b ∥ c)→d; b fails (fail-run) while c is in flight with a budget.
    const d = def(
      [trigger, step('a'), step('b'), step('c', { options: { timeoutMinutes: 1 } }), step('d')],
      [e('trg', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg);
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    current = execute(r1.run, r1.dispatches, reg); // b ∥ c in flight

    reg.status(current.runId, 'b', 'error', 1);
    const r2 = advanceRun(current, p, reg.probe, now);
    expect(r2.run.stopping?.to).toBe('failed'); // drain: c still live
    expect(r2.run.status).toBe('running');
    current = r2.run;

    tick(MIN + 1_000); // c breaches its budget while the run drains
    const r3 = advanceRun(current, p, reg.probe, now);
    expect(r3.stops?.length).toBe(1);
    expect(r3.stops?.[0]?.nodeId).toBe('c');
    expect(receiptOf(r3.run, 'c')?.status).toBe('failed');
    expect(r3.run.status).toBe('failed'); // last in-flight settled → drain terminal
    expect(r3.run.errors?.map((x) => x.code)).toEqual(['step-errored', 'step-timeout']);
    expect(r3.dispatches).toEqual([]);
  });
});

/* ── Output modes ───────────────────────────────────────────────────────────── */

const TEXT_WITH_BLOCK = [
  'I did the thing. Full prose here.',
  '```handoff',
  '{ "summary": "declared summary", "artifacts": ["x.md"], "notes": "n" }',
  '```',
].join('\n');

describe('output mode (GRS-016b) — handoff (default) vs full', () => {
  it('output:"full" skips block extraction: the outcome is the tail-capped final message only', () => {
    const { run, p, reg } = inFlightA(chain({ output: 'full' }));
    reg.idle(run.runId, 'a', 1, 1, TEXT_WITH_BLOCK);
    const r = advanceRun(run, p, reg.probe, now);
    const outcome = receiptOf(r.run, 'a')?.outcome;
    expect(outcome?.extractedFrom).toBe('final-message');
    expect(outcome?.summary).toBeUndefined();
    expect(outcome?.artifacts).toBeUndefined();
    expect(outcome?.finalMessage).toContain('declared summary'); // raw material preserved verbatim
  });

  it('the DEFAULT still extracts the declared block (control)', () => {
    const { run, p, reg } = inFlightA(chain());
    reg.idle(run.runId, 'a', 1, 1, TEXT_WITH_BLOCK);
    const r = advanceRun(run, p, reg.probe, now);
    const outcome = receiptOf(r.run, 'a')?.outcome;
    expect(outcome?.extractedFrom).toBe('handoff-block');
    expect(outcome?.summary).toBe('declared summary');
  });

  it('the parked probe-only pass honors output:"full" too', () => {
    // trigger→a→approval-gate; trigger→c(full, long) — park while c is in flight.
    const gate: WorkflowNode = {
      id: 'g', type: 'gate', label: 'G', position: { x: 0, y: 0 },
      gate: { kind: 'approval', description: 'approve', approvalRef: 'ap-g' },
    };
    const d = def(
      [trigger, step('a'), gate, step('c', { options: { output: 'full' } })],
      [e('trg', 'a'), e('a', 'g'), e('trg', 'c')],
      { concurrency: 2 },
    );
    const { run, p } = mint(d);
    const reg = probeMap();
    let current = execute(run, advanceRun(run, p, reg.probe, now).dispatches, reg); // a ∥ c
    reg.idle(current.runId, 'a');
    const r1 = advanceRun(current, p, reg.probe, now);
    expect(r1.run.status).toBe('parked'); // gate rings while c is live
    current = r1.run;

    reg.idle(current.runId, 'c', 1, 1, TEXT_WITH_BLOCK);
    const r2 = advanceRun(current, p, reg.probe, now); // probe-only pass
    expect(r2.run.status).toBe('parked');
    const outcome = receiptOf(r2.run, 'c')?.outcome;
    expect(receiptOf(r2.run, 'c')?.status).toBe('done');
    expect(outcome?.extractedFrom).toBe('final-message');
    expect(outcome?.summary).toBeUndefined();
  });
});
