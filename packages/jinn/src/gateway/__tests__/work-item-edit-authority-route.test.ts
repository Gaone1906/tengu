import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * PATCH /api/work-items/:id splits on content versus ownership: title, body,
 * acceptance, priority and dueAt are open to every authenticated session (like
 * status), while assignee, department, rank and verifyPolicy stay operator-only.
 * Same expectedVersion/idempotencyKey contract throughout.
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
  (await import("../../shared/db.js")).initDb();
});

describe("PATCH /api/work-items/:id — content is open, ownership is the operator's", () => {
  it("operator edits every field, content and ownership alike", async () => {
    const item = store.createWorkItem({ title: "op all fields" });
    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      title: "op edited",
      body: "op body",
      acceptance: "op acceptance",
      priority: 1,
      rank: 5,
      dueAt: "2026-08-01",
      verifyPolicy: { mode: "verify" },
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

  it("the assignee edits every content field and the audit names the employee", async () => {
    const item = store.createWorkItem({ title: "assignee editable", assignee: "platform-worker" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-assignee", employee: "platform-worker" });
    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      title: "refined title",
      body: "refined by the assignee",
      acceptance: "criteria v2",
      priority: 0,
      dueAt: "2026-08-15T12:00:00Z",
    }), toolHeaders(session.id));
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      title: "refined title",
      body: "refined by the assignee",
      acceptance: "criteria v2",
      priority: 0,
      dueAt: "2026-08-15T12:00:00.000Z",
    });
    const events = store.listWorkItemEvents(item.id);
    const edit = events.filter((e) => e.kind === "metadata_edited").at(-1)!;
    expect(edit.actor).toBe("platform-worker");
    expect((edit.detail!.updatedFields as string[]).sort()).toEqual(["acceptance", "body", "dueAt", "priority", "title"]);
  });

  it("a session with NO relation to the Todo edits its content too — that is the point", async () => {
    const item = store.createWorkItem({ title: "stranger editable", assignee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-stranger", employee: "solo-worker" });

    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      title: "retitled by a stranger",
      body: "and re-bodied",
    }), toolHeaders(stranger.id));
    expect(cap.status).toBe(200);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "retitled by a stranger", body: "and re-bodied" });
  });

  it("an employee-less session edits content as well; an anonymous tool call still cannot", async () => {
    const item = store.createWorkItem({ title: "bare session" });
    const bare = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-bare" });

    const ok = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { body: "bare edit" }), toolHeaders(bare.id));
    expect(ok.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "metadata_edited").at(-1)!.actor).toBe(`session:${bare.id}`);

    const anonymous = await call("PATCH", `/api/work-items/${item.id}`, patchBody(ok.body.workItem.version, { body: "ghost" }), {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    });
    expect(anonymous.status).toBe(403);
    expect(store.getWorkItem(item.id)!.body).toBe("bare edit");
  });

  it("ownership stays the operator's: assignee, department, rank and verifyPolicy are refused BY NAME", async () => {
    const item = store.createWorkItem({ title: "ownership fenced", assignee: "platform-worker" });
    // The assignee's own manager is refused too — this is not a hierarchy rule.
    const manager = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-manager", employee: "platform-lead" });

    for (const patch of [{ assignee: null }, { department: "marketing" }, { rank: 1 }, { verifyPolicy: { mode: "verify" } }]) {
      const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, patch), toolHeaders(manager.id));
      expect(cap.status).toBe(403);
      expect(cap.body.error).toContain(`"${Object.keys(patch)[0]}"`);
      expect(cap.body.error).toContain("operator-only");
    }
    expect(store.getWorkItem(item.id)).toMatchObject({ assignee: "platform-worker", rank: null });
  });

  it("a workflow phase edits the Todo it runs for without any run/Todo binding to consult", async () => {
    const item = store.createWorkItem({ title: "pipeline status block" });
    const phase = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "wf-phase",
      employee: "solo-worker",
      workflowProvenance: {
        kind: "phase",
        workflowId: "build-pipeline",
        workflowName: "Build Pipeline",
        runId: "run-1",
        triggerSource: "todo-status",
        phase: { nodeId: "implement", name: "Implement", index: 1, round: 1, attempt: 1 },
      },
    });

    const cap = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, {
      body: "<!-- pipeline-status -->\nIMPLEMENT: done",
      acceptance: "gates green",
    }), toolHeaders(phase.id));

    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      body: "<!-- pipeline-status -->\nIMPLEMENT: done",
      acceptance: "gates green",
    });
  });

  it("expectedVersion conflicts and idempotency replay work through the open path", async () => {
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

  it("validates fields the same for a session as for the operator: bad dueAt 400, nulls clear", async () => {
    const item = store.createWorkItem({ title: "field validation", acceptance: "old", dueAt: "2026-08-01T00:00:00.000Z" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "edit-validation", employee: "solo-worker" });

    const bad = await call("PATCH", `/api/work-items/${item.id}`, patchBody(item.version, { dueAt: "next tuesday" }), toolHeaders(session.id));
    expect(bad.status).toBe(400);

    const cleared = await call(
      "PATCH",
      `/api/work-items/${item.id}`,
      patchBody(item.version, { acceptance: null, dueAt: null }),
      toolHeaders(session.id),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.workItem.acceptance).toBeNull();
    expect(cleared.body.workItem.dueAt).toBeNull();
  });
});
