import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildTools } from "../server.js";
import { buildWorkItemTools, WORK_ITEM_SEARCH_LIMIT_MAX, WORK_ITEM_QUERY_CHAR_CAP } from "../work-item-tools.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-work-items-home-"));

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId: string | null = "session-test",
  sessionCapability = callerSessionId ? "cap-test" : undefined,
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    ctx: {
      gatewayUrl: "http://127.0.0.1:7777",
      fetchFn,
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(sessionCapability ? { sessionCapability } : {}),
    } satisfies JinnMcpContext,
  };
}

function tool(name: string): JinnMcpTool {
  const t = buildWorkItemTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("work-item tools — registry + schemas", () => {
  it("exposes the generic Todo verbs separately from COO approval verbs", () => {
    expect(buildWorkItemTools().map((t) => t.name)).toEqual([
      "list_work_items",
      "get_work_item",
      "search_work_items",
      "create_work_item",
      "update_work_item",
      "assign_work_item",
      "archive_work_item",
    ]);
    const names = buildTools().map((t) => t.name).sort();
    expect(names).toContain("create_work_item");
    expect(names).toContain("assign_work_item");
    expect(names).toContain("request_work_item_approval");
    expect(names).toContain("decide_work_item_approval");
    expect(names).toContain("escalate_work_item_approval");
    expect(names).toContain("archive_work_item");
    expect(names).toContain("delete_trigger");
    expect(names).toContain("cancel_workflow_run");
    expect(names.some((n) => /cancel/i.test(n) && /work_item/.test(n))).toBe(false);
    expect(names).toHaveLength(54);
  });

  it("positions list as recent/filter summaries and search as text/filter hits", () => {
    expect(tool("list_work_items").description).toMatch(/recent or filtered/i);
    expect(tool("list_work_items").description).toMatch(/compact summaries/i);
    expect(tool("search_work_items").description).toMatch(/by text/i);
    expect(tool("search_work_items").description).toMatch(/structured filters/i);
  });

  it("create schema has no approval fields and update schema allows manual start but excludes cancelled", () => {
    const createProps = tool("create_work_item").inputSchema.properties;
    expect(Object.keys(createProps).sort()).toEqual(
      ["acceptance", "assignee", "body", "department", "title", "verifyPolicy"].sort(),
    );
    expect(JSON.stringify(createProps)).not.toMatch(/approval/i);
    const status = tool("update_work_item").inputSchema.properties.status as { enum: string[] };
    expect(status.enum).toEqual(["executing", "in_review", "blocked", "escalated", "done"]);
    expect(status.enum).not.toContain("cancelled");
  });

  it("ships the generic Todo doctrine in the repo template CLAUDE.md", () => {
    const template = fs.readFileSync(path.join(process.cwd(), "template", "CLAUDE.md"), "utf-8");
    expect(template).toContain("Todos are the company's task ledger");
    expect(template).toContain("create_work_item");
    expect(template).toContain("Never mark your own item `done`");
    expect(template).not.toContain(["", "Users", ""].join("/"));
  });
});

describe("work-item tools — unit (stub gateway)", () => {
  it.each(["wi_0123456789ab", "JIN-0", "JIN-01", "JIN-9007199254740992", " JIN-1 "])(
    "rejects noncanonical Todo id %s before contacting the gateway",
    async (id) => {
      for (const name of ["get_work_item", "update_work_item", "assign_work_item", "archive_work_item"]) {
        const { calls, ctx } = stub(() => ({ status: 500, body: { error: "must not run" } }));
        const args = name === "update_work_item"
          ? { id, status: "executing" }
          : name === "assign_work_item"
            ? { id, assignee: "platform-worker" }
            : { id };
        await expect(tool(name).handler(args, ctx)).rejects.toThrow(/canonical Todo ID/i);
        expect(calls).toEqual([]);
      }
    },
  );

  it("preserves the route receipt at the MCP result root and points at the persisted chat receipt", async () => {
    const { ctx } = stub(() => ({
      status: 201,
      body: { workItem: { id: "JIN-101", title: "Receipt", status: "backlog" }, activityReceiptId: "todo:JIN-101" },
    }));
    const out = await tool("create_work_item").handler({ title: "Receipt" }, ctx) as Record<string, unknown>;
    expect(out.activityReceiptId).toBe("todo:JIN-101");
    expect(out.hint).toMatch(/Preview or Open the persisted activity receipt in this chat\./);
  });

  it("list passes status/source/assignee filters and returns compact summaries", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItems: [{ id: "JIN-1", title: "T", body: "MUST NOT LEAK", status: "blocked", source: "session", version: 7 }] } }));
    const out = (await tool("list_work_items").handler({ status: "blocked", source: "session", assignee: "qa", limit: 99 }, ctx)) as {
      workItems: Array<Record<string, unknown>>;
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/work-items");
    expect(url.searchParams.get("status")).toBe("blocked");
    expect(url.searchParams.get("source")).toBe("session");
    expect(url.searchParams.get("assignee")).toBe("qa");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(out.workItems[0]).toEqual({ id: "JIN-1", title: "T", status: "blocked", assignee: null, department: null, source: "session", version: 7, updatedAt: null });
  });

  it("get returns full Todo detail without projecting Workflow run state", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: {
        workItem: {
          id: "JIN-2",
          title: "WF",
          body: "body",
          status: "in_review",
          acceptance: "- pass",
          verifyPolicy: { mode: "verify" },
          rounds: 1,
          approvalState: "pending",
          approvalRequest: "decide",
          budgetUsd: 5,
          source: "workflow",
        },
        spendUsd: 1.25,
      },
    }));
    const out = (await tool("get_work_item").handler({ id: "JIN-2" }, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ spendUsd: 1.25 });
    expect(out).not.toHaveProperty("workflowRun");
    expect(out.workItem).toMatchObject({ acceptance: "- pass", approvalState: "pending", rounds: 1 });
  });

  it("search uses the search route, caps hostile input locally, and returns no body dumps", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItems: [{ id: "JIN-104", title: "Needle", body: "SECRET", status: "backlog", source: "session" }] } }));
    const out = (await tool("search_work_items").handler(
      { text: "%_\\ hostile", status: "backlog", department: "platform", limit: 999 },
      ctx,
    )) as { workItems: Array<Record<string, unknown>> };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/search/work-items");
    expect(url.searchParams.get("text")).toBe("%_\\ hostile");
    expect(url.searchParams.get("status")).toBe("backlog");
    expect(url.searchParams.get("department")).toBe("platform");
    expect(url.searchParams.get("limit")).toBe(String(WORK_ITEM_SEARCH_LIMIT_MAX));
    expect(out.workItems[0]).not.toHaveProperty("body");
    await expect(tool("search_work_items").handler({ text: "x".repeat(WORK_ITEM_QUERY_CHAR_CAP + 1) }, ctx)).rejects.toThrow(
      /text is too long.*shorten/,
    );
  });

  it("create requires caller identity, posts session provenance, and structurally refuses approval fields", async () => {
    const anon = stub(() => ({ status: 201, body: {} }), null);
    await expect(tool("create_work_item").handler({ title: "T" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);

    const { calls, ctx } = stub(() => ({ status: 201, body: { workItem: { id: "JIN-103", title: "T", status: "backlog", approvalState: null } } }), "sess-caller");
    await expect(tool("create_work_item").handler({ title: "T", approvalRequest: "decide" }, ctx)).rejects.toThrow(
      /approval.*authority surface/i,
    );
    await tool("create_work_item").handler({ title: "T", body: "B", acceptance: "- ok", verifyPolicy: { mode: "verify" } }, ctx);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items");
    expect(calls[0].headers[CALLER_SESSION_HEADER]).toBe("sess-caller");
    expect(calls[0].body).toMatchObject({ title: "T", body: "B", acceptance: "- ok", verifyPolicy: { mode: "verify" } });
    expect(calls[0].body).not.toHaveProperty("approvalRequest");
  });

  it("create refuses caller-supplied provenance instead of forwarding spoofable source/sourceRef", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: {} }), "sess-caller");
    await expect(
      tool("create_work_item").handler({ title: "Spoof", provenance: { source: "workflow", sourceRef: "workflow:wf:run" } }, ctx),
    ).rejects.toThrow(/cron and delegation create their own records.*source=workflow is historical audit provenance and is not currently minted/i);
    expect(calls).toHaveLength(0);
  });

  it("approval tools post to the separate request/decision/escalation routes", async () => {
    const names = new Set(buildTools().map((t) => t.name));
    expect(names.has("request_work_item_approval")).toBe(true);
    expect(names.has("decide_work_item_approval")).toBe(true);
    expect(names.has("escalate_work_item_approval")).toBe(true);

    const requestTool = buildTools().find((t) => t.name === "request_work_item_approval")!;
    const decideTool = buildTools().find((t) => t.name === "decide_work_item_approval")!;
    const escalateTool = buildTools().find((t) => t.name === "escalate_work_item_approval")!;
    const { calls, ctx } = stub((call) => ({ status: 200, body: { ok: true, route: new URL(call.url).pathname } }), "sess-coo");

    await requestTool.handler({ id: "JIN-102", request: "Approve release", target: "platform-manager" }, ctx);
    await decideTool.handler({ id: "JIN-102", decision: "approve", note: "ship" }, ctx);
    await escalateTool.handler({ id: "JIN-102", reason: "operator needed" }, ctx);

    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/api/work-items/JIN-102/approval/request", { request: "Approve release", target: "platform-manager" }],
      ["POST", "/api/work-items/JIN-102/approval", { decision: "approve", note: "ship" }],
      ["POST", "/api/work-items/JIN-102/approval/escalate", { reason: "operator needed" }],
    ]);
  });

  it("update is identity-gated, refuses cancel locally, and readable gateway refusals name the human surface", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "blocked" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    const { calls, ctx } = stub(() => ({ status: 403, body: { error: "self-review ban — use the human review surface" } }), "sess-1");
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "cancelled", note: "drop" }, ctx)).rejects.toThrow(
      /cancelling.*human surface/i,
    );
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "done" }, ctx)).rejects.toThrow(/human review surface/i);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/status");
    expect(calls[0].body).toEqual({ status: "done" });
  });

  it("accepts executing and sends it through the guarded status route", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "JIN-1", status: "executing" } } }), "sess-1");

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "executing" }, ctx)).resolves.toMatchObject({
      workItem: { status: "executing" },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "http://127.0.0.1:7777/api/work-items/JIN-1/status",
        body: { status: "executing" },
      }),
    ]);
  });

  it("assign validates through the route and maps readable 400 near-match errors", async () => {
    const { calls, ctx } = stub(() => ({ status: 400, body: { error: 'unknown employee "platfrom-dev". Did you mean "platform-dev"? Check find_employees.' } }), "sess-1");
    await expect(tool("assign_work_item").handler({ id: "JIN-1", assignee: "platfrom-dev" }, ctx)).rejects.toThrow(
      /Did you mean "platform-dev".*find_employees/,
    );
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/assign");
    expect(calls[0].body).toEqual({ assignee: "platfrom-dev" });
  });

  it("archive is identity-gated and posts to the non-deleting archive route", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("archive_work_item").handler({ id: "JIN-1", note: "stale" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);

    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "JIN-1", status: "cancelled" }, archived: true } }), "sess-1");
    const out = (await tool("archive_work_item").handler({ id: "JIN-1", note: "stale cleanup" }, ctx)) as {
      archived: boolean;
      workItem: { status: string };
    };
    expect(out).toMatchObject({ archived: true, workItem: { status: "cancelled" } });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/archive");
    expect(calls[0].body).toEqual({ note: "stale cleanup" });
  });
});

type Api = typeof import("../../gateway/api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
let api: Api;
let registry: Registry;
let store: Store;
let approvals: Approvals;

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
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId?: string, capability: "valid" | "none" | string = "valid"): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: callerSessionId && capability !== "none"
      ? capability === "valid" ? ensureSessionCapability(callerSessionId) : capability
      : undefined,
  };
}

function seedOrg() {
  const dir = path.join(process.env.JINN_HOME!, "org", "platform");
  const otherDir = path.join(process.env.JINN_HOME!, "org", "other");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.yaml"), "name: platform\n");
  fs.writeFileSync(path.join(otherDir, "department.yaml"), "name: other\n");
  fs.writeFileSync(
    path.join(dir, "coo.yaml"),
    "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs operations.\n",
  );
  fs.writeFileSync(
    path.join(dir, "platform-manager.yaml"),
    "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform.\nreportsTo: coo\n",
  );
  fs.writeFileSync(
    path.join(dir, "platform-dev.yaml"),
    "name: platform-dev\ndisplayName: Platform Dev\ndepartment: platform\nrank: senior\nengine: codex\nmodel: gpt-5.5\npersona: Builds the platform.\nreportsTo: platform-manager\n",
  );
  fs.writeFileSync(
    path.join(otherDir, "outsider.yaml"),
    "name: outsider\ndisplayName: Outsider\ndepartment: other\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Works elsewhere.\nreportsTo: coo\n",
  );
}

beforeAll(async () => {
  seedOrg();
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  registry.initDb();
});

describe("work-item tools — integration against the real API + store", () => {
  it("create → search → assign → update → read round-trips through MCP only", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller", employee: "platform-dev" });
    const ctx = ctxFor(caller.id);

    const created = (await tool("create_work_item").handler(
      { title: "Polish narwhal queue", body: "Literal %_\\ body", acceptance: "- ship", verifyPolicy: { mode: "verify" } },
      ctx,
    )) as { workItem: { id: string; approvalState: null } };
    expect(created.workItem.approvalState).toBeNull();

    const found = (await tool("search_work_items").handler({ text: "%_\\", status: "backlog" }, ctx)) as {
      workItems: Array<{ id: string }>;
    };
    expect(found.workItems.map((w) => w.id)).toContain(created.workItem.id);

    const assigned = (await tool("assign_work_item").handler({ id: created.workItem.id, assignee: "platform-dev" }, ctx)) as {
      workItem: { assignee: string; department: string; status: string };
    };
    expect(assigned.workItem).toMatchObject({ assignee: "platform-dev", department: "platform", status: "assigned" });

    const started = (await tool("update_work_item").handler({ id: created.workItem.id, status: "executing" }, ctx)) as {
      workItem: { status: string };
    };
    expect(started.workItem.status).toBe("executing");

    const reviewed = (await tool("update_work_item").handler({ id: created.workItem.id, status: "in_review", note: "done" }, ctx)) as {
      workItem: { status: string };
    };
    expect(reviewed.workItem.status).toBe("in_review");
    await expect(tool("update_work_item").handler({ id: created.workItem.id, status: "executing" }, ctx)).rejects.toThrow(
      /illegal manual transition in_review → executing/i,
    );

    const read = (await tool("get_work_item").handler({ id: created.workItem.id }, ctx)) as {
      workItem: { acceptance: string; verifyPolicy: { mode: string } };
      spendUsd: number;
    };
    expect(read.workItem.acceptance).toBe("- ship");
    expect(read.workItem.verifyPolicy.mode).toBe("verify");
    expect(read.spendUsd).toBe(0);
  });

  it("rejects unrelated self-assignment and terminal assignment while preserving authorized reassignment and unassigned self-claim", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-owner", title: "assign owner", employee: "platform-dev" });
    const outsider = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-outsider", title: "assign outsider", employee: "outsider" });
    const manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-manager", title: "assign manager", employee: "platform-manager" });
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-root", title: "assign root", employee: "coo" });

    const protectedItem = store.createWorkItem({ title: "Protected assignment", status: "assigned", assignee: "platform-dev", source: "session" });
    await expect(tool("assign_work_item").handler({ id: protectedItem.id, assignee: "outsider" }, ctxFor(outsider.id))).rejects.toThrow(
      /403.*does not own|403.*cannot assign/i,
    );
    expect(store.getWorkItem(protectedItem.id)?.assignee).toBe("platform-dev");

    const ownerAssigned = (await tool("assign_work_item").handler({ id: protectedItem.id, assignee: "outsider" }, ctxFor(owner.id))) as {
      workItem: { assignee: string };
    };
    expect(ownerAssigned.workItem.assignee).toBe("outsider");

    const managedItem = store.createWorkItem({ title: "Manager assignment", status: "assigned", assignee: "platform-dev", source: "session" });
    expect(((await tool("assign_work_item").handler({ id: managedItem.id, assignee: "outsider" }, ctxFor(manager.id))) as { workItem: { assignee: string } }).workItem.assignee).toBe("outsider");
    const rootItem = store.createWorkItem({ title: "Root assignment", status: "assigned", assignee: "platform-dev", source: "session" });
    expect(((await tool("assign_work_item").handler({ id: rootItem.id, assignee: "outsider" }, ctxFor(root.id))) as { workItem: { assignee: string } }).workItem.assignee).toBe("outsider");

    const unassigned = store.createWorkItem({ title: "Claimable backlog", status: "backlog", assignee: null, source: "human" });
    const claimed = (await tool("assign_work_item").handler({ id: unassigned.id, assignee: "outsider" }, ctxFor(outsider.id))) as {
      workItem: { assignee: string; status: string };
    };
    expect(claimed.workItem).toMatchObject({ assignee: "outsider", status: "assigned" });

    const terminal = store.createWorkItem({ title: "Closed assignment", status: "done", assignee: "platform-dev", source: "session" });
    await expect(tool("assign_work_item").handler({ id: terminal.id, assignee: "outsider" }, ctxFor(owner.id))).rejects.toThrow(
      /cannot assign.*done|terminal/i,
    );
    expect(store.getWorkItem(terminal.id)?.assignee).toBe("platform-dev");
  });

  it("linked executor can move its delegated item to in_review, but cannot mark it done", async () => {
    const coo = registry.createSession({ engine: "codex", source: "web", sourceRef: "coo", title: "coo" });
    const delegated = (await buildTools().find((t) => t.name === "delegate_task")!.handler(
      { task: "Execute the check", engine: "codex", title: "Executor check" },
      ctxFor(coo.id),
    )) as { workItemId: string; sessionId: string };
    expect(store.getWorkItem(delegated.workItemId)?.status).toBe("executing");

    const execCtx = ctxFor(delegated.sessionId);
    const moved = (await tool("update_work_item").handler({ id: delegated.workItemId, status: "in_review", note: "ready" }, execCtx)) as {
      workItem: { status: string };
    };
    expect(moved.workItem.status).toBe("in_review");
    await expect(tool("update_work_item").handler({ id: delegated.workItemId, status: "done" }, execCtx)).rejects.toThrow(
      /self-review ban.*human review surface/i,
    );
  });

  it("binds reviewer-close authority to the server-minted session capability", async () => {
    const reviewer = registry.createSession({ engine: "codex", source: "web", sourceRef: "qa-reviewer", title: "qa reviewer" });
    const operatorSource = registry.createSession({ engine: "codex", source: "web", sourceRef: "operator-source", title: "operator source" });
    const executor = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "qa-executor",
      title: "qa executor",
      parentSessionId: reviewer.id,
    });
    const item = store.createWorkItem({ title: "Identity authority close", status: "in_review", source: "delegation", sourceRef: `delegate:${reviewer.id}:qa` });
    store.linkSession(item.id, executor.id);

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor("ghost-session-not-in-db"))).rejects.toThrow(
      /unidentified.*tool.*caller|caller identity unavailable/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(reviewer.id, "none"))).rejects.toThrow(
      /caller identity unavailable|unidentified/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(operatorSource.id, "none"))).rejects.toThrow(
      /caller identity unavailable|unidentified/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(executor.id))).rejects.toThrow(
      /self-review ban.*human review surface/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    const closed = (await tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(reviewer.id))) as {
      workItem: { status: string };
    };
    expect(closed.workItem.status).toBe("done");
  });

  it("enforces Todo status ownership and forbids backlog to done through an agent caller", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "owner", title: "owner", employee: "platform-dev" });
    const other = registry.createSession({ engine: "codex", source: "web", sourceRef: "other", title: "other", employee: "other-dev" });

    const backlog = store.createWorkItem({ title: "No shortcut close", status: "backlog", assignee: "platform-dev", source: "session" });
    await expect(tool("update_work_item").handler({ id: backlog.id, status: "done" }, ctxFor(owner.id))).rejects.toThrow(
      /reviewer.*in_review|human review surface/i,
    );
    expect(store.getWorkItem(backlog.id)?.status).toBe("backlog");

    const unowned = store.createWorkItem({ title: "Owned by another assignee", status: "assigned", assignee: "platform-dev", source: "session" });
    await expect(tool("update_work_item").handler({ id: unowned.id, status: "blocked", note: "waiting" }, ctxFor(other.id))).rejects.toThrow(
      /does not own.*Todo|authorized reviewer/i,
    );
    expect(store.getWorkItem(unowned.id)?.status).toBe("assigned");

    const owned = store.createWorkItem({ title: "Owner may report blocked", status: "assigned", assignee: "platform-dev", source: "session" });
    const blocked = (await tool("update_work_item").handler({ id: owned.id, status: "blocked", note: "waiting on input" }, ctxFor(owner.id))) as {
      workItem: { status: string };
    };
    expect(blocked.workItem.status).toBe("blocked");
  });

  it("requests a default-routed approval idempotently", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-owner", title: "approval owner", employee: "platform-dev" });
    const requestTool = buildTools().find((t) => t.name === "request_work_item_approval")!;
    const item = store.createWorkItem({ title: "Request routed approval", status: "assigned", assignee: "platform-dev", source: "session" });
    const first = (await requestTool.handler({ id: item.id, request: "Approve release" }, ctxFor(owner.id))) as {
      workItem: { approvalState: string; approvalTarget: string };
    };
    const second = (await requestTool.handler({ id: item.id, request: "Approve release" }, ctxFor(owner.id))) as typeof first;

    expect(second).toEqual(first);
    expect(first.workItem).toMatchObject({ approvalState: "pending", approvalTarget: "platform-manager" });
    expect(store.listWorkItemEvents(item.id).filter((event) => event.kind === "approval_requested")).toHaveLength(1);
  });

  it("permits linked executors and accepts a valid explicit approval target", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-explicit-owner", title: "approval explicit owner", employee: "platform-dev" });
    const linkedExecutor = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-executor", title: "approval executor" });
    const requestTool = buildTools().find((t) => t.name === "request_work_item_approval")!;

    const explicitItem = store.createWorkItem({ title: "Explicit approval target", status: "assigned", assignee: "platform-dev", source: "session" });
    const explicit = (await requestTool.handler({ id: explicitItem.id, request: "Root review", target: "coo" }, ctxFor(owner.id))) as {
      workItem: { approvalState: string; approvalTarget: string };
    };
    expect(explicit.workItem).toMatchObject({ approvalState: "pending", approvalTarget: "coo" });

    const linkedItem = store.createWorkItem({ title: "Linked executor request", status: "executing", source: "delegation" });
    store.linkSession(linkedItem.id, linkedExecutor.id);
    const linked = (await requestTool.handler({ id: linkedItem.id, request: "Review linked work" }, ctxFor(linkedExecutor.id))) as {
      workItem: { approvalState: string; approvalTarget: string };
    };
    expect(linked.workItem).toMatchObject({ approvalState: "pending", approvalTarget: "coo" });
  });

  it("rejects missing, foreign, and invalid-target approval requests without writing events", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-reject-owner", title: "approval reject owner", employee: "platform-dev" });
    const outsider = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-outsider", title: "approval outsider", employee: "outsider" });
    const requestTool = buildTools().find((t) => t.name === "request_work_item_approval")!;
    const item = store.createWorkItem({ title: "Reject unsafe approval requests", status: "assigned", assignee: "platform-dev", source: "session" });

    await expect(requestTool.handler({ id: item.id, request: "Steal review" }, ctxFor(outsider.id))).rejects.toThrow(
      /403.*does not own|403.*cannot request approval/i,
    );
    await expect(requestTool.handler({ id: "JIN-999", request: "Missing" }, ctxFor(owner.id))).rejects.toThrow(/404.*not found/i);
    await expect(requestTool.handler({ id: item.id, request: "Bad route", target: "unknown-reviewer" }, ctxFor(owner.id))).rejects.toThrow(
      /400.*not an org employee|400.*approval target/i,
    );
    expect(store.listWorkItemEvents(item.id).filter((event) => event.kind === "approval_requested")).toHaveLength(0);
    expect(store.getWorkItem(item.id)?.approvalState).toBeNull();
  });

  it("keeps requested approvals compatible with decision and escalation", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-compat-owner", title: "approval compatibility owner", employee: "platform-dev" });
    const manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "approval-manager", title: "approval manager", employee: "platform-manager" });
    const requestTool = buildTools().find((t) => t.name === "request_work_item_approval")!;
    const decideTool = buildTools().find((t) => t.name === "decide_work_item_approval")!;
    const escalateTool = buildTools().find((t) => t.name === "escalate_work_item_approval")!;
    const item = store.createWorkItem({ title: "Decide requested approval", status: "assigned", assignee: "platform-dev", source: "session" });

    await requestTool.handler({ id: item.id, request: "Approve release" }, ctxFor(owner.id));
    const decided = (await decideTool.handler({ id: item.id, decision: "approve", note: "ship" }, ctxFor(manager.id))) as {
      workItem: { approvalState: string };
    };
    expect(decided.workItem.approvalState).toBe("approved");

    const escalationItem = store.createWorkItem({ title: "Escalate requested approval", status: "assigned", assignee: "platform-dev", source: "session" });
    await requestTool.handler({ id: escalationItem.id, request: "Escalate release" }, ctxFor(owner.id));
    const escalated = (await escalateTool.handler({ id: escalationItem.id, reason: "operator needed" }, ctxFor(manager.id))) as {
      workItem: { approvalState: string; approvalEscalatedAt: string | null };
    };
    expect(escalated.workItem).toMatchObject({ approvalState: "pending" });
    expect(escalated.workItem.approvalEscalatedAt).toBeTruthy();
  });

  it("refuses unrelated archive, while owner/root archive resolves pending approval without deleting evidence", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-owner", title: "archive owner", employee: "platform-dev" });
    const outsider = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-outsider", title: "archive outsider", employee: "outsider" });
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-root", title: "archive root", employee: "coo" });
    const item = store.createWorkItem({ title: "Archive, do not delete", status: "assigned", assignee: "platform-dev", source: "session" });
    approvals.requestApproval(item.id, { request: "Approve release", target: "platform-manager" });

    await expect(tool("archive_work_item").handler({ id: item.id, note: "malicious cancellation" }, ctxFor(outsider.id))).rejects.toThrow(
      /403.*does not own|403.*cannot archive/i,
    );
    expect(store.getWorkItem(item.id)).toMatchObject({ status: "assigned", approvalState: "pending" });

    const archived = (await tool("archive_work_item").handler({ id: item.id, note: "obsolete" }, ctxFor(owner.id))) as {
      archived: boolean;
      workItem: { id: string; status: string; closedAt: string | null; approvalState: string; approvalDecidedBy: string };
    };

    expect(archived.archived).toBe(true);
    expect(archived.workItem).toMatchObject({
      id: item.id,
      status: "cancelled",
      approvalState: "rejected",
      approvalDecidedBy: `session:${owner.id}`,
    });
    expect(archived.workItem.closedAt).toBeTruthy();
    expect(store.getWorkItem(item.id)?.status).toBe("cancelled");
    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "approval_decided" && e.actor === `session:${owner.id}`)).toBe(true);
    expect(events.some((e) => e.kind === "status_change" && e.fromStatus === "assigned" && e.toStatus === "cancelled")).toBe(true);

    const rootOwned = store.createWorkItem({ title: "Root may archive", status: "assigned", assignee: "platform-dev", source: "session" });
    const rootArchived = (await tool("archive_work_item").handler({ id: rootOwned.id }, ctxFor(root.id))) as { workItem: { status: string } };
    expect(rootArchived.workItem.status).toBe("cancelled");
  });

  it("recursively rejects approval keys and validates exact verifyPolicy/provenance schemas", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "schema-caller", title: "schema caller" });
    const ctx = ctxFor(caller.id);

    await expect(
      tool("create_work_item").handler({ title: "Nested approval", verifyPolicy: { mode: "verify", approvalState: "pending" } }, ctx),
    ).rejects.toThrow(/approval.*authority surface/i);
    await expect(
      tool("create_work_item").handler({ title: "Deep approval", provenance: { source: "session", nested: { approvalAlias: true } } }, ctx),
    ).rejects.toThrow(/approval.*authority surface/i);
    await expect(tool("create_work_item").handler({ title: "Unknown policy key", verifyPolicy: { mode: "verify", extra: true } }, ctx)).rejects.toThrow(
      /verifyPolicy.*unknown key|verifyPolicy.*only/i,
    );
    await expect(tool("create_work_item").handler({ title: "Bad policy mode", verifyPolicy: { mode: "maybe" } }, ctx)).rejects.toThrow(
      /verifyPolicy\.mode.*trust, verify, thorough/i,
    );
    await expect(tool("create_work_item").handler({ title: "Unknown provenance key", provenance: { source: "session", extra: true } }, ctx)).rejects.toThrow(
      /provenance.*dedicated bridge|cannot be supplied/i,
    );
    await expect(tool("create_work_item").handler({ title: "Bad provenance source", provenance: { source: "bogus" } }, ctx)).rejects.toThrow(
      /provenance.*dedicated bridge|cannot be supplied/i,
    );
    await expect(tool("update_work_item").handler({ id: "JIN-9999", status: "blocked", note: "x", metadata: { approvalBypass: true } }, ctx)).rejects.toThrow(
      /approval.*authority surface/i,
    );

    const assignTarget = store.createWorkItem({ title: "Assign approval reject", status: "backlog", source: "session" });
    const { status, body } = await (async () => {
      const res = await apiFetch()("http://gateway.test/api/work-items/" + encodeURIComponent(assignTarget.id) + "/assign", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
          [CALLER_SESSION_HEADER]: caller.id,
          [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(caller.id),
        },
        body: JSON.stringify({ assignee: "platform-dev", nested: { approvalState: "pending" } }),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as { error: string } };
    })();
    expect(status).toBe(400);
    expect(body.error).toMatch(/approval.*authority surface/i);
  });
});
