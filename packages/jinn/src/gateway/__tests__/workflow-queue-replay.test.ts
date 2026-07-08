import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GRS-014b-fix regression (Codex finding 1, high): workflow step sessions must have
 * exactly ONE recovery owner — the workflow run reconciler. Before the fix, the boot
 * sequence's generic web queue replay (`resumePendingWebQueueItems`) re-dispatched an
 * interrupted step session's stale queue row BEFORE the reconciler's startup sweep
 * ran, resuming attempt 1 under its old sessionKey and defeating the respawn-once
 * accounting (attempt 2 was never minted) — reproduced live by Codex QA.
 *
 * This test drives the REAL replay function against the real registry (temp
 * JINN_HOME): a workflow step queue row must be cancelled without touching its
 * session (left `interrupted` for the reconciler), while ordinary web rows are still
 * processed.
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfreplay-home-'));

type Api = typeof import('../api.js');
type Registry = typeof import('../../sessions/registry.js');
let api: Api;
let registry: Registry;

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  registry.initDb();
});

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  // No engine available: an ordinary web row that reaches the engine lookup is
  // cancelled + errored (existing behavior) — a workflow row must never get that far.
  sessionManager: { getEngine: () => undefined, getEngines: () => new Map() },
  emit: () => {},
} as unknown as import('../api.js').ApiContext;

describe('resumePendingWebQueueItems — workflow steps are ceded to the run reconciler', () => {
  it('cancels a workflow-run:* queue row WITHOUT touching its interrupted session, while ordinary web rows are still processed', () => {
    // The crash state recoverStaleSessions/recoverStaleQueueItems leave behind:
    // an interrupted step session + its pending (replayable) queue row.
    const stepKey = 'workflow-run:run-replay-test:sa:1';
    const stepSession = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: stepKey, sessionKey: stepKey,
      connector: 'web', prompt: 'step work',
    });
    registry.updateSession(stepSession.id, { status: 'interrupted', lastError: 'Interrupted: gateway restarted while session was running' });
    registry.enqueueQueueItem(stepSession.id, stepKey, 'step work');

    // Control: an ordinary web conversation with a pending row.
    const webSession = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: 'web:control', sessionKey: 'web:control',
      connector: 'web', prompt: 'hello',
    });
    registry.updateSession(webSession.id, { status: 'interrupted' });
    registry.enqueueQueueItem(webSession.id, 'web:control', 'hello');

    expect(registry.listAllPendingQueueItems()).toHaveLength(2);

    api.resumePendingWebQueueItems(ctx);

    // Both rows are gone from the pending set — neither can replay on a later boot.
    expect(registry.listAllPendingQueueItems()).toHaveLength(0);

    // The WORKFLOW step session was left exactly as the boot recovery stamped it:
    // `interrupted`, for the run reconciler (the single recovery owner) to respawn
    // as attempt 2 under a NEW sessionKey. The replay must not have flipped it to
    // running (the pre-fix steal) or to error (the engine-missing branch).
    const step = registry.getSession(stepSession.id)!;
    expect(step.status).toBe('interrupted');
    expect(step.lastError).toMatch(/gateway restarted/);

    // The ordinary web session WAS processed by the replay loop (engine missing →
    // cancelled + errored) — proving the workflow row was excluded by ownership,
    // not because the loop never ran.
    expect(registry.getSession(webSession.id)?.status).toBe('error');
  });

  it('recognizes the workflow ownership via sessionKey too (sourceRef defense-in-depth)', () => {
    // A step session whose sourceRef was rewritten by some future path but whose
    // sessionKey still carries the workflow identity must also be ceded.
    const key = 'workflow-run:run-replay-test:sb:1';
    const session = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: 'web:odd', sessionKey: key,
      connector: 'web', prompt: 'step work',
    });
    registry.updateSession(session.id, { status: 'interrupted' });
    registry.enqueueQueueItem(session.id, key, 'step work');

    api.resumePendingWebQueueItems(ctx);

    expect(registry.listAllPendingQueueItems()).toHaveLength(0);
    expect(registry.getSession(session.id)?.status).toBe('interrupted');
  });
});
