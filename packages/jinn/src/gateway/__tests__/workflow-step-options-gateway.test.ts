import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GRS-016b gateway tier — the real spawnWorkflowStepSession maps the spawn spec's
 * model/effort overrides onto the SESSION RECORD (the acceptance's "verifiably
 * carries those parameters over HTTP" reads exactly these fields), and the real
 * workflowRunDriverDeps.stopStepSession idles a live step session by its
 * deterministic sessionKey (the timeout stop — operator ruling #2).
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfopt-home-'));
// GRS-017f: two employees for the employee-actor model-resolution tests — one
// pinned to a REGISTERED model, one to a model this gateway doesn't register.
fs.mkdirSync(path.join(process.env.JINN_HOME, 'org'), { recursive: true });
fs.writeFileSync(
  path.join(process.env.JINN_HOME, 'org', 'wf-ok.yaml'),
  ['name: wf-ok', 'department: qa', 'engine: codex', 'model: gpt-5.5-mini', 'persona: workflow employee on a registered model', ''].join('\n'),
);
fs.writeFileSync(
  path.join(process.env.JINN_HOME, 'org', 'wf-stale.yaml'),
  ['name: wf-stale', 'department: qa', 'engine: codex', 'model: legacy-sonnet', 'persona: workflow employee pinned to an unregistered model', ''].join('\n'),
);

type Api = typeof import('../api.js');
type Registry = typeof import('../../sessions/registry.js');
let api: Api;
let registry: Registry;

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  registry.initDb();
  // The registry cache is module-global; make sure it is built from THIS config.
  const models = await import('../../shared/models.js');
  models.invalidateModelRegistry();
});

const fakeEngine = { name: 'codex' };
const cleared: string[] = [];
// A config with a real models block: overrides are validated against the SAME
// registry POST /api/sessions uses (GRS-016b-fix, Codex finding 2).
const config = {
  gateway: {},
  engines: { default: 'codex' },
  models: {
    codex: {
      models: [
        { id: 'gpt-5.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'gpt-5.5-mini', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'] },
      ],
    },
  },
};
const ctx = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  sessionManager: {
    getEngine: () => fakeEngine,
    getEngines: () => new Map([['codex', fakeEngine]]),
    getQueue: () => ({ enqueue: async () => {}, clearQueue: (key: string) => { cleared.push(key); } }),
  },
  emit: () => {},
} as unknown as import('../api.js').ApiContext;

describe('spawnWorkflowStepSession — model/effort overrides (GRS-016b)', () => {
  it('an engine-actor spawn carries options.model as the session model and options.effort as effortLevel', async () => {
    const result = await api.spawnWorkflowStepSession({
      runId: 'run-gw-opt-1',
      workflowId: 'wf-gw',
      nodeId: 'sa',
      label: 'Step A',
      attempt: 1,
      round: 1,
      spec: { actorKind: 'engine', actorRef: 'codex', model: 'gpt-5.5-mini', effort: 'xhigh' },
      prompt: 'do the work',
    }, ctx);
    const session = registry.getSession(result.sessionId)!;
    expect(session.model).toBe('gpt-5.5-mini');
    expect(session.effortLevel).toBe('xhigh');
    expect(session.sessionKey).toBe('workflow-run:run-gw-opt-1:sa:1');
  });

  it('an UNKNOWN model override is refused by the registry BEFORE any session exists (Codex 016b finding 2)', async () => {
    const badKey = 'workflow-run:run-gw-opt-bad:bad:1';
    await expect(api.spawnWorkflowStepSession({
      runId: 'run-gw-opt-bad',
      workflowId: 'wf-gw',
      nodeId: 'bad',
      label: 'Bad model',
      attempt: 1,
      round: 1,
      spec: { actorKind: 'engine', actorRef: 'codex', model: 'definitely-not-a-real-model' },
      prompt: 'doomed',
    }, ctx)).rejects.toThrow(/unknown model/);
    // The refusal happened BEFORE createSession — no doomed real session was minted.
    expect(registry.getSessionBySessionKey(badKey)).toBeUndefined();
  });

  it('an INVALID effort override is refused the same way (same validator as the sessions route)', async () => {
    await expect(api.spawnWorkflowStepSession({
      runId: 'run-gw-opt-badeffort',
      workflowId: 'wf-gw',
      nodeId: 'bad',
      label: 'Bad effort',
      attempt: 1,
      round: 1,
      spec: { actorKind: 'engine', actorRef: 'codex', model: 'gpt-5.5', effort: 'ultra' },
      prompt: 'doomed',
    }, ctx)).rejects.toThrow(/invalid effortLevel/);
    expect(registry.getSessionBySessionKey('workflow-run:run-gw-opt-badeffort:bad:1')).toBeUndefined();
  });

  it("an EMPLOYEE actor with a REGISTERED configured model spawns and carries that model — no override needed (GRS-017f)", async () => {
    const result = await api.spawnWorkflowStepSession({
      runId: 'run-gw-emp-ok',
      workflowId: 'wf-gw',
      nodeId: 'emp',
      label: 'Employee OK',
      attempt: 1,
      round: 1,
      spec: { actorKind: 'employee', actorRef: 'wf-ok' },
      prompt: 'do the work',
    }, ctx);
    const session = registry.getSession(result.sessionId)!;
    expect(session.model).toBe('gpt-5.5-mini');
    expect(session.employee).toBe('wf-ok');
  });

  it("an EMPLOYEE actor whose CONFIGURED model isn't registered is refused with the clear employee-named error BEFORE any session — consistent with delegate/spawn (GRS-017f)", async () => {
    const badKey = 'workflow-run:run-gw-emp-stale:emp:1';
    let message = '';
    try {
      await api.spawnWorkflowStepSession({
        runId: 'run-gw-emp-stale',
        workflowId: 'wf-gw',
        nodeId: 'emp',
        label: 'Employee stale model',
        attempt: 1,
        round: 1,
        spec: { actorKind: 'employee', actorRef: 'wf-stale' },
        prompt: 'doomed',
      }, ctx);
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/wf-stale/); // names the employee
    expect(message).toMatch(/legacy-sonnet/); // names its configured model
    expect(message).toMatch(/gpt-5\.5/); // names the known-model set
    expect(message).toMatch(/config\.yaml/); // names the fix
    expect(message).not.toMatch(/unknown model "legacy-sonnet" for engine/); // NOT the bare cryptic string
    // Refused BEFORE createSession — no doomed session minted (pre-fix this
    // silently spawned an unknown model here while delegate 400'd).
    expect(registry.getSessionBySessionKey(badKey)).toBeUndefined();
  });

  it('without overrides the session carries no model/effort (engine defaults apply) — v2 verbatim', async () => {
    const result = await api.spawnWorkflowStepSession({
      runId: 'run-gw-opt-2',
      workflowId: 'wf-gw',
      nodeId: 'sa',
      label: 'Step A',
      attempt: 1,
      round: 1,
      spec: { actorKind: 'engine', actorRef: 'codex' },
      prompt: 'do the work',
    }, ctx);
    const session = registry.getSession(result.sessionId)!;
    expect(session.model).toBeNull();
    expect(session.effortLevel).toBeNull();
  });
});

describe('workflowRunDriverDeps.stopStepSession — the timeout stop (GRS-016b)', () => {
  it('idles the live session found by sessionKey and clears its queue lane', async () => {
    const key = 'workflow-run:run-gw-stop:sb:1';
    const session = registry.createSession({
      engine: 'codex', source: 'web', sourceRef: key, sessionKey: key,
      connector: 'web', prompt: 'long work',
    });
    registry.updateSession(session.id, { status: 'running' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfopt-root-'));
    const deps = api.workflowRunDriverDeps(root, ctx);
    expect(deps.stopStepSession).toBeTypeOf('function');
    await deps.stopStepSession!({
      nodeId: 'sb', attempt: 1, round: 1, sessionKey: key, sessionId: session.id,
      reason: 'step-timeout: exceeded 1 minute(s) on attempt 1',
      runId: 'run-gw-stop', workflowId: 'wf-gw',
    });

    expect(registry.getSession(session.id)?.status).toBe('idle');
    expect(cleared).toContain(key);
  });

  it('a stop for a vanished session is a no-op, never a throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wfopt-root2-'));
    const deps = api.workflowRunDriverDeps(root, ctx);
    await expect(deps.stopStepSession!({
      nodeId: 'zz', attempt: 1, round: 1, sessionKey: 'workflow-run:run-none:zz:1',
      reason: 'step-timeout', runId: 'run-none', workflowId: 'wf-gw',
    })).resolves.toBeUndefined();
  });
});
