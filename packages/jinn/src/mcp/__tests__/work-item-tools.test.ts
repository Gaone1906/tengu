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
    expect(names).toContain("decide_work_item_approval");
    expect(names).toContain("escalate_work_item_approval");
    expect(names).toContain("archive_work_item");
    expect(names).toContain("delete_trigger");
    expect(names.some((n) => /cancel/i.test(n) && /work_item/.test(n))).toBe(false);
    expect(names).toHaveLength(41);
  });

  it("positions list as recent/filter summaries and search as text/filter hits", () => {
    expect(tool("list_work_items").description).toMatch(/recent or filtered/i);
    expect(tool("list_work_items").description).toMatch(/compact summaries/i);
    expect(tool("search_work_items").description).toMatch(/by text/i);
    expect(tool("search_work_items").description).toMatch(/structured filters/i);
  });

  it("create schema has no approval fields and update schema excludes cancelled", () => {
    const createProps = tool("create_work_item").inputSchema.properties;
    expect(Object.keys(createProps).sort()).toEqual(
      ["acceptance", "assignee", "body", "department", "title", "verifyPolicy"].sort(),
    );
    expect(JSON.stringify(createProps)).not.toMatch(/approval/i);
    const status = tool("update_work_item").inputSchema.properties.status as { enum: string[] };
    expect(status.enum).toEqual(["in_review", "blocked", "escalated", "done"]);
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
  it("list passes status/source/assignee filters and returns compact summaries", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItems: [{ id: "wi_1", title: "T", body: "MUST NOT LEAK", status: "blocked", source: "session" }] } }));
    const out = (await tool("list_work_items").handler({ status: "blocked", source: "session", assignee: "qa", limit: 99 }, ctx)) as {
      workItems: Array<Record<string, unknown>>;
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/work-items");
    expect(url.searchParams.get("status")).toBe("blocked");
    expect(url.searchParams.get("source")).toBe("session");
    expect(url.searchParams.get("assignee")).toBe("qa");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(out.workItems[0]).toEqual({ id: "wi_1", title: "T", status: "blocked", assignee: null, department: null, source: "session", updatedAt: null });
  });

  it("get returns full detail including acceptance/policy/approval/spend/workflowRun", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: {
        workItem: {
          id: "wi_2",
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
        workflowRun: { workflowId: "wf", runId: "run_1" },
      },
    }));
    const out = (await tool("get_work_item").handler({ id: "wi_2" }, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ spendUsd: 1.25, workflowRun: { workflowId: "wf", runId: "run_1" } });
    expect(out.workItem).toMatchObject({ acceptance: "- pass", approvalState: "pending", rounds: 1 });
  });

  it("search uses the search route, caps hostile input locally, and returns no body dumps", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItems: [{ id: "wi_s", title: "Needle", body: "SECRET", status: "backlog", source: "session" }] } }));
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

    const { calls, ctx } = stub(() => ({ status: 201, body: { workItem: { id: "wi_new", title: "T", status: "backlog", approvalState: null } } }), "sess-caller");
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
    ).rejects.toThrow(/provenance.*dedicated bridge|cannot be supplied/i);
    expect(calls).toHaveLength(0);
  });

  it("COO approval tools post to the separate approval decision/escalation routes", async () => {
    const names = new Set(buildTools().map((t) => t.name));
    expect(names.has("decide_work_item_approval")).toBe(true);
    expect(names.has("escalate_work_item_approval")).toBe(true);

    const decideTool = buildTools().find((t) => t.name === "decide_work_item_approval")!;
    const escalateTool = buildTools().find((t) => t.name === "escalate_work_item_approval")!;
    const { calls, ctx } = stub((call) => ({ status: 200, body: { ok: true, route: new URL(call.url).pathname } }), "sess-coo");

    await decideTool.handler({ id: "wi_approval", decision: "approve", note: "ship" }, ctx);
    await escalateTool.handler({ id: "wi_approval", reason: "operator needed" }, ctx);

    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/api/work-items/wi_approval/approval", { decision: "approve", note: "ship" }],
      ["POST", "/api/work-items/wi_approval/approval/escalate", { reason: "operator needed" }],
    ]);
  });

  it("update is identity-gated, refuses cancel locally, and readable gateway refusals name the human surface", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("update_work_item").handler({ id: "wi_1", status: "blocked" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    const { calls, ctx } = stub(() => ({ status: 403, body: { error: "self-review ban — use the human review surface" } }), "sess-1");
    await expect(tool("update_work_item").handler({ id: "wi_1", status: "cancelled", note: "drop" }, ctx)).rejects.toThrow(
      /cancelling.*human surface/i,
    );
    await expect(tool("update_work_item").handler({ id: "wi_1", status: "done" }, ctx)).rejects.toThrow(/human review surface/i);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/wi_1/status");
    expect(calls[0].body).toEqual({ status: "done" });
  });

  it("assign validates through the route and maps readable 400 near-match errors", async () => {
    const { calls, ctx } = stub(() => ({ status: 400, body: { error: 'unknown employee "platfrom-dev". Did you mean "platform-dev"? Check find_employees.' } }), "sess-1");
    await expect(tool("assign_work_item").handler({ id: "wi_1", assignee: "platfrom-dev" }, ctx)).rejects.toThrow(
      /Did you mean "platform-dev".*find_employees/,
    );
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/wi_1/assign");
    expect(calls[0].body).toEqual({ assignee: "platfrom-dev" });
  });

  it("archive is identity-gated and posts to the non-deleting archive route", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("archive_work_item").handler({ id: "wi_1", note: "stale" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);

    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "wi_1", status: "cancelled" }, archived: true } }), "sess-1");
    const out = (await tool("archive_work_item").handler({ id: "wi_1", note: "stale cleanup" }, ctx)) as {
      archived: boolean;
      workItem: { status: string };
    };
    expect(out).toMatchObject({ archived: true, workItem: { status: "cancelled" } });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/wi_1/archive");
    expect(calls[0].body).toEqual({ note: "stale cleanup" });
  });
});

type Api = typeof import("../../gateway/api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let registry: Registry;
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.yaml"), "name: platform\n");
  fs.writeFileSync(
    path.join(dir, "platform-dev.yaml"),
    "name: platform-dev\ndisplayName: Platform Dev\ndepartment: platform\nrank: senior\nengine: codex\nmodel: gpt-5.5\npersona: Builds the platform.\n",
  );
}

beforeAll(async () => {
  seedOrg();
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  registry.initDb();
});

describe("work-item tools — integration against the real API + store", () => {
  it("create → search → assign → update → read round-trips through MCP only", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller" });
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

    const reviewed = (await tool("update_work_item").handler({ id: created.workItem.id, status: "in_review", note: "done" }, ctx)) as {
      workItem: { status: string };
    };
    expect(reviewed.workItem.status).toBe("in_review");

    const read = (await tool("get_work_item").handler({ id: created.workItem.id }, ctx)) as {
      workItem: { acceptance: string; verifyPolicy: { mode: string } };
      spendUsd: number;
    };
    expect(read.workItem.acceptance).toBe("- ship");
    expect(read.workItem.verifyPolicy.mode).toBe("verify");
    expect(read.spendUsd).toBe(0);
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

  it("archives a Todo without deleting its row or audit history", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-caller", title: "archive caller" });
    const item = store.createWorkItem({ title: "Archive, do not delete", status: "backlog", source: "session" });

    const archived = (await tool("archive_work_item").handler({ id: item.id, note: "obsolete" }, ctxFor(caller.id))) as {
      archived: boolean;
      workItem: { id: string; status: string; closedAt: string | null };
    };

    expect(archived.archived).toBe(true);
    expect(archived.workItem).toMatchObject({ id: item.id, status: "cancelled" });
    expect(archived.workItem.closedAt).toBeTruthy();
    expect(store.getWorkItem(item.id)?.status).toBe("cancelled");
    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "status_change" && e.fromStatus === "backlog" && e.toStatus === "cancelled")).toBe(true);
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
    await expect(tool("update_work_item").handler({ id: "wi_missing", status: "blocked", note: "x", metadata: { approvalBypass: true } }, ctx)).rejects.toThrow(
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
