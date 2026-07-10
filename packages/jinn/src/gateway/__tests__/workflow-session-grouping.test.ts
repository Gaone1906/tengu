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
type Registry = typeof import('../../sessions/registry.js');
type Workflows = typeof import('../../workflows/index.js');
let api: Api;
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
  const cap = responseCapture();
  const req = Readable.from([]);
  Object.assign(req, {
    method: 'GET',
    url: pathname,
    headers: { host: 'localhost', authorization: 'Bearer test-token' },
  });
  await api.handleApiRequest(req as Parameters<Api['handleApiRequest']>[0], cap.res, context);
  return cap;
}

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  workflows = await import('../../workflows/index.js');
  registry.initDb();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
});

describe('workflow run session grouping', () => {
  it('groups a manual run-by-name phase under a visible run parent with full provenance', async () => {
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

    const parent = registry.getSessionBySessionKey('workflow-run:run-manual-group:parent');
    const phase = registry.getSessionBySessionKey('workflow-run:run-manual-group:review:1');
    expect(parent).toMatchObject({
      title: 'Workflow: release-check · run run-manual-group',
      source: 'web',
      status: 'running',
      workflowProvenance: {
        kind: 'run', workflowId: 'manual-record', workflowName: 'release-check',
        runId: 'run-manual-group', triggerSource: 'manual',
      },
    });
    expect(phase).toMatchObject({
      title: '[Workflow] release-check / REVIEW',
      parentSessionId: parent!.id,
      workflowProvenance: {
        kind: 'phase', workflowId: 'manual-record', workflowName: 'release-check',
        runId: 'run-manual-group', triggerSource: 'manual',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });

    const listed = await get('/api/sessions?limit=0');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).map((s) => s.id)).toEqual(expect.arrayContaining([parent!.id, phase!.id]));
    const searched = await get('/api/search/sessions?workflowRunId=run-manual-group');
    expect(searched.status).toBe(200);
    const searchedSessions = (searched.body as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(searchedSessions.map((s) => s.id))
      .toEqual(expect.arrayContaining([parent!.id, phase!.id]));
    expect(searchedSessions.find((session) => session.id === phase!.id)).toMatchObject({
      workflowProvenance: {
        kind: 'phase', workflowId: 'manual-record', workflowName: 'release-check',
        runId: 'run-manual-group', triggerSource: 'manual',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });
    const children = await get(`/api/sessions/${parent!.id}/children`);
    expect(children.status).toBe(200);
    expect(children.body).toEqual([expect.objectContaining({ id: phase!.id, parentSessionId: parent!.id })]);
  });

  it('groups a managed cron phase under its schedule-provenance run parent', async () => {
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

    const parent = registry.getSessionBySessionKey(`workflow-run:${fire.run.runId}:parent`);
    const phase = registry.getSessionBySessionKey(`workflow-run:${fire.run.runId}:review:1`);
    expect(parent?.workflowProvenance).toMatchObject({
      kind: 'run', workflowId: 'scheduled-record', workflowName: 'nightly-review',
      runId: fire.run.runId, triggerSource: 'schedule',
    });
    expect(phase).toMatchObject({
      parentSessionId: parent!.id,
      workflowProvenance: {
        kind: 'phase', workflowId: 'scheduled-record', workflowName: 'nightly-review',
        runId: fire.run.runId, triggerSource: 'schedule',
        phase: { nodeId: 'review', name: 'REVIEW', index: 1, round: 1, attempt: 1 },
      },
    });
    expect(registry.listChildSessions(parent!.id).map((session) => session.id)).toEqual([phase!.id]);
  });
});
