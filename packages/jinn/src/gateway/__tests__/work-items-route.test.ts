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
const dbModule = await import("../../shared/db.js");
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);
// Unrelated to platform-worker in every direction: no shared department, no
// reporting line. Drives the "any authenticated session" status lane.
fs.writeFileSync(
  path.join(tmp, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test loner.\n",
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
const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emittedEvents.push({ event, payload }),
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
  dbModule.initDb();
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

  it("accepts a canonical company-derived route ID before lookup", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ICI-999"), cap.res, ctx);
    expect(cap.status).toBe(404);
  });

  it.each(["wi_0123456789ab", "JIN-0", "JIN-01", "JIN-9007199254740992", "garbage"])(
    "rejects malformed Todo route id %s before storage lookup",
    async (id) => {
      for (const suffix of ["", "/sessions"]) {
        const cap = makeRes();
        await api.handleApiRequest(makeReq("GET", `/api/work-items/${id}${suffix}`), cap.res, ctx);
        expect(cap.status).toBe(400);
        expect(cap.body).toEqual({
          error: "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix",
        });
      }
    },
  );
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
    const db = dbModule.initDb();
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

  it("lets the operator PATCH the verify policy (set and clear) — the rail's verify picker lane", async () => {
    const item = store.createWorkItem({ title: "Verify policy edit", status: "assigned" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "thorough", maxRounds: 3 },
      }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.verifyPolicy).toEqual({ mode: "thorough", maxRounds: 3 });

    const clear = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: cap.body.workItem.version,
        verifyPolicy: null,
      }, operatorHeaders),
      clear.res,
      ctx,
    );
    expect(clear.status).toBe(200);
    expect(clear.body.workItem.verifyPolicy).toBeNull();
  })

  it("refuses an invalid verify policy mode readably", async () => {
    const item = store.createWorkItem({ title: "Verify policy invalid", status: "assigned" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "paranoid" },
      }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/verifyPolicy\.mode/);
  })

  it("keeps verifyPolicy operator-only: the creator session's PATCH is refused for that field", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "vp-caller", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "Agent vp edit", status: "assigned", createdBy: "platform-worker" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "trust" },
      }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(403);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toBeNull();
  })

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

  it("rejects unauthenticated callers, bad capabilities, and ownership edits by a session", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "patch-caller", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "Protected edit", assignee: "platform-worker", department: "platform" });

    const unauthenticated = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Spoofed" }), unauthenticated.res, ctx);
    expect(unauthenticated.status).toBe(403);

    // A session edits content freely, and is refused ownership by name.
    const session = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Session edit", expectedVersion: item.version }, toolHeaders(caller.id)),
      session.res,
      ctx,
    );
    expect(session.status).toBe(200);

    const ownership = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { department: "marketing", expectedVersion: session.body.workItem.version }, toolHeaders(caller.id)),
      ownership.res,
      ctx,
    );
    expect(ownership.status).toBe(403);
    expect(ownership.body.error).toContain('"department"');
    expect(ownership.body.error).toMatch(/operator/i);

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
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "Session edit", department: "platform" });
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

  // The `actor` filter on a todo-status Workflow trigger is only an authority
  // boundary if the operator string is exclusive to the operator surface. An
  // employee session moving the SAME Todo the SAME way must never record it.
  it("stamps an employee session's identical transition as session:<id>, never as the operator", async () => {
    const item = store.createWorkItem({ title: "Employee start", status: "assigned", assignee: "platform-worker" });
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:employee-actor", employee: "platform-worker" });
    store.linkSession(item.id, caller.id);
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/status`, { status: "executing" }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body]).toEqual([200, expect.anything()]);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "executing",
      actor: `session:${caller.id}`,
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

  it("keeps done → cancelled rejected (no declared edge, even for the operator)", async () => {
    const item = store.createWorkItem({ title: "Already done", status: "done" });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "cancelled" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([400, 403]).toContain(cap.status);
    expect(cap.body.error).toMatch(/illegal transition|human.*decision/i);
    expect(store.getWorkItem(item.id)?.status).toBe("done");
  });

  it.each(["blocked", "escalated"] as const)(
    "records a same-status %s note through the operator PUT lane (the banner's asked-for-after reason)",
    async (status) => {
      // Design-doc §5: a drop into Blocked/Escalated commits immediately and the
      // reason is asked for AFTER, in the opened task page's banner. That write
      // is a same-status PUT with a note — it must land as a reason-carrying
      // event (toStatus = the current status so the reason line reads it), not
      // vanish in the transition() same-status no-op.
      const item = store.createWorkItem({ title: `Reasonless ${status}`, status });
      const before = store.getWorkItem(item.id)!.version;
      const cap = makeRes();

      await api.handleApiRequest(
        makeReq("PUT", `/api/work-items/${item.id}/status`, { status, note: "Waiting on vendor keys" }, operatorHeaders),
        cap.res,
        ctx,
      );

      expect(cap.status).toBe(200);
      expect(cap.body.workItem.status).toBe(status);
      const event = store.listWorkItemEvents(item.id).at(-1);
      expect(event).toMatchObject({
        kind: "note",
        toStatus: status,
        actor: "operator",
      });
      expect(event?.detail?.note).toBe("Waiting on vendor keys");
      expect(store.getWorkItem(item.id)!.version).toBeGreaterThan(before);
    },
  );

  it("keeps a same-status operator PUT WITHOUT a note a plain no-op", async () => {
    const item = store.createWorkItem({ title: "No-op blocked", status: "blocked" });
    const events = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "blocked" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).length).toBe(events);
  });

  it("cancels an escalated item through the operator PUT lane (archive lane carries human authority)", async () => {
    // legalTargets() mirrors transitions.ts and offers escalated → cancelled;
    // the archive lane must honour the same human authority the PUT lane
    // already carries for every other sticky exit (Stage-A review F2).
    const item = store.createWorkItem({ title: "Escalated to cancel", status: "escalated" });
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
      fromStatus: "escalated",
      toStatus: "cancelled",
      actor: "operator",
    });
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
    ["dangling media parameter separator", '{"expectedVersion":1,"title":"safe"}', "application/json;", "Todo edit request must be valid JSON."],
    ["parameter without equals", '{"expectedVersion":1,"title":"safe"}', "application/json; charset", "Todo edit request must be valid JSON."],
    ["empty token parameter", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=", "Todo edit request must be valid JSON."],
    ["empty quoted parameter", '{"expectedVersion":1,"title":"safe"}', 'application/json; charset=""', "Todo edit request must be valid JSON."],
    ["missing parameter name", '{"expectedVersion":1,"title":"safe"}', "application/json; =utf-8", "Todo edit request must be valid JSON."],
    ["unterminated quoted parameter", '{"expectedVersion":1,"title":"safe"}', 'application/json; charset="utf-8', "Todo edit request must be valid JSON."],
    ["dangling quoted escape", '{"expectedVersion":1,"title":"safe"}', 'application/json; profile="safe\\', "Todo edit request must be valid JSON."],
    ["duplicate charset", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8; charset=utf-8", "Todo edit request must be valid JSON."],
    ["conflicting charset", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8; charset=utf-16", "Todo edit request must be valid JSON."],
    ["duplicate generic parameter", '{"expectedVersion":1,"title":"safe"}', "application/json; profile=one; PROFILE=two", "Todo edit request must be valid JSON."],
    ["header tab control", '{"expectedVersion":1,"title":"safe"}', "application/json;\tcharset=utf-8", "Todo edit request must be valid JSON."],
    ["header NUL control", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8\u0000", "Todo edit request must be valid JSON."],
    ["empty structured suffix prefix", '{"expectedVersion":1,"title":"safe"}', "application/+json", "Todo edit request must be valid JSON."],
  ])("returns a fixed typed response for %s Todo edit bodies", async (_name, raw, contentType, error) => {
    const item = store.createWorkItem({ title: "Raw validation target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();
    const headers = { ...operatorHeaders, "content-type": contentType };
    await api.handleApiRequest(makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, headers), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({
      error,
      code: "todo_invalid_patch",
    });
    expectNoHostileInput(cap.body);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "Raw validation target", version: 1 });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it.each([
    "application/json",
    "Application/JSON",
    " application/json ",
    "application/json;charset=utf-8",
    "application/json ; charset = UTF-8 ; profile = safe",
    'application/json; charset="utf-8"; profile="safe value"',
    'application/json; profile="safe,comma"',
    "application/merge-patch+json",
    "application/vnd.example.todo+json; version=1",
  ])("accepts the valid JSON media type %s", async (contentType) => {
    const item = store.createWorkItem({ title: "Valid media target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, '{"expectedVersion":1,"title":"valid media"}', {
        ...operatorHeaders,
        "content-type": contentType,
      }),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({ title: "valid media", version: 2 });
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

  it("invalidates stale edits after status, approval, and reconciler changes", async () => {
    const transitions = await import("../../work-items/transitions.js");
    const approvals = await import("../../work-items/approvals.js");
    const reconcile = await import("../../work-items/reconcile.js");
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

  it("rejects caller-supplied provenance and assigns normal tool-created Todos to the session source", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller", employee: "platform-worker" });

    const spoof = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "Spoof", provenance: { source: "workflow", sourceRef: "workflow:wf:run" } }, toolHeaders(caller.id)),
      spoof.res,
      ctx,
    );
    expect(spoof.status).toBe(400);
    expect(spoof.body.error).toContain("cron and delegation create their own records");
    expect(spoof.body.error).toContain("source=workflow is historical audit provenance and is not currently minted");
    expect(spoof.body.error).not.toMatch(/cron\/workflow\/delegation source records are minted|dedicated bridges?/i);

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

    const db = dbModule.initDb();
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
      approvalState: null,
      approvalTarget: null,
    });
    expect(cooQueue.body.workItems[1]).toMatchObject({
      id: cooApproval.id,
      sessionRef: null,
      approvalState: "pending",
      approvalTarget: "coo",
    });
    expect(cooQueue.body.workItems[0]).not.toHaveProperty("workflowRun");
    expect(cooQueue.body.workItems[1]).not.toHaveProperty("workflowRun");

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

describe("Todos v2 — sub-task create, tree route, new filters, cascade archive", () => {
  const operatorHeaders = { authorization: "Bearer test-token" };

  it("creates a sub-task with parentId/dueAt/priority and stamps createdBy from the caller", async () => {
    const rootRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "v2 tree root" }, operatorHeaders),
      rootRes.res,
      ctx,
    );
    expect(rootRes.status).toBe(201);
    const root = rootRes.body.workItem;
    expect(root.createdBy).toBe("operator");
    expect(root.parentId).toBeNull();
    expect(root.rootId).toBe(root.id);
    expect(root.depth).toBe(0);

    const childRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", {
        title: "v2 sub-task",
        parentId: root.id,
        dueAt: "2026-08-01T00:00:00.000Z",
        priority: 1,
      }, operatorHeaders),
      childRes.res,
      ctx,
    );
    expect(childRes.status).toBe(201);
    expect(childRes.body.workItem).toMatchObject({
      parentId: root.id,
      rootId: root.id,
      depth: 1,
      dueAt: "2026-08-01T00:00:00.000Z",
      priority: 1,
      createdBy: "operator",
    });
  });

  it("stamps the resolved employee SLUG as createdBy; session:<uuid> only for employee-less sessions (slice-5 decision 7)", async () => {
    const employeeSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "createdby-emp", employee: "platform-worker" });
    const bareSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "createdby-bare" });
    const headersFor = (sessionId: string): Record<string, string> => ({
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    });

    const bySlug = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "slug-created" }, headersFor(employeeSession.id)),
      bySlug.res,
      ctx,
    );
    expect(bySlug.status).toBe(201);
    expect(bySlug.body.workItem.createdBy).toBe("platform-worker");

    const bySession = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "bare-created" }, headersFor(bareSession.id)),
      bySession.res,
      ctx,
    );
    expect(bySession.status).toBe(201);
    expect(bySession.body.workItem.createdBy).toBe(`session:${bareSession.id}`);
  });

  it("inherits the parent's department (and prefix) when the request body has no department key", async () => {
    const root = store.createWorkItem({ title: "inherit root", department: "platform" });

    const inherited = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "inherit child", parentId: root.id }, operatorHeaders),
      inherited.res,
      ctx,
    );
    expect(inherited.status).toBe(201);
    expect(inherited.body.workItem.department).toBe("platform");
    expect(inherited.body.workItem.id.slice(0, 3)).toBe(root.id.slice(0, 3));

    const explicitNull = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "no-dept child", parentId: root.id, department: null }, operatorHeaders),
      explicitNull.res,
      ctx,
    );
    expect(explicitNull.status).toBe(201);
    expect(explicitNull.body.workItem.department).toBeNull();
    expect(explicitNull.body.workItem.id.slice(0, 3)).toBe("JIN"); // company prefix

    const explicitString = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "marketing child", parentId: root.id, department: "marketing" }, operatorHeaders),
      explicitString.res,
      ctx,
    );
    expect(explicitString.status).toBe(201);
    expect(explicitString.body.workItem.department).toBe("marketing");
    expect(explicitString.body.workItem.id.slice(0, 3)).not.toBe(root.id.slice(0, 3));
  });

  it("normalizes dueAt to a canonical ISO instant", async () => {
    const dateOnly = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "date-only due", dueAt: "2026-08-01" }, operatorHeaders),
      dateOnly.res,
      ctx,
    );
    expect(dateOnly.status).toBe(201);
    expect(dateOnly.body.workItem.dueAt).toBe("2026-08-01T00:00:00.000Z");

    const nonIso = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "sloppy due", dueAt: "Jan 1 2026" }, operatorHeaders),
      nonIso.res,
      ctx,
    );
    expect(nonIso.status).toBe(400);
    expect(nonIso.body.error).toMatch(/ISO 8601/);
  });

  it("rejects a malformed dueAt, an out-of-range priority, and an unknown parent", async () => {
    const badDue = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "bad due", dueAt: "not-a-date" }, operatorHeaders),
      badDue.res,
      ctx,
    );
    expect(badDue.status).toBe(400);
    expect(badDue.body.error).toMatch(/ISO 8601/);

    const badPriority = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "bad priority", priority: 9 }, operatorHeaders),
      badPriority.res,
      ctx,
    );
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.error).toMatch(/priority/);

    const badParent = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "orphan", parentId: "ZZZ-999" }, operatorHeaders),
      badParent.res,
      ctx,
    );
    expect(badParent.status).toBe(400);
    expect(badParent.body.error).toMatch(/not found/);
  });

  it("GET /api/work-items/:id/tree reaches the tree handler (no :id route collision) and nests children", async () => {
    const root = store.createWorkItem({ title: "route tree root" });
    const child = store.createWorkItem({ title: "route tree child", parentId: root.id });
    store.createWorkItem({ title: "route tree grandchild", parentId: child.id });

    const treeRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${root.id}/tree`), treeRes.res, ctx);
    expect(treeRes.status).toBe(200);
    const tree = treeRes.body.tree;
    expect(tree.root.id).toBe(root.id);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0].id).toBe(child.id);
    expect(tree.root.children[0].children).toHaveLength(1);
    expect(tree.totals.backlog).toBe(3);
    expect(tree.spendUsd).toBe(0);

    const missing = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ZZZ-424242/tree"), missing.res, ctx);
    expect(missing.status).toBe(404);
  });

  it("GET /api/work-items/trees returns root and leaf payloads equal to their single-tree responses and omits unknowns", async () => {
    const root = store.createWorkItem({ title: "batch route tree root" });
    const child = store.createWorkItem({ title: "batch route tree child", parentId: root.id });
    const leaf = store.createWorkItem({ title: "batch route tree leaf", parentId: child.id });
    const unknown = "ZZZ-424242";

    const rootRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${root.id}/tree`), rootRes.res, ctx);
    const leafRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${leaf.id}/tree`), leafRes.res, ctx);

    const batchRes = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items/trees?ids=${root.id},${leaf.id},${unknown}`),
      batchRes.res,
      ctx,
    );

    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toEqual({
      trees: {
        [root.id]: rootRes.body.tree,
        [leaf.id]: leafRes.body.tree,
      },
    });
    expect(batchRes.body.trees).not.toHaveProperty(unknown);
  });

  it("GET /api/work-items/trees rejects more than 100 ids with a readable 400", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `ZZZ-${index + 1}`);
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/trees?ids=${ids.join(",")}`), cap.res, ctx);

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/ids.*at most 100/i);
  });

  it("GET /api/work-items/trees has the same identified-caller auth guard as the single-tree route", async () => {
    const item = store.createWorkItem({ title: "batch route auth parity" });
    const unauthenticatedHeaders = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE };

    const single = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items/${item.id}/tree`, undefined, unauthenticatedHeaders),
      single.res,
      ctx,
    );
    const batch = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items/trees?ids=${item.id}`, undefined, unauthenticatedHeaders),
      batch.res,
      ctx,
    );

    expect(single.status).toBe(403);
    expect(batch.status).toBe(single.status);
    expect(batch.body).toEqual(single.body);
  });

  it("GET /api/work-items?ids returns the open-detail subset from single-item payloads and omits unknowns", async () => {
    const first = store.createWorkItem({ title: "batch detail first" });
    const second = store.createWorkItem({ title: "batch detail second" });
    const unknown = "ZZZ-424242";

    const firstRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${first.id}`), firstRes.res, ctx);
    const secondRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${second.id}`), secondRes.res, ctx);

    const batchRes = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items?ids=${first.id},${second.id},${unknown}`),
      batchRes.res,
      ctx,
    );

    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toEqual({
      workItems: [
        {
          workItem: firstRes.body.workItem,
          events: firstRes.body.events,
        },
        {
          workItem: secondRes.body.workItem,
          events: secondRes.body.events,
        },
      ],
    });
  });

  it("GET /api/work-items?ids rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `ZZZ-${index + 1}`);
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?ids=${ids.join(",")}`), cap.res, ctx);

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/ids.*at most 100/i);
  });

  it("GET /api/work-items?ids has the same identified-caller auth guard as the single-detail route", async () => {
    const item = store.createWorkItem({ title: "batch detail auth parity" });
    const unauthenticatedHeaders = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE };

    const single = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items/${item.id}`, undefined, unauthenticatedHeaders),
      single.res,
      ctx,
    );
    const batch = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items?ids=${item.id}`, undefined, unauthenticatedHeaders),
      batch.res,
      ctx,
    );

    expect(single.status).toBe(403);
    expect(batch.status).toBe(single.status);
    expect(batch.body).toEqual(single.body);
  });

  it("filters by createdBy/parent/root/rootsOnly and compact rows carry the five v2 fields", async () => {
    const root = store.createWorkItem({ title: "filter fixture root v2", createdBy: "operator" });
    const child = store.createWorkItem({ title: "filter fixture child v2", parentId: root.id, createdBy: "a-lead" });

    const roots = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?rootsOnly=true&createdBy=operator&q=filter+fixture"),
      roots.res,
      ctx,
    );
    expect(roots.status).toBe(200);
    expect(roots.body.workItems.map((w: { id: string }) => w.id)).toContain(root.id);
    for (const row of roots.body.workItems) {
      expect(row.parentId).toBeNull();
      expect(row).toHaveProperty("createdBy");
      expect(row).toHaveProperty("rootId");
      expect(row).toHaveProperty("depth");
      expect(row).toHaveProperty("dueAt");
    }

    const children = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?parent=${root.id}`), children.res, ctx);
    expect(children.status).toBe(200);
    expect(children.body.workItems.map((w: { id: string }) => w.id)).toEqual([child.id]);

    const family = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?root=${root.id}`), family.res, ctx);
    expect(family.status).toBe(200);
    expect(family.body.workItems.map((w: { id: string }) => w.id).sort()).toEqual([root.id, child.id].sort());

    const badParent = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?parent=garbage"), badParent.res, ctx);
    expect(badParent.status).toBe(400);
    expect(badParent.body.error).toMatch(/parent must be a Todo ID/);
  });

  it("operator archive with cascade cancels open descendants; without it the gate refuses", async () => {
    const parent = store.createWorkItem({ title: "cascade route parent" });
    const mid = store.createWorkItem({ title: "cascade route mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "cascade route leaf", parentId: mid.id });

    const refused = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/archive`, {}, operatorHeaders),
      refused.res,
      ctx,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(store.getWorkItem(parent.id)!.status).not.toBe("cancelled");

    const cascaded = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/archive`, { cascade: true }, operatorHeaders),
      cascaded.res,
      ctx,
    );
    expect(cascaded.status).toBe(200);
    expect(cascaded.body.workItem.status).toBe("cancelled");
    expect(store.getWorkItem(mid.id)!.status).toBe("cancelled");
    expect(store.getWorkItem(leaf.id)!.status).toBe("cancelled");
  });
});

describe("Todos v2 slice 2 — comment routes", () => {
  const operatorHeaders = { authorization: "Bearer test-token" };

  function toolHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  it("POST stamps author/authorKind server-side for operator, employee-session, and bare-session callers", async () => {
    const item = store.createWorkItem({ title: "comment stamp item" });

    const operator = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "operator says" }, operatorHeaders),
      operator.res,
      ctx,
    );
    expect(operator.status).toBe(201);
    expect(operator.body.comment).toMatchObject({
      workItemId: item.id,
      parentCommentId: null,
      author: "operator",
      authorKind: "operator",
      body: "operator says",
    });

    const employeeSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-emp", employee: "platform-worker" });
    const employee = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "employee says" }, toolHeaders(employeeSession.id)),
      employee.res,
      ctx,
    );
    expect(employee.status).toBe(201);
    expect(employee.body.comment).toMatchObject({ author: "platform-worker", authorKind: "employee" });

    const bareSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-bare" });
    const bare = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "bare session says" }, toolHeaders(bareSession.id)),
      bare.res,
      ctx,
    );
    expect(bare.status).toBe(201);
    expect(bare.body.comment).toMatchObject({ author: `session:${bareSession.id}`, authorKind: "employee" });
  });

  it("POST rejects body-supplied author fields and unauthenticated callers", async () => {
    const item = store.createWorkItem({ title: "comment reject item" });

    for (const bad of [{ body: "x", author: "operator" }, { body: "x", authorKind: "operator" }]) {
      const res = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, bad, operatorHeaders), res.res, ctx);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author/i);
    }

    const anonymous = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "anon" }), anonymous.res, ctx);
    expect(anonymous.status).toBe(403);

    const missingBody = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "   " }, operatorHeaders), missingBody.res, ctx);
    expect(missingBody.status).toBe(400);
    expect(missingBody.body.error).toMatch(/body/i);
  });

  it("POST enforces the 64 KiB byte cap with 413", async () => {
    const item = store.createWorkItem({ title: "comment cap item" });
    const raw = `{"body":"${"a".repeat(64 * 1024)}"}`;
    const res = makeRes();
    await api.handleApiRequest(
      makeRawReq("POST", `/api/work-items/${item.id}/comments`, raw, operatorHeaders),
      res.res,
      ctx,
    );
    expect(res.status).toBe(413);
  });

  it("POST threads single-level: replying to a reply re-parents to the thread root; 404s on unknown todo/parent", async () => {
    const item = store.createWorkItem({ title: "comment thread item" });
    const rootRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "thread root" }, operatorHeaders),
      rootRes.res,
      ctx,
    );
    const root = rootRes.body.comment;

    const replyRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "reply", parentCommentId: root.id }, operatorHeaders),
      replyRes.res,
      ctx,
    );
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.comment.parentCommentId).toBe(root.id);

    const deepRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "deep", parentCommentId: replyRes.body.comment.id }, operatorHeaders),
      deepRes.res,
      ctx,
    );
    expect(deepRes.status).toBe(201);
    expect(deepRes.body.comment.parentCommentId).toBe(root.id);

    const missingTodo = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items/ZZZ-424242/comments", { body: "?" }, operatorHeaders), missingTodo.res, ctx);
    expect(missingTodo.status).toBe(404);

    const missingParent = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "?", parentCommentId: "wic_000000000000" }, operatorHeaders),
      missingParent.res,
      ctx,
    );
    expect(missingParent.status).toBe(404);
  });

  it("GET lists chronologically with limit/offset and 404s on an unknown todo (no :id collision)", async () => {
    const item = store.createWorkItem({ title: "comment list item" });
    for (let i = 1; i <= 3; i++) {
      const res = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: `c${i}` }, operatorHeaders), res.res, ctx);
      expect(res.status).toBe(201);
    }

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}/comments`), list.res, ctx);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    expect(list.body.comments.map((c: { body: string }) => c.body)).toEqual(["c1", "c2", "c3"]);
    expect(list.body).toHaveProperty("limit");
    expect(list.body).toHaveProperty("offset");

    const page = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}/comments?limit=1&offset=1`), page.res, ctx);
    expect(page.status).toBe(200);
    expect(page.body.comments.map((c: { body: string }) => c.body)).toEqual(["c2"]);
    expect(page.body.total).toBe(3);

    const missing = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ZZZ-424242/comments"), missing.res, ctx);
    expect(missing.status).toBe(404);
  });

  it("the Todo detail payload carries the comments tail additively", async () => {
    const item = store.createWorkItem({ title: "comment tail item" });
    const posted = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "tail me" }, operatorHeaders), posted.res, ctx);
    expect(posted.status).toBe(201);

    const detail = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), detail.res, ctx);
    expect(detail.status).toBe(200);
    expect(detail.body.workItem.id).toBe(item.id);
    expect(detail.body).toHaveProperty("spendUsd");
    expect(detail.body).toHaveProperty("events");
    expect(detail.body.comments.total).toBe(1);
    expect(detail.body.comments.comments[0].body).toBe("tail me");
  });

  it("PATCH/DELETE enforce author-or-operator authority and tombstone semantics", async () => {
    const item = store.createWorkItem({ title: "comment authz item" });
    const authorSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-author", employee: "platform-worker" });
    const strangerSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-stranger" });

    const posted = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "original" }, toolHeaders(authorSession.id)),
      posted.res,
      ctx,
    );
    const comment = posted.body.comment;

    // A different (bare) session may not edit or delete someone else's comment.
    const strangerEdit = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "hijack" }, toolHeaders(strangerSession.id)),
      strangerEdit.res,
      ctx,
    );
    expect(strangerEdit.status).toBe(403);
    const strangerDelete = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${comment.id}`, undefined, toolHeaders(strangerSession.id)),
      strangerDelete.res,
      ctx,
    );
    expect(strangerDelete.status).toBe(403);

    // The author (same employee identity, any of their sessions) may edit.
    const authorSession2 = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-author-2", employee: "platform-worker" });
    const authorEdit = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "refined" }, toolHeaders(authorSession2.id)),
      authorEdit.res,
      ctx,
    );
    expect(authorEdit.status).toBe(200);
    expect(authorEdit.body.comment.body).toBe("refined");
    expect(authorEdit.body.comment.editedAt).not.toBeNull();

    // The operator may delete any comment; the tombstone keeps the row.
    const operatorDelete = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${comment.id}`, undefined, operatorHeaders),
      operatorDelete.res,
      ctx,
    );
    expect(operatorDelete.status).toBe(200);
    expect(operatorDelete.body.comment.body).toBe("");
    expect(operatorDelete.body.comment.deletedAt).not.toBeNull();

    // Editing a tombstone is refused.
    const editDeleted = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "resurrect" }, operatorHeaders),
      editDeleted.res,
      ctx,
    );
    expect(editDeleted.status).toBe(409);

    // Unknown comment id → 404.
    const missing = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/wic_000000000000`, { body: "?" }, operatorHeaders),
      missing.res,
      ctx,
    );
    expect(missing.status).toBe(404);
  });
});

describe("PUT /api/work-items/:id/status — the operator human-surface lane (Todos v2 slice 6)", () => {
  /* The board's design contract (design-doc §5/§6) requires the human-only
   * edges transitions.ts already supports: reopening closed work, unblocking,
   * routing escalated items. The operator PUT lane carries human authority —
   * it passes human:true, accepts every declared status target, and treats the
   * blocked/escalated note as asked-for-after (optional) rather than demanded
   * up front. The agent POST lane is UNCHANGED: allowlisted targets, note
   * required, sticky terminals locked. */
  const operatorHeaders = { authorization: "Bearer test-token" };

  function toolHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  it.each(["done", "cancelled"] as const)("reopens %s → backlog via PUT (drag-to-Backlog reopen)", async (status) => {
    const item = store.createWorkItem({ title: `Reopen ${status}`, status });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "backlog" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe("backlog");
    expect(cap.body.workItem.closedAt).toBeNull();
  });

  it.each(["backlog", "assigned", "in_review"] as const)("routes an escalated item to %s via PUT", async (target) => {
    const item = store.createWorkItem({ title: `Escalated route ${target}`, status: "escalated" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe(target);
  });

  it.each(["backlog", "assigned"] as const)("unblocks blocked → %s via PUT", async (target) => {
    const item = store.createWorkItem({ title: `Unblock to ${target}`, status: "blocked" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe(target);
  });

  it("accepts an operator PUT into blocked WITHOUT a note (the reason is asked for in the banner after)", async () => {
    const item = store.createWorkItem({ title: "Block without note", status: "executing" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "blocked" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe("blocked");
  });

  it("still records the note when the operator PUT provides one", async () => {
    const item = store.createWorkItem({ title: "Block with note", status: "executing" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "escalated", note: "needs owner call" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "escalated",
      detail: { note: "needs owner call" },
    });
  });

  it("still refuses an operator PUT along a truly illegal edge (executing → backlog)", async () => {
    const item = store.createWorkItem({ title: "Illegal edge", status: "executing" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "backlog" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/illegal transition executing → backlog/);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
  });

  it("rejects an unknown status on the operator PUT lane with the full status list", async () => {
    const item = store.createWorkItem({ title: "Garbage target", status: "backlog" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "paused" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/status must be one of/);
    expect(cap.body.error).toContain("backlog");
  });

  it("keeps the agent POST lane bounded: backlog is settable, note still required, sticky exits locked", async () => {
    const caller = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "agent-lane-pin",
      employee: "platform-worker",
    });

    // "Not now" is a legitimate agent move: a picked-up Todo goes back down.
    const owned = store.createWorkItem({ title: "Agent backlog allowed", status: "assigned", assignee: "platform-worker" });
    const backlog = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "backlog" }, toolHeaders(caller.id)),
      backlog.res,
      ctx,
    );
    expect(backlog.status).toBe(200);
    expect(store.getWorkItem(owned.id)?.status).toBe("backlog");

    // …but cancelled is still not an agent target at all.
    const cancel = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "cancelled" }, toolHeaders(caller.id)),
      cancel.res,
      ctx,
    );
    expect(cancel.status).toBe(403);
    expect(cancel.body.error).toMatch(/human surface decision/);

    // Note still demanded from agents entering blocked/escalated.
    const noteLess = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "blocked" }, toolHeaders(caller.id)),
      noteLess.res,
      ctx,
    );
    expect(noteLess.status).toBe(400);
    expect(noteLess.body.error).toMatch(/note is required/);

    // Sticky terminals still locked to agents (human-required refusal).
    const sticky = store.createWorkItem({ title: "Agent sticky locked", status: "done", assignee: "platform-worker" });
    const exitTry = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${sticky.id}/status`, { status: "in_review" }, toolHeaders(caller.id)),
      exitTry.res,
      ctx,
    );
    expect(exitTry.status).toBe(403);
    expect(exitTry.body.error).toMatch(/human decision/);
    expect(store.getWorkItem(sticky.id)?.status).toBe("done");
  });
});

/* Status is the one Todo write open to every authenticated session: the
 * relationship graph that used to gate it (creator / assignee / assignee's
 * manager / bound workflow run) is gone, and only `done` and `cancelled` stay
 * closed. */
describe("POST /api/work-items/:id/status — open to any authenticated session", () => {
  const operatorHeaders = { authorization: "Bearer test-token" };

  function toolHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  /** No relation to the Todo under test: not its creator, assignee, assignee's
   *  manager, linked execution attempt, or the run of any workflow. */
  function strangerSession(sourceRef: string) {
    return reg.createSession({ engine: "codex", source: "web", sourceRef, employee: "solo-worker" });
  }

  async function post(itemId: string, body: unknown, headers: Record<string, string>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${itemId}/status`, body, headers), cap.res, ctx);
    return cap;
  }

  it.each(["executing", "in_review", "blocked", "escalated"] as const)(
    "lets an unrelated employee session move a Todo it has no relationship to into %s",
    async (target) => {
      const item = store.createWorkItem({ title: `Stranger reports ${target}`, status: "assigned", assignee: "platform-worker" });
      const cap = await post(item.id, { status: target, note: "reporting from elsewhere" }, toolHeaders(strangerSession(`open-status-${target}`).id));

      expect([cap.status, cap.body.workItem?.status]).toEqual([200, target]);
    },
  );

  // The edge map used to govern this lane too, so the agent that unstuck a
  // blocked Todo could not put it back to work, and `assigned` had no agent
  // lane at all. Within the target allowlist the graph now stops applying.
  it.each([
    ["blocked", "executing"],
    ["in_review", "executing"],
    ["executing", "assigned"],
    ["in_review", "assigned"],
  ] as const)("moves a Todo %s → %s off the declared edges", async (from, target) => {
    const item = store.createWorkItem({ title: `Free ${from} to ${target}`, status: from, assignee: "platform-worker" });
    const cap = await post(item.id, { status: target }, toolHeaders(strangerSession(`free-${from}-${target}`).id));

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, target]);
  });

  it("lets an unrelated session close an in-review Todo, while cancelled stays operator-only", async () => {
    const item = store.createWorkItem({ title: "Stranger can review", status: "in_review", assignee: "platform-worker" });
    const session = strangerSession("open-status-closed-targets");

    const done = await post(item.id, { status: "done" }, toolHeaders(session.id));
    expect([done.status, done.body.workItem?.status]).toEqual([200, "done"]);

    const live = store.createWorkItem({ title: "Stranger cannot cancel", status: "assigned", assignee: "platform-worker" });
    const cancelled = await post(live.id, { status: "cancelled" }, toolHeaders(session.id));
    expect(cancelled.status).toBe(403);
    expect(cancelled.body.error).toMatch(/human surface decision/i);
    expect(store.getWorkItem(live.id)?.status).toBe("assigned");
  });

  it("keeps the self-review ban for a linked execution attempt but excludes a linked workflow phase", async () => {
    const reviewer = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-reviewer" });
    const executor = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-executor", parentSessionId: reviewer.id });
    const item = store.createWorkItem({
      title: "Self-review still banned",
      status: "executing",
      source: "delegation",
      sourceRef: `delegate:${reviewer.id}:open-status`,
    });
    store.linkSession(item.id, executor.id);

    const handed = await post(item.id, { status: "in_review" }, toolHeaders(executor.id));
    expect(handed.status).toBe(200);

    const selfClose = await post(item.id, { status: "done" }, toolHeaders(executor.id));
    expect(selfClose.status).toBe(403);
    expect(selfClose.body.error).toMatch(/self-review ban/i);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    const phase = reg.createSession({
      engine: "codex",
      source: "workflow",
      sourceRef: "workflow:review-flow:run-1:verify:1",
      workflowProvenance: {
        kind: "phase",
        workflowId: "review-flow",
        workflowName: "Review flow",
        runId: "run-1",
        triggerSource: "todo-status",
        phase: { nodeId: "verify", name: "Verify", index: 2, round: 1, attempt: 1 },
      },
    });
    const phaseItem = store.createWorkItem({ title: "Workflow phase reviews", status: "in_review" });
    store.linkSession(phaseItem.id, phase.id);

    const phaseClose = await post(phaseItem.id, { status: "done" }, toolHeaders(phase.id));
    expect([phaseClose.status, store.getWorkItem(phaseItem.id)?.status]).toEqual([200, "done"]);
  });

  it.each(["backlog", "assigned", "executing", "blocked"] as const)(
    "still refuses an unrelated session done from %s",
    async (status) => {
      const item = store.createWorkItem({ title: `No done shortcut from ${status}`, status });
      const session = strangerSession(`done-precondition-${status}`);

      const done = await post(item.id, { status: "done" }, toolHeaders(session.id));

      expect(done.status).toBe(403);
      expect(done.body.error).toMatch(/done is not an agent shortcut/i);
      expect(store.getWorkItem(item.id)?.status).toBe(status);
    },
  );

  it("leaves the operator lanes unaffected: POST done closes, PUT cancels", async () => {
    const reviewed = store.createWorkItem({ title: "Operator closes", status: "in_review" });
    const done = await post(reviewed.id, { status: "done" }, operatorHeaders);
    expect([done.status, done.body.workItem.status]).toEqual([200, "done"]);

    const live = store.createWorkItem({ title: "Operator cancels", status: "assigned" });
    const cancelled = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${live.id}/status`, { status: "cancelled" }, operatorHeaders),
      cancelled.res,
      ctx,
    );
    expect([cancelled.status, cancelled.body.workItem.status]).toEqual([200, "cancelled"]);
  });
});

describe("ICI-570 — comment writes emit company:changed for the parent Todo", () => {
  const operatorHeaders = { authorization: "Bearer test-token" };

  it("POST, PATCH, and DELETE each emit one entity=todo event", async () => {
    const item = store.createWorkItem({ title: "live comment item" });

    emittedEvents.length = 0;
    const posted = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "hello" }, operatorHeaders),
      posted.res,
      ctx,
    );
    expect(posted.status).toBe(201);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "commented", id: item.id }),
    }));

    const commentId = posted.body.comment.id;
    emittedEvents.length = 0;
    const edited = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${commentId}`, { body: "hello again" }, operatorHeaders),
      edited.res,
      ctx,
    );
    expect(edited.status).toBe(200);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "comment-edited", id: item.id }),
    }));

    emittedEvents.length = 0;
    const removed = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${commentId}`, undefined, operatorHeaders),
      removed.res,
      ctx,
    );
    expect(removed.status).toBe(200);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "comment-deleted", id: item.id }),
    }));
  });

  it("a refused comment write emits nothing", async () => {
    const item = store.createWorkItem({ title: "no event on refusal" });
    emittedEvents.length = 0;
    const refused = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "   " }, operatorHeaders),
      refused.res,
      ctx,
    );
    expect(refused.status).toBe(400);
    expect(emittedEvents).toEqual([]);
  });
});
