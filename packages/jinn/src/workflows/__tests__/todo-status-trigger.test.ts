import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefinition, getDefinition } from '../definition-store.js';
import { fireTodoStatusChangeWorkflows, replayMissedTodoStatusChangeWorkflowFires } from '../todo-status-trigger.js';
import { WORKFLOW_DEFINITION_SCHEMA_VERSION, type EditableWorkflowDefinition, type WorkflowNode } from '../definition.js';
import type { RunDriverDeps } from '../run-reconciler.js';
import { stepSessionKey, type StepSessionProbe } from '../advance.js';

const FIXED = '2026-07-06T10:00:00.000Z';
const now = () => FIXED;

const trigger = (toStatus: string, extra: Record<string, unknown> = {}): WorkflowNode => ({
  id: 'trg',
  type: 'trigger',
  label: 'Todo trigger',
  position: { x: 0, y: 0 },
  trigger: { kind: 'todo-status-change', toStatus, ...extra } as never,
});
const step = (id: string): WorkflowNode => ({
  id,
  type: 'step',
  label: id.toUpperCase(),
  position: { x: 0, y: 140 },
  actor: { kind: 'engine', ref: 'codex' },
});
function def(id: string, t: WorkflowNode): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes: [t, step('a')],
    edges: [{ id: 'e0', from: 'trg', to: 'a', kind: 'sequence' }],
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-todo-trigger-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(over: Partial<RunDriverDeps> = {}): RunDriverDeps {
  const sessions = new Map<string, StepSessionProbe>();
  return {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      sessions.set(key, { found: true, sessionId: 'sess-a', status: 'running' });
      return { sessionId: 'sess-a' };
    },
    now,
    ...over,
  };
}

describe('todo-status-change workflow trigger', () => {
  it('starts one matching workflow run per transition event and links the summoning Todo', async () => {
    createDefinition(root, def('verify-wf', trigger('in_review')), { now });

    const first = await fireTodoStatusChangeWorkflows(deps(), {
      id: 'wie_evt1',
      workItemId: 'wi_1',
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: null, assignee: null },
    });
    const second = await fireTodoStatusChangeWorkflows(deps(), {
      id: 'wie_evt1',
      workItemId: 'wi_1',
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: null, assignee: null },
    });

    expect(first.map((x) => x.outcome)).toEqual(['started']);
    expect(first[0].outcome).toBe('started');
    if (first[0].outcome !== 'started') return;
    expect(first[0].run?.trigger).toEqual({
      source: 'todo-status-change',
      event: 'todo.status_changed',
      payload: {
        todoId: 'wi_1',
        fromStatus: 'executing',
        toStatus: 'in_review',
        source: 'human',
        department: null,
        assignee: null,
      },
      fireRef: 'wie_evt1',
    });
    expect('triggerTodoId' in first[0].run).toBe(false);
    expect(second.map((x) => x.outcome)).toEqual(['duplicate']);
  });

  it('does not fire when the status or filters do not match', async () => {
    createDefinition(root, def('verify-wf', trigger('in_review', { filter: { source: 'delegation', department: 'platform' } })), { now });

    const outcomes = await fireTodoStatusChangeWorkflows(deps(), {
      id: 'wie_evt2',
      workItemId: 'wi_2',
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: 'platform', assignee: null },
    });

    expect(outcomes).toEqual([]);
  });

  it('suppresses a second non-terminal run for the same definition and Todo', async () => {
    createDefinition(root, def('cycle-wf', trigger('in_review')), { now });

    const first = await fireTodoStatusChangeWorkflows(deps(), {
      id: 'wie_a',
      workItemId: 'wi_cycle',
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: null, assignee: null },
    });
    const second = await fireTodoStatusChangeWorkflows(deps(), {
      id: 'wie_b',
      workItemId: 'wi_cycle',
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: null, assignee: null },
    });

    expect(first[0].outcome).toBe('started');
    expect(second).toEqual([{ workflowId: 'cycle-wf', outcome: 'suppressed', detail: expect.stringContaining('non-terminal') }]);
  });

  it('replays a transition event that committed before the listener was installed exactly once', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-todo-trigger-home-'));
    process.env.JINN_HOME = home;
    const store = await import('../../work-items/store.js');
    const transitions = await import('../../work-items/transitions.js');
    try {
      createDefinition(root, def('verify-wf', trigger('in_review')), { now });
      const todo = store.createWorkItem({ title: 'boot replay todo', status: 'executing', source: 'human' });

      transitions.setTodoStatusChangeListener(null);
      const transition = transitions.transition(todo.id, 'in_review', 'qa');
      expect(transition.event?.id).toMatch(/^wie_/);

      const first = await replayMissedTodoStatusChangeWorkflowFires(deps(), { limit: 50 });
      const second = await replayMissedTodoStatusChangeWorkflowFires(deps(), { limit: 50 });
      const firstHit = first.filter((entry) => entry.eventId === transition.event?.id);
      const secondHit = second.filter((entry) => entry.eventId === transition.event?.id);

      expect(firstHit).toEqual([{ eventId: transition.event?.id, outcomes: [{ workflowId: 'verify-wf', outcome: 'started' }] }]);
      expect(secondHit).toEqual([{ eventId: transition.event?.id, outcomes: [{ workflowId: 'verify-wf', outcome: 'duplicate' }] }]);
    } finally {
      transitions.setTodoStatusChangeListener(null);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
