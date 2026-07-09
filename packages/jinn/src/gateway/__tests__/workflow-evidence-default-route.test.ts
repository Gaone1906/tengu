import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

/**
 * Route-level proof that workflows work OUT OF THE BOX on a real gateway with no
 * JINN_WORKFLOW_EVIDENCE_ROOT set: the evidence root defaults to
 * <JINN_HOME>/workflow-evidence, is created lazily, and the definition CRUD +
 * run surfaces report evidenceConfigured:true (a normal empty state, not the
 * scary "storage disabled" banner). No env override anywhere in this file.
 */

// Deliberately NO JINN_WORKFLOW_EVIDENCE_ROOT — the whole point is the default.
delete process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-default-home-'));
process.env.JINN_HOME = home;
const orgDir = path.join(home, 'org', 'platform');
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, 'department.yaml'), 'name: platform\n');
fs.writeFileSync(
  path.join(orgDir, 'jimbo.yaml'),
  'name: jimbo\ndisplayName: Jimbo\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n',
);

type Api = typeof import('../api.js');
let api: Api;

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

function makeReq(method: string, urlPath: string, body?: unknown) {
  const base = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(base, { method, url: urlPath, headers: { host: 'localhost', 'content-type': 'application/json' } });
  return base as unknown as Parameters<Api['handleApiRequest']>[0];
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
} as unknown as import('../api.js').ApiContext;

async function call(method: string, url: string, body?: unknown) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body), cap.res, ctx);
  return cap;
}

const validDef = {
  id: 'default-root-wf',
  title: 'Default Root WF',
  nodes: [
    { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
    { id: 's1', type: 'step', label: 'Work', position: { x: 0, y: 140 }, actor: { kind: 'employee', ref: 'jimbo' } },
  ],
  edges: [{ id: 'e1', from: 'trg', to: 's1', kind: 'sequence' }],
};

beforeAll(async () => {
  api = await import('../api.js');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('workflows default evidence root (no env override)', () => {
  it('lists as a NORMAL empty result on a fresh gateway and creates the default dir lazily', async () => {
    const list = await call('GET', '/api/workflow-definitions');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ definitions: [], evidenceConfigured: true });
    // No scary reason on the happy path.
    expect((list.body as { evidenceReason?: string }).evidenceReason).toBeUndefined();
    // The default root (and its workflows/ subdir) now physically exists under JINN_HOME.
    expect(fs.statSync(path.join(home, 'workflow-evidence', 'workflows')).isDirectory()).toBe(true);
  });

  it('a definition created without any env var is stored under the default root, listed, and its runs surface is armed', async () => {
    const created = await call('POST', '/api/workflow-definitions', validDef);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'default-root-wf', version: 1 });

    // Persisted under the DEFAULT root, not some sprint/env dir.
    expect(fs.existsSync(path.join(home, 'workflow-evidence', 'workflows', 'default-root-wf.definition.json'))).toBe(true);

    const list = await call('GET', '/api/workflow-definitions');
    expect((list.body as { definitions: Array<{ id: string }> }).definitions.map((d) => d.id)).toContain('default-root-wf');

    // Runs surface reports a normal armed-but-empty state (not evidence-root-missing).
    const runs = await call('GET', '/api/workflow-definitions/default-root-wf/runs');
    expect(runs.status).toBe(200);
    expect(runs.body).toMatchObject({ runs: [], evidenceConfigured: true });

    // The GET /api/workflows derived view is also armed on the default root
    // (it lists the legacy *.workflow.yaml derived shape, so it need not contain
    // the CRUD *.definition.json id — evidenceConfigured proves it's live).
    const wf = await call('GET', '/api/workflows');
    expect((wf.body as { evidenceConfigured: boolean }).evidenceConfigured).toBe(true);
  });
});
