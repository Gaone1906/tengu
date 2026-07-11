import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActivityEventInput } from "../../activity/types.js";

// Fresh JINN_HOME before importing api/registry (all path constants resolve at import).
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-activity-api-home-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../activity/store.js");
let api: Api;
let registry: Registry;
let store: Store;

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {}, portal: { portalName: "Jinn" } }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  const chunks: Buffer[] = [];
  let status = 200;
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    write(body?: Buffer | string) { if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return true; },
    end(body?: Buffer | string) { if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const text = Buffer.concat(chunks).toString("utf-8");
      return text ? JSON.parse(text) : null;
    },
  };
}

async function request(url: string) {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers: { host: "gateway.test" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  const capture = makeRes();
  await api.handleApiRequest(req, capture.res, apiCtx);
  return { status: capture.status, body: capture.body };
}

function event(index: number, overrides: Partial<ActivityEventInput> = {}): ActivityEventInput {
  return {
    occurredAt: `2026-07-11T12:0${index}:00.000Z`,
    kind: "todo",
    action: "todo.updated",
    actor: { type: "employee", id: "operations-lead", displayName: "Operations Lead" },
    object: { type: "todo", id: `object-${index}`, label: `Todo ${index}`, href: `/todos?item=object-${index}` },
    outcome: { state: "succeeded", label: "Updated" },
    summary: `Updated Todo ${index}`,
    correlationId: `todo:update:${index}`,
    idempotencyKey: `todo:updated:event-${index}`,
    detail: { index },
    ...overrides,
  };
}

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  store = await import("../../activity/store.js");
  api = await import("../api.js");
});

describe("normalized Activity HTTP contract", () => {
  it("migrates on a fresh gateway home and returns cursor-paginated stories with honest totals", async () => {
    const database = registry.initDb();
    store.appendActivityEvent(event(0), { database });
    store.appendActivityEvent(event(1, { kind: "workflow", outcome: { state: "failed", label: "Failed" }, summary: "Workflow failed" }), { database });
    store.appendActivityEvent(event(2, { kind: "approval", outcome: { state: "attention", label: "Waiting" }, summary: "Approval waiting" }), { database });

    const response = await request("/api/activity?limit=2&kinds=workflow,approval");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [
        { headline: "Approval waiting", eventCount: 1 },
        { headline: "Workflow failed", eventCount: 1 },
      ],
      page: { hasMore: false, nextCursor: null },
      totals: { matching: 2, total: 3, attention: 1, failed: 1 },
    });
    expect(response.body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns complete story detail and applies server-side search/outcome filters", async () => {
    const database = registry.initDb();
    const first = store.appendActivityEvent(event(3, {
      occurredAt: "2026-07-11T12:03:00.000Z",
      correlationId: "workflow:run:shared",
      summary: "Workflow started",
      outcome: { state: "running", label: "Running" },
    }), { database }).event;
    store.appendActivityEvent(event(4, {
      occurredAt: "2026-07-11T12:04:00.000Z",
      correlationId: "workflow:run:shared",
      summary: "Workflow completed",
      causationId: first.id,
    }), { database });

    const filtered = await request("/api/activity?q=Workflow%20completed&outcomes=succeeded");
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0]).toMatchObject({ id: first.storyId, headline: "Workflow completed", eventCount: 2 });

    const detail = await request(`/api/activity/${first.storyId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((item: { summary: string }) => item.summary)).toEqual(["Workflow started", "Workflow completed"]);
  });

  it("returns 400 for malformed cursors/filters and 404 for an unknown well-formed story", async () => {
    expect(await request("/api/activity?cursor=broken")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/cursor/i) } });
    expect(await request("/api/activity?kinds=unknown")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/kind/i) } });
    expect(await request("/api/activity/story_000000000000000000000000")).toMatchObject({ status: 404, body: { error: "Not found" } });
  });

  it("keeps raw logs on the separate Diagnostics endpoint", async () => {
    const response = await request("/api/logs?n=5");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ lines: [] });
  });
});
