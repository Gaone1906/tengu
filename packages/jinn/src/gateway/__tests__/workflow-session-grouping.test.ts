import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-group-home-'));
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-group-root-'));
process.env.JINN_HOME = home;
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;

type Api = typeof import('../api.js');
type Server = typeof import('../server.js');
type Registry = typeof import('../../sessions/registry.js');
type Workflows = typeof import('../../workflows/index.js');
let api: Api;
let server: Server;
let registry: Registry;
let workflows: Workflows;

const events: Array<{ event: string; payload: unknown }> = [];
const queue = {
  enqueue: async () => undefined,
  clearQueue: () => undefined,
  isRunning: () => false,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status === 'running' ? 'running' : 'idle',
};
const fakeEngine = { name: 'codex' };
const context = {
  getConfig: () => ({ gateway: {}, engines: { default: 'codex' } }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: 'test-token',
  sessionManager: {
    getEngine: (name: string) => name === 'codex' ? fakeEngine : undefined,
    getEngines: () => new Map([['codex', fakeEngine]]),
    getQueue: () => queue,
  },
  emit: (event: string, payload: unknown) => events.push({ event, payload }),
} as unknown as import('../api.js').ApiContext;

function definition(id: string, name: string, trigger: import('../../workflows/index.js').WorkflowTrigger) {
  return {
    schemaVersion: 1,
    id,
    name,
    title: `${name} title`,
    version: 1,
    status: 'active' as const,
    nodes: [
      { id: 'trigger', type: 'trigger' as const, label: 'Start', position: { x: 0, y: 0 }, trigger },
      {
        id: 'review',
        type: 'step' as const,
        label: 'REVIEW',
        position: { x: 0, y: 100 },
        actor: { kind: 'engine' as const, ref: 'codex' },
        instructions: 'Review the input.',
      },
    ],
    edges: [{ id: 'edge', from: 'trigger', to: 'review', kind: 'sequence' as const }],
  };
}

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() { return JSON.parse(Buffer.concat(chunks).toString('utf8')); },
  };
}

async function get(pathname: string) {
  return request('GET', pathname);
}

async function request(method: string, pathname: string, body?: unknown) {
  const cap = responseCapture();
  const encoded = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(encoded);
  Object.assign(req, {
    method,
    url: pathname,
    headers: {
      host: 'localhost',
      authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  await api.handleApiRequest(req as Parameters<Api['handleApiRequest']>[0], cap.res, context);
  return cap;
}

beforeAll(async () => {
  api = await import('../api.js');
  server = await import('../server.js');
  registry = await import('../../sessions/registry.js');
  workflows = await import('../../workflows/index.js');
  registry.initDb();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

describe('workflow run session grouping', () => {
  it('redirects historical direct reads and rejects every mutation without changing evidence', async () => {
    const legacy = registry.createSession({
      engine: 'workflow',
      source: 'web',
      sourceRef: 'workflow-run:run-read-only:parent',
      sessionKey: 'workflow-run:run-read-only:parent',
      workflowProvenance: {
        kind: 'run',
        workflowId: 'release-review',
        workflowName: 'release-review',
        runId: 'run-read-only',
        triggerSource: 'manual',
      },
    });
    registry.updateSession(legacy.id, { status: 'running', lastActivity: '2026-01-02T03:04:05.000Z' });
    const messageId = registry.insertMessage(legacy.id, 'notification', 'Historical evidence');
    const queueId = registry.enqueueQueueItem(legacy.id, legacy.sessionKey, 'Historical queue');
    const delivery = registry.claimCallbackDelivery({
      parentSessionId: legacy.id,
      childSessionId: 'historical-phase',
      attemptToken: 'historical-attempt',
      terminalOutcome: 'succeeded',
      terminalVersion: 1,
      callbackKind: 'parent-completion',
      payload: { message: 'Historical callback', displayMessage: 'Historical callback' },
    }).delivery;
    const database = registry.initDb();
    const snapshot = () => ({
      session: database.prepare('SELECT * FROM sessions WHERE id = ?').get(legacy.id),
      messages: database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(legacy.id),
      queue: database.prepare('SELECT * FROM queue_items WHERE session_id = ? ORDER BY id').all(legacy.id),
      deliveries: database.prepare('SELECT * FROM callback_deliveries WHERE target_session_id = ? ORDER BY id').all(legacy.id),
    });
    const before = snapshot();
    const location = {
      workflowId: 'release-review',
      runId: 'run-read-only',
      openPath: '/workflow/release-review?mode=runs&run=run-read-only',
    };

    for (const pathname of [
      `/api/sessions/${legacy.id}`,
      `/api/sessions/${legacy.id}/messages`,
      `/api/sessions/${legacy.id}/queue`,
      `/api/sessions/${legacy.id}/children`,
      `/api/sessions/${legacy.id}/context?message=${messageId}`,
      `/api/sessions/${legacy.id}/transcript`,
    ]) {
      const response = await request('GET', pathname);
      expect(response.status, pathname).toBe(410);
      expect(response.body).toEqual({
        error: 'Workflow runs are no longer sessions.',
        legacyWorkflowRun: location,
      });
    }

    const mutations: Array<[string, string, unknown?]> = [
      ['PUT', `/api/sessions/${legacy.id}`, { title: 'Changed' }],
      ['PATCH', `/api/sessions/${legacy.id}`, { title: 'Changed' }],
      ['DELETE', `/api/sessions/${legacy.id}`],
      ['POST', `/api/sessions/${legacy.id}/stop`, {}],
      ['POST', `/api/sessions/${legacy.id}/reset`, {}],
      ['POST', `/api/sessions/${legacy.id}/duplicate`, {}],
      ['DELETE', `/api/sessions/${legacy.id}/queue/${queueId}`],
      ['DELETE', `/api/sessions/${legacy.id}/queue`],
      ['POST', `/api/sessions/${legacy.id}/queue/pause`, {}],
      ['POST', `/api/sessions/${legacy.id}/queue/resume`, {}],
      ['POST', `/api/sessions/${legacy.id}/message`, { callbackDeliveryId: delivery.id }],
      ['POST', `/api/sessions/${legacy.id}/attachments`, { content: 'changed', filename: 'changed.txt' }],
      ['POST', '/api/sessions/bulk-delete', { ids: [legacy.id] }],
    ];
    for (const [method, pathname, body] of mutations) {
      const response = await request(method, pathname, body);
      expect(response.status, `${method} ${pathname}`).toBe(409);
      expect(response.body).toEqual({
        error: 'Historical Workflow session is read-only.',
        legacyWorkflowRun: location,
      });
    }

    expect(snapshot()).toEqual(before);
    expect(registry.getCallbackDelivery(delivery.id)?.status).toBe('pending');
    expect((await get('/api/sessions/missing-ordinary-session')).status).toBe(404);
  });

  it('lists historical run projections as idle evidence without counting or interrupting them', async () => {
    const legacy = registry.createSession({
      engine: 'workflow',
      source: 'web',
      sourceRef: 'workflow-run:run-history:parent',
      sessionKey: 'workflow-run:run-history:parent',
      workflowProvenance: {
        kind: 'run',
        workflowId: 'historical-record',
        workflowName: 'historical-record',
        runId: 'run-history',
        triggerSource: 'manual',
      },
    });
    registry.updateSession(legacy.id, { status: 'running', lastActivity: '2026-01-01T00:00:00.000Z' });

    const listed = await get('/api/sessions?limit=0');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<Record<string, unknown>>).find((session) => session.id === legacy.id))
      .toMatchObject({ status: 'running', transportState: 'idle' });
    const status = await get('/api/status');
    expect(status.body).toMatchObject({ sessions: { running: 0, active: 0 } });
    const searched = await get('/api/search/sessions?workflowRunId=run-history');
    expect((searched.body as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id))
      .toEqual([legacy.id]);

    const interruptForShutdown = (server as Server & {
      interruptRunningSessionsForShutdown?: () => void;
    }).interruptRunningSessionsForShutdown;
    expect(interruptForShutdown).toBeTypeOf('function');
    interruptForShutdown!();
    expect(registry.getSession(legacy.id)?.status).toBe('running');
  });

  it('groups a manual run-by-name through phase provenance without a synthetic parent', async () => {
    const saved = workflows.createDefinition(
      evidenceRoot,
      definition('manual-record', 'release-check', { kind: 'manual' }),
    );
    const resolved = workflows.getDefinitionByName(evidenceRoot, 'release-check');
    expect(resolved?.id).toBe(saved.id);

    const run = await workflows.startWorkflowRunFromTrigger(
      api.workflowRunDriverDeps(evidenceRoot, context),
      resolved!,
      { source: 'manual', event: 'workflow.manual_started', payload: { requestedBy: 'api' } },
      { knownEngines: ['codex'], makeRunId: () => 'run-manual-group' },
    );
    expect(run.status).toBe('running');

    const phase = registry.getSessionBySessionKey('workflow-run:run-manual-group:review:1');
    expect(registry.getSessionBySessionKey('workflow-run:run-manual-group:parent')).toBeUndefined();
    expect(phase).toMatchObject({
      title: '[Workflow] release-check / REVIEW',
      parentSessionId: null,
      workflowProvenance: {
        kind: 'phase', workflowId: 'manual-record', workflowName: 'release-check',
        runId: 'run-manual-group', triggerSource: 'manual',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });

    const listed = await get('/api/sessions?limit=0');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string; engine: string }>).map((s) => s.id)).toContain(phase!.id);
    expect(registry.getSessionBySessionKey('workflow-run:run-manual-group:parent')).toBeUndefined();
    const searched = await get('/api/search/sessions?workflowRunId=run-manual-group');
    expect(searched.status).toBe(200);
    const searchedSessions = (searched.body as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(searchedSessions.map((s) => s.id)).toEqual([phase!.id]);
    expect(searchedSessions.find((session) => session.id === phase!.id)).toMatchObject({
      workflowProvenance: {
        kind: 'phase', workflowId: 'manual-record', workflowName: 'release-check',
        runId: 'run-manual-group', triggerSource: 'manual',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });
  });

  it('groups a managed cron phase by run id without a synthetic parent', async () => {
    workflows.createDefinition(
      evidenceRoot,
      definition('scheduled-record', 'nightly-review', { kind: 'schedule', cron: '0 1 * * *', timezone: 'UTC' }),
    );
    const fire = await workflows.fireWorkflowCronJob(
      api.workflowRunDriverDeps(evidenceRoot, context),
      {
        id: 'workflow:scheduled-record',
        name: 'nightly-review',
        enabled: true,
        schedule: '0 1 * * *',
        timezone: 'UTC',
        managedBy: 'workflow',
        workflowId: 'scheduled-record',
      },
      '2026-07-10T01:00:00.000Z',
    );
    expect(fire.outcome).toBe('started');
    if (fire.outcome !== 'started') throw new Error('expected cron run to start');

    const phase = registry.getSessionBySessionKey(`workflow-run:${fire.run.runId}:review:1`);
    expect(registry.getSessionBySessionKey(`workflow-run:${fire.run.runId}:parent`)).toBeUndefined();
    expect(phase).toMatchObject({
      parentSessionId: null,
      workflowProvenance: {
        kind: 'phase', workflowId: 'scheduled-record', workflowName: 'nightly-review',
        runId: fire.run.runId, triggerSource: 'schedule',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });
    expect(registry.searchSessionsFiltered({ workflowRunId: fire.run.runId }).map((session) => session.id))
      .toEqual([phase!.id]);
  });
});
