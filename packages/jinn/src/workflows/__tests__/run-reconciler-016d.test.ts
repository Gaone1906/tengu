import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startWorkflowRun,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { stepSessionKey, type SpawnContext, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import { getRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016d integration tier — the three features through the REAL driver + stores:
 * a failing step routes down its error lane (the error-branch prompt carries the
 * engine-generated failure notice with error-edge wording, the success branch
 * skips, the run completes); a fire-and-forget step settles `fired` at spawn (the
 * run completes without its session ever going idle, and the successor's prompt
 * carries no handoff from it); a wait node pauses the run and the sweep resumes it
 * — including across a simulated restart (fresh harness over the persisted file).
 */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function makeDef(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id, title: id, version: 1, status: 'active', nodes, edges };
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-016d-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function harness(now: () => string) {
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
  const settle = (runId: string, nodeId: string, probe: Partial<StepSessionProbe>, attempt = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, 1);
    sessions.set(key, { found: true, sessionId: `sess:${nodeId}:${attempt}`, ...probe });
  };
  return { deps, spawnCalls, settle, sessions };
}

describe('GRS-016d error lane through the real driver', () => {
  const now = () => '2026-07-05T09:00:00.000Z';

  it('a session error routes the error lane: rescue runs with the failure notice, ok skips, run completes', async () => {
    const def = createDefinition(root, makeDef('lane', [
      trigger,
      step('a', { options: { onError: 'error-edge' } }),
      step('ok'),
      step('rescue', { label: 'Rescue' }),
    ], [
      e('trg', 'a'), e('a', 'ok'), e('a', 'rescue', { lane: 'error' }),
    ]), { now });
    const { deps, spawnCalls, settle } = harness(now);
    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('running');

    settle(run.runId, 'a', { status: 'error' });
    await sweepWorkflowRuns(deps);
    let after = getRun(root, def.id, run.runId)!;
    expect(after.steps.find((s) => s.nodeId === 'a')!.status).toBe('failed');
    expect(after.steps.find((s) => s.nodeId === 'ok')!.status).toBe('skipped');
    expect(after.status).toBe('running');

    // The error-branch prompt carries the engine-generated notice, error-edge worded.
    const rescuePrompt = spawnCalls.find((c) => c.nodeId === 'rescue')!.prompt;
    expect(rescuePrompt).toContain('Predecessor "A" (codex) FAILED');
    expect(rescuePrompt).toContain('routed to this error branch by policy (onError: error-edge)');
    expect(rescuePrompt).not.toContain('handoff-data'); // no fabricated outcome

    settle(run.runId, 'rescue', { status: 'idle', finalAssistantText: 'cleaned up.' });
    await sweepWorkflowRuns(deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.errors ?? []).toEqual([]);
  });
});

describe('GRS-016d-fix — the prompt frame collects ACTIVE in-edges only (Codex finding 1)', () => {
  const now = () => '2026-07-05T09:00:00.000Z';

  it("the reviewer's repro: a failed error-edge predecessor's INACTIVE normal edge leaks nothing into a join reached via another live path", async () => {
    const def = createDefinition(root, {
      ...makeDef('inactive-leak', [
        trigger,
        step('boom', { label: 'Boom', options: { onError: 'error-edge' } }),
        step('other', { label: 'Other' }),
        step('rescue', { label: 'Rescue' }),
        step('join', { label: 'Join' }),
      ], [
        e('trg', 'boom'), e('trg', 'other'),
        e('boom', 'rescue', { lane: 'error' }),
        e('boom', 'join'),
        e('other', 'join'),
      ]),
      concurrency: 2,
    }, { now });
    const { deps, spawnCalls, settle } = harness(now);
    const run = await startWorkflowRun(deps, def);
    settle(run.runId, 'boom', { status: 'error' });
    settle(run.runId, 'other', {
      status: 'idle',
      finalAssistantText: 'other work\n\n```handoff\n{"summary":"Other finished its part."}\n```\n',
    });
    await sweepWorkflowRuns(deps);
    settle(run.runId, 'rescue', { status: 'idle', finalAssistantText: 'rescued.' });
    await sweepWorkflowRuns(deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.steps.find((s) => s.nodeId === 'boom')!.status).toBe('failed');

    // join became ready through OTHER's live edge; boom's normal edge is inactive.
    const joinPrompt = spawnCalls.find((c) => c.nodeId === 'join')!.prompt;
    expect(joinPrompt).toContain('Handoff from "Other"');
    expect(joinPrompt).toContain('Other finished its part.');
    expect(joinPrompt).not.toContain('Boom'); // no failure notice from the inactive edge
    expect(joinPrompt).not.toContain('FAILED');

    // The error-lane successor still gets the policy-worded notice — through the
    // edge the run actually traversed.
    const rescuePrompt = spawnCalls.find((c) => c.nodeId === 'rescue')!.prompt;
    expect(rescuePrompt).toContain('Predecessor "Boom" (codex) FAILED');
    expect(rescuePrompt).toContain('routed to this error branch by policy (onError: error-edge)');
  });

  it('a NOT-taken switch out-edge passes no material through: the join sees only the taken branch', async () => {
    const def = createDefinition(root, makeDef('sw-leak', [
      trigger,
      step('review', { label: 'Review' }),
      { id: 'sw', type: 'switch', label: 'Route', position: { x: 0, y: 0 } },
      step('a', { label: 'ShipWork' }),
      step('j', { label: 'Join' }),
    ], [
      e('trg', 'review'), e('review', 'sw'),
      e('sw', 'a', { when: [{ path: 'steps.review.outcome.fields.verdict', op: 'eq', value: 'ship' }] }),
      e('sw', 'j'), // the default branch — NOT taken when verdict=ship
      e('a', 'j'),
    ]), { now });
    const { deps, spawnCalls, settle } = harness(now);
    const run = await startWorkflowRun(deps, def);
    settle(run.runId, 'review', {
      status: 'idle',
      finalAssistantText: 'reviewed\n\n```handoff\n{"summary":"Review says ship.","fields":{"verdict":"ship"}}\n```\n',
    });
    await sweepWorkflowRuns(deps);
    settle(run.runId, 'a', {
      status: 'idle',
      finalAssistantText: 'shipped\n\n```handoff\n{"summary":"Ship work done."}\n```\n',
    });
    await sweepWorkflowRuns(deps);

    // a got review's handoff THROUGH the taken edge (016c pass-through intact)…
    const aPrompt = spawnCalls.find((c) => c.nodeId === 'a')!.prompt;
    expect(aPrompt).toContain('Handoff from "Review"');
    // …but j is fed by the NOT-taken default edge + a's live edge: only a's
    // material may appear — review must not leak through the dead branch.
    const jPrompt = spawnCalls.find((c) => c.nodeId === 'j')!.prompt;
    expect(jPrompt).toContain('Handoff from "ShipWork"');
    expect(jPrompt).not.toContain('Handoff from "Review"');

    settle(run.runId, 'j', { status: 'idle', finalAssistantText: 'joined.' });
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, run.runId)!.status).toBe('completed');
  });

  it('an all-active fan-in still receives every handoff (no regression to the normal case)', async () => {
    const def = createDefinition(root, {
      ...makeDef('fanin-ok', [
        trigger, step('x', { label: 'X' }), step('y', { label: 'Y' }), step('join', { label: 'Join' }),
      ], [
        e('trg', 'x'), e('trg', 'y'), e('x', 'join'), e('y', 'join'),
      ]),
      concurrency: 2,
    }, { now });
    const { deps, spawnCalls, settle } = harness(now);
    const run = await startWorkflowRun(deps, def);
    settle(run.runId, 'x', { status: 'idle', finalAssistantText: 'x\n\n```handoff\n{"summary":"X done."}\n```\n' });
    settle(run.runId, 'y', { status: 'idle', finalAssistantText: 'y\n\n```handoff\n{"summary":"Y done."}\n```\n' });
    await sweepWorkflowRuns(deps);
    const joinPrompt = spawnCalls.find((c) => c.nodeId === 'join')!.prompt;
    expect(joinPrompt).toContain('Handoff from "X"');
    expect(joinPrompt).toContain('Handoff from "Y"');
  });
});

describe("GRS-016d output:'none' through the real driver", () => {
  const now = () => '2026-07-05T09:00:00.000Z';

  it('the receipt settles fired at spawn; the run completes while the fired session is still running; the successor gets no handoff from it', async () => {
    const def = createDefinition(root, makeDef('fnf', [
      trigger,
      step('fire', { options: { output: 'none' } }),
      step('next'),
    ], [
      e('trg', 'fire'), e('fire', 'next'),
    ]), { now });
    const { deps, spawnCalls, settle, sessions } = harness(now);
    const run = await startWorkflowRun(deps, def);

    // Fired at spawn, in the same drive; the successor dispatched immediately.
    let after = getRun(root, def.id, run.runId)!;
    const fire = after.steps.find((s) => s.nodeId === 'fire')!;
    expect(fire.status).toBe('fired');
    expect(fire.sessionId).toBe('sess:fire:1');
    expect(fire.settledAt).toBeTruthy();
    expect(fire.outcome).toBeUndefined();
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['fire', 'next']);

    // The fired session NEVER goes idle — and the run completes anyway.
    expect(sessions.get(stepSessionKey(run.runId, 'fire', 1))?.status).toBe('running');
    settle(run.runId, 'next', { status: 'idle', finalAssistantText: 'done.' });
    await sweepWorkflowRuns(deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');

    // No handoff section (and no failure notice) from the fired predecessor.
    const nextPrompt = spawnCalls.find((c) => c.nodeId === 'next')!.prompt;
    expect(nextPrompt).not.toContain('Handoff from "FIRE"');
    expect(nextPrompt).not.toContain('FAILED');
    // The fire-and-forget node still gets its own prompt with the task text.
    expect(spawnCalls.find((c) => c.nodeId === 'fire')!.prompt).toContain('Your task');
  });
});

describe('GRS-016d wait node through the real driver', () => {
  it('the run pauses on waiting (no dispatch), the sweep settles it after the deadline, and the successor runs', async () => {
    let clock = '2026-07-05T09:00:00.000Z';
    const now = () => clock;
    const def = createDefinition(root, makeDef('waitrun', [
      trigger, step('a'),
      { id: 'w', type: 'wait', label: 'Cool down', position: { x: 0, y: 0 }, waitMinutes: 2 },
      step('b'),
    ], [
      e('trg', 'a'), e('a', 'w'), e('w', 'b'),
    ]), { now });
    const { deps, spawnCalls, settle } = harness(now);
    const run = await startWorkflowRun(deps, def);
    settle(run.runId, 'a', { status: 'idle', finalAssistantText: 'a done.' });
    await sweepWorkflowRuns(deps);

    let after = getRun(root, def.id, run.runId)!;
    const w = after.steps.find((s) => s.nodeId === 'w')!;
    expect(w.status).toBe('waiting');
    expect(w.readyAt).toBe('2026-07-05T09:02:00.000Z');
    expect(after.status).toBe('running');
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a']); // b not dispatched

    // A sweep before the deadline holds.
    clock = '2026-07-05T09:01:00.000Z';
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'w')!.status).toBe('waiting');

    // A sweep after the deadline settles + dispatches b.
    clock = '2026-07-05T09:02:10.000Z';
    await sweepWorkflowRuns(deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.steps.find((s) => s.nodeId === 'w')!.status).toBe('checkpoint');
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['a', 'b']);

    settle(run.runId, 'b', { status: 'idle', finalAssistantText: 'b done.' });
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, run.runId)!.status).toBe('completed');
  });

  it('survives a restart: a FRESH harness over the persisted record resumes from readyAt alone', async () => {
    let clock = '2026-07-05T09:00:00.000Z';
    const now = () => clock;
    const def = createDefinition(root, makeDef('waitboot', [
      trigger,
      { id: 'w', type: 'wait', label: 'Overnight', position: { x: 0, y: 0 }, waitMinutes: 5 },
      step('b'),
    ], [
      e('trg', 'w'), e('w', 'b'),
    ]), { now });
    const first = harness(now);
    const run = await startWorkflowRun(first.deps, def);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'w')!.status).toBe('waiting');

    // "Restart": a brand-new harness (empty session registry, new deps object) —
    // the only state is the run file on disk. The startup sweep resumes the wait.
    clock = '2026-07-05T09:06:00.000Z';
    const second = harness(now);
    await sweepWorkflowRuns(second.deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.steps.find((s) => s.nodeId === 'w')!.status).toBe('checkpoint');
    expect(second.spawnCalls.map((c) => c.nodeId)).toEqual(['b']);

    second.settle(run.runId, 'b', { status: 'idle', finalAssistantText: 'b done.' });
    await sweepWorkflowRuns(second.deps);
    expect(getRun(root, def.id, run.runId)!.status).toBe('completed');
  });

  it('a legacy-shaped record with an in-flight sibling and a waiting receipt drains honestly when the sibling fails', async () => {
    // Belt-and-braces on the store contract: a terminal record never carries a
    // live-looking `waiting` receipt (the cancelWaitingReceipts rule) — driven
    // through the real sweep by failing a sibling while a wait is pending.
    let clock = '2026-07-05T09:00:00.000Z';
    const now = () => clock;
    const def = createDefinition(root, makeDef('waitdrain', [
      trigger, step('x'),
      { id: 'w', type: 'wait', label: 'Long wait', position: { x: 0, y: 0 }, waitMinutes: 60 },
      step('b'),
    ], [
      e('trg', 'x'), e('trg', 'w'), e('w', 'b'),
    ]), { now });
    // concurrency 2 so x and w arm together
    const parallel = { ...getDefinition(root, 'waitdrain')!, concurrency: 2 };
    const h = harness(now);
    const run = await startWorkflowRun(h.deps, parallel);
    expect(getRun(root, 'waitdrain', run.runId)!.steps.find((s) => s.nodeId === 'w')!.status).toBe('waiting');

    h.settle(run.runId, 'x', { status: 'error' });
    await sweepWorkflowRuns(h.deps);
    const after = getRun(root, 'waitdrain', run.runId)!;
    expect(after.status).toBe('failed');
    expect(after.steps.find((s) => s.nodeId === 'w')!.status).toBe('skipped');
    expect(after.steps.find((s) => s.nodeId === 'w')!.detail).toContain('wait cancelled');
  });
});
