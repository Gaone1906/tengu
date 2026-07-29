import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * Route-level tests for Todos v2 slice 3: relation link/unlink, the label
 * registry + replace-set surface, and the list-payload wire data (labels +
 * blocked). Drives handleApiRequest directly against a throwaway JINN_HOME.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-rel-route-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
// platform-lead manages platform-worker → platform-lead IS a manager;
// platform-worker and solo-worker have no reports.
fs.writeFileSync(
  path.join(tmp, "org", "platform-lead.yaml"),
  "name: platform-lead\ndisplayName: Platform Lead\ndepartment: platform\nrank: senior\nengine: codex\nmodel: default\npersona: Route-test manager.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\nreportsTo: platform-lead\npersona: Route-test worker.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Route-test loner.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;
let db: import("better-sqlite3").Database;

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
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

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

const operatorHeaders = { authorization: "Bearer test-token" };

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), cap.res, ctx);
  return cap;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  db = reg.initDb();
});

describe("POST/DELETE /api/work-items/:id/relations", () => {
  it("links two Todos with server-stamped createdBy and returns 201", async () => {
    const a = store.createWorkItem({ title: "rel route a" });
    const b = store.createWorkItem({ title: "rel route b" });
    const cap = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "blocks" }, operatorHeaders);
    expect(cap.status).toBe(201);
    expect(cap.body.relation).toMatchObject({ srcId: a.id, dstId: b.id, kind: "blocks", createdBy: "operator" });
  });

  it("refuses a cycle with the path in the message, unknown dst with 404, bad kind with 400", async () => {
    const a = store.createWorkItem({ title: "cycle route a" });
    const b = store.createWorkItem({ title: "cycle route b" });
    await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "blocks" }, operatorHeaders);

    const cycle = await call("POST", `/api/work-items/${b.id}/relations`, { dstId: a.id, kind: "blocks" }, operatorHeaders);
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toBe(`${b.id} blocks ${a.id} would create a cycle: ${b.id} → ${a.id} → ${b.id}`);

    const missing = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: "ZZZ-424242", kind: "blocks" }, operatorHeaders);
    expect(missing.status).toBe(404);

    const badKind = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "meta" }, operatorHeaders);
    expect(badKind.status).toBe(400);

    const self = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: a.id, kind: "relates" }, operatorHeaders);
    expect(self.status).toBe(400);

    const anonymous = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "relates" }, { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE });
    expect(anonymous.status).toBe(403);
  });

  it("removes only for the relation creator or the operator", async () => {
    const a = store.createWorkItem({ title: "auth route a" });
    const b = store.createWorkItem({ title: "auth route b" });
    const creator = reg.createSession({ engine: "codex", source: "web", sourceRef: "rel-creator", employee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "rel-stranger", employee: "solo-worker" });

    const created = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "duplicates" }, toolHeaders(creator.id));
    expect(created.status).toBe(201);
    expect(created.body.relation.createdBy).toBe(`session:${creator.id}`);

    const denied = await call("DELETE", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "duplicates" }, toolHeaders(stranger.id));
    expect(denied.status).toBe(403);

    const removed = await call("DELETE", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "duplicates" }, toolHeaders(creator.id));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });

    const absent = await call("DELETE", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "duplicates" }, operatorHeaders);
    expect(absent.status).toBe(404);
  });

  it("shows both-direction relation views in the Todo detail payload", async () => {
    const hub = store.createWorkItem({ title: "detail hub" });
    const outward = store.createWorkItem({ title: "detail out" });
    const inward = store.createWorkItem({ title: "detail in" });
    await call("POST", `/api/work-items/${hub.id}/relations`, { dstId: outward.id, kind: "blocks" }, operatorHeaders);
    await call("POST", `/api/work-items/${inward.id}/relations`, { dstId: hub.id, kind: "blocks" }, operatorHeaders);

    const detail = await call("GET", `/api/work-items/${hub.id}`);
    expect(detail.status).toBe(200);
    const relations = detail.body.relations as Array<{ kind: string; direction: string; other: { id: string } }>;
    expect(relations).toHaveLength(2);
    expect(relations.find((r) => r.direction === "out")?.other.id).toBe(outward.id);
    expect(relations.find((r) => r.direction === "in")?.other.id).toBe(inward.id);
  });
});

describe("label registry routes", () => {
  it("creates labels as operator or manager, refuses non-managers, normalizes names", async () => {
    const created = await call("POST", "/api/labels", { name: "Route Label", color: "#112233" }, operatorHeaders);
    expect(created.status).toBe(201);
    expect(created.body.label).toMatchObject({ name: "route-label", color: "#112233", department: null });

    const managerSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "lbl-mgr", employee: "platform-lead" });
    const byManager = await call("POST", "/api/labels", { name: "team-label", department: "platform" }, toolHeaders(managerSession.id));
    expect(byManager.status).toBe(201);
    expect(byManager.body.label.department).toBe("platform");

    const icSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "lbl-ic", employee: "platform-worker" });
    const denied = await call("POST", "/api/labels", { name: "sneaky" }, toolHeaders(icSession.id));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("manager");

    const badColor = await call("POST", "/api/labels", { name: "bad", color: "red" }, operatorHeaders);
    expect(badColor.status).toBe(400);

    const listed = await call("GET", "/api/labels");
    expect(listed.status).toBe(200);
    const names = (listed.body.labels as Array<{ name: string }>).map((l) => l.name);
    expect(names).toContain("route-label");
    expect(names).toContain("team-label");
    expect(names).not.toContain("sneaky");
  });

  it("replaces a Todo's label set under operator/creator/assignee authority only", async () => {
    await call("POST", "/api/labels", { name: "wire-bug" }, operatorHeaders);
    await call("POST", "/api/labels", { name: "wire-perf" }, operatorHeaders);

    const assignee = reg.createSession({ engine: "codex", source: "web", sourceRef: "lbl-assignee", employee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "lbl-stranger", employee: "solo-worker" });
    const item = store.createWorkItem({ title: "labelled over http", assignee: "platform-worker" });

    const put = await call("PUT", `/api/work-items/${item.id}/labels`, { labels: ["wire-bug", "wire-perf"] }, operatorHeaders);
    expect(put.status).toBe(200);
    expect((put.body.labels as Array<{ name: string }>).map((l) => l.name)).toEqual(["wire-bug", "wire-perf"]);

    const byAssignee = await call("PUT", `/api/work-items/${item.id}/labels`, { labels: ["wire-bug"] }, toolHeaders(assignee.id));
    expect(byAssignee.status).toBe(200);

    const denied = await call("PUT", `/api/work-items/${item.id}/labels`, { labels: [] }, toolHeaders(stranger.id));
    expect(denied.status).toBe(403);

    // A session-created Todo is editable by its creator session.
    const creatorSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "lbl-creator", employee: "solo-worker" });
    const own = await call("POST", "/api/work-items", { title: "creator labelled" }, toolHeaders(creatorSession.id));
    expect(own.status).toBe(201);
    const ownPut = await call("PUT", `/api/work-items/${own.body.workItem.id}/labels`, { labels: ["wire-bug"] }, toolHeaders(creatorSession.id));
    expect(ownPut.status).toBe(200);

    const unknown = await call("PUT", `/api/work-items/${item.id}/labels`, { labels: ["never-registered"] }, operatorHeaders);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("valid labels");

    const missing = await call("PUT", "/api/work-items/ZZZ-424242/labels", { labels: [] }, operatorHeaders);
    expect(missing.status).toBe(404);
  });

  it("tags a Todo at creation with existing labels only, rolling the create back on an unknown one", async () => {
    await call("POST", "/api/labels", { name: "birth-tag" }, operatorHeaders);

    const created = await call("POST", "/api/work-items", { title: "born tagged", labels: ["Birth Tag"] }, operatorHeaders);
    expect(created.status).toBe(201);
    expect((created.body.labels as Array<{ name: string }>).map((l) => l.name)).toEqual(["birth-tag"]);
    const detail = await call("GET", `/api/work-items/${created.body.workItem.id}`);
    expect((detail.body.labels as Array<{ name: string }>).map((l) => l.name)).toEqual(["birth-tag"]);

    // An unknown label fails the whole request: no implicit label, no orphan Todo.
    const rejected = await call("POST", "/api/work-items", { title: "born untaggable", labels: ["ghost-tag"] }, operatorHeaders);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("valid labels");
    const names = ((await call("GET", "/api/labels")).body.labels as Array<{ name: string }>).map((l) => l.name);
    expect(names).not.toContain("ghost-tag");
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE title = ?").get("born untaggable")).toEqual({ n: 0 });

    const blank = await call("POST", "/api/work-items", { title: "bad labels", labels: ["  "] }, operatorHeaders);
    expect(blank.status).toBe(400);
    expect(blank.body.error).toContain("labels must be an array");
  });
});

describe("list wire data — labels, blocked flag, label filter", () => {
  it("serves label chips and a live blocked flag from batched queries, and filters by label", async () => {
    await call("POST", "/api/labels", { name: "wire-filter" }, operatorHeaders);
    const blocker = store.createWorkItem({ title: "wire blocker", department: "wire-fixture" });
    const blocked = store.createWorkItem({ title: "wire blocked", department: "wire-fixture" });
    const plain = store.createWorkItem({ title: "wire plain", department: "wire-fixture" });
    await call("POST", `/api/work-items/${blocker.id}/relations`, { dstId: blocked.id, kind: "blocks" }, operatorHeaders);
    await call("PUT", `/api/work-items/${blocked.id}/labels`, { labels: ["wire-filter"] }, operatorHeaders);

    // The page's relation + label wire data must come from the two batch
    // functions — ONE prepared query each per page, not one per row (N+1 guard).
    const prepared: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      prepared.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;
    let page: Awaited<ReturnType<typeof call>>;
    try {
      page = await call("GET", "/api/work-items?department=wire-fixture");
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
    expect(page.status).toBe(200);
    expect(prepared.filter((sql) => sql.includes("work_item_relations")).length).toBe(1);
    expect(prepared.filter((sql) => sql.includes("work_item_labels")).length).toBe(1);

    const items = page.body.workItems as Array<{ id: string; blocked: boolean; labels: Array<{ name: string }> }>;
    const blockedRow = items.find((i) => i.id === blocked.id)!;
    expect(blockedRow.blocked).toBe(true);
    expect(blockedRow.labels.map((l) => l.name)).toEqual(["wire-filter"]);
    expect(items.find((i) => i.id === blocker.id)!.blocked).toBe(false);
    expect(items.find((i) => i.id === plain.id)!.labels).toEqual([]);

    // The blocked flag clears when the blocker closes.
    await call("POST", `/api/work-items/${blocker.id}/status`, { status: "done" }, operatorHeaders);
    const after = await call("GET", "/api/work-items?department=wire-fixture");
    const afterItems = after.body.workItems as Array<{ id: string; blocked: boolean }>;
    expect(afterItems.find((i) => i.id === blocked.id)!.blocked).toBe(false);

    // Label filter, by name and by id.
    const byName = await call("GET", "/api/work-items?label=wire-filter");
    expect((byName.body.workItems as Array<{ id: string }>).map((i) => i.id)).toEqual([blocked.id]);
    const labelId = ((await call("GET", "/api/labels")).body.labels as Array<{ id: string; name: string }>).find(
      (l) => l.name === "wire-filter",
    )!.id;
    const byId = await call("GET", `/api/work-items?label=${labelId}`);
    expect((byId.body.workItems as Array<{ id: string }>).map((i) => i.id)).toEqual([blocked.id]);

    const badLabel = await call("GET", "/api/work-items?label=!!!");
    expect(badLabel.status).toBe(400);
  });
});

describe("ICI-570 — relation and label writes emit company:changed", () => {
  it("linking emits one entity=todo event per endpoint; unlinking too", async () => {
    const a = store.createWorkItem({ title: "live rel a" });
    const b = store.createWorkItem({ title: "live rel b" });

    emittedEvents.length = 0;
    const linked = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "relates" }, operatorHeaders);
    expect(linked.status).toBe(201);
    for (const id of [a.id, b.id]) {
      expect(emittedEvents).toContainEqual(expect.objectContaining({
        event: "company:changed",
        payload: expect.objectContaining({ entity: "todo", action: "relation-added", id }),
      }));
    }

    emittedEvents.length = 0;
    const unlinked = await call("DELETE", `/api/work-items/${a.id}/relations`, { dstId: b.id, kind: "relates" }, operatorHeaders);
    expect(unlinked.status).toBe(200);
    for (const id of [a.id, b.id]) {
      expect(emittedEvents).toContainEqual(expect.objectContaining({
        event: "company:changed",
        payload: expect.objectContaining({ entity: "todo", action: "relation-removed", id }),
      }));
    }
  });

  it("replacing the label set emits one entity=todo event with the bumped version", async () => {
    const item = store.createWorkItem({ title: "live label item" });
    const created = await call("POST", "/api/labels", { name: `live-label-${Date.now()}` }, operatorHeaders);
    expect(created.status).toBe(201);

    emittedEvents.length = 0;
    const put = await call("PUT", `/api/work-items/${item.id}/labels`, { labels: [created.body.label.id] }, operatorHeaders);
    expect(put.status).toBe(200);
    const event = emittedEvents.find((entry) =>
      entry.event === "company:changed" && entry.payload.action === "labels-updated" && entry.payload.id === item.id,
    );
    expect(event).toBeDefined();
    expect(event?.payload.version).toBe(store.getWorkItem(item.id)!.version);
  });

  it("a refused relation write emits nothing", async () => {
    const a = store.createWorkItem({ title: "no event rel" });
    emittedEvents.length = 0;
    const refused = await call("POST", `/api/work-items/${a.id}/relations`, { dstId: a.id, kind: "nonsense" }, operatorHeaders);
    expect(refused.status).toBe(400);
    expect(emittedEvents).toEqual([]);
  });
});
