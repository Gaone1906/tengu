import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-todo-decoupling-home-'));
process.env.JINN_HOME = home;

const todoWrites = vi.hoisted(() => ({
  createWorkItem: 0,
  linkSession: 0,
  transition: 0,
  transitionDerived: 0,
  requestApproval: 0,
  decideApproval: 0,
}));

vi.mock('../../work-items/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items/store.js')>();
  return {
    ...actual,
    createWorkItem: vi.fn((...args: Parameters<typeof actual.createWorkItem>) => {
      todoWrites.createWorkItem += 1;
      return actual.createWorkItem(...args);
    }),
    linkSession: vi.fn((...args: Parameters<typeof actual.linkSession>) => {
      todoWrites.linkSession += 1;
      return actual.linkSession(...args);
    }),
  };
});

vi.mock('../../work-items/transitions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items/transitions.js')>();
  return {
    ...actual,
    transition: vi.fn((...args: Parameters<typeof actual.transition>) => {
      todoWrites.transition += 1;
      return actual.transition(...args);
    }),
    transitionDerived: vi.fn((...args: Parameters<typeof actual.transitionDerived>) => {
      todoWrites.transitionDerived += 1;
      return actual.transitionDerived(...args);
    }),
  };
});

vi.mock('../../work-items/approvals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items/approvals.js')>();
  return {
    ...actual,
    requestApproval: vi.fn((...args: Parameters<typeof actual.requestApproval>) => {
      todoWrites.requestApproval += 1;
      return actual.requestApproval(...args);
    }),
    decideWorkItemApproval: vi.fn((...args: Parameters<typeof actual.decideWorkItemApproval>) => {
      todoWrites.decideApproval += 1;
      return actual.decideWorkItemApproval(...args);
    }),
  };
});

type WorkflowModules = {
  api: typeof import('../../gateway/api.js');
  approvals: typeof import('../../work-items/approvals.js');
  cron: typeof import('../cron-sync.js');
  customTriggers: typeof import('../custom-triggers.js');
  definitions: typeof import('../definition-store.js');
  poll: typeof import('../poll-trigger.js');
  reconciler: typeof import('../run-reconciler.js');
  runStore: typeof import('../run-store.js');
  store: typeof import('../../work-items/store.js');
  todoStatus: typeof import('../todo-status-trigger.js');
  transitions: typeof import('../../work-items/transitions.js');
  advance: typeof import('../advance.js');
  registry: typeof import('../../sessions/registry.js');
};

let modules: WorkflowModules;
let root: string;
let clock = Date.parse('2026-07-12T08:00:00.000Z');

beforeAll(async () => {
  const [api, approvals, cron, customTriggers, definitions, poll, reconciler, runStore, store, todoStatus, transitions, advance, registry] = await Promise.all([
    import('../../gateway/api.js'),
    import('../../work-items/approvals.js'),
    import('../cron-sync.js'),
    import('../custom-triggers.js'),
    import('../definition-store.js'),
    import('../poll-trigger.js'),
    import('../run-reconciler.js'),
    import('../run-store.js'),
    import('../../work-items/store.js'),
    import('../todo-status-trigger.js'),
    import('../../work-items/transitions.js'),
    import('../advance.js'),
    import('../../sessions/registry.js'),
  ]);
  modules = { api, approvals, cron, customTriggers, definitions, poll, reconciler, runStore, store, todoStatus, transitions, advance, registry };
  registry.initDb();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-todo-decoupling-'));
  clock = Date.parse('2026-07-12T08:00:00.000Z');
  vi.mocked(modules.store.createWorkItem).mockClear();
  vi.mocked(modules.store.linkSession).mockClear();
  vi.mocked(modules.transitions.transition).mockClear();
  vi.mocked(modules.transitions.transitionDerived).mockClear();
  vi.mocked(modules.approvals.requestApproval).mockClear();
  vi.mocked(modules.approvals.decideWorkItemApproval).mockClear();
  Object.assign(todoWrites, {
    createWorkItem: 0,
    linkSession: 0,
    transition: 0,
    transitionDerived: 0,
    requestApproval: 0,
    decideApproval: 0,
  });
});

function trigger(kind: 'manual' | 'schedule' | 'todo-status-change' = 'manual') {
  const triggerConfig = kind === 'schedule'
    ? { kind, cron: '0 8 * * *' }
    : kind === 'todo-status-change'
      ? { kind, toStatus: 'in_review' }
      : { kind };
  return { id: 'trigger', type: 'trigger', label: 'Trigger', position: { x: 0, y: 0 }, trigger: triggerConfig };
}

function step(id = 'step', options?: Record<string, unknown>) {
  return {
    id,
    type: 'step',
    label: id,
    position: { x: 0, y: 100 },
    actor: { kind: 'engine', ref: 'codex' },
    ...(options ? { options } : {}),
  };
}

function inlineStep(id = 'inline') {
  return {
    id,
    type: 'step',
    label: id,
    position: { x: 0, y: 100 },
  };
}

function approvalGate(id = 'approval') {
  return {
    id,
    type: 'gate',
    label: 'Approval',
    position: { x: 0, y: 100 },
    gate: { kind: 'approval', description: 'Approve this run', approvalRef: 'native-gate' },
  };
}

function createDefinition(id: string, nodes: Array<Record<string, unknown>>) {
  return modules.definitions.createDefinition(root, {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: String(nodes[index].id),
      to: String(node.id),
      kind: 'sequence',
    })),
  } as never, { now: () => new Date(clock).toISOString() });
}

function pollScript(name: string, output: unknown): string {
  const script = path.join(root, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s' '${JSON.stringify(output)}'\n`, 'utf8');
  fs.chmodSync(script, 0o700);
  return script;
}

function harness() {
  const sessions = new Map<string, import('../advance.js').StepSessionProbe>();
  const apiContext = {
    getConfig: () => ({ gateway: {}, engines: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: 'test-token',
    jinnHome: home,
    sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
    emit: () => undefined,
  } as unknown as import('../../gateway/api.js').ApiContext;
  const deps = {
    ...modules.api.workflowRunDriverDeps(root, apiContext),
    now: () => new Date(clock).toISOString(),
    syncRunSession: undefined,
    probeStepSession: (key: string) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx: import('../advance.js').SpawnContext) => {
      const key = modules.advance.stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `session:${ctx.runId}:${ctx.nodeId}:${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId };
    },
    stopStepSession: async () => undefined,
  };
  const legacyBridge = (deps as typeof deps & {
    workItems?: {
      mintRunItem: (...args: unknown[]) => void;
      linkTriggeredRunItem: (...args: unknown[]) => void;
      linkRunSession: (...args: unknown[]) => void;
      onRunTerminal: (...args: unknown[]) => void;
      mirrorParkedGate: (...args: unknown[]) => void;
      clearParkMirror: (...args: unknown[]) => void;
    };
  }).workItems;
  if (legacyBridge) {
    (deps as typeof deps & { workItems: typeof legacyBridge }).workItems = {
      mintRunItem: (...args) => {
        todoWrites.createWorkItem += 1;
        legacyBridge.mintRunItem(...args);
      },
      linkTriggeredRunItem: (...args) => {
        todoWrites.linkSession += 1;
        legacyBridge.linkTriggeredRunItem(...args);
      },
      linkRunSession: (...args) => {
        todoWrites.linkSession += 1;
        legacyBridge.linkRunSession(...args);
      },
      onRunTerminal: (...args) => {
        todoWrites.transitionDerived += 1;
        legacyBridge.onRunTerminal(...args);
      },
      mirrorParkedGate: (...args) => {
        todoWrites.requestApproval += 1;
        legacyBridge.mirrorParkedGate(...args);
      },
      clearParkMirror: (...args) => {
        todoWrites.decideApproval += 1;
        legacyBridge.clearParkMirror(...args);
      },
    };
  }
  const settle = (runId: string, nodeId: string, attempt = 1, outcome: 'idle' | 'interrupted' = 'idle') => {
    const key = modules.advance.stepSessionKey(runId, nodeId, attempt, 1);
    sessions.set(key, {
      found: true,
      sessionId: `session:${runId}:${nodeId}:${attempt}`,
      status: outcome,
      ...(outcome === 'idle' ? { finalAssistantText: `${nodeId} done` } : {}),
    });
  };
  return { deps, sessions, settle };
}

function todoWriteCounts(sourceTodoId: string) {
  const directWorkflowTransitions = modules.store.listWorkItemEvents(sourceTodoId)
    .filter((event) => event.kind === 'status_change' && event.actor === 'workflow-run')
    .length;
  return { ...todoWrites, transition: todoWrites.transition + directWorkflowTransitions };
}

describe('Workflow has no Todo write capability', () => {
  it('keeps every invocation and lifecycle path outside the Todo write boundary', async () => {
    const sourceTodo = modules.store.createWorkItem({
      title: 'Source Todo',
      status: 'in_review',
      source: 'human',
    });
    vi.mocked(modules.store.createWorkItem).mockClear();
    todoWrites.createWorkItem = 0;

    const main = harness();

    const manualDef = createDefinition('manual-source', [trigger(), inlineStep()]);
    const manual = await modules.reconciler.startWorkflowRun(main.deps, manualDef);
    expect(manual.status).toBe('completed');

    const scheduleDef = createDefinition('schedule-source', [trigger('schedule'), inlineStep()]);
    const scheduled = await modules.cron.fireWorkflowCronJob(main.deps, {
      id: 'workflow:schedule-source',
      name: 'Schedule source',
      enabled: true,
      schedule: '0 8 * * *',
      managedBy: 'workflow',
      workflowId: 'schedule-source',
    }, '2026-07-12T08:00:00.000Z');
    expect(scheduled.outcome).toBe('started');

    const eventDef = createDefinition('event-source', [trigger(), inlineStep()]);
    const event = await modules.reconciler.startWorkflowRunFromTrigger(main.deps, eventDef, {
      source: 'event-webhook',
      event: 'example.received',
      payload: { value: 1 },
      fireRef: 'event-1',
    });
    expect(event.trigger).toMatchObject({ source: 'event-webhook', fireRef: 'event-1' });

    createDefinition('poll-source', [trigger(), inlineStep()]);
    const pendingPoll = modules.customTriggers.createWorkflowTriggerBinding(root, {
      kind: 'poll',
      name: 'native-poll',
      event: 'poll.ready',
      targetWorkflowId: 'poll-source',
      command: pollScript('native-poll', { fire: true, payload: { ready: true }, fireRef: 'poll-1' }),
      intervalSeconds: 60,
    }, { now: main.deps.now }).binding;
    const approvedPoll = await modules.customTriggers.decidePollActivationApproval(
      root,
      pendingPoll.name,
      'approve',
      'workflow-manager',
      { now: main.deps.now },
    );
    const poll = await modules.poll.runPollTriggerOnce(main.deps, approvedPoll);
    expect(poll.outcome).toBe('fired');

    const todoDef = createDefinition('todo-source', [trigger('todo-status-change'), inlineStep('todo-step')]);
    const todoOutcomes = await modules.todoStatus.fireTodoStatusChangeWorkflows(main.deps, {
      id: 'todo-event-1',
      workItemId: sourceTodo.id,
      fromStatus: 'executing',
      toStatus: 'in_review',
      item: { source: 'human', department: null, assignee: null },
    });
    expect(todoOutcomes).toHaveLength(1);
    const todoRun = 'run' in todoOutcomes[0] ? todoOutcomes[0].run : null;
    expect(todoRun?.trigger).toMatchObject({
      source: 'todo-status-change',
      payload: { todoId: sourceTodo.id },
    });

    const spawnedDef = createDefinition('spawn-complete', [trigger(), step()]);
    const spawned = await modules.reconciler.startWorkflowRun(main.deps, spawnedDef);
    main.settle(spawned.runId, 'step');
    await modules.reconciler.sweepWorkflowRuns(main.deps);
    expect(modules.runStore.getRun(root, spawnedDef.id, spawned.runId)?.status).toBe('completed');

    const retryDef = createDefinition('retry-path', [trigger(), step('retry-step', { retry: { maxAttempts: 2, on: ['interrupted'] } })]);
    const retryRun = await modules.reconciler.startWorkflowRun(main.deps, retryDef);
    main.settle(retryRun.runId, 'retry-step', 1, 'interrupted');
    await modules.reconciler.sweepWorkflowRuns(main.deps);
    main.settle(retryRun.runId, 'retry-step', 2);
    await modules.reconciler.sweepWorkflowRuns(main.deps);
    expect(modules.runStore.getRun(root, retryDef.id, retryRun.runId)?.status).toBe('completed');

    const parkedDef = createDefinition('park-approval', [trigger(), step('park-step'), approvalGate()]);
    const parking = await modules.reconciler.startWorkflowRun(main.deps, parkedDef);
    main.settle(parking.runId, 'park-step');
    await modules.reconciler.sweepWorkflowRuns(main.deps);
    const parked = modules.runStore.getRun(root, parkedDef.id, parking.runId)!;
    expect(parked.status).toBe('parked');
    const approved = await modules.reconciler.resolveWorkflowRunGate(main.deps, parkedDef.id, parked.runId, 'approve', { decidedBy: 'workflow-manager' });
    expect(approved.outcome).toBe('resolved');

    const failing = harness();
    failing.deps.spawnStep = async () => { throw new Error('engine unavailable'); };
    const failedDef = createDefinition('failure-path', [trigger(), step('failure-step')]);
    const failed = await modules.reconciler.startWorkflowRun(failing.deps, failedDef);
    expect(failed.status).toBe('failed');

    const timeout = harness();
    const timeoutDef = createDefinition('timeout-path', [trigger(), step('timeout-step', { timeoutMinutes: 1 })]);
    const timed = await modules.reconciler.startWorkflowRun(timeout.deps, timeoutDef);
    clock += 61_000;
    await modules.reconciler.sweepWorkflowRuns(timeout.deps);
    expect(modules.runStore.getRun(root, timeoutDef.id, timed.runId)?.status).toBe('failed');

    const cancellation = harness();
    const cancellationDef = createDefinition('cancellation-path', [trigger(), step('cancel-step')]);
    const cancelling = await modules.reconciler.startWorkflowRun(cancellation.deps, cancellationDef);
    const cancellationRequested = await modules.reconciler.cancelWorkflowRun(
      cancellation.deps,
      cancellationDef.id,
      cancelling.runId,
      { actor: 'operator', reason: 'negative capability test' },
    );
    expect(cancellationRequested).toMatchObject({
      outcome: 'cancelled',
      run: { status: 'running', stopping: { to: 'cancelled' } },
    });
    cancellation.settle(cancelling.runId, 'cancel-step', 1, 'interrupted');
    await modules.reconciler.sweepWorkflowRuns(cancellation.deps);
    expect(modules.runStore.getRun(root, cancellationDef.id, cancelling.runId)?.status).toBe('cancelled');

    expect(todoWriteCounts(sourceTodo.id)).toEqual({
      createWorkItem: 0,
      linkSession: 0,
      transition: 0,
      transitionDerived: 0,
      requestApproval: 0,
      decideApproval: 0,
    });
    expect(modules.store.getWorkItem(sourceTodo.id)?.status).toBe('in_review');
  });
});
