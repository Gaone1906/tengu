import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startWorkflowRun,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import {
  correlateSessionTurn,
  sharedSessionKey,
  stepSessionKey,
  turnMarkerFor,
  type FollowUpContext,
  type SpawnContext,
  type StepSessionStatus,
} from '../advance.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import { getRun, saveRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016e integration tier — session modes through the REAL driver + stores.
 *
 * The fake session model mirrors the gateway's session DB (persists across
 * "restarts" — a fresh harness over the same model is a fresh gateway over the
 * same sqlite): messages are an ordered log, the turn probe correlates by the
 * persisted turnMarker (marker user message present → posted; FIRST non-partial
 * assistant message AFTER the marker → the step's reply), exactly the contract
 * the gateway-side probe implements.
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
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-016e-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

interface FakeMessage { id: string; role: string; content: string; partial?: boolean }
interface FakeSession { id: string; status: StepSessionStatus; messages: FakeMessage[] }

/** The gateway session DB stand-in — survives harness "restarts" by construction.
 * Every row carries a durable id (the anchor identity, GRS-016e-fix). */
function makeSessionModel() {
  const byId = new Map<string, FakeSession>();
  const byKey = new Map<string, string>();
  let n = 0;
  let m = 0;
  const row = (role: string, content: string): FakeMessage => ({ id: `msg-${++m}`, role, content });
  return {
    byId,
    byKey,
    row,
    create(key: string, prompt: string, promptRowId?: string): FakeSession {
      const promptRow = promptRowId ? { id: promptRowId, role: 'user', content: prompt } : row('user', prompt);
      const s: FakeSession = { id: `sess-${++n}`, status: 'running', messages: [promptRow] };
      byId.set(s.id, s);
      byKey.set(key, s.id);
      return s;
    },
    createBare(id: string, status: StepSessionStatus = 'idle'): FakeSession {
      const s: FakeSession = { id, status, messages: [] };
      byId.set(id, s);
      return s;
    },
    /** Append an assistant reply and settle the session idle. */
    reply(id: string, text: string): void {
      const s = byId.get(id)!;
      s.messages.push(row('assistant', text));
      s.status = 'idle';
    },
  };
}
type SessionModel = ReturnType<typeof makeSessionModel>;

function harness(now: () => string, model: SessionModel) {
  const spawnCalls: SpawnContext[] = [];
  const followUps: FollowUpContext[] = [];
  let turnProbes = 0;
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => {
      const id = model.byKey.get(key);
      const s = id ? model.byId.get(id) : undefined;
      if (!s) return { found: false };
      let finalAssistantText: string | null | undefined;
      if (s.status === 'idle') {
        const last = [...s.messages].reverse().find((m) => m.role === 'assistant' && !m.partial);
        finalAssistantText = last ? last.content : null;
      }
      return { found: true, sessionId: s.id, status: s.status, ...(finalAssistantText !== undefined ? { finalAssistantText } : {}) };
    },
    // The REAL row-anchored correlator (GRS-016e-fix): the fake probe consumes
    // `correlateSessionTurn` itself, so harness and gateway can never drift.
    probeSessionTurn: ({ sessionId, marker, anchor }) => {
      turnProbes++;
      const s = model.byId.get(sessionId);
      if (!s) return { found: false };
      const c = correlateSessionTurn(s.messages, { marker, ...(anchor ? { anchor } : {}) });
      return {
        found: true,
        status: s.status,
        markerPosted: c.markerPosted,
        ...(c.superseded ? { superseded: true } : {}),
        ...(s.status === 'idle' && c.markerPosted ? { replyText: c.replyText } : {}),
      };
    },
    spawnStep: async (ctx) => {
      spawnCalls.push(ctx);
      const key = ctx.sessionKey ?? stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const s = model.create(key, ctx.prompt, ctx.anchorMessageId);
      return { sessionId: s.id };
    },
    postStepFollowUp: async (ctx) => {
      followUps.push(ctx);
      // Race window hook (GRS-016e-fix, Codex finding 2): fires BETWEEN the
      // planner's busy probe and the post's own atomic check — exactly where an
      // operator message can land in the real gateway.
      hooks.onBeforePost?.(ctx);
      const s = model.byId.get(ctx.sessionId);
      if (!s) throw new Error(`target session "${ctx.sessionId}" not found`);
      // The atomic busy-reserve (mirrors the gateway's await-free segment): a
      // busy — or became-busy — target defers instead of inserting. Dispatch-
      // started mark BEFORE the insert (GRS-016e-fix3): an anchored row can never
      // exist without the durable 'running' evidence boot recovery keys on.
      if (s.status === 'running' || s.status === 'waiting') {
        return { outcome: 'deferred' as const, reason: `target session ${s.id} is busy (status ${s.status})` };
      }
      s.status = 'running';
      s.messages.push({ id: ctx.anchorMessageId, role: 'user', content: ctx.prompt });
      return { outcome: 'posted' as const, sessionId: s.id };
    },
    sessionExists: (id) => model.byId.has(id),
    now,
  };
  const hooks: { onBeforePost?: (ctx: FollowUpContext) => void } = {};
  return { deps, spawnCalls, followUps, turnProbes: () => turnProbes, hooks };
}

const now = () => '2026-07-05T12:00:00.000Z';
const handoff = (summary: string) => `work done\n\n\`\`\`handoff\n{"summary":"${summary}"}\n\`\`\`\n`;

describe('GRS-016e workflow-shared session mode', () => {
  it('two workflow-mode steps run as two marker-correlated turns of ONE session, the second seeing the first handoff', async () => {
    const def = createDefinition(root, makeDef('shared-chain', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } }, instructions: 'do part one' }),
      step('b', { options: { session: { mode: 'workflow' } }, instructions: 'do part two' }),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(run.status).toBe('running');

    // The first workflow-mode node CREATES the shared session under the shared key,
    // with its turn marker embedded in the prompt; the id is persisted on the run.
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].sessionKey).toBe(sharedSessionKey(run.runId));
    const aMarker = turnMarkerFor(run.runId, 'a', 1, 1);
    expect(h.spawnCalls[0].prompt).toContain(aMarker);
    let persisted = getRun(root, def.id, run.runId)!;
    const sharedId = persisted.sharedSessionId!;
    expect(sharedId).toBeTruthy();
    const aReceipt = persisted.steps.find((s) => s.nodeId === 'a')!;
    expect(aReceipt.status).toBe('running');
    expect(aReceipt.sessionId).toBe(sharedId);
    expect(aReceipt.turnMarker).toBe(aMarker);

    // First turn settles → a done (outcome from the post-marker reply), b posts a
    // FOLLOW-UP into the same session (no second spawn) carrying a's handoff.
    model.reply(sharedId, handoff('A finished part one.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.steps.find((s) => s.nodeId === 'a')!.status).toBe('done');
    expect(persisted.steps.find((s) => s.nodeId === 'a')!.outcome?.summary).toBe('A finished part one.');
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0].sessionId).toBe(sharedId);
    const bMarker = turnMarkerFor(run.runId, 'b', 1, 1);
    expect(h.followUps[0].prompt).toContain(bMarker);
    expect(h.followUps[0].prompt).toContain('Handoff from "A"');
    const bReceipt = persisted.steps.find((s) => s.nodeId === 'b')!;
    expect(bReceipt.status).toBe('running');
    expect(bReceipt.sessionId).toBe(sharedId);
    expect(bReceipt.turnMarker).toBe(bMarker);

    // Second turn settles → completed; both receipts share the ONE session id.
    model.reply(sharedId, handoff('B finished part two.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.outcome?.summary).toBe('B finished part two.');
    expect(persisted.steps.map((s) => s.sessionId)).toEqual([sharedId, sharedId]);
    // The session log reads as a plain conversation: a prompt, a reply, b prompt, b reply.
    expect(model.byId.get(sharedId)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('concurrent-ready workflow-mode steps SERIALIZE on the shared session instead of interleaving it', async () => {
    const def = createDefinition(root, {
      ...makeDef('shared-serial', [
        trigger,
        step('a', { options: { session: { mode: 'workflow' } } }),
        step('b', { options: { session: { mode: 'workflow' } } }),
      ], [e('trg', 'a'), e('trg', 'b')]),
      concurrency: 2,
    }, { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);

    // Both are edge-ready under concurrency 2 — but only ONE turn may be
    // outstanding on the shared session: a dispatched, b held ready-but-undispatched.
    let persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.steps.find((s) => s.nodeId === 'a')!.status).toBe('running');
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.status).toBe('pending');
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.followUps).toHaveLength(0);

    const sharedId = persisted.sharedSessionId!;
    model.reply(sharedId, handoff('A done.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.status).toBe('running');
    expect(h.followUps).toHaveLength(1);

    model.reply(sharedId, handoff('B done.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    // Strictly alternating turns — the serialization contract.
    expect(model.byId.get(sharedId)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('a superseded shared turn (idle with NO assistant message after the marker) is an honest no-output failure — an EARLIER reply is never mis-adopted', async () => {
    const def = createDefinition(root, makeDef('shared-noout', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    const sharedId = getRun(root, def.id, run.runId)!.sharedSessionId!;
    model.reply(sharedId, handoff('A done.'));
    await sweepWorkflowRuns(h.deps);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'b')!.status).toBe('running');

    // The session settles idle WITHOUT replying to b's marker. a's earlier reply
    // sits in the log BEFORE the marker — correlation must not claim it for b.
    model.byId.get(sharedId)!.status = 'idle';
    await sweepWorkflowRuns(h.deps);
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('failed');
    const b = persisted.steps.find((s) => s.nodeId === 'b')!;
    expect(b.status).toBe('failed');
    expect(b.detail).toContain('no output');
  });

  it('a shared-session turn that ends in error routes the ordinary error cause', async () => {
    const def = createDefinition(root, makeDef('shared-err', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a')]), { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    const sharedId = getRun(root, def.id, run.runId)!.sharedSessionId!;
    model.byId.get(sharedId)!.status = 'error';
    await sweepWorkflowRuns(h.deps);
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('failed');
    expect(persisted.errors?.[0]?.code).toBe('step-errored');
  });
});

describe('GRS-016e restart durability (marker + expected turn re-derived from the record alone)', () => {
  it('a restart mid-shared-turn re-correlates: a FRESH harness settles the running step from the persisted marker', async () => {
    const def = createDefinition(root, makeDef('shared-boot', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);
    const sharedId = getRun(root, def.id, run.runId)!.sharedSessionId!;
    model.reply(sharedId, handoff('A done.'));
    await sweepWorkflowRuns(first.deps);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'b')!.status).toBe('running');

    // "Restart": new deps, zero in-memory state; the session DB (model) persists.
    model.reply(sharedId, handoff('B done after the restart.'));
    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.outcome?.summary).toBe('B done after the restart.');
    expect(second.followUps).toHaveLength(0); // adopted, never re-posted
  });

  it('crash AFTER the follow-up posted but BEFORE running persisted → the marker probe ADOPTS, no duplicate post', async () => {
    const def = createDefinition(root, makeDef('shared-adopt', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);
    const sharedId = getRun(root, def.id, run.runId)!.sharedSessionId!;
    model.reply(sharedId, handoff('A done.'));
    await sweepWorkflowRuns(first.deps);

    // Simulate the crash window: rewind b's persisted receipt to `dispatching`.
    // The anchor SURVIVES this window by construction (GRS-016e-fix2): it is
    // pre-minted and persisted in the SAME write as the dispatching mark, so the
    // recovery probe disambiguates purely by row id.
    const record = getRun(root, def.id, run.runId)!;
    const b = record.steps.find((s) => s.nodeId === 'b')!;
    b.status = 'dispatching';
    delete b.sessionId;
    saveRun(root, record);

    model.reply(sharedId, handoff('B done.'));
    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.sessionId).toBe(sharedId);
    expect(second.followUps).toHaveLength(0); // adopted from the marker, not re-posted
  });

  it('crash BEFORE the follow-up posted → the same attempt is RE-POSTED (marker absent from the log)', async () => {
    const def = createDefinition(root, makeDef('shared-repost', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);
    const sharedId = getRun(root, def.id, run.runId)!.sharedSessionId!;
    model.reply(sharedId, handoff('A done.'));
    await sweepWorkflowRuns(first.deps);

    // Simulate: the mint (dispatching + marker + pre-minted anchor) persisted,
    // the post never happened — no row with the anchor id exists.
    const record = getRun(root, def.id, run.runId)!;
    const b = record.steps.find((s) => s.nodeId === 'b')!;
    b.status = 'dispatching';
    delete b.sessionId;
    saveRun(root, record);
    const session = model.byId.get(sharedId)!;
    session.messages = session.messages.filter((m) => !m.content.includes(turnMarkerFor(run.runId, 'b', 1, 1)));
    session.status = 'idle';

    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    expect(second.followUps).toHaveLength(1); // SAME attempt re-posted
    expect(second.followUps[0].prompt).toContain(turnMarkerFor(run.runId, 'b', 1, 1));
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.steps.find((s) => s.nodeId === 'b')!.status).toBe('running');
  });
});

describe('GRS-016e existing-session mode', () => {
  it('an existing-mode step posts a marker-correlated follow-up into the operator-picked session', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('existing-happy', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0].sessionId).toBe('op-1');
    expect(h.followUps[0].prompt).toContain(turnMarkerFor(run.runId, 'x', 1, 1));
    let persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.steps[0].status).toBe('running');
    expect(persisted.steps[0].sessionId).toBe('op-1');

    model.reply('op-1', handoff('Handled in the live session.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.steps[0].outcome?.summary).toBe('Handled in the live session.');
  });

  it('a BUSY existing target defers the dispatch until the session is idle (never interleaves a live turn)', async () => {
    const model = makeSessionModel();
    model.createBare('op-1', 'running');
    const def = createDefinition(root, makeDef('existing-busy', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(h.followUps).toHaveLength(0);
    expect(getRun(root, def.id, run.runId)!.steps[0].status).toBe('pending');

    model.byId.get('op-1')!.status = 'idle';
    await sweepWorkflowRuns(h.deps);
    expect(h.followUps).toHaveLength(1);
    expect(getRun(root, def.id, run.runId)!.steps[0].status).toBe('running');
  });

  it('a target deleted BEFORE the run starts fails the run honestly at start (unknown-session-target)', async () => {
    const model = makeSessionModel(); // op-1 never created
    const def = createDefinition(root, makeDef('existing-gone', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(run.status).toBe('failed');
    expect(run.errors?.[0]?.code).toBe('unknown-session-target');
    expect(run.errors?.[0]?.ref).toBe('x');
    expect(h.followUps).toHaveLength(0);
  });

  it('a target that vanishes MID-RUN fails through the declared retry/onError policy instead of wedging', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('existing-vanish', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' }, onError: 'continue' } }),
      step('y'),
    ], [e('trg', 'x'), e('x', 'y')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'x')!.status).toBe('running');

    // The operator deletes the session while the step is in flight: the vanished
    // session routes 'interrupted' → the default respawn-once RE-POSTS attempt 2 →
    // the post fails honestly → onError:'continue' keeps the run alive.
    model.byId.delete('op-1');
    await sweepWorkflowRuns(h.deps);
    let persisted = getRun(root, def.id, run.runId)!;
    const x = persisted.steps.find((s) => s.nodeId === 'x')!;
    expect(x.status).toBe('failed');
    expect(x.detail).toContain('spawn failed');
    expect(persisted.status).toBe('running'); // y proceeds

    const yKey = stepSessionKey(run.runId, 'y', 1, 1);
    const yId = model.byKey.get(yKey)!;
    model.reply(yId, handoff('Y done.'));
    await sweepWorkflowRuns(h.deps);
    persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.errors ?? []).toEqual([]);
  });

  it('two existing-mode steps targeting the SAME session serialize like the shared mode', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, {
      ...makeDef('existing-serial', [
        trigger,
        step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
        step('y', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
      ], [e('trg', 'x'), e('trg', 'y')]),
      concurrency: 2,
    }, { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(h.followUps).toHaveLength(1);
    expect(getRun(root, def.id, run.runId)!.steps.find((s) => s.nodeId === 'y')!.status).toBe('pending');

    model.reply('op-1', handoff('X done.'));
    await sweepWorkflowRuns(h.deps);
    expect(h.followUps).toHaveLength(2);
    model.reply('op-1', handoff('Y done.'));
    await sweepWorkflowRuns(h.deps);
    expect(getRun(root, def.id, run.runId)!.status).toBe('completed');
    expect(model.byId.get('op-1')!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('GRS-016e-fix — Codex round-1 regressions (row-index anchor + atomic busy-reserve)', () => {
  it('MARKER ECHO (finding 1): an assistant reply that CONTAINS the marker string still settles the step — correlation anchors to the inserted user ROW, not marker text', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('fix-echo', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(getRun(root, def.id, run.runId)!.steps[0].status).toBe('running');

    // The model ECHOES the workflow-turn marker line verbatim before answering —
    // the Codex live repro (codex016e-marker-echo): a correct answer that the
    // string-matching probe mistook for the marker row itself.
    const echo = `[workflow-turn ${turnMarkerFor(run.runId, 'x', 1, 1)}] acknowledged.\n\n${handoff('ECHO-DONE')}`;
    model.reply('op-1', echo);
    await sweepWorkflowRuns(h.deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].status).toBe('done');
    expect(after.steps[0].outcome?.summary).toBe('ECHO-DONE');
  });

  it('INTERLEAVE RACE (finding 2): an operator message landing between the busy probe and the post defers the post — the workflow NEVER adopts the operator reply and consumes no attempt', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('fix-race', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    // The TOCTOU window: the planner probed idle; the operator's message lands
    // BEFORE the workflow's insert. The atomic check inside the post must catch it.
    h.hooks.onBeforePost = () => {
      h.hooks.onBeforePost = undefined; // once
      const s = model.byId.get('op-1')!;
      s.messages.push(model.row('user', 'operator: quick question mid-race'));
      s.status = 'running';
    };
    const run = await startWorkflowRun(h.deps, def);

    // Deferred, not posted: no workflow row in the target, receipt back to
    // pending with the attempt NOT consumed.
    const target = model.byId.get('op-1')!;
    expect(target.messages.some((m) => m.content.includes('workflow-turn'))).toBe(false);
    let x = getRun(root, def.id, run.runId)!.steps[0];
    expect(x.status).toBe('pending');
    expect(x.attempt ?? 0).toBe(0);

    // The operator's turn finishes; the next sweep posts cleanly BEHIND it.
    model.reply('op-1', 'OPERATOR-REPLY');
    await sweepWorkflowRuns(h.deps);
    x = getRun(root, def.id, run.runId)!.steps[0];
    expect(x.status).toBe('running');
    expect(x.attempt).toBe(1); // first REAL attempt — the deferred one cost nothing

    model.reply('op-1', handoff('workflow answer'));
    await sweepWorkflowRuns(h.deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].outcome?.summary).toBe('workflow answer');
    // The mis-adoption the finding describes can never happen: the operator's
    // reply is not the step's outcome.
    expect(after.steps[0].outcome?.finalMessage ?? '').not.toContain('OPERATOR-REPLY');
  });

  it('INTERRUPT SUPERSEDE (finding 2, live-QA-found shape): an operator message that interrupts the POSTED turn routes a retry — the operator reply is never adopted as the outcome', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('fix-supersede', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    expect(getRun(root, def.id, run.runId)!.steps[0].status).toBe('running');

    // The exact live log shape: our marker row posted, then the operator's message
    // INTERRUPTED our running turn (interruptOnNewMessage default) and only the
    // operator's reply landed.
    const s = model.byId.get('op-1')!;
    s.messages.push(model.row('user', 'Operator here mid-race: reply with exactly OPERATOR-REPLY.'));
    s.messages.push(model.row('assistant', 'OPERATOR-REPLY'));
    s.status = 'idle';
    await sweepWorkflowRuns(h.deps);

    // Routed as an interrupted turn → the default respawn-once RE-POSTED attempt 2.
    let x = getRun(root, def.id, run.runId)!.steps[0];
    expect(x.status).toBe('running');
    expect(x.attempt).toBe(2);
    expect(x.outcome).toBeUndefined(); // OPERATOR-REPLY never became the outcome

    model.reply('op-1', handoff('the real workflow answer'));
    await sweepWorkflowRuns(h.deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].outcome?.summary).toBe('the real workflow answer');
    expect(after.steps[0].outcome?.finalMessage ?? '').not.toContain('OPERATOR-REPLY');
  });

  it('LOST ANCHOR + DUPLICATE MARKER (Codex round-2, finding 3): an anchor-less crash record NEVER content-guesses — it re-posts, and the interloper reply behind a stale duplicate marker row is never adopted', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('fix2-dup-marker', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);
    const marker = turnMarkerFor(run.runId, 'x', 1, 1);

    // The reviewer's exact trigger: the anchor is LOST (a legacy fix-1-era record
    // — under fix2 the anchor is persisted WITH the dispatching mark and cannot be
    // lost in this window), the receipt is back in the dispatching state, and the
    // target log holds the real marker row PLUS a later DUPLICATE marker-prefix
    // user row followed by an interloper reply.
    const record = getRun(root, def.id, run.runId)!;
    const x = record.steps.find((s) => s.nodeId === 'x')!;
    x.status = 'dispatching';
    delete x.sessionId;
    delete x.turnAnchor;
    saveRun(root, record);
    const target = model.byId.get('op-1')!;
    target.messages.push(model.row('user', `[workflow-turn ${marker}] duplicate user marker after anchor was lost`));
    target.messages.push(model.row('assistant', 'OPERATOR-REPLY'));
    target.status = 'idle';

    // "Restart": a fresh harness recovers the record. Ambiguity is retryable —
    // the SAME attempt is RE-POSTED (new durable anchor); nothing is adopted.
    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    let after = getRun(root, def.id, run.runId)!;
    const xAfter = after.steps.find((s) => s.nodeId === 'x')!;
    expect(second.followUps).toHaveLength(1); // re-posted, not adopted
    expect(xAfter.status).toBe('running');
    expect(xAfter.turnAnchor).toBeTruthy(); // the new anchor is durable again
    expect(xAfter.outcome).toBeUndefined();

    // The step settles ONLY on the reply to its OWN re-posted row.
    model.reply('op-1', handoff('the workflow own answer'));
    await sweepWorkflowRuns(second.deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].outcome?.summary).toBe('the workflow own answer');
    expect(after.steps[0].outcome?.finalMessage ?? '').not.toContain('OPERATOR-REPLY');
  });

  it('CRASH AFTER INSERT, BEFORE THE ENGINE TURN (Codex round-3, finding 4): boot recovery routes INTERRUPTED and re-posts — never step-no-output', async () => {
    const model = makeSessionModel();
    model.createBare('op-1');
    const def = createDefinition(root, makeDef('fix3-window', [
      trigger,
      step('x', { options: { session: { mode: 'existing', sessionId: 'op-1' } } }),
    ], [e('trg', 'x')]), { now });
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);

    // The gateway died right after the atomic post segment: the anchored row is
    // in the log and the dispatch-started mark ('running') is durable — but the
    // engine turn NEVER ran (gateway-tier test pins the poster leaves exactly
    // this state). The receipt is back at `dispatching` (the driver died too).
    const record = getRun(root, def.id, run.runId)!;
    const x = record.steps.find((s) => s.nodeId === 'x')!;
    expect(model.byId.get('op-1')!.status).toBe('running'); // dispatch-started evidence
    x.status = 'dispatching';
    delete x.sessionId;
    saveRun(root, record);

    // BOOT: recoverStaleSessions stamps every dead 'running' session interrupted
    // (the real function is pinned at the gateway tier; the model mirrors its
    // contract here).
    model.byId.get('op-1')!.status = 'interrupted';

    // Recovery: adopt by row id → the interrupted turn routes the RETRY, not a
    // terminal no-output; attempt 2 re-posts under a fresh durable anchor.
    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    let after = getRun(root, def.id, run.runId)!;
    let xAfter = after.steps.find((s) => s.nodeId === 'x')!;
    expect(xAfter.status).toBe('running');
    expect(xAfter.attempt).toBe(2);
    expect(xAfter.detail ?? '').not.toContain('no output');
    expect(second.followUps).toHaveLength(1); // the attempt-2 re-post

    model.reply('op-1', handoff('done after recovery'));
    await sweepWorkflowRuns(second.deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].outcome?.summary).toBe('done after recovery');
  });

  it('CRASH AFTER THE SHARED-SESSION CREATION INSERT (Codex round-4, finding 5): boot recovery routes INTERRUPTED and re-posts — never step-no-output', async () => {
    const model = makeSessionModel();
    const def = createDefinition(root, makeDef('fix4-window', [
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a')]), { now });
    const first = harness(now, model);
    const run = await startWorkflowRun(first.deps, def);

    // The gateway died right after the spawner's atomic segment: the shared
    // session exists under `workflow-run:<runId>:shared` with the anchored row
    // in its log and the dispatch-started mark ('running') durable — but the
    // engine turn NEVER ran (the gateway-tier test pins the REAL spawner leaves
    // exactly this state at the insert boundary). The spawn never returned, so
    // the receipt is back at `dispatching` and the run never adopted the
    // shared session id.
    const sharedId = model.byKey.get(sharedSessionKey(run.runId))!;
    expect(model.byId.get(sharedId)!.status).toBe('running'); // dispatch-started evidence
    const record = getRun(root, def.id, run.runId)!;
    const a = record.steps.find((s) => s.nodeId === 'a')!;
    a.status = 'dispatching';
    delete a.sessionId;
    delete record.sharedSessionId;
    saveRun(root, record);

    // BOOT: recoverStaleSessions stamps every dead 'running' session interrupted
    // (the real function is pinned at the gateway tier; the model mirrors its
    // contract here).
    model.byId.get(sharedId)!.status = 'interrupted';

    // Recovery: the creation window disambiguates on the shared sessionKey —
    // the session is found, adopted (sharedSessionId re-learned), its turn
    // probes 'interrupted' → the RETRY, not a terminal no-output; attempt 2
    // re-posts into the SAME shared session under a fresh durable anchor.
    const second = harness(now, model);
    await sweepWorkflowRuns(second.deps);
    let after = getRun(root, def.id, run.runId)!;
    let aAfter = after.steps.find((s) => s.nodeId === 'a')!;
    expect(after.sharedSessionId).toBe(sharedId);
    expect(aAfter.status).toBe('running');
    expect(aAfter.attempt).toBe(2);
    expect(aAfter.detail ?? '').not.toContain('no output');
    expect(second.spawnCalls).toHaveLength(0); // the shared session is never re-created
    expect(second.followUps).toHaveLength(1); // the attempt-2 re-post
    expect(second.followUps[0].sessionId).toBe(sharedId);

    model.reply(sharedId, handoff('done after creation-window recovery'));
    await sweepWorkflowRuns(second.deps);
    after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('completed');
    expect(after.steps[0].outcome?.summary).toBe('done after creation-window recovery');
  });
});

describe('GRS-016e compat + driver capability guard', () => {
  it('a definition WITHOUT session modes never touches the follow-up machinery (the v2 path verbatim)', async () => {
    const def = createDefinition(root, makeDef('fresh-compat', [
      trigger, step('a'), step('b'),
    ], [e('trg', 'a'), e('a', 'b')]), { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const run = await startWorkflowRun(h.deps, def);
    model.reply(model.byKey.get(stepSessionKey(run.runId, 'a', 1, 1))!.toString(), handoff('A.'));
    await sweepWorkflowRuns(h.deps);
    model.reply(model.byKey.get(stepSessionKey(run.runId, 'b', 1, 1))!.toString(), handoff('B.'));
    await sweepWorkflowRuns(h.deps);
    const persisted = getRun(root, def.id, run.runId)!;
    expect(persisted.status).toBe('completed');
    expect(h.followUps).toHaveLength(0);
    expect(h.turnProbes()).toBe(0);
    expect('sharedSessionId' in persisted).toBe(false);
    expect(persisted.steps.every((s) => !('turnMarker' in s))).toBe(true);
  });

  it('a driver without the follow-up deps refuses a session-mode run at START, honestly', async () => {
    const def = createDefinition(root, makeDef('no-caps', [
      trigger, step('a', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a')]), { now });
    const model = makeSessionModel();
    const h = harness(now, model);
    const bare: RunDriverDeps = { ...h.deps };
    delete bare.postStepFollowUp;
    delete bare.probeSessionTurn;
    const run = await startWorkflowRun(bare, def);
    expect(run.status).toBe('failed');
    expect(run.errors?.[0]?.code).toBe('session-mode-unsupported');
    expect(h.spawnCalls).toHaveLength(0);
  });
});
