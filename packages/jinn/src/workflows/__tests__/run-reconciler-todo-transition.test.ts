import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowNode, EditableWorkflowDefinition } from '../definition.js';
import type { RunDriverDeps } from '../run-reconciler.js';
import type { StepSessionProbe } from '../advance.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todo-transition-home-'));
process.env.JINN_HOME = home;

const FIXED = '2026-07-06T11:00:00.000Z';
const now = () => FIXED;

let wf: typeof import('../run-reconciler.js');
let defStore: typeof import('../definition-store.js');
let defMod: typeof import('../definition.js');
let adv: typeof import('../advance.js');
let store: typeof import('../../work-items/store.js');

beforeAll(async () => {
  wf = await import('../run-reconciler.js');
  defStore = await import('../definition-store.js');
  defMod = await import('../definition.js');
  adv = await import('../advance.js');
  store = await import('../../work-items/store.js');
  await import('../../sessions/registry.js').then((m) => m.initDb());
});

function trigger(): WorkflowNode {
  return { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } };
}
function step(id: string, todoTransition: string): WorkflowNode {
  return {
    id,
    type: 'step',
    label: id.toUpperCase(),
    position: { x: 0, y: 140 },
    actor: { kind: 'engine', ref: 'codex' },
    todoTransition: todoTransition as never,
  };
}
function inlineStep(id: string, todoTransition: string): WorkflowNode {
  return {
    id,
    type: 'step',
    label: id.toUpperCase(),
    position: { x: 0, y: 140 },
    todoTransition: todoTransition as never,
  };
}
function chainDef(id: string, nodes: WorkflowNode[]): EditableWorkflowDefinition {
  return {
    schemaVersion: defMod.WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const })),
  };
}

function harness(root: string) {
  const sessions = new Map<string, StepSessionProbe>();
  const deps: RunDriverDeps = {
    root,
    getDefinition: defStore.getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      const key = adv.stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      sessions.set(key, { found: true, sessionId: `sess:${ctx.nodeId}:1`, status: 'running' });
      return { sessionId: `sess:${ctx.nodeId}:1` };
    },
    now,
  };
  const settle = (runId: string, nodeId: string) => {
    const key = adv.stepSessionKey(runId, nodeId, 1, 1);
    sessions.set(key, {
      found: true,
      sessionId: `sess:${nodeId}:1`,
      status: 'idle',
      finalAssistantText: `${nodeId} done`,
    });
  };
  return { deps, settle };
}

describe('step todoTransition', () => {
  it('advances the linked Todo through the guarded transition path when the step settles', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todo-transition-'));
    const todo = store.createWorkItem({ title: 'linked todo', status: 'backlog', source: 'human' });
    const def = defStore.createDefinition(root, chainDef('advance-todo', [trigger(), step('a', 'executing')]), { now });
    const { deps, settle } = harness(root);

    const started = await wf.startWorkflowRun(deps, def, { triggerTodoId: todo.id });
    settle(started.runId, 'a');
    await wf.sweepWorkflowRuns(deps);

    expect(store.getWorkItem(todo.id)?.status).toBe('executing');
    expect(store.listWorkItemEvents(todo.id).at(-1)).toMatchObject({
      kind: 'status_change',
      fromStatus: 'backlog',
      toStatus: 'executing',
      actor: 'workflow-run',
      detail: { workflowId: 'advance-todo', runId: started.runId, nodeId: 'a' },
    });
  });

  it('fails the run honestly and leaves the Todo unchanged when the transition is illegal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todo-transition-'));
    const todo = store.createWorkItem({ title: 'illegal todo', status: 'executing', source: 'human' });
    const def = defStore.createDefinition(root, chainDef('illegal-todo', [trigger(), step('a', 'assigned')]), { now });
    const { deps, settle } = harness(root);

    const started = await wf.startWorkflowRun(deps, def, { triggerTodoId: todo.id });
    settle(started.runId, 'a');
    await wf.sweepWorkflowRuns(deps);
    const run = (await import('../run-store.js')).getRun(root, 'illegal-todo', started.runId)!;

    expect(store.getWorkItem(todo.id)?.status).toBe('executing');
    expect(run.status).toBe('failed');
    expect(run.errors?.at(-1)).toMatchObject({ code: 'todo-transition-failed', ref: 'a' });
  });

  it('a self-triggering todo workflow terminates at escalated via the rounds ceiling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todo-cycle-'));
    const triggerNode: WorkflowNode = {
      id: 'trg',
      type: 'trigger',
      label: 'Todo trigger',
      position: { x: 0, y: 0 },
      trigger: { kind: 'todo-status-change', toStatus: 'in_review' },
    };
    const def = defStore.createDefinition(
      root,
      chainDef('cycle-todo', [
        triggerNode,
        inlineStep('bounce-1', 'executing'),
        inlineStep('review-again', 'in_review'),
        inlineStep('bounce-2', 'executing'),
      ]),
      { now },
    );
    const todo = store.createWorkItem({
      title: 'cyclic todo',
      status: 'executing',
      source: 'human',
      verifyPolicy: { mode: 'verify', maxRounds: 2 },
    });
    const fire = await import('../todo-status-trigger.js');
    const runStore = await import('../run-store.js');
    const transitions = await import('../../work-items/transitions.js');
    const { deps } = harness(root);
    transitions.setTodoStatusChangeListener((event) => {
      void fire.fireTodoStatusChangeWorkflows(deps, {
        id: event.id,
        workItemId: event.workItemId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        item: { source: event.item.source, department: event.item.department, assignee: event.item.assignee },
      });
    });
    try {
      transitions.transition(todo.id, 'in_review', 'qa');
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (store.getWorkItem(todo.id)?.status === 'escalated') return resolve();
          if (Date.now() - started > 2000) return reject(new Error('cycle did not escalate'));
          setTimeout(tick, 10);
        };
        tick();
      });
    } finally {
      transitions.setTodoStatusChangeListener(null);
    }

    const item = store.getWorkItem(todo.id)!;
    const runs = runStore.listRuns(root, def.id);
    expect(item.status).toBe('escalated');
    expect(item.rounds).toBe(2);
    expect(runs.length).toBeLessThanOrEqual(2);
    expect(store.listWorkItemEvents(todo.id).some((event) => event.kind === 'escalated' && event.detail?.reason === 'max-rounds-exhausted')).toBe(true);
  });

  it('does not let the real Todo bridge terminal reflection overwrite a step-driven transition on a triggered run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todo-terminal-skip-'));
    const todo = store.createWorkItem({ title: 'step authority todo', status: 'in_review', source: 'human' });
    const def = defStore.createDefinition(root, chainDef('step-authority', [trigger(), inlineStep('a', 'executing')]), { now });
    const bridge = await import('../../work-items/workflow-bridge.js');
    const { deps } = harness(root);
    deps.workItems = bridge.createWorkflowTodoBridge();

    const started = await wf.startWorkflowRun(deps, def, {
      trigger: { kind: 'todo-status-change', fireRef: 'wie_step_authority' },
      triggerTodoId: todo.id,
    });
    await wf.sweepWorkflowRuns(deps);
    const run = (await import('../run-store.js')).getRun(root, 'step-authority', started.runId)!;
    const statusTrail = store
      .listWorkItemEvents(todo.id)
      .filter((event) => event.fromStatus || event.toStatus)
      .map((event) => `${event.fromStatus}->${event.toStatus}:${event.actor}`);

    expect(run.status).toBe('completed');
    expect(store.getWorkItem(todo.id)?.status).toBe('executing');
    expect(statusTrail).toContain(`in_review->executing:workflow-run`);
    expect(statusTrail).not.toContain(`executing->done:workflow-run`);
  });
});
