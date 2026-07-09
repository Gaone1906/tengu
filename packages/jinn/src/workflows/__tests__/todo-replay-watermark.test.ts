import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh JINN_HOME BEFORE importing the registry so this suite's work_item_events
// and replay watermark live in an isolated DB (not a sibling test's shared one).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wm-home-'));
process.env.JINN_HOME = home;

import { createDefinition } from '../definition-store.js';
import { getDefinition } from '../definition-store.js';
import { replayMissedTodoStatusChangeWorkflowFires } from '../todo-status-trigger.js';
import { WORKFLOW_DEFINITION_SCHEMA_VERSION, type EditableWorkflowDefinition, type WorkflowNode } from '../definition.js';
import type { RunDriverDeps } from '../run-reconciler.js';
import { stepSessionKey, type StepSessionProbe } from '../advance.js';

const now = () => '2026-07-06T10:00:00.000Z';

function def(id: string): EditableWorkflowDefinition {
  const trigger: WorkflowNode = {
    id: 'trg', type: 'trigger', label: 'Todo trigger', position: { x: 0, y: 0 },
    trigger: { kind: 'todo-status-change', toStatus: 'in_review' } as never,
  };
  const step: WorkflowNode = {
    id: 'a', type: 'step', label: 'A', position: { x: 0, y: 140 },
    actor: { kind: 'engine', ref: 'codex' },
  };
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes: [trigger, step],
    edges: [{ id: 'e0', from: 'trg', to: 'a', kind: 'sequence' }],
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wm-root-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(): RunDriverDeps {
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
  };
}

describe('todo-status replay watermark', () => {
  it('a second replay only processes events created after the first', async () => {
    const store = await import('../../work-items/store.js');
    const transitions = await import('../../work-items/transitions.js');
    transitions.setTodoStatusChangeListener(null);

    createDefinition(root, def('verify-wf'), { now });

    const t1 = store.createWorkItem({ title: 'first', status: 'executing', source: 'human' });
    const e1 = transitions.transition(t1.id, 'in_review', 'qa').event?.id;

    const first = await replayMissedTodoStatusChangeWorkflowFires(deps(), { limit: 50 });
    expect(first.map((r) => r.eventId)).toContain(e1);

    // A brand-new transition AFTER the first replay advanced the watermark.
    const t2 = store.createWorkItem({ title: 'second', status: 'executing', source: 'human' });
    const e2 = transitions.transition(t2.id, 'in_review', 'qa').event?.id;

    const second = await replayMissedTodoStatusChangeWorkflowFires(deps(), { limit: 50 });
    const ids = second.map((r) => r.eventId);
    // Only the new event is replayed; the already-processed one is not re-scanned.
    expect(ids).toContain(e2);
    expect(ids).not.toContain(e1);
  });
});
