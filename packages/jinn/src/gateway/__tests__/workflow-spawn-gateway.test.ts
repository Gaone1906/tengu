import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GRS-016e-fix4 gateway tier (Codex round-4 finding 5) — the REAL
 * spawnWorkflowStepSession (the SHARED-SESSION CREATION path: the first
 * `sessionMode:'workflow'` turn of a run) against the REAL registry + the
 * REAL recoverStaleSessions.
 *
 * The same status-before-insert invariant fix3 pinned for
 * postWorkflowStepFollowUp, now on session CREATION: the new session must be
 * durably `running` BEFORE the anchored prompt row exists, so a process death
 * at any point after the insert leaves a dead `running` row that boot
 * recovery stamps `interrupted` — the planner's retryable cause — never an
 * idle+anchored+no-reply log that mis-settles terminal `step-no-output`.
 * Only the ENGINE's completion handler sets idle, so ran-and-empty stays the
 * one honest owner of that shape.
 *
 * The crash is driven for real: the registry's insertMessage is wrapped so
 * the anchored row COMMITS and then the process "dies" (throws) before the
 * next statement — a kill -9 can land between any two writes, and this is
 * the exact boundary the ordering protects. RED pre-fix: the session was
 * still `idle` at that boundary (spawn marked running only AFTER the insert).
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfsp-home-'));

const crash = vi.hoisted(() => ({ afterInsert: false }));

vi.mock('../../sessions/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sessions/registry.js')>();
  return {
    ...real,
    insertMessage: (...args: Parameters<typeof real.insertMessage>) => {
      const id = real.insertMessage(...args);
      if (crash.afterInsert) {
        crash.afterInsert = false;
        throw new Error('SIMULATED-PROCESS-DEATH-AFTER-INSERT');
      }
      return id;
    },
  };
});

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
// RUNS — combined with the insert-boundary death this is the durable world
// state Codex round-4 named (row present, engine turn never started).
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

const spawnCtx = (runId: string, anchorId: string, marker: string) => ({
  runId, workflowId: 'wf-sp', nodeId: 'a', label: 'A',
  attempt: 1, round: 1,
  spec: { actorKind: 'engine' as const, actorRef: 'codex' },
  prompt: `[workflow-turn ${marker}] do the first shared step`,
  sessionKey: `workflow-run:${runId}:shared`,
  anchorMessageId: anchorId,
});

describe('spawnWorkflowStepSession — durable dispatch-started evidence on shared-session creation (GRS-016e-fix4)', () => {
  it('the anchored prompt row can never exist without the RUNNING mark: a death at the insert boundary recovers interrupted (retryable), never step-no-output', async () => {
    const MARKER = 'wf-turn:run-sp-gw:a:r1:a1';
    const anchorId = 'anchor-row-sp-1';
    crash.afterInsert = true;
    await expect(
      api.spawnWorkflowStepSession(spawnCtx('run-sp-gw', anchorId, MARKER), ctx),
    ).rejects.toThrow('SIMULATED-PROCESS-DEATH-AFTER-INSERT');

    // The durable crash state: the session exists under the shared key with the
    // anchored row committed…
    const session = registry.getSessionBySessionKey('workflow-run:run-sp-gw:shared');
    expect(session).toBeDefined();
    const rows = registry.getMessages(session!.id);
    expect(rows.some((m) => m.id === anchorId && m.role === 'user')).toBe(true);
    // …and the session is durably RUNNING even though the engine never ran —
    // the dispatch-started evidence boot recovery keys on. (Codex round-4: the
    // pre-fix spawner marked running only AFTER the insert, so this read idle
    // and the crash window settled terminal step-no-output.)
    expect(session!.status).toBe('running');

    // "Gateway death + boot": the REAL recovery stamps the dead running session.
    registry.recoverStaleSessions();
    expect(registry.getSession(session!.id)?.status).toBe('interrupted');

    // The REAL driver probe then reports the retryable cause — the planner's
    // existing interrupted arm re-posts (attempt+1), never step-no-output.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfsp-root-'));
    const probe = api.workflowRunDriverDeps(root, ctx).probeSessionTurn!;
    const q = probe({ sessionId: session!.id, marker: MARKER, anchor: anchorId });
    expect(q).toMatchObject({ found: true, status: 'interrupted', markerPosted: true });
  });

  it('a turn the ENGINE completed with no reply still probes as the honest ran-and-empty terminal (idle, anchored, replyText null)', async () => {
    const MARKER = 'wf-turn:run-sp-gw2:a:r1:a1';
    const anchorId = 'anchor-row-sp-2';
    const spawned = await api.spawnWorkflowStepSession(spawnCtx('run-sp-gw2', anchorId, MARKER), ctx);
    // Spawn leaves the dispatch-started mark; completion is what sets idle
    // (simulated the way the engine's completion handler does).
    expect(registry.getSession(spawned.sessionId)?.status).toBe('running');
    registry.updateSession(spawned.sessionId, { status: 'idle' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfsp-root2-'));
    const probe = api.workflowRunDriverDeps(root, ctx).probeSessionTurn!;
    const q = probe({ sessionId: spawned.sessionId, marker: MARKER, anchor: anchorId });
    expect(q).toMatchObject({ found: true, status: 'idle', markerPosted: true, replyText: null });
  });
});
