import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GRS-016e-fix3 gateway tier (Codex round-3 finding 4) — the REAL
 * postWorkflowStepFollowUp against the REAL registry + the REAL
 * recoverStaleSessions.
 *
 * The recovery-completeness contract under test: `step-no-output` must mean
 * "the turn actually RAN and produced nothing", which requires durable
 * dispatch-started evidence. The poster provides it by marking the target
 * session `running` INSIDE the atomic segment, BEFORE the anchored insert —
 * so a process death anywhere from that write to (and through) the engine
 * turn leaves a dead `running` row that boot recovery stamps `interrupted`,
 * and the planner's retry arm re-posts. Only a turn the ENGINE completed can
 * present as idle — making idle+anchored+no-reply the honest ran-and-empty
 * terminal, never a crash artifact.
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wffu-home-'));

type Api = typeof import('../api.js');
type Registry = typeof import('../../sessions/registry.js');
let api: Api;
let registry: Registry;

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  registry.initDb();
  const models = await import('../../shared/models.js');
  models.invalidateModelRegistry();
});

// A no-op engine + queue: the enqueue/dispatch is accepted but the turn NEVER
// RUNS — the durable world state of a process death between the anchored insert
// and the engine turn (Codex round-3's exact window).
const fakeEngine = { name: 'codex' };
const config = { gateway: {}, engines: { default: 'codex' } };
const ctx = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  sessionManager: {
    getEngine: () => fakeEngine,
    getEngines: () => new Map([['codex', fakeEngine]]),
    getQueue: () => ({
      enqueue: async () => {},
      clearQueue: () => {},
      isRunning: () => false,
      getPendingCount: () => 0,
    }),
  },
  emit: () => {},
} as unknown as import('../api.js').ApiContext;

const MARKER = 'wf-turn:run-fu-gw:x:r1:a1';

describe('postWorkflowStepFollowUp — durable dispatch-started evidence (GRS-016e-fix3)', () => {
  it('marks the target session RUNNING within the atomic post segment, so a crash before the engine turn can never present as idle', async () => {
    const target = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: 'fu-target-1',
      connector: 'web', prompt: 'operator session',
    });
    registry.updateSession(target.id, { status: 'idle' });

    const anchorId = 'anchor-row-fu-1';
    const posted = await api.postWorkflowStepFollowUp({
      runId: 'run-fu-gw', workflowId: 'wf-fu', nodeId: 'x', label: 'X',
      attempt: 1, round: 1, sessionId: target.id,
      spec: { actorKind: 'engine', actorRef: 'codex' },
      prompt: `[workflow-turn ${MARKER}] do the step`,
      turnMarker: MARKER,
      anchorMessageId: anchorId,
    }, ctx);
    expect(posted.outcome).toBe('posted');

    // The anchored row exists under the pre-minted id…
    const rows = registry.getMessages(target.id);
    expect(rows.some((m) => m.id === anchorId && m.role === 'user')).toBe(true);
    // …and the session is durably RUNNING even though the engine never ran —
    // the dispatch-started evidence boot recovery keys on. (Codex round-3: the
    // pre-fix poster left this idle, so the crash window settled step-no-output.)
    expect(registry.getSession(target.id)?.status).toBe('running');

    // "Gateway death + boot": the REAL recovery stamps the dead running session.
    registry.recoverStaleSessions();
    expect(registry.getSession(target.id)?.status).toBe('interrupted');

    // The REAL driver probe then reports the retryable cause — the planner's
    // existing interrupted arm re-posts (attempt+1), never step-no-output.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wffu-root-'));
    const probe = api.workflowRunDriverDeps(root, ctx).probeSessionTurn!;
    const q = probe({ sessionId: target.id, marker: MARKER, anchor: anchorId });
    expect(q).toMatchObject({ found: true, status: 'interrupted', markerPosted: true });
  });

  it('a turn the ENGINE completed with no reply still probes as the honest ran-and-empty terminal (idle, anchored, replyText null)', async () => {
    const target = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: 'fu-target-2',
      connector: 'web', prompt: 'operator session',
    });
    registry.updateSession(target.id, { status: 'idle' });
    const anchorId = 'anchor-row-fu-2';
    await api.postWorkflowStepFollowUp({
      runId: 'run-fu-gw2', workflowId: 'wf-fu', nodeId: 'x', label: 'X',
      attempt: 1, round: 1, sessionId: target.id,
      spec: { actorKind: 'engine', actorRef: 'codex' },
      prompt: `[workflow-turn wf-turn:run-fu-gw2:x:r1:a1] do the step`,
      turnMarker: 'wf-turn:run-fu-gw2:x:r1:a1',
      anchorMessageId: anchorId,
    }, ctx);
    // The engine ran the turn to completion and produced nothing: completion is
    // what sets idle (simulated the way the engine's completion handler does).
    registry.updateSession(target.id, { status: 'idle' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wffu-root2-'));
    const probe = api.workflowRunDriverDeps(root, ctx).probeSessionTurn!;
    const q = probe({ sessionId: target.id, marker: 'wf-turn:run-fu-gw2:x:r1:a1', anchor: anchorId });
    expect(q).toMatchObject({ found: true, status: 'idle', markerPosted: true, replyText: null });
  });

  it('a BUSY target still defers atomically (the fix2 invariant is untouched)', async () => {
    const target = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: 'fu-target-3',
      connector: 'web', prompt: 'operator session',
    });
    registry.updateSession(target.id, { status: 'running' });
    const posted = await api.postWorkflowStepFollowUp({
      runId: 'run-fu-gw3', workflowId: 'wf-fu', nodeId: 'x', label: 'X',
      attempt: 1, round: 1, sessionId: target.id,
      spec: { actorKind: 'engine', actorRef: 'codex' },
      prompt: '[workflow-turn wf-turn:run-fu-gw3:x:r1:a1] do the step',
      turnMarker: 'wf-turn:run-fu-gw3:x:r1:a1',
      anchorMessageId: 'anchor-row-fu-3',
    }, ctx);
    expect(posted.outcome).toBe('deferred');
    expect(registry.getMessages(target.id).some((m) => m.id === 'anchor-row-fu-3')).toBe(false);
  });
});
