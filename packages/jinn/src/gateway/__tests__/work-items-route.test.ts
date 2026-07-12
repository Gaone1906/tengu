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
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);

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

function makeRawReq(method: string, urlPath: string, raw: string, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([Buffer.from(raw)]), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

function makeChunkedRawReq(
  method: string,
  urlPath: string,
  chunks: string[],
  headers: Record<string, string> = {},
  slow = false,
) {
  const source = slow
    ? Readable.from((async function* () {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield Buffer.from(chunk);
        }
      })())
    : Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  return Object.assign(source, {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

function sizedTodoPatch(expectedVersion: number, byteLength: number, multibyte: boolean): string {
  const prefix = `{"expectedVersion":${expectedVersion},"body":"`;
  const suffix = '"}';
  let remaining = byteLength - Buffer.byteLength(prefix + suffix);
  if (remaining < 0) throw new Error("requested Todo patch size is smaller than its JSON envelope");
  let body = "";
  if (multibyte) {
    const unit = "ж"; // two UTF-8 bytes; JSON.stringify preserves it verbatim.
    body = unit.repeat(Math.floor(remaining / Buffer.byteLength(unit)));
    remaining -= Buffer.byteLength(body);
  }
  body += "a".repeat(remaining);
  const raw = prefix + body + suffix;
  if (Buffer.byteLength(raw) !== byteLength) throw new Error("Todo patch byte-size fixture drifted");
  return raw;
}

// serializeSession only reaches sessionManager.getQueue() + (absent) backgroundActivity.
const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
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
    expect(totals.body.workItems.every((item: { version?: number }) => item.version === 1)).toBe(true);

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

describe("PATCH /api/work-items/:id — operator metadata editing", () => {
  const operatorHeaders = { authorization: "Bearer test-token" };
  const hostileInputs = [
    "wi_private_validation_marker",
    "/srv/private-validation.db",
    "SQLITE_DROP_TABLE_validation",
    "token=validation-token",
    "secret=validation-secret",
    "control\u0001marker",
  ];

  function expectNoHostileInput(body: unknown): void {
    const serialized = JSON.stringify(body);
    for (const input of hostileInputs) {
      const escaped = JSON.stringify(input).slice(1, -1);
      expect(serialized).not.toContain(input);
      expect(serialized).not.toContain(escaped);
    }
  }

  function toolHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  it("lets the authenticated operator edit metadata and manual rank without changing status", async () => {
    const item = store.createWorkItem({ title: "Before edit", body: "old body", status: "backlog" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        title: "After edit",
        body: "new body",
        assignee: "platform-worker",
        department: "platform",
        priority: 3,
        rank: 12.5,
      }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      id: item.id,
      title: "After edit",
      body: "new body",
      assignee: "platform-worker",
      department: "platform",
      priority: 3,
      rank: 12.5,
      status: "backlog",
      version: 2,
    });
    expect(cap.body.replayed).toBe(false);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "After edit", body: "new body", status: "backlog" });
  });

  it("rejects unauthenticated and capability-scoped session callers, even when assigned", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "patch-caller", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "Protected edit", assignee: "platform-worker", department: "platform" });

    const unauthenticated = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Spoofed" }), unauthenticated.res, ctx);
    expect(unauthenticated.status).toBe(403);

    const session = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Session edit" }, toolHeaders(caller.id)),
      session.res,
      ctx,
    );
    expect(session.status).toBe(403);
    expect(session.body.error).toMatch(/operator/i);

    const badCapability = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Bad cap" }, {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: caller.id,
        [CALLER_SESSION_CAPABILITY_HEADER]: "bad-capability",
      }),
      badCapability.res,
      ctx,
    );
    expect(badCapability.status).toBe(403);
    expect(store.getWorkItem(item.id)?.title).toBe("Protected edit");
  });

  it("rejects status in PATCH and keeps lifecycle changes on the guarded transition route", async () => {
    const item = store.createWorkItem({ title: "Lifecycle separation", status: "backlog" });
    const patch = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { status: "done", expectedVersion: item.version }, operatorHeaders),
      patch.res,
      ctx,
    );
    expect(patch.status).toBe(400);
    expect(patch.body.error).toMatch(/status.*transition|transition.*status/i);
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");

    const transition = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/status`, { status: "done" }, operatorHeaders),
      transition.res,
      ctx,
    );
    expect(transition.status).toBe(200);
    expect(transition.body.workItem.status).toBe("done");
  });

  it.each(["backlog", "assigned"] as const)("round-trips an operator PUT that manually starts %s work", async (status) => {
    const item = store.createWorkItem({ title: `Start ${status}`, status });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "executing" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe("executing");
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      fromStatus: status,
      toStatus: "executing",
      actor: "operator",
    });
  });

  it.each(["backlog", "assigned", "executing", "in_review", "blocked"] as const)(
    "lets the authenticated operator cancel %s work through PUT",
    async (status) => {
      const item = store.createWorkItem({ title: `Cancel ${status}`, status });
      const cap = makeRes();

      await api.handleApiRequest(
        makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "cancelled" }, operatorHeaders),
        cap.res,
        ctx,
      );

      expect(cap.status).toBe(200);
      expect(cap.body.workItem.status).toBe("cancelled");
      expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
        kind: "status_change",
        fromStatus: status,
        toStatus: "cancelled",
        actor: "operator",
      });
    },
  );

  it("keeps capability-scoped POST cancellation forbidden", async () => {
    const caller = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "cancel-caller",
      employee: "platform-worker",
    });
    const item = store.createWorkItem({
      title: "Agent cancellation forbidden",
      status: "assigned",
      assignee: "platform-worker",
    });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/status`, { status: "cancelled" }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toMatch(/cancelling.*human surface/i);
    expect(store.getWorkItem(item.id)?.status).toBe("assigned");
  });

  it.each(["done", "escalated"] as const)("keeps %s terminal cancellation rejected", async (status) => {
    const item = store.createWorkItem({ title: `Already ${status}`, status });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "cancelled" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([400, 403]).toContain(cap.status);
    expect(cap.body.error).toMatch(/illegal transition|human.*decision/i);
    expect(store.getWorkItem(item.id)?.status).toBe(status);
  });

  it.each([
    [{}, /at least one|empty/i],
    [{ source: "cron" }, /source|unsupported|field/i],
    [{ title: "   " }, /title/i],
    [{ body: 7 }, /body/i],
    [{ assignee: "" }, /assignee/i],
    [{ assignee: "missing-worker" }, /unknown employee/i],
    [{ department: "" }, /department/i],
    [{ priority: 4 }, /priority/i],
    [{ rank: "not-a-rank" }, /rank/i],
  ])("rejects invalid metadata patch %o", async (body, message) => {
    const item = store.createWorkItem({ title: "Validation target" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...body }, operatorHeaders), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(message);
  });

  it.each([
    ["empty", "", "application/json", "Todo edit request must be valid JSON."],
    ["whitespace", " \n\t ", "application/json", "Todo edit request must be valid JSON."],
    ["truncated object", '{"title":"cut off"', "application/json", "Todo edit request must be valid JSON."],
    ["invalid token", `{"title":"${hostileInputs[0]}",oops}`, "application/json", "Todo edit request must be valid JSON."],
    ["array", '[{"title":"no"}]', "application/json", "Todo edit request must be a JSON object."],
    ["string primitive", `"${hostileInputs[1]}"`, "application/json", "Todo edit request must be a JSON object."],
    ["number primitive", "42", "application/json", "Todo edit request must be a JSON object."],
    ["null primitive", "null", "application/json", "Todo edit request must be a JSON object."],
    ["duplicate key", '{"expectedVersion":1,"title":"first","title":"second"}', "application/json", "Todo edit request must be valid JSON."],
    ["missing content type", '{"expectedVersion":1,"title":"safe"}', "", "Todo edit request must be valid JSON."],
    ["wrong content type", '{"expectedVersion":1,"title":"safe"}', "text/plain", "Todo edit request must be valid JSON."],
    ["ambiguous content type", '{"expectedVersion":1,"title":"safe"}', "application/json, text/plain", "Todo edit request must be valid JSON."],
  ])("returns a fixed typed response for %s Todo edit bodies", async (_name, raw, contentType, error) => {
    const item = store.createWorkItem({ title: "Raw validation target" });
    const cap = makeRes();
    const headers = { ...operatorHeaders, "content-type": contentType };
    await api.handleApiRequest(makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, headers), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({
      error,
      code: "todo_invalid_patch",
    });
    expectNoHostileInput(cap.body);
  });

  it("preserves authorization ordering for malformed Todo edit JSON", async () => {
    const item = store.createWorkItem({ title: "Raw auth target" });
    const cap = makeRes();
    await api.handleApiRequest(makeRawReq("PATCH", `/api/work-items/${item.id}`, "{"), cap.res, ctx);
    expect(cap.status).toBe(403);
    expect(cap.body).not.toMatchObject({ code: "todo_invalid_patch" });
  });

  it.each([
    ["ASCII limit - 1", -1, false],
    ["ASCII limit", 0, false],
    ["ASCII limit + 1", 1, false],
    ["Unicode limit - 1", -1, true],
    ["Unicode limit", 0, true],
    ["Unicode limit + 1", 1, true],
  ])("enforces the 64 KiB UTF-8 request bound at %s", async (_name, delta, multibyte) => {
    const item = store.createWorkItem({ title: "Bounded edit target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const raw = sizedTodoPatch(item.version, 64 * 1024 + delta, multibyte);
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, {
        ...operatorHeaders,
        "content-length": String(Buffer.byteLength(raw)),
      }),
      cap.res,
      ctx,
    );

    if (delta <= 0) {
      expect(cap.status).toBe(200);
      expect(cap.body.workItem.version).toBe(2);
      expect(Buffer.byteLength(cap.body.workItem.body, "utf8")).toBeLessThan(64 * 1024);
    } else {
      expect(cap.status).toBe(413);
      expect(cap.body).toEqual({
        error: "Todo edit request exceeds the 64 KiB limit.",
        code: "todo_edit_too_large",
      });
      expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, body: null });
      expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
    }
  });

  it("rejects an oversized declared Content-Length before reading or mutating", async () => {
    const item = store.createWorkItem({ title: "Declared length target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, '{"expectedVersion":1,"title":"safe"}', {
        ...operatorHeaders,
        "content-length": String(64 * 1024 + 1),
      }),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(413);
    expect(cap.body).toEqual({ error: "Todo edit request exceeds the 64 KiB limit.", code: "todo_edit_too_large" });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, title: "Declared length target" });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it.each([
    ["a lying short Content-Length", { "content-length": "1" }, false],
    ["a chunked body with no Content-Length", {}, false],
    ["a slow streamed body", {}, true],
  ])("rejects %s when streamed bytes cross the limit", async (_name, extraHeaders, slow) => {
    const item = store.createWorkItem({ title: "Stream bound target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const raw = sizedTodoPatch(item.version, 64 * 1024 + 1, true);
    const chunks = Array.from({ length: Math.ceil(raw.length / 1024) }, (_, index) => raw.slice(index * 1024, (index + 1) * 1024));
    const cap = makeRes();
    await api.handleApiRequest(
      makeChunkedRawReq("PATCH", `/api/work-items/${item.id}`, chunks, { ...operatorHeaders, ...extraHeaders }, slow),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(413);
    expect(cap.body).toEqual({ error: "Todo edit request exceeds the 64 KiB limit.", code: "todo_edit_too_large" });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, body: null });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it("does not store or audit a two-megabyte Todo body", async () => {
    const item = store.createWorkItem({ title: "Two megabyte target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const raw = `{"expectedVersion":1,"body":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const cap = makeRes();
    await api.handleApiRequest(makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, operatorHeaders), cap.res, ctx);
    expect(cap.status).toBe(413);
    expect(cap.body).toEqual({ error: "Todo edit request exceeds the 64 KiB limit.", code: "todo_edit_too_large" });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, body: null });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it("keeps authorization ahead of declared and streamed body bounds", async () => {
    const item = store.createWorkItem({ title: "Bound auth target" });
    for (const req of [
      makeRawReq("PATCH", `/api/work-items/${item.id}`, "{}", { "content-length": String(64 * 1024 + 1) }),
      makeRawReq("PATCH", `/api/work-items/${item.id}`, "x".repeat(64 * 1024 + 1)),
    ]) {
      const cap = makeRes();
      await api.handleApiRequest(req, cap.res, ctx);
      expect(cap.status).toBe(403);
      expect(cap.body).not.toMatchObject({ code: "todo_edit_too_large" });
    }
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, title: "Bound auth target" });
  });

  it("rejects compressed Todo edit bodies instead of buffering or decompressing them", async () => {
    const item = store.createWorkItem({ title: "Encoding policy target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, '{"expectedVersion":1,"title":"encoded"}', {
        ...operatorHeaders,
        "content-encoding": "gzip",
      }),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "Todo edit request must be valid JSON.", code: "todo_invalid_patch" });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, title: "Encoding policy target" });
  });

  it("never reflects unsupported field names or values in typed validation responses", async () => {
    for (const hostile of hostileInputs) {
      const item = store.createWorkItem({ title: "Unsupported privacy target" });
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, {
          expectedVersion: item.version,
          title: "safe title",
          [hostile]: hostile,
        }, operatorHeaders),
        cap.res,
        ctx,
      );
      expect(cap.status).toBe(400);
      expect(cap.body).toEqual({
        error: "Todo edit request contains unsupported fields.",
        code: "todo_invalid_patch",
      });
      expectNoHostileInput(cap.body);
    }
  });

  it("never reflects an unknown assignee in its typed validation response", async () => {
    for (const hostile of hostileInputs) {
      const item = store.createWorkItem({ title: "Assignee privacy target" });
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, {
          expectedVersion: item.version,
          assignee: hostile,
        }, operatorHeaders),
        cap.res,
        ctx,
      );
      expect(cap.status).toBe(400);
      expect(cap.body).toEqual({
        error: "Unknown employee for Todo assignee. Check the organization directory.",
        code: "todo_invalid_assignee",
      });
      expectNoHostileInput(cap.body);
    }
  });

  it.each([
    ["status", { status: hostileInputs[0] }, "Todo status must use the guarded status transition surface.", "todo_invalid_patch"],
    ["title shape", { title: { marker: hostileInputs[0] } }, "title must be a string", "todo_invalid_patch"],
    ["title length", { title: hostileInputs[0] + "x".repeat(201) }, "title must be at most 200 characters", "todo_invalid_patch"],
    ["body", { body: { marker: hostileInputs[1] } }, "body must be a string or null", "todo_invalid_patch"],
    ["assignee shape", { assignee: { marker: hostileInputs[2] } }, "assignee must be a non-empty string or null", "todo_invalid_patch"],
    ["department", { department: { marker: hostileInputs[3] } }, "department must be a non-empty string or null", "todo_invalid_patch"],
    ["priority", { priority: hostileInputs[4] }, "priority must be an integer from 0 through 3", "todo_invalid_patch"],
    ["rank", { rank: hostileInputs[5] }, "rank must be a finite number or null", "todo_invalid_patch"],
    ["idempotency key shape", { title: "safe", idempotencyKey: { marker: hostileInputs[0] } }, "Todo edit idempotency key must be a non-empty string.", "todo_invalid_patch"],
    ["idempotency key length", { title: "safe", idempotencyKey: hostileInputs[4] + "x".repeat(257) }, "Todo edit idempotency key is too long.", "todo_invalid_patch"],
    ["idempotency key control", { title: "safe", idempotencyKey: `safe-${hostileInputs[5]}` }, "Todo edit idempotency key contains invalid characters.", "todo_invalid_patch"],
    ["expected version", { title: "safe", expectedVersion: hostileInputs[3] }, "Todo version must be a positive safe integer.", "todo_invalid_version"],
  ])("returns a fixed typed response for rejected %s values", async (_field, patch, error, code) => {
    const item = store.createWorkItem({ title: "Rejected value privacy target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...patch }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error, code });
    expectNoHostileInput(cap.body);
  });

  it("keeps hostile edit content out of precondition and conflict responses", async () => {
    const item = store.createWorkItem({ title: "Conflict privacy target" });
    const hostileTitle = hostileInputs.join("|");

    const missing = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: hostileTitle }, operatorHeaders),
      missing.res,
      ctx,
    );
    expect(missing.body).toEqual({ error: "A current Todo version is required.", code: "todo_precondition_required" });
    expectNoHostileInput(missing.body);

    store.updateWorkItem(item.id, { title: "remote winner" }, "other-tab");
    const stale = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: hostileTitle, expectedVersion: item.version }, operatorHeaders),
      stale.res,
      ctx,
    );
    expect(stale.body).toEqual({
      error: "Todo changed since it was loaded.",
      code: "todo_version_conflict",
      currentVersion: 2,
    });
    expectNoHostileInput(stale.body);

    const keyed = store.createWorkItem({ title: "Idempotency privacy target" });
    const key = "todo:privacy:key-reuse";
    const first = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${keyed.id}`, { title: "first", expectedVersion: keyed.version, idempotencyKey: key }, operatorHeaders),
      first.res,
      ctx,
    );
    const misuse = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${keyed.id}`, { title: hostileTitle, expectedVersion: keyed.version, idempotencyKey: key }, operatorHeaders),
      misuse.res,
      ctx,
    );
    expect(misuse.body).toEqual({
      error: "This Todo edit key was already used for a different request.",
      code: "todo_idempotency_conflict",
      currentVersion: 2,
    });
    expectNoHostileInput(misuse.body);
  });

  it("requires a positive expected version, accepts an equivalent If-Match, and rejects disagreement", async () => {
    const item = store.createWorkItem({ title: "Preconditions" });

    const missing = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { title: "missing" }, operatorHeaders), missing.res, ctx);
    expect(missing.status).toBe(428);
    expect(missing.body).toEqual({ error: "A current Todo version is required.", code: "todo_precondition_required" });

    for (const expectedVersion of [0, -1, 1.5, "1", null]) {
      const malformed = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { title: "bad", expectedVersion }, operatorHeaders),
        malformed.res,
        ctx,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "Todo version must be a positive safe integer.", code: "todo_invalid_version" });
    }

    for (const ifMatch of ['W/"1"', '"0"', '"1", "2"', 'not-a-version']) {
      const malformed = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { title: "bad header" }, { ...operatorHeaders, "if-match": ifMatch }),
        malformed.res,
        ctx,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "Todo version must be a positive safe integer.", code: "todo_invalid_version" });
    }

    const mismatch = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "mismatch", expectedVersion: 1 }, { ...operatorHeaders, "if-match": '"2"' }),
      mismatch.res,
      ctx,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: "Todo version preconditions do not match.", code: "todo_invalid_version" });

    const header = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "header success" }, { ...operatorHeaders, "if-match": '"1"' }),
      header.res,
      ctx,
    );
    expect(header.status).toBe(200);
    expect(header.body.workItem).toMatchObject({ title: "header success", version: 2 });
  });

  it("allows exactly one same-version save and returns only a sanitized typed conflict", async () => {
    const item = store.createWorkItem({ title: "Race" });
    const first = makeRes();
    const second = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "winner", expectedVersion: item.version }, operatorHeaders),
      first.res,
      ctx,
    );
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "loser", expectedVersion: item.version }, operatorHeaders),
      second.res,
      ctx,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "Todo changed since it was loaded.",
      code: "todo_version_conflict",
      currentVersion: 2,
    });
    expect(JSON.stringify(second.body)).not.toMatch(/wi_|SQLITE|\/private|\/srv|\.db/i);
  });

  it("replays a lost response by idempotency key without another event or version bump", async () => {
    const item = store.createWorkItem({ title: "Before lost response" });
    const beforeEvents = store.listWorkItemEvents(item.id).length;
    const request = { title: "Committed", expectedVersion: item.version, idempotencyKey: "todo:edit:lost-response-one" };

    const lost = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, request, operatorHeaders), lost.res, ctx);
    const retry = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, request, operatorHeaders), retry.res, ctx);

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, workItem: { title: "Committed", version: 2 } });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(beforeEvents + 1);

    const misuse = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { ...request, title: "different private content" }, operatorHeaders),
      misuse.res,
      ctx,
    );
    expect(misuse.status).toBe(409);
    expect(misuse.body).toEqual({
      error: "This Todo edit key was already used for a different request.",
      code: "todo_idempotency_conflict",
      currentVersion: 2,
    });
    expect(JSON.stringify(misuse.body)).not.toContain("different private content");
  });

  it("invalidates stale edits after status, approval, reconciler, and Workflow mirror changes", async () => {
    const transitions = await import("../../work-items/transitions.js");
    const approvals = await import("../../work-items/approvals.js");
    const reconcile = await import("../../work-items/reconcile.js");
    const workflow = await import("../../work-items/workflow-bridge.js");
    const stale: Array<{ id: string; version: number; currentVersion: number }> = [];

    const statusItem = store.createWorkItem({ title: "status stale" });
    transitions.transition(statusItem.id, "executing", "system");
    stale.push({ id: statusItem.id, version: statusItem.version, currentVersion: 2 });

    const approvalItem = store.createWorkItem({ title: "approval stale" });
    approvals.requestApproval(approvalItem.id, { request: "decide", target: "reviewer" });
    stale.push({ id: approvalItem.id, version: approvalItem.version, currentVersion: 2 });

    const reconciledItem = store.createWorkItem({ title: "reconcile stale", source: "session" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "route-cas-reconcile" });
    store.linkSession(reconciledItem.id, session.id);
    const beforeReconcile = store.getWorkItem(reconciledItem.id)!.version;
    reg.updateSession(session.id, { status: "running" });
    reconcile.reconcileWorkItem(reconciledItem.id);
    stale.push({ id: reconciledItem.id, version: beforeReconcile, currentVersion: beforeReconcile + 1 });

    const bridge = workflow.createWorkflowTodoBridge();
    const run = { workflowId: "route-cas-workflow", runId: "run-one", title: "Workflow stale" };
    bridge.mintRunItem(run);
    const workflowItem = store.getWorkItemBySourceRef("workflow", workflow.workflowRunSourceRef(run))!;
    bridge.mirrorParkedGate(run, { ref: "approve", description: "Approve" });
    stale.push({ id: workflowItem.id, version: workflowItem.version, currentVersion: 2 });

    for (const target of stale) {
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${target.id}`, { title: "stale edit", expectedVersion: target.version }, operatorHeaders),
        cap.res,
        ctx,
      );
      expect(cap.status).toBe(409);
      expect(cap.body).toMatchObject({ code: "todo_version_conflict", currentVersion: target.currentVersion });
    }
  });

  it("implements overwrite only as refetch-current-version followed by a normal conditional PATCH", async () => {
    const item = store.createWorkItem({ title: "local desired" });
    store.updateWorkItem(item.id, { title: "remote winner" }, "other-tab");

    const stale = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "local desired", expectedVersion: item.version }, operatorHeaders),
      stale.res,
      ctx,
    );
    expect(stale.status).toBe(409);

    const refreshed = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), refreshed.res, ctx);
    const overwriteVersion = refreshed.body.workItem.version;
    const overwrite = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "local desired", expectedVersion: overwriteVersion }, operatorHeaders),
      overwrite.res,
      ctx,
    );
    expect(overwrite.status).toBe(200);
    expect(overwrite.body).toMatchObject({ replayed: false, workItem: { title: "local desired", version: overwriteVersion + 1 } });
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
