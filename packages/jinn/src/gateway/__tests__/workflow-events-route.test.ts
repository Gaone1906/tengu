import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-events-root-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-events-home-'));
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;
process.env.JINN_HOME = home;
const orgDir = path.join(home, 'org', 'platform');
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, 'department.yaml'), 'name: platform\n');
fs.writeFileSync(
  path.join(orgDir, 'coo.yaml'),
  'name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs operations.\n',
);
fs.writeFileSync(
  path.join(orgDir, 'worker.yaml'),
  'name: worker\ndisplayName: Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Builds assigned workflows.\nreportsTo: coo\n',
);

type Api = typeof import('../api.js');
type DefStore = typeof import('../../workflows/definition-store.js');
type CustomTriggers = typeof import('../../workflows/custom-triggers.js');
type Registry = typeof import('../../sessions/registry.js');
type Identity = typeof import('../../mcp/identity.js');

let api: Api;
let defStore: DefStore;
let triggers: CustomTriggers;
let registry: Registry;
let identity: Identity;

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
  defStore = await import('../../workflows/definition-store.js');
  triggers = await import('../../workflows/custom-triggers.js');
  registry = await import('../../sessions/registry.js');
  identity = await import('../../mcp/identity.js');
  registry.initDb();
});

beforeEach(() => {
  fs.rmSync(path.join(evidenceRoot, 'workflows'), { recursive: true, force: true });
  fs.rmSync(path.join(evidenceRoot, 'workflow-triggers'), { recursive: true, force: true });
  triggers.resetWorkflowEventRateLimitForTests();
});

afterEach(() => {
  triggers.resetWorkflowEventRateLimitForTests();
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const res = {
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) for (const [key, value] of Object.entries(h)) headers.set(key.toLowerCase(), value);
      return this;
    },
    setHeader(key: string, value: unknown) {
      headers.set(key.toLowerCase(), value);
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
    get text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    json<T = unknown>(): T {
      return JSON.parse(this.text) as T;
    },
  };
}

async function request(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const chunks = opts.body === undefined ? [] : [Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: {
      host: 'gateway.test',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))) } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api['handleApiRequest']>[0], cap.res, apiCtx);
  return cap;
}

function seedWorkflow(id = 'webhook-wf', extra: Record<string, unknown> = {}) {
  return defStore.createDefinition(evidenceRoot, {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      { id: 'a', type: 'step', label: 'A', position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'e1', from: 'trg', to: 'a', kind: 'sequence' }],
    ...extra,
  } as Parameters<typeof defStore.createDefinition>[1], { now: () => '2026-07-06T09:00:00.000Z' });
}

function verifiedSessionHeaders(employee: string): Record<string, string> {
  const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: `${employee}-caller`, employee });
  return {
    [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
    [identity.CALLER_SESSION_HEADER]: session.id,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(session.id),
  };
}

describe('POST /api/workflow-events', () => {
  it('rejects unauthenticated inbound events even on the in-process API path', async () => {
    seedWorkflow();
    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'lead-hook',
      event: 'lead.created',
      targetWorkflowId: 'webhook-wf',
      secretToken: 'binding-secret',
    });

    const res = await request('POST', '/api/workflow-events', { body: { event: 'lead.created', payload: {} } });

    expect(res.status).toBe(401);
    expect(res.json<{ error: string }>().error).toMatch(/workflow event authentication required/i);
  });

  it('accepts a per-binding token and starts only matching bound workflows', async () => {
    seedWorkflow();
    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'lead-hook',
      event: 'lead.created',
      targetWorkflowId: 'webhook-wf',
      secretToken: 'binding-secret',
    });

    const res = await request('POST', '/api/workflow-events', {
      headers: { authorization: 'Bearer binding-secret' },
      body: { event: 'lead.created', payload: { id: 'lead_1' }, fireRef: 'delivery-1' },
    });

    expect(res.status).toBe(202);
    expect(res.json<{ outcomes: Array<{ triggerName: string; run: { trigger: unknown } }> }>().outcomes[0]).toMatchObject({
      triggerName: 'lead-hook',
      run: { trigger: { source: 'event-webhook', event: 'lead.created', payload: { id: 'lead_1' }, fireRef: 'delivery-1' } },
    });
  });

  it('rejects unbound events instead of starting an arbitrary workflow', async () => {
    seedWorkflow();
    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'lead-hook',
      event: 'lead.created',
      targetWorkflowId: 'webhook-wf',
      secretToken: 'binding-secret',
    });

    const res = await request('POST', '/api/workflow-events', {
      headers: { authorization: 'Bearer gateway-secret' },
      body: { event: 'invoice.paid', payload: { id: 'inv_1' } },
    });

    expect(res.status).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/no matching workflow trigger binding/i);
  });

  it('caps request bodies before parsing payloads', async () => {
    const res = await request('POST', '/api/workflow-events', {
      headers: { authorization: 'Bearer gateway-secret' },
      body: { event: 'lead.created', payload: { blob: 'x'.repeat(80 * 1024) } },
    });

    expect(res.status).toBe(413);
  });

  it('rate-limits repeated inbound events by auth key', async () => {
    seedWorkflow();
    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'lead-hook',
      event: 'lead.created',
      targetWorkflowId: 'webhook-wf',
      secretToken: 'binding-secret',
    });
    triggers.configureWorkflowEventRateLimitForTests({ max: 1, windowMs: 60_000, now: () => 1_000 });

    const headers = { authorization: 'Bearer gateway-secret' };
    expect((await request('POST', '/api/workflow-events', { headers, body: { event: 'missing.one', payload: {} } })).status).toBe(404);
    const limited = await request('POST', '/api/workflow-events', { headers, body: { event: 'missing.two', payload: {} } });

    expect(limited.status).toBe(429);
    expect(limited.json<{ error: string }>().error).toMatch(/rate limit/i);
  });
});

describe('workflow trigger authoring routes', () => {
  it('requires verified session capability for MCP write calls', async () => {
    seedWorkflow();
    const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'caller', employee: 'coo' });

    const denied = await request('POST', '/api/workflow-triggers', {
      headers: {
        [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
        [identity.CALLER_SESSION_HEADER]: session.id,
      },
      body: { kind: 'webhook', name: 'lead-hook', event: 'lead.created', targetWorkflowId: 'webhook-wf', secretToken: 'binding-secret' },
    });
    expect(denied.status).toBe(403);

    const allowed = await request('POST', '/api/workflow-triggers', {
      headers: {
        [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
        [identity.CALLER_SESSION_HEADER]: session.id,
        [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(session.id),
      },
      body: { kind: 'webhook', name: 'lead-hook', event: 'lead.created', targetWorkflowId: 'webhook-wf', secretToken: 'binding-secret' },
    });
    expect(allowed.status).toBe(201);
  });

  it('poll trigger creation mints a pending COO approval bound to the exact execution contract', async () => {
    seedWorkflow('poll-wf');
    const checkScript = path.join(home, 'check.sh');
    fs.writeFileSync(checkScript, '#!/bin/sh\nprintf \'%s\' \'{"fire":false}\'\n', 'utf8');
    fs.chmodSync(checkScript, 0o700);
    const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'poll-caller', employee: 'coo' });
    const headers = {
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: session.id,
      [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(session.id),
    };

    const created = await request('POST', '/api/workflow-triggers', {
      headers,
      body: {
        kind: 'poll',
        name: 'poll-ready',
        event: 'poll.ready',
        targetWorkflowId: 'poll-wf',
        command: checkScript,
        intervalSeconds: 60,
        timeoutMs: 1200,
        stdoutMaxBytes: 2048,
        stderrMaxBytes: 1024,
      },
    });

    expect(created.status).toBe(201);
    const body = created.json<{
      trigger: {
        activation: string;
        approvalWorkItemId: string;
        activationContractHash?: string;
        activationContract?: Record<string, unknown>;
      };
      approval: { workItem: { approvalState: string; approvalTarget: string; body: string | null; approvalRequest: string | null } };
    }>();
    expect(body.trigger).toMatchObject({
      activation: 'pending_approval',
      activationContractHash: expect.any(String),
      activationContract: {
        command: checkScript,
        intervalSeconds: 60,
        cwdPolicy: expect.any(String),
        envPolicy: expect.any(String),
        timeoutMs: 1200,
        stdoutMaxBytes: 2048,
        stderrMaxBytes: 1024,
      },
    });
    expect(body.approval.workItem).toMatchObject({ approvalState: 'pending', approvalTarget: 'coo' });
    const approvalText = `${body.approval.workItem.body ?? ''}\n${body.approval.workItem.approvalRequest ?? ''}`;
    for (const expected of [
      checkScript,
      'intervalSeconds: 60',
      'cwdPolicy:',
      'envPolicy:',
      'timeoutMs: 1200',
      'stdoutMaxBytes: 2048',
      'stderrMaxBytes: 1024',
      body.trigger.activationContractHash,
    ]) {
      expect(approvalText).toContain(expected);
    }

    const listed = await request('GET', '/api/workflow-triggers');
    expect(listed.json<{ triggers: Array<{ name: string; secretToken?: string; activation?: string }> }>().triggers).toContainEqual(
      expect.objectContaining({ name: 'poll-ready', activation: 'pending_approval' }),
    );
    expect(JSON.stringify(listed.json())).not.toContain('binding-secret');
  });

  it('returns a clear client rejection when a poll command is not fully pinnable', async () => {
    seedWorkflow('poll-unpinnable-wf');
    const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'poll-unpinnable-caller', employee: 'coo' });
    const headers = {
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: session.id,
      [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(session.id),
    };

    const response = await request('POST', '/api/workflow-triggers', {
      headers,
      body: {
        kind: 'poll',
        name: 'poll-unpinnable',
        event: 'poll.ready',
        targetWorkflowId: 'poll-unpinnable-wf',
        command: 'node check.js',
        intervalSeconds: 60,
      },
    });

    expect(response.status).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/not a fully pinnable poll command.*use a single absolute path/i);
    expect(triggers.getWorkflowTriggerBinding(evidenceRoot, 'poll-unpinnable')).toBeNull();
  });

  it('refuses a non-COO worker creating or deleting triggers for a COO-owned critical workflow', async () => {
    seedWorkflow('coo-owned-critical', { owner: 'coo', department: 'platform', critical: true });
    const workerHeaders = verifiedSessionHeaders('worker');

    const createDenied = await request('POST', '/api/workflow-triggers', {
      headers: workerHeaders,
      body: { kind: 'webhook', name: 'critical-hook', event: 'critical.event', targetWorkflowId: 'coo-owned-critical', secretToken: 'binding-secret' },
    });
    expect(createDenied.status).toBe(403);

    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'critical-hook',
      event: 'critical.event',
      targetWorkflowId: 'coo-owned-critical',
      secretToken: 'binding-secret',
      createdBy: 'coo',
    });
    const deleteDenied = await request('DELETE', '/api/workflow-triggers/critical-hook', { headers: workerHeaders });
    expect(deleteDenied.status).toBe(403);
    expect(triggers.getWorkflowTriggerBinding(evidenceRoot, 'critical-hook')).not.toBeNull();
  });

  it('allows an employee to create and delete triggers for its own workflow', async () => {
    seedWorkflow('worker-owned', { owner: 'worker', department: 'platform' });
    const workerHeaders = verifiedSessionHeaders('worker');

    const created = await request('POST', '/api/workflow-triggers', {
      headers: workerHeaders,
      body: { kind: 'webhook', name: 'worker-hook', event: 'worker.event', targetWorkflowId: 'worker-owned', secretToken: 'binding-secret' },
    });
    expect(created.status).toBe(201);

    const deleted = await request('DELETE', '/api/workflow-triggers/worker-hook', { headers: workerHeaders });
    expect(deleted.status).toBe(200);
  });

  it('allows an employee to bind a trigger to a workflow it authored through the API path', async () => {
    const workerHeaders = verifiedSessionHeaders('worker');
    const createdWorkflow = await request('POST', '/api/workflow-definitions', {
      headers: workerHeaders,
      body: {
        schemaVersion: 1,
        id: 'worker-authored',
        title: 'Worker Authored',
        version: 1,
        status: 'active',
        nodes: [
          { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
          { id: 'a', type: 'step', label: 'A', position: { x: 0, y: 0 } },
        ],
        edges: [{ id: 'e1', from: 'trg', to: 'a', kind: 'sequence' }],
      },
    });
    expect(createdWorkflow.status).toBe(201);
    expect(createdWorkflow.json<{ owner: string; department: string }>())
      .toMatchObject({ owner: 'worker', department: 'platform' });

    const createdTrigger = await request('POST', '/api/workflow-triggers', {
      headers: workerHeaders,
      body: { kind: 'webhook', name: 'worker-authored-hook', event: 'worker.authored', targetWorkflowId: 'worker-authored', secretToken: 'binding-secret' },
    });
    expect(createdTrigger.status).toBe(201);
  });

  it('default-denies non-COO trigger changes when workflow authority cannot be established', async () => {
    seedWorkflow('unknown-owner');
    const workerHeaders = verifiedSessionHeaders('worker');

    const createDenied = await request('POST', '/api/workflow-triggers', {
      headers: workerHeaders,
      body: { kind: 'webhook', name: 'unknown-hook', event: 'unknown.event', targetWorkflowId: 'unknown-owner', secretToken: 'binding-secret' },
    });
    expect(createDenied.status).toBe(403);

    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'unknown-hook',
      event: 'unknown.event',
      targetWorkflowId: 'unknown-owner',
      secretToken: 'binding-secret',
      createdBy: 'worker',
    });
    const deleteDenied = await request('DELETE', '/api/workflow-triggers/unknown-hook', { headers: workerHeaders });
    expect(deleteDenied.status).toBe(403);
    expect(triggers.getWorkflowTriggerBinding(evidenceRoot, 'unknown-hook')).not.toBeNull();
  });

  it('lets COO delete an orphaned trigger whose target workflow disappeared while non-COO stays denied', async () => {
    triggers.createWorkflowTriggerBinding(evidenceRoot, {
      kind: 'webhook',
      name: 'orphan-hook',
      event: 'orphan.event',
      targetWorkflowId: 'missing-workflow',
      secretToken: 'binding-secret',
      createdBy: 'worker',
    });

    const workerDenied = await request('DELETE', '/api/workflow-triggers/orphan-hook', { headers: verifiedSessionHeaders('worker') });
    expect(workerDenied.status).toBe(403);
    expect(triggers.getWorkflowTriggerBinding(evidenceRoot, 'orphan-hook')).not.toBeNull();

    const cooDeleted = await request('DELETE', '/api/workflow-triggers/orphan-hook', { headers: verifiedSessionHeaders('coo') });
    expect(cooDeleted.status).toBe(200);
    expect(triggers.getWorkflowTriggerBinding(evidenceRoot, 'orphan-hook')).toBeNull();
  });

  it('refuses the PUT-forge-owner escalation chain against a COO-owned critical workflow', async () => {
    seedWorkflow('coo-owned-critical', { owner: 'coo', createdBy: 'coo', department: 'platform', critical: true });
    const workerHeaders = verifiedSessionHeaders('worker');

    const forged = await request('PUT', '/api/workflow-definitions/coo-owned-critical', {
      headers: workerHeaders,
      body: { owner: 'worker', createdBy: 'worker', department: 'platform', critical: false, title: 'Forged' },
    });
    expect(forged.status).toBe(403);

    const after = await request('GET', '/api/workflow-definitions/coo-owned-critical');
    expect(after.json<Record<string, unknown>>()).toMatchObject({
      owner: 'coo',
      createdBy: 'coo',
      department: 'platform',
      critical: true,
      title: 'coo-owned-critical',
    });

    const trigger = await request('POST', '/api/workflow-triggers', {
      headers: workerHeaders,
      body: { kind: 'webhook', name: 'forged-hook', event: 'forged.event', targetWorkflowId: 'coo-owned-critical', secretToken: 'binding-secret' },
    });
    expect(trigger.status).toBe(403);
  });

  it('lets a legitimate owner edit workflow steps but restamps authority fields from the persisted record', async () => {
    seedWorkflow('worker-owned-edit', { owner: 'worker', createdBy: 'worker', department: 'platform', critical: true });
    const workerHeaders = verifiedSessionHeaders('worker');

    const edited = await request('PUT', '/api/workflow-definitions/worker-owned-edit', {
      headers: workerHeaders,
      body: {
        owner: 'coo',
        createdBy: 'coo',
        department: 'ops',
        critical: false,
        nodes: [
          { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
          { id: 'a', type: 'step', label: 'Edited Step', position: { x: 0, y: 0 } },
        ],
        edges: [{ id: 'e1', from: 'trg', to: 'a', kind: 'sequence' }],
      },
    });

    expect(edited.status).toBe(200);
    const body = edited.json<{ owner: string; createdBy: string; department: string; critical: boolean; nodes: Array<{ id: string; label: string }> }>();
    expect(body).toMatchObject({ owner: 'worker', createdBy: 'worker', department: 'platform', critical: true });
    expect(body.nodes.find((n) => n.id === 'a')?.label).toBe('Edited Step');
  });

  it('allows COO to change workflow authority fields', async () => {
    seedWorkflow('worker-owned-transfer', { owner: 'worker', createdBy: 'worker', department: 'platform', critical: false });
    const cooHeaders = verifiedSessionHeaders('coo');

    const changed = await request('PUT', '/api/workflow-definitions/worker-owned-transfer', {
      headers: cooHeaders,
      body: { owner: 'coo', createdBy: 'coo', department: 'platform', critical: true },
    });

    expect(changed.status).toBe(200);
    expect(changed.json<Record<string, unknown>>()).toMatchObject({
      owner: 'coo',
      createdBy: 'coo',
      department: 'platform',
      critical: true,
    });
  });

  it('default-denies non-COO workflow PUT when ownership is unknown', async () => {
    seedWorkflow('unknown-put-owner');
    const workerHeaders = verifiedSessionHeaders('worker');

    const denied = await request('PUT', '/api/workflow-definitions/unknown-put-owner', {
      headers: workerHeaders,
      body: { title: 'Denied' },
    });

    expect(denied.status).toBe(403);
  });
});
