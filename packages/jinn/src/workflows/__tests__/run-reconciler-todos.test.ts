import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkflowRunGate,
  startWorkflowRun,
  sweepWorkflowRuns,
  type RunDriverDeps,
} from '../run-reconciler.js';
import { stepSessionKey, type SpawnContext, type StepSessionProbe } from '../advance.js';
import { createDefinition, getDefinition } from '../definition-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
} from '../definition.js';
import type { BridgeRunRef, WorkflowTodoBridge } from '../../work-items/workflow-bridge.js';

/**
 * GRS-021a — the run driver's Todos-ledger contract (design §2, the missing
 * structural auto-mint point): startWorkflowRun MINTS the run-level work item
 * right after the durable record exists and BEFORE any spawn; every session the
 * driver SPAWNS is linked; a terminal run is reflected. All best-effort — a
 * throwing bridge never touches the run. Stub-bridge tier (the bridge's own
 * store behavior is covered in work-items tests; the live path in QA).
 */

const FIXED = '2026-07-05T10:00:00.000Z';
const now = () => FIXED;

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
function approvalGate(id: string): WorkflowNode {
  return { id, type: 'gate', label: id.toUpperCase(), position: { x: 0, y: 0 }, gate: { kind: 'approval', description: 'approve', approvalRef: 'ap' } };
}
function chainDef(id: string, nodes: WorkflowNode[]): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id, title: id, version: 1, status: 'active',
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, to: n.id, kind: 'sequence' as const })),
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-runrec-todos-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Recording stub bridge: every call appended to one ordered log. */
function stubBridge() {
  const calls: Array<{
    op: 'mint' | 'link-triggered' | 'link' | 'terminal' | 'mirror' | 'clear';
    run: BridgeRunRef;
    sessionId?: string;
    gate?: { ref?: string; description: string };
    decision?: 'approve' | 'reject';
  }> = [];
  const bridge: WorkflowTodoBridge = {
    mintRunItem: (run) => calls.push({ op: 'mint', run }),
    linkTriggeredRunItem: (run) => calls.push({ op: 'link-triggered', run }),
    linkRunSession: (run, sessionId) => calls.push({ op: 'link', run, sessionId }),
    onRunTerminal: (run) => calls.push({ op: 'terminal', run }),
    mirrorParkedGate: (run, gate) => calls.push({ op: 'mirror', run, gate }),
    clearParkMirror: (run, decision) => calls.push({ op: 'clear', run, decision }),
  };
  return { bridge, calls };
}

function harness(bridge?: WorkflowTodoBridge) {
  const sessions = new Map<string, StepSessionProbe>();
  const spawnCalls: SpawnContext[] = [];
  const ordered: string[] = []; // cross-cutting order log (mint vs spawn)
  const deps: RunDriverDeps = {
    root,
    getDefinition,
    probeStepSession: (key) => sessions.get(key) ?? { found: false },
    spawnStep: async (ctx) => {
      spawnCalls.push(ctx);
      ordered.push(`spawn:${ctx.nodeId}`);
      const key = stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
      const sessionId = `sess:${ctx.nodeId}:${ctx.attempt}`;
      sessions.set(key, { found: true, sessionId, status: 'running' });
      return { sessionId };
    },
    ...(bridge
      ? {
        workItems: {
            mintRunItem: (run) => {
              ordered.push('mint');
              bridge.mintRunItem(run);
            },
            linkTriggeredRunItem: (run, todoId) => {
              ordered.push(`link-triggered:${todoId}`);
              bridge.linkTriggeredRunItem(run, todoId);
            },
            linkRunSession: (run, sessionId) => {
              ordered.push(`link:${sessionId}`);
              bridge.linkRunSession(run, sessionId);
            },
            onRunTerminal: (run) => {
              ordered.push(`terminal:${run.status}`);
              bridge.onRunTerminal(run);
            },
            mirrorParkedGate: (run, gate) => {
              ordered.push('mirror');
              bridge.mirrorParkedGate(run, gate);
            },
            clearParkMirror: (run, decision) => {
              ordered.push('clear');
              bridge.clearParkMirror(run, decision);
            },
          },
        }
      : {}),
    now,
  };
  const settle = (runId: string, nodeId: string, attempt: number, status: StepSessionProbe['status'] = 'idle') => {
    const key = stepSessionKey(runId, nodeId, attempt, 1);
    const existing = sessions.get(key);
    sessions.set(key, {
      found: true,
      sessionId: existing?.sessionId ?? `sess:${nodeId}:${attempt}`,
      status,
      ...(status === 'idle' ? { finalAssistantText: `output of ${nodeId}` } : {}),
    });
  };
  return { deps, spawnCalls, settle, ordered };
}

describe('startWorkflowRun — the Todos auto-mint contract', () => {
  it('mints the run item BEFORE the first spawn, links every spawned step session, and reflects completion', async () => {
    const def = createDefinition(root, chainDef('todo-mint', [trigger, step('a'), step('b')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps, settle, ordered } = harness(bridge);

    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running');

    // Mint-before-spawn: the ledger records intent before the irreversible step.
    expect(ordered[0]).toBe('mint');
    expect(ordered.indexOf('mint')).toBeLessThan(ordered.indexOf('spawn:a'));
    expect(calls[0]).toMatchObject({ op: 'mint', run: { runId: started.runId, workflowId: 'todo-mint', title: 'todo-mint' } });
    // Step a's spawned session is linked.
    expect(calls.filter((c) => c.op === 'link').map((c) => c.sessionId)).toEqual(['sess:a:1']);

    // a settles → sweep spawns + links b; b settles → run completes → terminal reflect.
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    expect(calls.filter((c) => c.op === 'link').map((c) => c.sessionId)).toEqual(['sess:a:1', 'sess:b:1']);

    settle(started.runId, 'b', 1);
    await sweepWorkflowRuns(deps);
    const terminals = calls.filter((c) => c.op === 'terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].run).toMatchObject({ runId: started.runId, status: 'completed' });
  });

  it('links the triggering Todo instead of minting a sibling run item', async () => {
    const def = createDefinition(root, chainDef('todo-linked', [trigger, step('a')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps, ordered } = harness(bridge);

    const started = await startWorkflowRun(deps, def, {
      triggerTodoId: 'wi_existing',
      trigger: { kind: 'todo-status-change', fireRef: 'wie_existing' } as never,
    });

    expect(started.trigger).toMatchObject({ source: 'todo-status-change', payload: { todoId: 'wi_existing' } });
    expect('triggerTodoId' in started).toBe(false);
    expect(calls.filter((c) => c.op === 'mint')).toHaveLength(0);
    expect(ordered[0]).toBe('link-triggered:wi_existing');
    expect(ordered.indexOf('link-triggered:wi_existing')).toBeLessThan(ordered.indexOf('spawn:a'));
  });

  it('reflects a FAILED run onto the ledger (spawn failure → run failed → terminal:failed)', async () => {
    const def = createDefinition(root, chainDef('todo-fail', [trigger, step('a')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps } = harness(bridge);
    deps.spawnStep = async () => {
      throw new Error('engine down');
    };

    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('failed');
    // 'clear' trails 'terminal': a terminal reflect also clears any pending mirror
    // (QA finding 1 — a no-op here, no gate parked, but the call is made).
    expect(calls.map((c) => c.op)).toEqual(['mint', 'terminal', 'clear']);
    expect(calls[1].run.status).toBe('failed');
  });

  it('does NOT mint for a run refused at validation (no drivable record = no company work)', async () => {
    // 'existing'-session-mode step on a driver without follow-up deps → refused at START.
    const def = createDefinition(
      root,
      chainDef('todo-refused', [trigger, step('a', { options: { session: { mode: 'existing', sessionId: 'sess-x' } } } as Partial<WorkflowNode>)]),
      { now },
    );
    const { bridge, calls } = stubBridge();
    const { deps } = harness(bridge);

    const run = await startWorkflowRun(deps, def);
    expect(run.status).toBe('failed');
    expect(run.errors?.[0]?.code).toBe('session-mode-unsupported');
    expect(calls.filter((c) => c.op === 'mint')).toHaveLength(0);
  });

  it('an operator REJECTION of a parked approval gate reflects the failed run onto the ledger', async () => {
    const def = createDefinition(root, chainDef('todo-reject', [trigger, step('a'), approvalGate('g')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps, settle } = harness(bridge);

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps); // a done → gate parks the run
    expect((await import('../run-store.js')).getRun(root, 'todo-reject', started.runId)?.status).toBe('parked');
    expect(calls.filter((c) => c.op === 'terminal')).toHaveLength(0); // parked is NOT terminal (021b mirrors parks)

    const resolved = await resolveWorkflowRunGate(deps, 'todo-reject', started.runId, 'reject');
    expect(resolved.outcome).toBe('resolved');
    const terminals = calls.filter((c) => c.op === 'terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].run.status).toBe('failed');
  });

  it('a THROWING bridge never affects the run (best-effort at every call site)', async () => {
    const def = createDefinition(root, chainDef('todo-throws', [trigger, step('a')]), { now });
    const { deps, settle } = harness({
      mintRunItem: () => {
        throw new Error('ledger down');
      },
      linkTriggeredRunItem: () => {
        throw new Error('ledger down');
      },
      linkRunSession: () => {
        throw new Error('ledger down');
      },
      onRunTerminal: () => {
        throw new Error('ledger down');
      },
      mirrorParkedGate: () => {
        throw new Error('ledger down');
      },
      clearParkMirror: () => {
        throw new Error('ledger down');
      },
    });

    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running'); // mint + link throws swallowed
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    const run = (await import('../run-store.js')).getRun(root, 'todo-throws', started.runId)!;
    expect(run.status).toBe('completed'); // terminal reflect throw swallowed
    expect(run.errors ?? []).toEqual([]);
  });

  it('a driver WITHOUT the bridge behaves exactly as before (deps.workItems optional)', async () => {
    const def = createDefinition(root, chainDef('todo-absent', [trigger, step('a')]), { now });
    const { deps, settle } = harness(); // no workItems
    const started = await startWorkflowRun(deps, def);
    expect(started.status).toBe('running');
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    expect((await import('../run-store.js')).getRun(root, 'todo-absent', started.runId)?.status).toBe('completed');
  });
});

describe('the park mirror (GRS-021b, design §1.3)', () => {
  it('a run parking on an approval gate mirrors the gate onto the ledger (pending, not terminal)', async () => {
    const def = createDefinition(root, chainDef('todo-park', [trigger, step('a'), approvalGate('g')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps, settle } = harness(bridge);

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps); // a done → the gate parks the run

    expect((await import('../run-store.js')).getRun(root, 'todo-park', started.runId)?.status).toBe('parked');
    // The park is MIRRORED (queued for the operator), NOT reflected as terminal.
    expect(calls.filter((c) => c.op === 'terminal')).toHaveLength(0);
    const mirror = calls.find((c) => c.op === 'mirror');
    expect(mirror).toBeTruthy();
    expect(mirror!.gate).toEqual({ ref: 'ap', description: 'approve' });
    expect(mirror!.run).toMatchObject({ runId: started.runId, workflowId: 'todo-park' });
  });

  it('approving the mirrored gate through resolve-gate unparks + completes the run (terminal reflect)', async () => {
    const def = createDefinition(root, chainDef('todo-park-ok', [trigger, step('a'), approvalGate('g')]), { now });
    const { bridge, calls } = stubBridge();
    const { deps, settle } = harness(bridge);

    const started = await startWorkflowRun(deps, def);
    settle(started.runId, 'a', 1);
    await sweepWorkflowRuns(deps);
    expect(calls.some((c) => c.op === 'mirror')).toBe(true);

    const resolved = await resolveWorkflowRunGate(deps, 'todo-park-ok', started.runId, 'approve');
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.run.status).toBe('completed');
    const terminals = calls.filter((c) => c.op === 'terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].run.status).toBe('completed');
  });

  it('the ledger bridge NEVER alters the run record — the resolve-gate result is byte-identical with or without a ledger', async () => {
    const def = createDefinition(root, chainDef('todo-golden', [trigger, step('a'), approvalGate('g')]), { now });
    const drive = async (workItems: WorkflowTodoBridge | undefined, runId: string) => {
      const { deps, settle } = harness(workItems);
      const started = await startWorkflowRun(deps, def, { makeRunId: () => runId });
      settle(started.runId, 'a', 1);
      await sweepWorkflowRuns(deps); // parks on the gate (mirrors, if a ledger is wired)
      return resolveWorkflowRunGate(deps, 'todo-golden', started.runId, 'approve');
    };

    const withLedger = await drive(stubBridge().bridge, 'run_with');
    const withoutLedger = await drive(undefined, 'run_without');
    expect(withLedger.outcome).toBe('resolved');
    expect(withoutLedger.outcome).toBe('resolved');
    if (withLedger.outcome !== 'resolved' || withoutLedger.outcome !== 'resolved') return;
    // Normalize only the runId token — everything else must match byte-for-byte:
    // a mirror touches the Todo store, never the run file the resolve goldens pin.
    const norm = (run: unknown, id: string) => JSON.stringify(run).split(id).join('RUNID');
    expect(norm(withLedger.run, 'run_with')).toEqual(norm(withoutLedger.run, 'run_without'));
  });
});
