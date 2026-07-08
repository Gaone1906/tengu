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
 * GRS-016c integration tier — switch routing through the REAL driver + stores:
 * fields extracted from a live handoff block and persisted on the receipt, the
 * fields contract advertised in the routed-on node's own prompt, predecessor
 * outcomes passing THROUGH the switch into the taken branch's prompt, the untaken
 * branch skipped, and the fail path failing the run with the authored message.
 */

const FIXED = '2026-07-05T09:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

/** trigger→review→sw; sw→ship when verdict=ship; sw→stop (fail) default. */
function switchDef(id: string, extraEdges: WorkflowEdge[] = []): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes: [
      trigger,
      step('review'),
      { id: 'sw', type: 'switch', label: 'Route', position: { x: 0, y: 0 } },
      step('ship'),
      { id: 'stop', type: 'fail', label: 'Stop', position: { x: 0, y: 0 }, failMessage: 'review rejected the change' },
    ],
    edges: [
      e('trg', 'review'),
      e('review', 'sw'),
      e('sw', 'ship', { when: [{ path: 'steps.review.outcome.fields.verdict', op: 'eq', value: 'ship' }] }),
      e('sw', 'stop'),
      ...extraEdges,
    ],
  };
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-sw-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function harness() {
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
  const settleIdle = (runId: string, nodeId: string, text: string, attempt = 1) => {
    const key = stepSessionKey(runId, nodeId, attempt, 1);
    sessions.set(key, { found: true, sessionId: `sess:${nodeId}:${attempt}`, status: 'idle', finalAssistantText: text });
  };
  return { deps, spawnCalls, settleIdle };
}

const reviewReply = (verdict: string) =>
  `Review complete.\n\n\`\`\`handoff\n${JSON.stringify({
    summary: 'Reviewed the change end to end.',
    artifacts: ['reports/review.md'],
    fields: { verdict, bugCount: 1 },
  })}\n\`\`\`\n`;

describe('GRS-016c switch routing through the real driver', () => {
  it('ship path: fields persist on the receipt, the contract is advertised, the handoff passes through the switch, the untaken branch skips', async () => {
    const def = createDefinition(root, switchDef('sw-ship'), { now });
    const { deps, spawnCalls, settleIdle } = harness();
    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('running');

    // The routed-on node's OWN prompt advertises the fields contract by name.
    const reviewPrompt = spawnCalls.find((c) => c.nodeId === 'review')!.prompt;
    expect(reviewPrompt).toContain('"fields"');
    expect(reviewPrompt).toContain('"verdict"');

    settleIdle(run.runId, 'review', reviewReply('ship'));
    await sweepWorkflowRuns(deps);
    const after = getRun(root, def.id, run.runId)!;

    // Fields persisted on the frozen receipt.
    const review = after.steps.find((s) => s.nodeId === 'review')!;
    expect(review.outcome?.fields).toEqual({ verdict: 'ship', bugCount: 1 });
    // Switch routed + frozen; fail branch skipped.
    const sw = after.steps.find((s) => s.nodeId === 'sw')!;
    expect(sw.status).toBe('routed');
    expect(sw.route).toEqual(['e_sw__ship']);
    expect(after.steps.find((s) => s.nodeId === 'stop')!.status).toBe('skipped');

    // The taken branch received review's outcome THROUGH the switch.
    const shipPrompt = spawnCalls.find((c) => c.nodeId === 'ship')!.prompt;
    expect(shipPrompt).toContain('Handoff from "REVIEW"');
    expect(shipPrompt).toContain('Reviewed the change end to end.');
    expect(shipPrompt).toContain('- verdict: "ship"');

    settleIdle(run.runId, 'ship', 'shipped.');
    await sweepWorkflowRuns(deps);
    expect(getRun(root, def.id, run.runId)!.status).toBe('completed');
  });

  it('reject path: the default edge reaches the fail node and the run fails with the authored message; ship skips', async () => {
    const def = createDefinition(root, switchDef('sw-reject'), { now });
    const { deps, spawnCalls, settleIdle } = harness();
    const run = await startWorkflowRun(deps, def);
    settleIdle(run.runId, 'review', reviewReply('reject'));
    await sweepWorkflowRuns(deps);
    const after = getRun(root, def.id, run.runId)!;
    expect(after.status).toBe('failed');
    expect(after.errors).toEqual([{ code: 'authored-fail', message: 'review rejected the change', ref: 'stop' }]);
    expect(after.steps.find((s) => s.nodeId === 'stop')!.status).toBe('failed');
    expect(after.steps.find((s) => s.nodeId === 'stop')!.detail).toBe('review rejected the change');
    expect(after.steps.find((s) => s.nodeId === 'ship')!.status).toBe('skipped');
    expect(spawnCalls.map((c) => c.nodeId)).toEqual(['review']); // ship never spawned
  });

  it('pass-through never duplicates a predecessor also wired directly', async () => {
    const def = createDefinition(root, switchDef('sw-dedupe', [e('review', 'ship')]), { now });
    const { deps, spawnCalls, settleIdle } = harness();
    const run = await startWorkflowRun(deps, def);
    settleIdle(run.runId, 'review', reviewReply('ship'));
    await sweepWorkflowRuns(deps);
    const shipPrompt = spawnCalls.find((c) => c.nodeId === 'ship')!.prompt;
    expect(shipPrompt.match(/Handoff from "REVIEW"/g)).toHaveLength(1);
  });
});
