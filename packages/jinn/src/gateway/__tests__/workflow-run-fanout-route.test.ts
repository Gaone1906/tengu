import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

/**
 * Route-level test for GRS-016a: a fan-out definition with `concurrency` executes both
 * branches and joins over the REAL run route (handleApiRequest → startWorkflowRun),
 * and the `bad-concurrency` validation surfaces as a 400 at authoring time. Mirrors
 * workflow-definitions-route.test.ts's bootstrap (fake req/res, throwaway evidence
 * root — nothing live is touched). All-inline steps (no actors) keep the route drive
 * synchronous and engine-free; genuine session overlap is proven at the reconciler
 * tier (run-reconciler-parallel.test.ts) and live by the Codex QA repro.
 */

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-fanout-route-'));
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-fanout-home-'));
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;

type Api = typeof import('../api.js');
let api: Api;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown) {
  const base = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(base, { method, url: urlPath, headers: { host: 'localhost' } });
  return base as unknown as Parameters<Api['handleApiRequest']>[0];
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
} as unknown as import('../api.js').ApiContext;

async function call(method: string, url: string, body?: unknown) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body), cap.res, ctx);
  return cap;
}

/** All-inline fan-out diamond: trigger→a→(b ∥ c)→d, no actors — runs without spawning. */
function inlineDiamond(id: string, concurrency?: number) {
  const node = (nid: string) => ({ id: nid, type: 'step', label: nid.toUpperCase(), position: { x: 0, y: 0 } });
  return {
    id, title: id,
    ...(concurrency !== undefined ? { concurrency } : {}),
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      node('a'), node('b'), node('c'), node('d'),
    ],
    edges: [
      { id: 'e0', from: 'trg', to: 'a', kind: 'sequence' },
      { id: 'e1', from: 'a', to: 'b', kind: 'sequence' },
      { id: 'e2', from: 'a', to: 'c', kind: 'sequence' },
      { id: 'e3', from: 'b', to: 'd', kind: 'sequence' },
      { id: 'e4', from: 'c', to: 'd', kind: 'sequence' },
    ],
  };
}

beforeAll(async () => {
  api = await import('../api.js');
});

afterAll(() => {
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  if (process.env.JINN_HOME) fs.rmSync(process.env.JINN_HOME, { recursive: true, force: true });
});

describe('workflow run route — GRS-016a fan-out + concurrency over HTTP', () => {
  it('POST create rejects an out-of-range concurrency with a structured bad-concurrency 400', async () => {
    const res = await call('POST', '/api/workflow-definitions', inlineDiamond('fanout-bad', 9));
    expect(res.status).toBe(400);
    const codes = (res.body as { errors: Array<{ code: string }> }).errors.map((e) => e.code);
    expect(codes).toContain('bad-concurrency');
  });

  it('POST create accepts concurrency 2 and persists it on the definition', async () => {
    const res = await call('POST', '/api/workflow-definitions', inlineDiamond('fanout-ok', 2));
    expect(res.status).toBe(201);
    expect((res.body as { concurrency?: number }).concurrency).toBe(2);
  });

  it('POST :id/run executes the fan-out and joins: all four steps settle, receipts stay in frozen topo order', async () => {
    const run = await call('POST', '/api/workflow-definitions/fanout-ok/run');
    expect(run.status).toBe(201);
    const body = run.body as {
      runId: string; status: string; order: string[];
      steps: Array<{ nodeId: string; status: string }>;
    };
    expect(body.status).toBe('completed'); // both branches executed AND the join ran
    expect(body.order).toEqual(['a', 'b', 'c', 'd']);
    expect(body.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['a', 'inline'], ['b', 'inline'], ['c', 'inline'], ['d', 'inline'],
    ]);
    // The persisted record matches (the route returns the saved snapshot).
    const onDisk = JSON.parse(fs.readFileSync(
      path.join(evidenceRoot, 'reports', 'runs', 'fanout-ok', `${body.runId}.json`), 'utf8',
    )) as { status: string; definitionSnapshot?: { concurrency?: number } };
    expect(onDisk.status).toBe('completed');
    expect(onDisk.definitionSnapshot?.concurrency).toBe(2); // frozen with the snapshot
  });

  it('the same fan-out WITHOUT concurrency also runs to completion (sequential compat over the route)', async () => {
    const created = await call('POST', '/api/workflow-definitions', inlineDiamond('fanout-seq'));
    expect(created.status).toBe(201);
    const run = await call('POST', '/api/workflow-definitions/fanout-seq/run');
    expect(run.status).toBe(201);
    expect((run.body as { status: string }).status).toBe('completed');
  });
});
