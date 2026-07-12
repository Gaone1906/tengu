import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
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

/**
 * Route-level test for the GRS-011b workflow-definition CRUD surface. Drives
 * handleApiRequest directly with fake req/res (no HTTP server boot) and points
 * JINN_WORKFLOW_EVIDENCE_ROOT at a throwaway dir so nothing live is touched.
 */

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-def-route-'));
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-def-home-'));
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;
const orgDir = path.join(process.env.JINN_HOME, 'org', 'platform');
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, 'department.yaml'), 'name: platform\n');
fs.writeFileSync(
  path.join(orgDir, 'coo.yaml'),
  'name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n',
);

type Api = typeof import('../api.js');
type Registry = typeof import('../../sessions/registry.js');
let api: Api;
let registry: Registry;
let cooSession: import('../../shared/types.js').Session;

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
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const base =
    body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(base, { method, url: urlPath, headers: { host: 'localhost', 'content-type': 'application/json', authorization: 'Bearer test-token', ...headers } });
  return base as unknown as Parameters<Api['handleApiRequest']>[0];
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: 'test-token',
} as unknown as import('../api.js').ApiContext;

/** Run-route context: POST …/run resolves the engine roster off sessionManager. An
 * empty roster is fine for the fixtures below — their steps are actorless (inline),
 * so nothing spawns and no engine is ever looked up. */
const runCtx = {
  ...(ctx as unknown as Record<string, unknown>),
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
} as unknown as import('../api.js').ApiContext;

const validDef = {
  id: 'route-wf',
  title: 'Route WF',
  nodes: [
    { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
    { id: 's1', type: 'step', label: 'Work', position: { x: 0, y: 140 }, actor: { kind: 'employee', ref: 'jimbo' } },
  ],
  edges: [{ id: 'e1', from: 'trg', to: 's1', kind: 'sequence' }],
};

async function call(method: string, url: string, body?: unknown, context: import('../api.js').ApiContext = ctx) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body), cap.res, context);
  return cap;
}

function cooHeaders(): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: cooSession.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(cooSession.id),
  };
}

async function callAsCoo(method: string, url: string, body?: unknown, context: import('../api.js').ApiContext = ctx) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body, cooHeaders()), cap.res, context);
  return cap;
}

beforeAll(async () => {
  api = await import('../api.js');
  registry = await import('../../sessions/registry.js');
  registry.initDb();
  cooSession = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'coo', title: 'coo', employee: 'coo' });
});

beforeEach(() => {
  fs.mkdirSync(path.join(evidenceRoot, 'workflows'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(path.join(evidenceRoot, 'workflows'), { recursive: true, force: true });
  fs.rmSync(path.join(evidenceRoot, 'reports'), { recursive: true, force: true });
});

describe('workflow-definition CRUD routes', () => {
  it('runs the full create → get → list → update → duplicate → retire lifecycle', async () => {
    // create
    const created = await call('POST', '/api/workflow-definitions', validDef);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'route-wf', version: 1, status: 'active' });
    expect(typeof (created.body as { updatedAt: string }).updatedAt).toBe('string');

    // get
    const got = await call('GET', '/api/workflow-definitions/route-wf');
    expect(got.status).toBe(200);
    expect((got.body as { id: string }).id).toBe('route-wf');

    // list
    const list = await call('GET', '/api/workflow-definitions');
    expect(list.status).toBe(200);
    expect((list.body as { definitions: Array<{ id: string }> }).definitions.map((d) => d.id)).toContain('route-wf');
    expect((list.body as { evidenceConfigured: boolean }).evidenceConfigured).toBe(true);

    // update (version bump)
    const updated = await call('PUT', '/api/workflow-definitions/route-wf', { title: 'Renamed', expectedVersion: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: 'Renamed', version: 2 });

    // duplicate
    const dup = await call('POST', '/api/workflow-definitions/route-wf/duplicate', {});
    expect(dup.status).toBe(201);
    expect((dup.body as { id: string }).id).toBe('route-wf-copy');

    // retire
    const retired = await call('POST', '/api/workflow-definitions/route-wf/retire', {});
    expect(retired.status).toBe(200);
    expect((retired.body as { status: string }).status).toBe('retired');
  });

  it('404s a missing definition on GET', async () => {
    const res = await call('GET', '/api/workflow-definitions/nope');
    expect(res.status).toBe(404);
  });

  it('returns 400 + errors[] for an invalid create', async () => {
    const res = await call('POST', '/api/workflow-definitions', { id: 'broken', title: 'x', nodes: [], edges: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray((res.body as { errors: unknown[] }).errors)).toBe(true);
    expect((res.body as { errors: Array<{ code: string }> }).errors.some((e) => e.code === 'missing-trigger')).toBe(true);
  });

  it.sequential('rejects unknown fields at plan/direct/mutate seams before persistence', async () => {
    const planned = await call('POST', '/api/workflow-definitions/plan', {
      definition: {
        ...validDef,
        schemaVersion: 1,
        version: 1,
        status: 'active',
        mysteryMode: true,
      },
    });
    expect(planned.status).toBe(400);

    const directCreate = await call('POST', '/api/workflow-definitions', {
      ...validDef,
      id: 'strict-direct-create',
      mysteryMode: true,
    });
    expect(directCreate.status).toBe(400);
    expect(fs.existsSync(path.join(evidenceRoot, 'workflows', 'strict-direct-create.definition.json'))).toBe(false);

    const mutateCreateDefinition: any = {
      ...structuredClone(validDef),
      id: 'strict-mutate-create',
      schemaVersion: 1,
      version: 1,
      status: 'active',
    };
    mutateCreateDefinition.nodes[1] = {
      ...mutateCreateDefinition.nodes[1],
      options: { retry: { maxAttempts: 2, on: ['error'], mysteryMode: true } },
    };
    const mutateCreate = await call('POST', '/api/workflow-definitions/mutate', {
      operation: 'create',
      definition: mutateCreateDefinition,
    });
    expect(mutateCreate.status).toBe(400);
    expect(fs.existsSync(path.join(evidenceRoot, 'workflows', 'strict-mutate-create.definition.json'))).toBe(false);
  });

  it.sequential('rejects unknown direct/mutate update fields without changing bytes or version', async () => {
    await call('POST', '/api/workflow-definitions', { ...validDef, id: 'strict-direct-update' });
    const directFile = path.join(evidenceRoot, 'workflows', 'strict-direct-update.definition.json');
    const directBefore = fs.readFileSync(directFile);
    const directNodes: any[] = structuredClone(validDef.nodes);
    directNodes[1].onError = 'continue';

    const directUpdate = await call('PUT', '/api/workflow-definitions/strict-direct-update', {
      nodes: directNodes,
      expectedVersion: 1,
    });
    expect(directUpdate.status).toBe(400);
    expect(fs.readFileSync(directFile).equals(directBefore)).toBe(true);
    expect((await call('GET', '/api/workflow-definitions/strict-direct-update')).body).toMatchObject({ version: 1 });

    await call('POST', '/api/workflow-definitions', { ...validDef, id: 'strict-mutate-update' });
    const mutateFile = path.join(evidenceRoot, 'workflows', 'strict-mutate-update.definition.json');
    const mutateBefore = fs.readFileSync(mutateFile);
    const mutateUpdate = await call('POST', '/api/workflow-definitions/mutate', {
      operation: 'update',
      workflowId: 'strict-mutate-update',
      expectedVersion: 1,
      patch: { mysteryMode: true },
    });
    expect(mutateUpdate.status).toBe(400);
    expect(fs.readFileSync(mutateFile).equals(mutateBefore)).toBe(true);
    expect((await call('GET', '/api/workflow-definitions/strict-mutate-update')).body).toMatchObject({ version: 1 });
  });

  it('plans a loaded persisted definition with recognized provenance and authority metadata', async () => {
    const created = await call('POST', '/api/workflow-definitions', { ...validDef, id: 'loaded-plan', owner: 'jimbo' });
    expect(created.status).toBe(201);
    const planned = await call('POST', '/api/workflow-definitions/plan', { definition: created.body });
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ ok: true, definition: { id: 'loaded-plan' } });
  });

  it('direct generated create auto-places nodes that omit positions', async () => {
    const nodes = structuredClone(validDef.nodes) as Array<Record<string, unknown>>;
    delete nodes[1].position;
    const created = await call('POST', '/api/workflow-definitions', {
      ...validDef,
      id: 'generated-no-position',
      nodes,
      layoutIntent: 'generated',
    });
    expect(created.status).toBe(201);
    expect((created.body as { nodes: Array<{ position?: unknown }> }).nodes[1].position).toBeDefined();
  });

  it('rejects a reachable non-loop cycle at plan, create, and update before persistence', async () => {
    const acyclic = {
      ...validDef,
      id: 'cycle-guard',
      schemaVersion: 1,
      version: 1,
      status: 'active',
      nodes: [
        validDef.nodes[0],
        validDef.nodes[1],
        { id: 's2', type: 'step', label: 'Review', position: { x: 640, y: 0 }, actor: { kind: 'employee', ref: 'jimbo' } },
      ],
      edges: [
        validDef.edges[0],
        { id: 'e2', from: 's1', to: 's2', kind: 'sequence' },
      ],
    };
    const cyclic = {
      ...acyclic,
      edges: [...acyclic.edges, { id: 'back', from: 's2', to: 's1', kind: 'handoff' }],
    };

    const planned = await call('POST', '/api/workflow-definitions/plan', { definition: cyclic });
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({
      ok: false,
      validation: { ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'non-loop-cycle' })]) },
      execution: { ok: false },
    });

    const created = await call('POST', '/api/workflow-definitions', cyclic);
    expect(created.status).toBe(400);
    expect((created.body as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toContain('non-loop-cycle');
    expect(fs.existsSync(path.join(evidenceRoot, 'workflows', 'cycle-guard.definition.json'))).toBe(false);

    const validCreate = await call('POST', '/api/workflow-definitions', acyclic);
    expect(validCreate.status).toBe(201);
    const updated = await call('PUT', '/api/workflow-definitions/cycle-guard', {
      edges: cyclic.edges,
      expectedVersion: 1,
    });
    expect(updated.status).toBe(400);
    expect((updated.body as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toContain('non-loop-cycle');
    const persisted = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'workflows', 'cycle-guard.definition.json'), 'utf8'));
    expect(persisted.version).toBe(1);
    expect(persisted.edges).toHaveLength(2);
  });

  it('rejects an over-limit graph quickly without creating a definition file', async () => {
    const nodes = Array.from({ length: 97 }, (_, index) => index === 0
      ? { id: 'n0', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } }
      : { id: `n${index}`, type: 'step', label: `Step ${index}`, position: { x: index * 320, y: 0 } });
    const edges = nodes.flatMap((_node, from) => nodes.slice(from + 1, from + 6).map((_target, offset) => ({
      id: `e-${from}-${from + offset + 1}`,
      from: `n${from}`,
      to: `n${from + offset + 1}`,
      kind: 'sequence',
    })));
    const started = performance.now();
    const response = await call('POST', '/api/workflow-definitions', {
      id: 'route-over-limit',
      title: 'Route over limit',
      nodes,
      edges,
    });
    const elapsedMs = performance.now() - started;

    expect(response.status).toBe(400);
    expect((response.body as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'too-many-nodes',
      'too-many-edges',
      'workflow-too-dense',
    ]));
    expect(elapsedMs).toBeLessThan(800);
    expect(fs.existsSync(path.join(evidenceRoot, 'workflows', 'route-over-limit.definition.json'))).toBe(false);
  });

  it('409s a duplicate-id create and a stale update', async () => {
    await call('POST', '/api/workflow-definitions', { ...validDef, id: 'conflict-wf' });
    const dupCreate = await call('POST', '/api/workflow-definitions', { ...validDef, id: 'conflict-wf' });
    expect(dupCreate.status).toBe(409);

    const stale = await call('PUT', '/api/workflow-definitions/conflict-wf', { title: 'x', expectedVersion: 99 });
    expect(stale.status).toBe(409);
  });

  it('400s an unsafe id via the store guard (route param guard also blocks traversal)', async () => {
    // A create body with an unsafe id reaches the store guard → 400 invalid-id.
    const res = await call('POST', '/api/workflow-definitions', { ...validDef, id: 'bad id!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not 500) for a structurally malformed body', async () => {
    const res = await call('POST', '/api/workflow-definitions', {
      id: 'malf',
      title: 'x',
      nodes: [null],
      edges: [null],
    });
    expect(res.status).toBe(400);
    expect(Array.isArray((res.body as { errors: unknown[] }).errors)).toBe(true);
  });

  it('413s an oversized create body (body cap enforced)', async () => {
    const huge = { ...validDef, id: 'huge', description: 'x'.repeat(600 * 1024) };
    const res = await call('POST', '/api/workflow-definitions', huge);
    expect(res.status).toBe(413);
  });

  it('returns 400 (not 500) for a non-string title in the create body', async () => {
    const res = await call('POST', '/api/workflow-definitions', { ...validDef, id: 'numtitle', title: 123 });
    expect(res.status).toBe(400);
  });

  it('400s a PUT with a non-object JSON body', async () => {
    await call('POST', '/api/workflow-definitions', { ...validDef, id: 'putobj' });
    const res = await call('PUT', '/api/workflow-definitions/putobj', 123);
    expect(res.status).toBe(400);
  });

  it('the :id path param guard rejects traversal → 404 (never escapes the root)', async () => {
    // matchRoute rejects %2f/%5c/.. in the :id segment → route does not match → 404.
    const res = await call('GET', '/api/workflow-definitions/..%2f..%2fsecret');
    expect(res.status).toBe(404);
  });
});

describe('workflow-definition dry-run plan route (GRS-011d-1)', () => {
  it('GET :id/plan compiles a valid definition into an execution plan', async () => {
    await call('POST', '/api/workflow-definitions', { ...validDef, id: 'plan-wf' });
    const res = await call('GET', '/api/workflow-definitions/plan-wf/plan');
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; plan?: { workflowId: string; steps: unknown[]; trigger: { kind: string } } };
    expect(body.ok).toBe(true);
    expect(body.plan?.workflowId).toBe('plan-wf');
    expect(body.plan?.trigger.kind).toBe('manual');
    expect(body.plan?.steps).toHaveLength(1);
  });

  it('GET :id/plan surfaces an approval gate as a run-parking (blocking) gate', async () => {
    const withApproval = {
      ...validDef,
      id: 'plan-appr',
      runGates: [{ kind: 'approval', approvalRef: 'merge', description: 'operator approves merge' }],
    };
    await call('POST', '/api/workflow-definitions', withApproval);
    const res = await call('GET', '/api/workflow-definitions/plan-appr/plan');
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; plan?: { hasApprovalGate: boolean; runGates: Array<{ evaluator: string; blocking: boolean }> } };
    expect(body.ok).toBe(true);
    expect(body.plan?.hasApprovalGate).toBe(true);
    expect(body.plan?.runGates[0]).toMatchObject({ evaluator: 'human-approval', blocking: true });
  });

  it('GET :id/plan 404s a missing definition', async () => {
    const res = await call('GET', '/api/workflow-definitions/nope/plan');
    expect(res.status).toBe(404);
  });
});

describe('run route — GRS-014b sequential engine + honest statuses + legacy mapping', () => {
  /** All-inline definition (no actors): the run executes fully without touching the
   * engine roster or spawning any session — perfect for route-level execution tests. */
  const inlineDef = (id: string, edges: Array<{ id: string; from: string; to: string }>) => ({
    id,
    title: 'Run WF',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      { id: 'sa', type: 'step', label: 'Step A', position: { x: 0, y: 140 } },
      { id: 'sb', type: 'step', label: 'Step B', position: { x: 0, y: 280 } },
    ],
    edges: edges.map((e) => ({ ...e, kind: 'sequence' })),
  });

  it('POST :id/run persists a schemaVersion-2 run with an honest earned terminal for an all-inline chain', async () => {
    const linear = inlineDef('run-linear', [
      { id: 'e0', from: 'trg', to: 'sa' },
      { id: 'e1', from: 'sa', to: 'sb' },
    ]);
    await call('POST', '/api/workflow-definitions', linear);
    const res = await call('POST', '/api/workflow-definitions/run-linear/run', undefined, runCtx);
    expect(res.status).toBe(201);
    const run = res.body as { runId: string; schemaVersion: number; status: string; order: string[]; orderWarning?: unknown; invocation?: unknown };
    expect(run.schemaVersion).toBe(2);
    expect(run.status).toBe('completed'); // all-inline: every step genuinely finished in the drive
    expect(run.order).toEqual(['sa', 'sb']);
    expect(run.orderWarning).toBeUndefined();
    expect(run.invocation).toBeUndefined(); // bodyless/manual callers remain compatible
    // The persisted record carries the same v2 stamp.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, 'reports', 'runs', 'run-linear', `${run.runId}.json`), 'utf8'),
    );
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.status).toBe('completed');
  });

  it('POST :id/run replays exact intent with 200 and rejects changed intent with a sanitized typed 409', async () => {
    const definition = inlineDef('run-input', [
      { id: 'e0', from: 'trg', to: 'sa' },
      { id: 'e1', from: 'sa', to: 'sb' },
    ]);
    await call('POST', '/api/workflow-definitions', definition);

    const first = await call('POST', '/api/workflow-definitions/run-input/run', {
      input: { ticket: { id: 'ABC-42' }, priority: 2 },
      idempotencyKey: 'request-42',
    }, runCtx);
    expect(first.status).toBe(201);
    const firstRun = first.body as {
      runId: string;
      invocation: { input: Record<string, unknown>; idempotencyKey: string };
      trigger: { fireRef?: string };
    };
    expect(firstRun.invocation).toEqual({
      input: { ticket: { id: 'ABC-42' }, priority: 2 },
      idempotencyKey: 'request-42',
    });
    expect(firstRun.trigger.fireRef).toBe('request-42');

    const replay = await call('POST', '/api/workflow-definitions/run-input/run', {
      input: { priority: 2, ticket: { id: 'ABC-42' } },
      idempotencyKey: 'request-42',
    }, runCtx);
    expect(replay.status).toBe(200);
    expect((replay.body as typeof firstRun).runId).toBe(firstRun.runId);

    const duplicate = await call('POST', '/api/workflow-definitions/run-input/run', {
      input: { ticket: { id: 'SHOULD-NOT-REPLACE' } },
      idempotencyKey: 'request-42',
    }, runCtx);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: 'This idempotency key is already bound to a different workflow run request.',
      code: 'workflow-run-idempotency-conflict',
      runId: firstRun.runId,
    });
    const conflictWire = JSON.stringify(duplicate.body);
    expect(conflictWire).not.toContain('request-42');
    expect(conflictWire).not.toContain('SHOULD-NOT-REPLACE');
    expect(conflictWire).not.toContain('ABC-42');
    expect(conflictWire).not.toContain('fingerprint');

    const files = fs.readdirSync(path.join(evidenceRoot, 'reports', 'runs', 'run-input'));
    expect(files.filter((name) => name.endsWith('.json'))).toEqual([`${firstRun.runId}.json`]);
  });

  it('accepts per-phase prompt overrides and audits an operator edit to a pending phase', async () => {
    const definition = {
      id: 'run-prompt-edit',
      title: 'Run Prompt Edit',
      nodes: [
        { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 'gate', type: 'gate', label: 'Approve', position: { x: 0, y: 140 }, gate: { kind: 'approval', description: 'approve execution', approvalRef: 'run' } },
        { id: 'verify', type: 'step', label: 'Verify', position: { x: 0, y: 280 }, actor: { kind: 'engine', ref: 'codex' }, instructions: 'Run the authored checks.' },
      ],
      edges: [
        { id: 'e0', from: 'trg', to: 'gate', kind: 'sequence' },
        { id: 'e1', from: 'gate', to: 'verify', kind: 'sequence' },
      ],
    };
    await call('POST', '/api/workflow-definitions', definition);
    const promptRunCtx = {
      ...(runCtx as unknown as Record<string, unknown>),
      sessionManager: { getEngines: () => new Map([['codex', {}]]), getEngine: () => undefined },
    } as unknown as import('../api.js').ApiContext;

    const started = await call('POST', '/api/workflow-definitions/run-prompt-edit/run', {
      input: { ticket: 'ABC-42' },
      stepOverrides: { verify: { prompt: 'Run the invocation-specific checks.' } },
    }, promptRunCtx);
    expect(started.status).toBe(201);
    const run = started.body as {
      runId: string;
      status: string;
      invocation: { input: Record<string, unknown> };
      stepOverrides: Record<string, { prompt: string }>;
    };
    expect(run.status).toBe('parked');
    expect(run.stepOverrides.verify.prompt).toBe('Run the invocation-specific checks.');

    const edited = await call('PATCH', `/api/workflow-definitions/run-prompt-edit/runs/${run.runId}/pending-steps/verify`, {
      prompt: 'Run the revised pending-phase checks.',
    }, promptRunCtx);
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      invocation: { input: { ticket: 'ABC-42' } },
      stepOverrides: { verify: { prompt: 'Run the revised pending-phase checks.' } },
      stepPromptRevision: 1,
      stepPromptEdits: [{
        revision: 1,
        nodeId: 'verify',
        actor: 'operator',
        before: 'Run the invocation-specific checks.',
        after: 'Run the revised pending-phase checks.',
      }],
    });
  });

  it('rejects malformed or unknown per-phase prompt overrides', async () => {
    const definition = inlineDef('run-prompt-invalid', [
      { id: 'e0', from: 'trg', to: 'sa' },
      { id: 'e1', from: 'sa', to: 'sb' },
    ]);
    await call('POST', '/api/workflow-definitions', definition);

    const malformed = await call('POST', '/api/workflow-definitions/run-prompt-invalid/run', {
      stepOverrides: { sa: { prompt: '' } },
    }, runCtx);
    expect(malformed.status).toBe(400);
    expect((malformed.body as { error: string }).error).toMatch(/stepOverrides.*prompt/i);

    const unknown = await call('POST', '/api/workflow-definitions/run-prompt-invalid/run', {
      stepOverrides: { missing: { prompt: 'Do this.' } },
    }, runCtx);
    expect(unknown.status).toBe(400);
    expect((unknown.body as { error: string }).error).toMatch(/unknown.*step/i);
  });

  it('POST /api/workflow-runs/by-name replays exact intent and conflicts on changed input', async () => {
    const definition = {
      ...inlineDef('run-by-name-record', [
        { id: 'e0', from: 'trg', to: 'sa' },
        { id: 'e1', from: 'sa', to: 'sb' },
      ]),
      name: 'full-cycle-workflow',
    };
    await call('POST', '/api/workflow-definitions', definition);

    const first = await call('POST', '/api/workflow-runs/by-name', {
      name: 'full-cycle-workflow',
      input: { request: 'implement this', ticket: 'ABC-42' },
      idempotencyKey: 'agent-request-42',
    }, runCtx);
    expect(first.status).toBe(201);
    const firstRun = first.body as {
      runId: string;
      workflowId: string;
      invocation: { input: Record<string, unknown>; idempotencyKey: string };
      trigger: { source: string; event: string };
    };
    expect(firstRun.workflowId).toBe('run-by-name-record');
    expect(firstRun.trigger).toMatchObject({ source: 'manual', event: 'workflow.manual_started' });
    expect(firstRun.invocation).toEqual({
      input: { request: 'implement this', ticket: 'ABC-42' },
      idempotencyKey: 'agent-request-42',
    });

    const replay = await call('POST', '/api/workflow-runs/by-name', {
      name: 'full-cycle-workflow',
      input: { ticket: 'ABC-42', request: 'implement this' },
      idempotencyKey: 'agent-request-42',
    }, runCtx);
    expect(replay.status).toBe(200);
    expect((replay.body as typeof firstRun).runId).toBe(firstRun.runId);

    const duplicate = await call('POST', '/api/workflow-runs/by-name', {
      name: 'full-cycle-workflow',
      input: { request: 'must not replace the original input' },
      idempotencyKey: 'agent-request-42',
    }, runCtx);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      code: 'workflow-run-idempotency-conflict',
      runId: firstRun.runId,
    });
  });

  it('POST /api/workflow-runs/by-name returns a clear 404 for an unknown canonical name', async () => {
    const res = await call('POST', '/api/workflow-runs/by-name', {
      name: 'missing-workflow',
      input: { request: 'implement this' },
    }, runCtx);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/workflow name "missing-workflow" not found/i);
  });

  it('POST :id/run rejects malformed invocation input and idempotency keys', async () => {
    const definition = inlineDef('run-input-invalid', [
      { id: 'e0', from: 'trg', to: 'sa' },
      { id: 'e1', from: 'sa', to: 'sb' },
    ]);
    await call('POST', '/api/workflow-definitions', definition);

    const arrayInput = await call('POST', '/api/workflow-definitions/run-input-invalid/run', { input: ['not', 'an', 'object'] }, runCtx);
    expect(arrayInput.status).toBe(400);
    expect((arrayInput.body as { error: string }).error).toMatch(/input.*JSON object/i);

    const emptyKey = await call('POST', '/api/workflow-definitions/run-input-invalid/run', { idempotencyKey: '   ' }, runCtx);
    expect(emptyKey.status).toBe(400);
    expect((emptyKey.body as { error: string }).error).toMatch(/idempotencyKey/i);
  });

  it('POST :id/run EXECUTES the edge-implied order (GRS-014b) — no warning shim, edges win', async () => {
    // Declared [trg, sa, sb] but wired trg→sb→sa: the sequential engine runs sb first.
    // (The GRS-014a order-warning shim died with the declaration-order walk.)
    const branching = inlineDef('run-branch', [
      { id: 'e0', from: 'trg', to: 'sb' },
      { id: 'e1', from: 'sb', to: 'sa' },
    ]);
    await call('POST', '/api/workflow-definitions', branching);
    const res = await call('POST', '/api/workflow-definitions/run-branch/run', undefined, runCtx);
    expect(res.status).toBe(201);
    const run = res.body as { runId: string; status: string; order: string[]; steps: Array<{ nodeId: string; status: string }>; orderWarning?: unknown };
    expect(run.order).toEqual(['sb', 'sa']);
    expect(run.steps.map((s) => s.nodeId)).toEqual(['sb', 'sa']); // receipts in EXECUTION order
    expect(run.status).toBe('completed');
    expect(run.orderWarning).toBeUndefined();
  });

  it('refuses a cyclic graph during authoring, before a run can be created', async () => {
    const cyclic = inlineDef('run-cycle', [
      { id: 'e0', from: 'trg', to: 'sa' },
      { id: 'e1', from: 'sa', to: 'sb' },
      { id: 'e2', from: 'sb', to: 'sa' },
    ]);
    const created = await call('POST', '/api/workflow-definitions', cyclic);
    expect(created.status).toBe(400);
    expect((created.body as { errors: Array<{ code: string }> }).errors.map((error) => error.code)).toContain('non-loop-cycle');
    expect(fs.existsSync(path.join(evidenceRoot, 'workflows', 'run-cycle.definition.json'))).toBe(false);
  });

  it('POST :id/run parks mid-graph on an approval gate node with downstream steps still pending', async () => {
    const parky = {
      id: 'run-park',
      title: 'Park WF',
      nodes: [
        { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 'sa', type: 'step', label: 'Step A', position: { x: 0, y: 140 } },
        { id: 'gate', type: 'gate', label: 'Approve', position: { x: 0, y: 280 }, gate: { kind: 'approval', description: 'operator approves', approvalRef: 'ap' } },
        { id: 'sb', type: 'step', label: 'Step B', position: { x: 0, y: 420 } },
      ],
      edges: [
        { id: 'e0', from: 'trg', to: 'sa', kind: 'sequence' },
        { id: 'e1', from: 'sa', to: 'gate', kind: 'sequence' },
        { id: 'e2', from: 'gate', to: 'sb', kind: 'sequence' },
      ],
    };
    await call('POST', '/api/workflow-definitions', parky);
    const res = await call('POST', '/api/workflow-definitions/run-park/run', undefined, runCtx);
    expect(res.status).toBe(201);
    const run = res.body as { status: string; endedAt: string | null; parked: { scope: string; nodeId: string } | null; steps: Array<{ nodeId: string; status: string }> };
    expect(run.status).toBe('parked');
    expect(run.parked).toMatchObject({ scope: 'gateNode', nodeId: 'gate' });
    expect(run.endedAt).toBeNull(); // parking is not terminal
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['sa', 'inline'],
      ['gate', 'pending'],
      ['sb', 'pending'], // downstream never started
    ]);
  });

  it("serves a legacy v1 'passed' run as 'dispatched' over HTTP without touching the file", async () => {
    const dir = path.join(evidenceRoot, 'reports', 'runs', 'legacy-wf');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run-legacy.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        runId: 'run-legacy', workflowId: 'legacy-wf', definitionVersion: 1, title: 'Legacy',
        trigger: 'manual', status: 'passed', startedAt: '2026-07-01T06:00:00.000Z',
        endedAt: '2026-07-01T06:00:01.000Z', steps: [], parked: null,
      }, null, 2) + '\n',
      'utf8',
    );
    const before = fs.readFileSync(file);

    const list = await call('GET', '/api/workflow-definitions/legacy-wf/runs');
    expect(list.status).toBe(200);
    expect((list.body as { runs: Array<{ status: string }> }).runs[0].status).toBe('dispatched');

    const one = await call('GET', '/api/workflow-definitions/legacy-wf/runs/run-legacy');
    expect(one.status).toBe(200);
    expect((one.body as { status: string }).status).toBe('dispatched');

    // Read-time mapping only: the frozen evidence file is byte-identical.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).status).toBe('passed');
  });
});

describe('managed workflow cron jobs (GRS-014d) — definition CRUD keeps jobs.json in sync', () => {
  const cronJobsFile = path.join(process.env.JINN_HOME!, 'cron', 'jobs.json');
  const loadCron = (): Array<Record<string, unknown>> =>
    fs.existsSync(cronJobsFile) ? JSON.parse(fs.readFileSync(cronJobsFile, 'utf8')) : [];

  const schedDef = {
    id: 'sched-wf',
    title: 'Scheduled WF',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Nightly', position: { x: 0, y: 0 }, trigger: { kind: 'schedule', cron: '0 6 * * *', timezone: 'Europe/Sofia' } },
      { id: 's1', type: 'step', label: 'Work', position: { x: 0, y: 140 }, actor: { kind: 'engine', ref: 'codex' } },
    ],
    edges: [{ id: 'e1', from: 'trg', to: 's1', kind: 'sequence' }],
  };

  beforeEach(() => {
    fs.rmSync(path.dirname(cronJobsFile), { recursive: true, force: true });
  });
  afterAll(async () => {
    // The route sync reloads the real scheduler (node-cron tasks) — stop them.
    const { stopScheduler } = await import('../../cron/scheduler.js');
    stopScheduler();
  });

  it('create → managed entry appears; update cron → entry updated; retire → entry gone; user jobs untouched', async () => {
    // A pre-existing user job must survive every sync verbatim.
    fs.mkdirSync(path.dirname(cronJobsFile), { recursive: true });
    const userJob = { id: 'u-1', name: 'User', enabled: true, schedule: '0 * * * *', prompt: 'hi' };
    fs.writeFileSync(cronJobsFile, JSON.stringify([userJob], null, 2) + '\n', 'utf8');

    // CREATE — the managed job materializes with the id convention.
    const created = await call('POST', '/api/workflow-definitions', schedDef);
    expect(created.status).toBe(201);
    let jobs = loadCron();
    expect(jobs.map((j) => j.id)).toEqual(['u-1', 'workflow:sched-wf']);
    expect(jobs[1]).toMatchObject({
      managedBy: 'workflow', workflowId: 'sched-wf', schedule: '0 6 * * *',
      timezone: 'Europe/Sofia', enabled: true, name: 'Scheduled WF',
    });
    expect(jobs[0]).toEqual(userJob);

    // UPDATE the schedule — the managed entry follows the definition.
    const trg = { ...schedDef.nodes[0], trigger: { kind: 'schedule', cron: '15 7 * * *' } };
    const updated = await call('PUT', '/api/workflow-definitions/sched-wf', { nodes: [trg, schedDef.nodes[1]], expectedVersion: 1 });
    expect(updated.status).toBe(200);
    jobs = loadCron();
    expect(jobs.find((j) => j.id === 'workflow:sched-wf')).toMatchObject({ schedule: '15 7 * * *' });
    expect('timezone' in jobs.find((j) => j.id === 'workflow:sched-wf')!).toBe(false);

    // A manual edit of the managed job is re-synced away on the next definition save.
    const tampered = loadCron().map((j) => (j.id === 'workflow:sched-wf' ? { ...j, schedule: '* * * * *', prompt: 'sneak' } : j));
    fs.writeFileSync(cronJobsFile, JSON.stringify(tampered, null, 2) + '\n', 'utf8');
    const touch = await call('PUT', '/api/workflow-definitions/sched-wf', { title: 'Scheduled WF v2', expectedVersion: 2 });
    expect(touch.status).toBe(200);
    const healed = loadCron().find((j) => j.id === 'workflow:sched-wf')!;
    expect(healed.schedule).toBe('15 7 * * *');
    expect('prompt' in healed).toBe(false);

    // RETIRE — the managed entry is removed; the user job survives untouched.
    const retired = await call('POST', '/api/workflow-definitions/sched-wf/retire', {});
    expect(retired.status).toBe(200);
    jobs = loadCron();
    expect(jobs).toEqual([userJob]);
  });

  it('pausing a definition removes its managed entry; re-activating restores it', async () => {
    const created = await call('POST', '/api/workflow-definitions', { ...schedDef, id: 'pause-wf' });
    expect(created.status).toBe(201);
    expect(loadCron().map((j) => j.id)).toEqual(['workflow:pause-wf']);

    const paused = await call('PUT', '/api/workflow-definitions/pause-wf', { status: 'paused', expectedVersion: 1 });
    expect(paused.status).toBe(200);
    expect(loadCron()).toEqual([]);

    const active = await call('PUT', '/api/workflow-definitions/pause-wf', { status: 'active', expectedVersion: 2 });
    expect(active.status).toBe(200);
    expect(loadCron().map((j) => j.id)).toEqual(['workflow:pause-wf']);
  });

  it('a manual-trigger definition creates no managed job', async () => {
    const created = await call('POST', '/api/workflow-definitions', { ...validDef, id: 'no-sched-wf' });
    expect(created.status).toBe(201);
    expect(loadCron()).toEqual([]);
  });

  it('rejects non-string workflow schedule fields before definition or cron persistence', async () => {
    for (const [field, value] of [['timezone', 7], ['cron', 7], ['until', 7]] as const) {
      const id = `bad-schedule-${field}`;
      const trigger = { kind: 'schedule', cron: '0 6 * * *', [field]: value };
      const attempted = await call('POST', '/api/workflow-definitions', {
        ...schedDef,
        id,
        nodes: [{ ...schedDef.nodes[0], trigger }, schedDef.nodes[1]],
      });
      expect(attempted.status).toBe(400);
      expect(await call('GET', `/api/workflow-definitions/${id}`)).toMatchObject({ status: 404 });
      expect(loadCron()).toEqual([]);
    }
  });

  it('POST/PUT /api/cron reject a managed job without workflowId (managed ⇒ workflowId)', async () => {
    const bad = await call('POST', '/api/cron', { name: 'broken', schedule: '0 * * * *', managedBy: 'workflow' });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toContain('workflowId');

    const ok = await call('POST', '/api/cron', { id: 'hand-managed', name: 'hand', schedule: '0 * * * *', managedBy: 'workflow', workflowId: 'some-wf', enabled: false });
    expect(ok.status).toBe(201);

    const badPut = await call('PUT', '/api/cron/hand-managed', { workflowId: '' });
    expect(badPut.status).toBe(400);
    expect((badPut.body as { error: string }).error).toContain('workflowId');
  });

  it('POST/PUT /api/cron reject runtime-invalid schedules before jobs.json is persisted', async () => {
    const invalidTimezone = await call('POST', '/api/cron', {
      id: 'invalid-timezone',
      name: 'invalid timezone',
      schedule: '0 * * * *',
      timezone: 'Mars/Olympus',
      prompt: 'never persist',
    });
    expect(invalidTimezone.status).toBe(400);
    expect((invalidTimezone.body as { error: string }).error).toMatch(/valid IANA timezone/i);
    expect(loadCron()).toEqual([]);

    const valid = await call('POST', '/api/cron', { id: 'valid-job', name: 'valid', schedule: '0 * * * *', prompt: 'ok', enabled: false });
    expect(valid.status).toBe(201);
    const invalidUpdate = await call('PUT', '/api/cron/valid-job', { schedule: 'not a cron' });
    expect(invalidUpdate.status).toBe(400);
    expect(loadCron()[0].schedule).toBe('0 * * * *');
  });

  it('a run started over HTTP records the normalized manual trigger event', async () => {
    const created = await call('POST', '/api/workflow-definitions', { ...schedDef, id: 'trig-wf', nodes: [schedDef.nodes[0], { ...schedDef.nodes[1], actor: undefined }] });
    expect(created.status).toBe(201);
    const run = await call('POST', '/api/workflow-definitions/trig-wf/run', undefined, runCtx);
    expect(run.status).toBe(201);
    expect((run.body as { trigger: unknown }).trigger).toEqual({
      source: 'manual',
      event: 'workflow.manual_started',
      payload: { workflowId: 'trig-wf', requestedBy: 'api' },
    });
  });
});

describe('cron job id uniqueness (GRS-014d-fix, Codex finding 2)', () => {
  const cronJobsFile = path.join(process.env.JINN_HOME!, 'cron', 'jobs.json');
  beforeEach(() => {
    fs.rmSync(path.dirname(cronJobsFile), { recursive: true, force: true });
  });
  afterAll(async () => {
    const { stopScheduler } = await import('../../cron/scheduler.js');
    stopScheduler();
  });

  it('POST /api/cron rejects a duplicate id — the duplicate-id squatter shape cannot be created via the API', async () => {
    const first = await call('POST', '/api/cron', { id: 'dup-1', name: 'first', schedule: '0 * * * *', prompt: 'a' });
    expect(first.status).toBe(201);

    const dup = await call('POST', '/api/cron', { id: 'dup-1', name: 'second', schedule: '0 * * * *', prompt: 'b' });
    expect(dup.status).toBe(400);
    expect((dup.body as { error: string }).error).toContain('already exists');

    const jobs = JSON.parse(fs.readFileSync(cronJobsFile, 'utf8')) as Array<{ id: string }>;
    expect(jobs.filter((j) => j.id === 'dup-1')).toHaveLength(1);
  });

  it('duplicate detection is CANONICAL (GRS-014d-fix2): case variants and padded ids are the same identity as their run-log file', async () => {
    const first = await call('POST', '/api/cron', { id: 'workflow:case-1', name: 'first', schedule: '0 * * * *', prompt: 'a' });
    expect(first.status).toBe(201);

    // A case-variant id would share workflow:case-1.jsonl on macOS — same identity, rejected.
    const caseDup = await call('POST', '/api/cron', { id: 'Workflow:CASE-1', name: 'second', schedule: '0 * * * *', prompt: 'b' });
    expect(caseDup.status).toBe(400);
    expect((caseDup.body as { error: string }).error).toContain('already exists');

    // A whitespace-padded id breaks addressing (and trims to an existing identity) — rejected outright.
    const padded = await call('POST', '/api/cron', { id: ' workflow:case-1 ', name: 'third', schedule: '0 * * * *', prompt: 'c' });
    expect(padded.status).toBe(400);
    expect((padded.body as { error: string }).error).toContain('whitespace');

    const jobs = JSON.parse(fs.readFileSync(cronJobsFile, 'utf8')) as Array<{ id: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('workflow:case-1'); // stored as authored
  });
});

describe('resolve-gate route (GRS-014e) — approve/reject a parked run over HTTP', () => {
  const parkyDef = (id: string) => ({
    id,
    title: 'Park WF',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      { id: 'sa', type: 'step', label: 'Step A', position: { x: 0, y: 140 } },
      { id: 'gate', type: 'gate', label: 'Approve', position: { x: 0, y: 280 }, gate: { kind: 'approval', description: 'operator approves', approvalRef: 'ap' } },
      { id: 'sb', type: 'step', label: 'Step B', position: { x: 0, y: 420 } },
    ],
    edges: [
      { id: 'e0', from: 'trg', to: 'sa', kind: 'sequence' },
      { id: 'e1', from: 'sa', to: 'gate', kind: 'sequence' },
      { id: 'e2', from: 'gate', to: 'sb', kind: 'sequence' },
    ],
  });

  async function parkRun(id: string): Promise<string> {
    await call('POST', '/api/workflow-definitions', parkyDef(id));
    const res = await call('POST', `/api/workflow-definitions/${id}/run`, undefined, runCtx);
    expect(res.status).toBe(201);
    expect((res.body as { status: string }).status).toBe('parked');
    return (res.body as { runId: string }).runId;
  }

  it('approve → 200, the run resumes and completes (inline steps); the gate receipt records the routed COO', async () => {
    const runId = await parkRun('rg-approve');
    const res = await callAsCoo('POST', `/api/workflow-definitions/rg-approve/runs/${runId}/resolve-gate`, { decision: 'approve' }, runCtx);
    expect(res.status).toBe(200);
    const run = res.body as { status: string; parked: unknown; steps: Array<{ nodeId: string; status: string; detail?: string }> };
    expect(run.status).toBe('completed'); // sb is inline → the drive finishes in-route
    expect(run.parked).toBeNull();
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['sa', 'inline'], ['gate', 'checkpoint'], ['sb', 'inline'],
    ]);
    expect(run.steps[1].detail).toBe('approved by coo');
  });

  it('repairs a missing mirrored Todo before resolving a parked run gate', async () => {
    const runId = await parkRun('rg-repair-mirror');
    registry.initDb().prepare("DELETE FROM work_items WHERE source = 'workflow' AND source_ref = ?").run(`workflow:rg-repair-mirror:${runId}`);

    const res = await callAsCoo('POST', `/api/workflow-definitions/rg-repair-mirror/runs/${runId}/resolve-gate`, { decision: 'approve' }, runCtx);

    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('completed');
  });

  it('reject → 200 with a failed run and the gate-rejected error; downstream stayed pending', async () => {
    const runId = await parkRun('rg-reject');
    const res = await callAsCoo('POST', `/api/workflow-definitions/rg-reject/runs/${runId}/resolve-gate`, { decision: 'reject' }, runCtx);
    expect(res.status).toBe(200);
    const run = res.body as { status: string; errors?: Array<{ code: string }>; steps: Array<{ nodeId: string; status: string }> };
    expect(run.status).toBe('failed');
    expect(run.errors?.map((e) => e.code)).toContain('gate-rejected');
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['sa', 'inline'], ['gate', 'failed'], ['sb', 'pending'],
    ]);
  });

  it('404 unknown run · 409 not parked · 400 bad decision', async () => {
    const missing = await call('POST', '/api/workflow-definitions/rg-missing/runs/run-nope/resolve-gate', { decision: 'approve' }, runCtx);
    expect(missing.status).toBe(404);

    const runId = await parkRun('rg-conflict');
    // Resolve it once (completed), then resolving again is a 409 — no longer parked.
    await callAsCoo('POST', `/api/workflow-definitions/rg-conflict/runs/${runId}/resolve-gate`, { decision: 'approve' }, runCtx);
    const again = await callAsCoo('POST', `/api/workflow-definitions/rg-conflict/runs/${runId}/resolve-gate`, { decision: 'approve' }, runCtx);
    expect(again.status).toBe(409);
    expect((again.body as { status: string }).status).toBe('completed');

    const bad = await call('POST', `/api/workflow-definitions/rg-conflict/runs/${runId}/resolve-gate`, { decision: 'maybe' }, runCtx);
    expect(bad.status).toBe(400);
  });
});
