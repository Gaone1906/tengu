import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * Todos v2 slice 4 — the widened PATCH /api/work-items/:id authority matrix
 * (spec §3.4): body/acceptance/priority/dueAt for operator, creator, assignee,
 * or the assignee's manager; title for operator/creator only; assignee,
 * department, and rank stay operator-only. Same expectedVersion/idempotencyKey
 * contract as before, now reachable by authorized non-operator callers.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-edit-auth-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
// platform-lead manages platform-worker; solo-worker is unrelated.
fs.writeFileSync(
  path.join(tmp, "org", "platform-lead.yaml"),
  "name: platform-lead\ndisplayName: Platform Lead\ndepartment: platform\nrank: senior\nengine: codex\nmodel: default\npersona: Edit-authority manager.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\nreportsTo: platform-lead\npersona: Edit-authority worker.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Edit-authority loner.\n",
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
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

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

function patchBody(expectedVersion: number, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { expectedVersion, ...patch, ...extra };
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  reg.initDb();
});

describe("PATCH /api/work-items/:id — widened edit authority (spec §3.4)", () => {
  it("operator edits every field including the new acceptance and dueAt", async () => {
    const item = store.createWorkItem({ title: "op all fields" });
    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      title: "op edited",
      body: "op body",
      acceptance: "op acceptance",
      priority: 1,
      rank: 5,
      dueAt: "2026-08-01",
    }), operatorHeaders);
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      title: "op edited",
      body: "op body",
      acceptance: "op acceptance",
      priority: 1,
      rank: 5,
      dueAt: "2026-08-01T00:00:00.000Z", // normalized like the create route
    });
  });

  it("assignee edits body/acceptance/priority/dueAt and the audit is a metadata_edited event with the employee actor", async () => {
    const item = store.createWorkItem({ title: "assignee editable", assignee: "platform-worker" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-assignee", employee: "platform-worker" });
    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      body: "refined by the assignee",
      acceptance: "criteria v2",
      priority: 0,
      dueAt: "2026-08-15T12:00:00Z",
    }), toolHeaders(session.id));
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      body: "refined by the assignee",
      acceptance: "criteria v2",
      priority: 0,
      dueAt: "2026-08-15T12:00:00.000Z",
    });
    const events = store.listWorkItemEvents(item.id);
    const edit = events.filter((e) => e.kind === "metadata_edited").at(-1)!;
    expect(edit.actor).toBe("platform-worker");
    expect((edit.detail!.updatedFields as string[]).sort()).toEqual(["acceptance", "body", "dueAt", "priority"]);
  });

  it("assignee gets a 403 NAMING the field for title and rank", async () => {
    const item = store.createWorkItem({ title: "assignee limits", assignee: "platform-worker" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-assignee-limits", employee: "platform-worker" });

    const title = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { title: "hijack" }), toolHeaders(session.id));
    expect(title.status).toBe(403);
    expect(title.body.error).toContain('"title"');

    const rank = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { rank: 1 }), toolHeaders(session.id));
    expect(rank.status).toBe(403);
    expect(rank.body.error).toContain('"rank"');

    const assignee = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { assignee: null }), toolHeaders(session.id));
    expect(assignee.status).toBe(403);
    expect(assignee.body.error).toContain('"assignee"');

    expect(store.getWorkItem(item.id)!.title).toBe("assignee limits");
  });

  it("the assignee's manager has the same field authority as the assignee", async () => {
    const item = store.createWorkItem({ title: "manager editable", assignee: "platform-worker" });
    const manager = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-manager", employee: "platform-lead" });

    const ok = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { body: "manager refinement" }), toolHeaders(manager.id));
    expect(ok.status).toBe(200);
    expect(ok.body.workItem.body).toBe("manager refinement");

    const title = await call("PATCH", `/api/work-items/${item.id}`, patchBody(ok.body.workItem.version, { title: "manager hijack" }), toolHeaders(manager.id));
    expect(title.status).toBe(403);
    expect(title.body.error).toContain('"title"');
  });

  it("the item creator (employee slug) may edit the title too", async () => {
    const item = store.createWorkItem({ title: "creator titled", createdBy: "platform-worker" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-creator-slug", employee: "platform-worker" });
    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { title: "creator retitled" }), toolHeaders(session.id));
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.title).toBe("creator retitled");
  });

  it("an employee session stamps its SLUG as creator, so a sibling session of the same employee holds creator authority too (slice-5 decision 7)", async () => {
    const creatorSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-creator-session", employee: "platform-worker" });
    const created = await call("POST", "/api/work-items", { title: "slug-created", assignee: "platform-worker" }, toolHeaders(creatorSession.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    const version = created.body.workItem.version as number;
    expect(created.body.workItem.createdBy).toBe("platform-worker");

    // the creating session may edit the title…
    const ok = await call("PATCH", `/api/work-items/${id}`, patchBody(version, { title: "creator session retitle" }), toolHeaders(creatorSession.id));
    expect(ok.status).toBe(200);

    // …and so may a DIFFERENT session of the same employee — the creator is the
    // employee (comments identity model), not one ephemeral session.
    const sibling = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-creator-sibling", employee: "platform-worker" });
    const siblingOk = await call(
      "PATCH",
      `/api/work-items/${id}`,
      patchBody(ok.body.workItem.version, { title: "sibling retitle" }),
      toolHeaders(sibling.id),
    );
    expect(siblingOk.status).toBe(200);
    expect(store.getWorkItem(id)!.title).toBe("sibling retitle");
  });

  it("a session:<uuid> creator (employee-less session) matches only that exact session", async () => {
    const creatorSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-creator-bare" });
    const created = await call("POST", "/api/work-items", { title: "bare-session-created" }, toolHeaders(creatorSession.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    const version = created.body.workItem.version as number;
    expect(created.body.workItem.createdBy).toBe(`session:${creatorSession.id}`);

    // the exact creator session may edit the title…
    const ok = await call("PATCH", `/api/work-items/${id}`, patchBody(version, { title: "bare creator retitle" }), toolHeaders(creatorSession.id));
    expect(ok.status).toBe(200);

    // …a DIFFERENT bare session is neither creator, assignee, nor manager.
    const other = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-creator-other-bare" });
    const denied = await call(
      "PATCH",
      `/api/work-items/${id}`,
      patchBody(ok.body.workItem.version, { title: "bare hijack" }),
      toolHeaders(other.id),
    );
    expect(denied.status).toBe(403);
    expect(store.getWorkItem(id)!.title).toBe("bare creator retitle");
  });

  it("an unrelated employee gets 403 outright; an anonymous tool call stays 403", async () => {
    const item = store.createWorkItem({ title: "stranger fenced", assignee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-stranger", employee: "solo-worker" });
    const denied = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { body: "sneaky" }), toolHeaders(stranger.id));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/creator|assignee|manager/i);
    expect(store.getWorkItem(item.id)!.body).toBeNull();

    const anonymous = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { body: "ghost" }), {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    });
    expect(anonymous.status).toBe(403);
  });

  it("expectedVersion conflicts and idempotency replay work through the widened path", async () => {
    const item = store.createWorkItem({ title: "cas widened", assignee: "platform-worker" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-cas", employee: "platform-worker" });

    const stale = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version + 7, { body: "stale" }), toolHeaders(session.id));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("todo_version_conflict");

    const first = await call(
      "PATCH",
      `/api/work-items/${item.id}`,
      patchBody(item.version, { body: "keyed edit" }, { idempotencyKey: "edit-auth-key-1" }),
      toolHeaders(session.id),
    );
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    const replay = await call(
      "PATCH",
      `/api/work-items/${item.id}`,
      patchBody(item.version, { body: "keyed edit" }, { idempotencyKey: "edit-auth-key-1" }),
      toolHeaders(session.id),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.workItem.version).toBe(first.body.workItem.version);
  });

  it("validates the new fields: bad dueAt 400, acceptance null clears, dueAt null clears", async () => {
    const item = store.createWorkItem({ title: "field validation", acceptance: "old", dueAt: "2026-08-01T00:00:00.000Z" });
    const bad = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { dueAt: "next tuesday" }), operatorHeaders);
    expect(bad.status).toBe(400);

    const cleared = await call(
      "PATCH",
      `/api/work-items/${item.id}`,
      patchBody(item.version, { acceptance: null, dueAt: null }),
      operatorHeaders,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.workItem.acceptance).toBeNull();
    expect(cleared.body.workItem.dueAt).toBeNull();
  });
});
