import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from '../../mcp/identity.js';
import { getDefinition, createDefinition } from '../../workflows/definition-store.js';

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-auth-route-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-auth-home-'));
process.env.JINN_HOME = home;
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;

const platformDir = path.join(home, 'org', 'platform');
const growthDir = path.join(home, 'org', 'growth');
fs.mkdirSync(platformDir, { recursive: true });
fs.mkdirSync(growthDir, { recursive: true });
fs.writeFileSync(path.join(platformDir, 'department.yaml'), 'name: platform\n');
fs.writeFileSync(path.join(growthDir, 'department.yaml'), 'name: growth\n');
fs.writeFileSync(
  path.join(platformDir, 'coo.yaml'),
  'name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs operations.\n',
);
fs.writeFileSync(
  path.join(platformDir, 'owner.yaml'),
  'name: owner\ndisplayName: Owner\ndepartment: platform\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Owns workflows.\nreportsTo: coo\n',
);
fs.writeFileSync(
  path.join(platformDir, 'platform-manager.yaml'),
  'name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform workflows.\nreportsTo: coo\n',
);
fs.writeFileSync(
  path.join(growthDir, 'outsider.yaml'),
  'name: outsider\ndisplayName: Outsider\ndepartment: growth\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Works elsewhere.\nreportsTo: coo\n',
);

type Api = typeof import('../api.js');
type Registry = typeof import('../../sessions/registry.js');
let api: Api;
let registry: Registry;

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: 'gateway-secret',
  jinnHome: home,
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
} as unknown as import('../api.js').ApiContext;

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  registry.initDb();
});

beforeEach(() => {
  fs.rmSync(path.join(evidenceRoot, 'workflows'), { recursive: true, force: true });
  fs.rmSync(path.join(evidenceRoot, 'reports'), { recursive: true, force: true });
  fs.rmSync(path.join(evidenceRoot, 'workflow-triggers'), { recursive: true, force: true });
});

afterAll(async () => {
  const { stopScheduler } = await import('../../cron/scheduler.js');
  stopScheduler();
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

async function request(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: {
      host: 'gateway.test',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api['handleApiRequest']>[0], cap.res, apiCtx);
  return cap;
}

function workflowDef(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      { id: 'a', type: 'step', label: 'A', position: { x: 0, y: 140 } },
    ],
    edges: [{ id: 'e1', from: 'trg', to: 'a', kind: 'sequence' }],
    ...extra,
  };
}

function seedWorkflow(id: string, extra: Record<string, unknown> = {}) {
  return createDefinition(evidenceRoot, workflowDef(id, extra) as Parameters<typeof createDefinition>[1]);
}

function verifiedHeaders(employee: string): Record<string, string> {
  const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: `auth-${employee}`, title: employee, employee });
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
  };
}

function badCapabilityHeaders(): Record<string, string> {
  const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'auth-bad', title: 'bad', employee: 'coo' });
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: 'not-the-session-capability',
  };
}

const toolWithoutCallerHeaders = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE };

const callers = [
  { name: 'operator', headers: () => ({ authorization: 'Bearer gateway-secret' }), allowed: true },
  { name: 'coo', headers: () => verifiedHeaders('coo'), allowed: true },
  { name: 'owner', headers: () => verifiedHeaders('owner'), allowed: true },
  { name: 'department-manager', headers: () => verifiedHeaders('platform-manager'), allowed: true },
  { name: 'unrelated-worker', headers: () => verifiedHeaders('outsider'), allowed: false },
  { name: 'unidentified-tool', headers: () => toolWithoutCallerHeaders, allowed: false },
  { name: 'bad-capability', headers: () => badCapabilityHeaders(), allowed: false },
] as const;

describe('uniform workflow operation authority', () => {
  it('keeps principal namespaces stable while binding replay to the invoking Session', async () => {
    seedWorkflow('stable-principal-run', { owner: 'owner', createdBy: 'owner', department: 'platform' });
    const body = { input: { ticket: 'ABC-42' }, idempotencyKey: 'same-key' };
    const ownerSession = verifiedHeaders('owner');

    const first = await request('POST', '/api/workflow-definitions/stable-principal-run/run', {
      headers: ownerSession, body,
    });
    const sameSession = await request('POST', '/api/workflow-definitions/stable-principal-run/run', {
      headers: ownerSession, body,
    });
    expect(first.status).toBe(201);
    expect(sameSession.status).toBe(200);
    expect((sameSession.body as { runId: string }).runId).toBe((first.body as { runId: string }).runId);

    const anotherSession = await request('POST', '/api/workflow-definitions/stable-principal-run/run', {
      headers: verifiedHeaders('owner'), body,
    });
    expect(anotherSession.status).toBe(409);
    expect(anotherSession.body).toMatchObject({ code: 'workflow-run-idempotency-conflict' });

    const operator = await request('POST', '/api/workflow-definitions/stable-principal-run/run', {
      headers: { authorization: 'Bearer gateway-secret' }, body,
    });
    const manager = await request('POST', '/api/workflow-definitions/stable-principal-run/run', {
      headers: verifiedHeaders('platform-manager'), body,
    });
    expect(operator.status).toBe(201);
    expect(manager.status).toBe(201);
    expect(new Set([
      (first.body as { runId: string }).runId,
      (operator.body as { runId: string }).runId,
      (manager.body as { runId: string }).runId,
    ]).size).toBe(3);
  });

  it('enforces the operation matrix for update, duplicate, retire, run, and trigger bind/unbind', async () => {
    for (const caller of callers) {
      const updateId = `update-${caller.name}`;
      seedWorkflow(updateId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const updated = await request('PUT', `/api/workflow-definitions/${updateId}`, {
        headers: caller.headers(),
        body: { title: `updated by ${caller.name}` },
      });
      expect({ op: 'update', caller: caller.name, status: updated.status }).toMatchObject({
        status: caller.allowed ? 200 : 403,
      });

      const duplicateId = `duplicate-${caller.name}`;
      seedWorkflow(duplicateId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const duplicated = await request('POST', `/api/workflow-definitions/${duplicateId}/duplicate`, {
        headers: caller.headers(),
        body: { newId: `${duplicateId}-copy` },
      });
      expect({ op: 'duplicate', caller: caller.name, status: duplicated.status }).toMatchObject({
        status: caller.allowed ? 201 : 403,
      });

      const retireId = `retire-${caller.name}`;
      seedWorkflow(retireId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const retired = await request('POST', `/api/workflow-definitions/${retireId}/retire`, {
        headers: caller.headers(),
        body: {},
      });
      expect({ op: 'retire', caller: caller.name, status: retired.status }).toMatchObject({
        status: caller.allowed ? 200 : 403,
      });

      const runId = `run-${caller.name}`;
      seedWorkflow(runId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const run = await request('POST', `/api/workflow-definitions/${runId}/run`, {
        headers: caller.headers(),
        body: {},
      });
      expect({ op: 'run', caller: caller.name, status: run.status }).toMatchObject({
        status: caller.allowed ? 201 : 403,
      });

      const bindId = `bind-${caller.name}`;
      seedWorkflow(bindId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const triggerName = `trigger-${caller.name}`;
      const bound = await request('POST', '/api/workflow-triggers', {
        headers: caller.headers(),
        body: { kind: 'webhook', name: triggerName, event: `${triggerName}.event`, targetWorkflowId: bindId, secretToken: 'binding-secret' },
      });
      expect({ op: 'bind-trigger', caller: caller.name, status: bound.status }).toMatchObject({
        status: caller.allowed ? 201 : 403,
      });

      const unbindId = `unbind-${caller.name}`;
      seedWorkflow(unbindId, { owner: 'owner', createdBy: 'owner', department: 'platform' });
      const unbindTrigger = `delete-trigger-${caller.name}`;
      await request('POST', '/api/workflow-triggers', {
        headers: verifiedHeaders('coo'),
        body: { kind: 'webhook', name: unbindTrigger, event: `${unbindTrigger}.event`, targetWorkflowId: unbindId, secretToken: 'binding-secret' },
      });
      const unbound = await request('DELETE', `/api/workflow-triggers/${unbindTrigger}`, { headers: caller.headers() });
      expect({ op: 'unbind-trigger', caller: caller.name, status: unbound.status }).toMatchObject({
        status: caller.allowed ? 200 : 403,
      });
    }
  });

  it('requires a verified caller for tool-marked workflow creates and stamps session ownership', async () => {
    const missing = await request('POST', '/api/workflow-definitions', {
      headers: toolWithoutCallerHeaders,
      body: workflowDef('missing-caller-create', { owner: 'coo', department: 'growth', critical: true }),
    });
    expect(missing.status).toBe(403);

    const bad = await request('POST', '/api/workflow-definitions', {
      headers: badCapabilityHeaders(),
      body: workflowDef('bad-cap-create', { owner: 'coo', department: 'growth', critical: true }),
    });
    expect(bad.status).toBe(403);

    const worker = await request('POST', '/api/workflow-definitions', {
      headers: verifiedHeaders('owner'),
      body: workflowDef('owner-created', {
        owner: 'coo',
        createdBy: 'coo',
        department: 'growth',
        critical: true,
        classification: 'critical',
        authority: 'operator',
      }),
    });
    expect(worker.status).toBe(201);
    expect(worker.body).toMatchObject({ owner: 'owner', createdBy: 'owner', department: 'platform' });
    expect(worker.body).not.toMatchObject({ critical: true, classification: 'critical', authority: 'operator' });
  });

  it('preserves recognized legacy authority fields for privileged direct API callers', async () => {
    const operator = { authorization: 'Bearer gateway-secret' };
    const created = await request('POST', '/api/workflow-definitions', {
      headers: operator,
      body: workflowDef('legacy-authority-direct', {
        ownerEmployee: 'owner',
        workflowOwner: 'owner',
        creator: 'operator',
        author: 'operator',
        ownerDepartment: 'platform',
        workflowDepartment: 'platform',
        critical: true,
        cooOwned: false,
        requiresCooApproval: true,
        classification: 'critical',
        authority: 'operator',
      }),
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      ownerEmployee: 'owner',
      workflowOwner: 'owner',
      creator: 'operator',
      author: 'operator',
      ownerDepartment: 'platform',
      workflowDepartment: 'platform',
      critical: true,
      cooOwned: false,
      requiresCooApproval: true,
      classification: 'critical',
      authority: 'operator',
      createdBy: 'operator',
    });

    const updated = await request('PUT', '/api/workflow-definitions/legacy-authority-direct', {
      headers: operator,
      body: { authority: 'coo', expectedVersion: 1 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ authority: 'coo', version: 2 });
  });

  it('keeps manual layout provenance operator-only across create, mutate, and PUT routes', async () => {
    const validManual = (id: string) => workflowDef(id, {
      nodes: [
        { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 'a', type: 'step', label: 'A', position: { x: 400, y: 0 } },
      ],
      owner: 'owner',
      createdBy: 'owner',
      department: 'platform',
    });
    const ownerHeaders = verifiedHeaders('owner');

    const directCreate = await request('POST', '/api/workflow-definitions', {
      headers: ownerHeaders,
      body: { ...validManual('manual-direct-create'), layoutIntent: 'manual' },
    });
    expect(directCreate.status).toBe(403);
    expect(getDefinition(evidenceRoot, 'manual-direct-create')).toBeNull();

    const mutateCreate = await request('POST', '/api/workflow-definitions/mutate', {
      headers: ownerHeaders,
      body: { operation: 'create', definition: validManual('manual-mutate-create'), layoutIntent: 'manual' },
    });
    expect(mutateCreate.status).toBe(403);
    expect(getDefinition(evidenceRoot, 'manual-mutate-create')).toBeNull();

    seedWorkflow('manual-direct-update', { owner: 'owner', createdBy: 'owner', department: 'platform' });
    const directUpdate = await request('PUT', '/api/workflow-definitions/manual-direct-update', {
      headers: ownerHeaders,
      body: { nodes: validManual('unused').nodes, layoutIntent: 'manual' },
    });
    expect(directUpdate.status).toBe(403);

    seedWorkflow('manual-mutate-update', { owner: 'owner', createdBy: 'owner', department: 'platform' });
    const mutateUpdate = await request('POST', '/api/workflow-definitions/mutate', {
      headers: ownerHeaders,
      body: {
        operation: 'update',
        workflowId: 'manual-mutate-update',
        patch: { nodes: validManual('unused').nodes },
        layoutIntent: 'manual',
      },
    });
    expect(mutateUpdate.status).toBe(403);

    const operatorCreate = await request('POST', '/api/workflow-definitions', {
      headers: { authorization: 'Bearer gateway-secret' },
      body: { ...validManual('manual-operator-create'), layoutIntent: 'manual' },
    });
    expect(operatorCreate.status).toBe(201);
    expect(getDefinition(evidenceRoot, 'manual-operator-create')?.layout).toEqual({ source: 'manual', version: 1 });
  });

  it('normalizes omitted-intent graph PUTs while preserving metadata-only provenance', async () => {
    const original = workflowDef('manual-graph-default', {
      nodes: [
        { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 'a', type: 'step', label: 'A', position: { x: 400, y: 0 } },
      ],
      owner: 'owner',
      createdBy: 'owner',
      department: 'platform',
    });
    createDefinition(evidenceRoot, original as Parameters<typeof createDefinition>[1], { layoutIntent: 'manual' });

    const graphUpdate = await request('PUT', '/api/workflow-definitions/manual-graph-default', {
      headers: verifiedHeaders('owner'),
      body: {
        nodes: [
          original.nodes[0],
          { ...original.nodes[1], label: 'Moved', position: { x: 0, y: 0 } },
        ],
      },
    });
    expect(graphUpdate.status).toBe(200);
    expect((graphUpdate.body as { layout?: unknown }).layout).toEqual({ source: 'normalized', version: 1 });

    const metadataUpdate = await request('PUT', '/api/workflow-definitions/manual-graph-default', {
      headers: verifiedHeaders('owner'),
      body: { title: 'Metadata only' },
    });
    expect(metadataUpdate.status).toBe(200);
    expect((metadataUpdate.body as { layout?: unknown }).layout).toEqual({ source: 'normalized', version: 1 });
  });

  it('closes the full escalation chain against a COO-owned critical workflow', async () => {
    seedWorkflow('live-coo-critical', { owner: 'coo', createdBy: 'coo', department: 'platform', critical: true });
    const worker = verifiedHeaders('owner');

    expect((await request('POST', '/api/workflow-definitions/live-coo-critical/duplicate', { headers: worker, body: { newId: 'copied-critical' } })).status).toBe(403);
    expect(getDefinition(evidenceRoot, 'copied-critical')).toBeNull();

    expect((await request('POST', '/api/workflow-definitions/live-coo-critical/retire', { headers: worker, body: {} })).status).toBe(403);
    expect(getDefinition(evidenceRoot, 'live-coo-critical')?.status).toBe('active');

    expect((await request('POST', '/api/workflow-definitions/live-coo-critical/run', { headers: worker, body: {} })).status).toBe(403);

    expect((await request('PUT', '/api/workflow-definitions/live-coo-critical', {
      headers: worker,
      body: { owner: 'owner', createdBy: 'owner', critical: false, title: 'forged' },
    })).status).toBe(403);

    expect((await request('POST', '/api/workflow-triggers', {
      headers: worker,
      body: { kind: 'webhook', name: 'critical-hook', event: 'critical.event', targetWorkflowId: 'live-coo-critical', secretToken: 'binding-secret' },
    })).status).toBe(403);

    expect(getDefinition(evidenceRoot, 'live-coo-critical')).toMatchObject({
      owner: 'coo',
      createdBy: 'coo',
      department: 'platform',
      critical: true,
      title: 'live-coo-critical',
      status: 'active',
    });
  });

  it('restamps duplicate authority to the verified caller', async () => {
    seedWorkflow('owner-source', { owner: 'owner', createdBy: 'owner', department: 'platform', critical: true });

    const duplicated = await request('POST', '/api/workflow-definitions/owner-source/duplicate', {
      headers: verifiedHeaders('owner'),
      body: { newId: 'owner-source-copy', title: 'Owner copy' },
    });

    expect(duplicated.status).toBe(201);
    expect(duplicated.body).toMatchObject({
      id: 'owner-source-copy',
      title: 'Owner copy',
      owner: 'owner',
      createdBy: 'owner',
      department: 'platform',
    });
    expect(duplicated.body).not.toMatchObject({ critical: true });
  });
});
