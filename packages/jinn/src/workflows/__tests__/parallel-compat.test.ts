import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceWorkflowRunById,
  startWorkflowRun,
  sweepWorkflowRuns,
  resolveWorkflowRunGate,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { stepSessionKey, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import { getRun, WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from '../run-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016a COMPAT CORNERSTONE — byte-identical v2 execution goldens.
 *
 * These snapshots were GENERATED ON THE PRE-PARALLEL v2 ENGINE (GRS-014e state,
 * commit f28bfa2 lineage) and committed BEFORE any GRS-016a engine change. Every
 * fixture below is a definition WITHOUT the new `concurrency` field — the compat
 * contract is that such definitions execute byte-identically under the parallel
 * build (absent concurrency = 1 = the sequential v2 engine), apart from later
 * operator-approved persistence-envelope migrations.
 *
 * Determinism: fixed injected clock (every timestamp is the same constant), fixed
 * injected runId, deterministic stub spawner/prober, and a drive loop that settles
 * scripted sessions then sweeps to quiescence — so the final persisted run FILE
 * (read raw off disk, definitionSnapshot included) is fully reproducible and the
 * snapshot equality IS byte-level equality after projecting away only the approved
 * schema-v3 run envelope (`schemaVersion: 3` plus `revision`) and the Task 5
 * append-only reporting envelope (`reportSequence` plus `reportEpisodes`): each scenario
 * snapshots BOTH the parsed object (readability) AND the raw utf8 file string
 * (`raw-bytes` — the true byte-level assertion; GRS-016a-fix, Codex finding 4).
 *
 * The actual parked/terminal file is separately required to carry schema v3 and a
 * positive safe-integer revision. If the legacy projection breaks a snapshot, that
 * is behavioral drift beyond the approved envelope — do not update the snapshot;
 * fix the engine. The describe title is retained because it is part of Vitest's
 * snapshot identity; "byte-identically" there means after this explicit projection.
 */

const FIXED = '2026-07-04T18:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
function chainEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const }));
}
function def(id: string, nodes: WorkflowNode[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes,
    edges: chainEdges(nodes),
    ...over,
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-compat-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const sessions = new Map<string, StepSessionProbe>();
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `sess:${ctx.nodeId}:${ctx.round > 1 ? `r${ctx.round}:` : ''}${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId, detail: `spawned ${ctx.spec.actorKind} "${ctx.spec.actorRef}"` };
    },
    now,
  };
  const settle = (runId: string, nodeId: string, attempt: number, opts: {
    status?: StepSessionProbe['status'];
    text?: string | null;
    round?: number;
  } = {}) => {
    const key = stepSessionKey(runId, nodeId, attempt, opts.round ?? 1);
    const existing = sessions.get(key);
    sessions.set(key, {
      found: true,
      sessionId: existing?.sessionId ?? `sess:${nodeId}:${attempt}`,
      status: opts.status ?? 'idle',
      ...((opts.status ?? 'idle') === 'idle'
        ? { finalAssistantText: opts.text === undefined ? `output of ${nodeId} attempt ${attempt}` : opts.text }
        : {}),
    });
  };
  return { deps, settle };
}

/** Sweep to quiescence: sweep repeatedly until the persisted record stops changing. */
async function sweepUntilQuiet(deps: RunDriverDeps, workflowId: string, runId: string): Promise<WorkflowRun> {
  let previous = '';
  for (let guard = 0; guard < 30; guard++) {
    await sweepWorkflowRuns(deps);
    const raw = fs.readFileSync(path.join(root, 'reports', 'runs', workflowId, `${runId}.json`), 'utf8');
    if (raw === previous) return JSON.parse(raw) as WorkflowRun;
    previous = raw;
  }
  throw new Error('sweepUntilQuiet guard exceeded');
}

/**
 * The RAW on-disk bytes (GRS-016a-fix, Codex finding 4) — the artifact the
 * byte-identity claim is about. Snapshotting the utf8 string (not a parsed object)
 * makes the golden a true byte-level assertion: key order, whitespace, and every
 * serialization detail are part of the contract. These raw snapshots were generated
 * on the pre-parallel v2 engine (commit 5ce55f7 checked out in a scratch worktree)
 * and must never be regenerated on a newer engine.
 */
function actualDiskRaw(workflowId: string, runId: string): string {
  return fs.readFileSync(path.join(root, 'reports', 'runs', workflowId, `${runId}.json`), 'utf8');
}

function actualDiskRun(workflowId: string, runId: string): { raw: string; record: WorkflowRun } {
  const raw = actualDiskRaw(workflowId, runId);
  const record = JSON.parse(raw) as WorkflowRun;
  expect(WORKFLOW_RUN_SCHEMA_VERSION).toBe(3);
  expect(record.schemaVersion).toBe(WORKFLOW_RUN_SCHEMA_VERSION);
  expect(Number.isSafeInteger(record.revision) && (record.revision ?? 0) > 0).toBe(true);
  return { raw, record };
}

/** Parsed v2-compatible view: remove only approved schema-v3 persistence envelopes. */
function legacyCompatibleDiskRecord(workflowId: string, runId: string): unknown {
  const { record } = actualDiskRun(workflowId, runId);
  const projected = { ...record } as Record<string, unknown>;
  projected.schemaVersion = 2;
  delete projected.revision;
  delete projected.reportSequence;
  delete projected.reportEpisodes;
  return projected;
}

/** Raw v2-compatible bytes: preserve all ordering/formatting outside approved v3 envelopes. */
function legacyCompatibleDiskRaw(workflowId: string, runId: string): string {
  const projected = legacyCompatibleDiskRecord(workflowId, runId);
  return JSON.stringify(projected, null, 2) + '\n';
}

const runIdOf = (n: number) => () => `run-golden-${n}`;

describe('GRS-016a compat goldens — v2 definitions (no concurrency field) execute byte-identically', () => {
  it('golden 1: linear three-step chain with declared handoff blocks', async () => {
    const d = createDefinition(root, def('golden-linear', [
      trigger,
      step('a', { instructions: 'do a' }),
      step('b', { instructions: 'do b' }),
      step('c', { instructions: 'do c' }),
    ]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(1) });
    expect(started.status).toBe('running');

    settle(started.runId, 'a', 1, { text: 'A done.\n```handoff\n{ "summary": "a shipped", "artifacts": ["src/a.ts"] }\n```' });
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1, { text: 'B done.\n```handoff\n{ "summary": "b reviewed a", "artifacts": ["src/b.ts"], "notes": "watch the cap" }\n```' });
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'c', 1, { text: 'C wrapped everything up.' });
    const final = await sweepUntilQuiet(deps, d.id, started.runId);

    expect(final.status).toBe('completed');
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 2: sample-shaped branching graph (fan-out + fan-in) executes sequentially in topo order', async () => {
    const nodes = [trigger, step('select'), step('implement'), step('adversary'), step('steer'), step('decide')];
    const d = createDefinition(root, def('golden-branch', nodes, {
      edges: [
        { id: 'e0', from: 'trg', to: 'select', kind: 'sequence' },
        { id: 'e1', from: 'select', to: 'implement', kind: 'sequence' },
        { id: 'e2', from: 'implement', to: 'adversary', kind: 'sequence' },
        { id: 'e3', from: 'adversary', to: 'decide', kind: 'handoff' },
        { id: 'e4', from: 'adversary', to: 'steer', kind: 'sequence' },
        { id: 'e5', from: 'steer', to: 'decide', kind: 'sequence' },
      ],
    }), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(2) });

    for (const nodeId of ['select', 'implement', 'adversary', 'steer', 'decide']) {
      settle(started.runId, nodeId, 1);
      await sweepUntilQuiet(deps, d.id, started.runId);
    }
    const final = getRun(root, d.id, started.runId)!;
    expect(final.status).toBe('completed');
    expect(final.steps.map((s) => s.nodeId)).toEqual(['select', 'implement', 'adversary', 'steer', 'decide']);
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 3: inline steps + artifact checkpoint + mid-graph approval park, then approve to completion', async () => {
    const d = createDefinition(root, def('golden-park', [
      trigger,
      step('i', { actor: undefined }),
      { id: 'chk', type: 'gate', label: 'CHK', position: { x: 0, y: 0 }, gate: { kind: 'artifact', glob: 'reports/*.md', description: 'has report' } },
      step('a'),
      { id: 'ap', type: 'gate', label: 'AP', position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'operator approves', approvalRef: 'op-ok' } },
      step('b'),
    ]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(3) });

    settle(started.runId, 'a', 1);
    const parked = await sweepUntilQuiet(deps, d.id, started.runId);
    expect(parked.status).toBe('parked');
    // Golden 3a: the PARKED record — downstream honestly pending.
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot('parked');
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('parked raw-bytes');

    const resolved = await resolveWorkflowRunGate(deps, d.id, started.runId, 'approve');
    expect(resolved.outcome).toBe('resolved');
    settle(started.runId, 'b', 1);
    const final = await sweepUntilQuiet(deps, d.id, started.runId);
    expect(final.status).toBe('completed');
    // Golden 3b: the COMPLETED record after operator approval.
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot('approved-completed');
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('approved-completed raw-bytes');
  });

  it('golden 4: gate-less bounded loop runs exactly maxRoundsPerRun rounds with in-place spliced receipts', async () => {
    const nodes = [trigger, step('a'), step('b'), step('c')];
    const d = createDefinition(root, def('golden-loop', nodes, {
      edges: [
        ...chainEdges(nodes),
        { id: 'lp', from: 'b', to: 'a', kind: 'loop' },
      ],
      loop: { maxRoundsPerRun: 2 },
    }), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(4) });

    settle(started.runId, 'a', 1);
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1);
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'a', 1, { round: 2, text: 'round-2 a builds on round-1 b' });
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1, { round: 2 });
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'c', 1);
    const final = await sweepUntilQuiet(deps, d.id, started.runId);

    expect(final.status).toBe('completed');
    expect(final.rounds).toBe(2);
    expect(final.steps.map((s) => `${s.nodeId}@${s.round ?? 1}`)).toEqual(['a@1', 'b@1', 'a@2', 'b@2', 'c@1']);
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 5: a required step erroring fails the run immediately with downstream pending', async () => {
    const d = createDefinition(root, def('golden-fail', [trigger, step('a'), step('b'), step('c')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(5) });

    settle(started.runId, 'a', 1);
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1, { status: 'error' });
    const final = await sweepUntilQuiet(deps, d.id, started.runId);

    expect(final.status).toBe('failed');
    expect(final.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['a', 'done'], ['b', 'failed'], ['c', 'pending'],
    ]);
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 6: an optional step settling with no output is skipped and the chain keeps advancing', async () => {
    const d = createDefinition(root, def('golden-skip', [trigger, step('a', { optional: true }), step('b')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(6) });

    settle(started.runId, 'a', 1, { text: null });
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1);
    const final = await sweepUntilQuiet(deps, d.id, started.runId);

    expect(final.status).toBe('completed');
    expect(final.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'skipped'], ['b', 'done']]);
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 7: interrupted step respawns once (attempt 2) under a NEW sessionKey then completes', async () => {
    const d = createDefinition(root, def('golden-respawn', [trigger, step('a'), step('b')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(7) });

    settle(started.runId, 'a', 1, { status: 'interrupted' });
    await sweepUntilQuiet(deps, d.id, started.runId); // respawns attempt 2
    settle(started.runId, 'a', 2);
    await sweepUntilQuiet(deps, d.id, started.runId);
    settle(started.runId, 'b', 1);
    const final = await sweepUntilQuiet(deps, d.id, started.runId);

    expect(final.status).toBe('completed');
    expect(final.steps.find((s) => s.nodeId === 'a')?.attempt).toBe(2);
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });

  it('golden 8: advanceWorkflowRunById on a single run matches the sweep path (same driver)', async () => {
    const d = createDefinition(root, def('golden-byid', [trigger, step('a')]), { now });
    const { deps, settle } = harness();
    const started = await startWorkflowRun(deps, d, { makeRunId: runIdOf(8) });
    settle(started.runId, 'a', 1);
    const advanced = await advanceWorkflowRunById(deps, d.id, started.runId);
    expect(advanced?.status).toBe('completed');
    expect(legacyCompatibleDiskRecord(d.id, started.runId)).toMatchSnapshot();
    expect(legacyCompatibleDiskRaw(d.id, started.runId)).toMatchSnapshot('raw-bytes');
  });
});
