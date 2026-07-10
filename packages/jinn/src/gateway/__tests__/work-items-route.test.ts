import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * Route-level test for GET /api/work-items/:id/sessions (GRS-002). Drives
 * handleApiRequest directly with fake req/res — no HTTP server boot — and points
 * the registry DB at a throwaway JINN_HOME so it never touches the live DB.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-route-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;

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
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<
    Api["handleApiRequest"]
  >[0];
}

// serializeSession only reaches sessionManager.getQueue() + (absent) backgroundActivity.
const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  reg.initDb();
});

describe("GET /api/work-items/:id/sessions", () => {
  it("returns the sessions linked to a work item", async () => {
    const s = reg.createSession({ engine: "claude", source: "cron", sourceRef: "cron:routejob:1" });
    const wi = store.createWorkItem({ title: "route item", source: "cron", sourceRef: "cron:routejob:1:wi" });
    store.linkSession(wi.id, s.id);

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}/sessions`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    const ids = (cap.body as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(s.id);
  });

  it("returns an empty array for a work item with no linked sessions", async () => {
    const wi = store.createWorkItem({ title: "lonely item" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}/sessions`), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });
});

describe("GET /api/work-items and /api/search/work-items — pagination, totals, and filters", () => {
  it("returns exact totals plus an offset page beyond the first 20 rows", async () => {
    for (let i = 0; i < 25; i++) {
      store.createWorkItem({
        title: `route page backlog ${i}`,
        status: "backlog",
        department: "route-page-fixture",
        source: "human",
      });
    }
    for (let i = 0; i < 2; i++) {
      store.createWorkItem({
        title: `route page done ${i}`,
        status: "done",
        department: "route-page-fixture",
        source: "human",
      });
    }

    const totals = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?department=route-page-fixture&limit=20"), totals.res, ctx);
    expect(totals.status).toBe(200);
    expect(totals.body).toMatchObject({
      total: 27,
      totals: { backlog: 25, done: 2, assigned: 0, executing: 0, in_review: 0, blocked: 0, escalated: 0, cancelled: 0 },
      limit: 20,
      offset: 0,
      nextOffset: 20,
    });

    const second = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?department=route-page-fixture&status=backlog&limit=20&offset=20"),
      second.res,
      ctx,
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ total: 25, limit: 20, offset: 20, nextOffset: null });
    expect(second.body.workItems).toHaveLength(5);
  });

  it("AND-composes status, assignee, department, source, q, since, and until on list and search", async () => {
    const match = store.createWorkItem({
      title: "route-filter-needle",
      body: "body",
      status: "assigned",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
    });
    const bodyOnly = store.createWorkItem({
      title: "route body candidate",
      body: "route-filter-needle in body",
      status: "assigned",
      assignee: "someone-else",
      department: "somewhere-else",
      source: "connector",
    });
    const outside = store.createWorkItem({
      title: "route-filter-needle outside",
      status: "assigned",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
    });
    const db = reg.initDb();
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-10T08:00:00.000Z", match.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-11T08:00:00.000Z", bodyOnly.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-03-01T08:00:00.000Z", outside.id);
    store.updateWorkItem(match.id, { rank: 7 }, "operator");
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-10T08:00:00.000Z", match.id);

    const query = new URLSearchParams({
      status: "assigned",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
      q: "route-filter-needle",
      since: "2033-02-10T08:00:00+00:00",
      until: "2033-02-28",
      limit: "20",
    });
    for (const pathname of [`/api/work-items?${query}`, `/api/search/work-items?${query}`]) {
      const cap = makeRes();
      await api.handleApiRequest(makeReq("GET", pathname), cap.res, ctx);
      expect(cap.status).toBe(200);
      expect(cap.body.workItems.map((item: { id: string }) => item.id)).toEqual([match.id]);
      expect(cap.body.workItems[0]).toMatchObject({ rank: 7 });
      expect(cap.body).toMatchObject({ total: 1, totals: { assigned: 1 }, offset: 0, nextOffset: null });
    }

    const qMatches = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?q=route-filter-needle&source=connector&limit=100"), qMatches.res, ctx);
    expect(new Set(qMatches.body.workItems.map((item: { id: string }) => item.id))).toEqual(new Set([match.id, bodyOnly.id, outside.id]));

    const legacyText = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/search/work-items?text=route-filter-needle&source=connector&limit=100"), legacyText.res, ctx);
    expect(new Set(legacyText.body.workItems.map((item: { id: string }) => item.id))).toEqual(new Set([match.id, bodyOnly.id, outside.id]));
  });

  it.each([
    ["offset=-1", /offset/i],
    ["offset=1.5", /offset/i],
    ["offset=9007199254740992", /offset/i],
    ["limit=0", /limit/i],
    ["limit=2x", /limit/i],
    ["since=not-a-date", /since/i],
    ["until=not-a-date", /until/i],
    ["since=2033-03-01T00%3A00%3A00.000Z&until=2033-02-01T00%3A00%3A00.000Z", /since.*until|range/i],
  ])("rejects invalid list query %s", async (query, message) => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?${query}`), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(message);
  });
});

describe("POST /api/work-items — provenance and approval routing fields", () => {
  function toolHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  it("rejects caller-supplied provenance and mints normal tool-created Todos as session source", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller", employee: "platform-worker" });

    const spoof = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "Spoof", provenance: { source: "workflow", sourceRef: "workflow:wf:run" } }, toolHeaders(caller.id)),
      spoof.res,
      ctx,
    );
    expect(spoof.status).toBe(400);
    expect(spoof.body.error).toMatch(/provenance.*dedicated bridge|cannot be supplied/i);

    const ok = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Normal" }, toolHeaders(caller.id)), ok.res, ctx);
    expect(ok.status).toBe(201);
    expect(ok.body.workItem).toMatchObject({ source: "session", approvalTarget: null, approvalEscalatedAt: null });
    expect(ok.body.workItem.sourceRef).toMatch(new RegExp(`^session:${caller.id}:`));
  });

  it("returns approvalTarget in compact and full API records", async () => {
    const wi = store.createWorkItem({ title: "Approval target row", source: "human" });
    const approvals = await import("../../work-items/approvals.js");
    approvals.requestApproval(wi.id, { request: "decide", target: "coo" });

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?limit=20"), list.res, ctx);
    expect(list.status).toBe(200);
    expect((list.body.workItems as Array<Record<string, unknown>>).find((item) => item.id === wi.id)).toMatchObject({
      approvalTarget: "coo",
      approvalState: "pending",
    });

    const full = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}`), full.res, ctx);
    expect(full.status).toBe(200);
    expect(full.body.workItem).toMatchObject({ approvalTarget: "coo", approvalEscalatedAt: null });
  });

  it("returns a capability-scoped needs-attention queue ordered by updatedAt with compact run/session refs", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-attn", title: "coo", employee: "coo" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "worker-attn", title: "worker", employee: "platform-worker" });

    const cooApproval = store.createWorkItem({ title: "COO approval", source: "workflow", sourceRef: "workflow:wf-coo:run-1", status: "in_review" });
    const workerApproval = store.createWorkItem({ title: "Worker approval", source: "workflow", sourceRef: "workflow:wf-worker:run-2", status: "in_review" });
    const cooBlocked = store.createWorkItem({ title: "COO blocked", source: "session", sourceRef: `session:${coo.id}:abc123`, assignee: "coo", status: "blocked" });
    const cooNormal = store.createWorkItem({ title: "COO normal", assignee: "coo", status: "assigned" });

    const approvals = await import("../../work-items/approvals.js");
    approvals.requestApproval(cooApproval.id, { request: "approve coo", target: "coo" });
    approvals.requestApproval(workerApproval.id, { request: "approve worker", target: "platform-worker" });

    const db = reg.initDb();
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T10:00:00.000Z", cooApproval.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T12:00:00.000Z", cooBlocked.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T13:00:00.000Z", workerApproval.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T14:00:00.000Z", cooNormal.id);

    const cooQueue = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=2", undefined, toolHeaders(coo.id)),
      cooQueue.res,
      ctx,
    );
    expect(cooQueue.status).toBe(200);
    expect((cooQueue.body.workItems as Array<{ id: string }>).map((item) => item.id)).toEqual([cooBlocked.id, cooApproval.id]);
    expect(cooQueue.body.workItems[0]).toMatchObject({
      id: cooBlocked.id,
      sessionRef: { sessionId: coo.id },
      workflowRun: null,
      approvalState: null,
      approvalTarget: null,
    });
    expect(cooQueue.body.workItems[1]).toMatchObject({
      id: cooApproval.id,
      workflowRun: { workflowId: "wf-coo", runId: "run-1" },
      sessionRef: null,
      approvalState: "pending",
      approvalTarget: "coo",
    });

    const workerQueue = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=10", undefined, toolHeaders(worker.id)),
      workerQueue.res,
      ctx,
    );
    expect(workerQueue.status).toBe(200);
    expect((workerQueue.body.workItems as Array<{ id: string }>).map((item) => item.id)).toEqual([workerApproval.id]);

    const spoof = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=coo&limit=10", undefined, toolHeaders(worker.id)),
      spoof.res,
      ctx,
    );
    expect(spoof.status).toBe(403);
    expect(spoof.body.error).toMatch(/own queue|needsAttentionFor=me|cannot read/i);

    const badCapability = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me", undefined, {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: coo.id,
        [CALLER_SESSION_CAPABILITY_HEADER]: "bad-capability",
      }),
      badCapability.res,
      ctx,
    );
    expect(badCapability.status).toBe(403);
  });
});
