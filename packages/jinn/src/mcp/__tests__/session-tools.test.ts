import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  buildSessionTools,
  READ_LAST_MAX,
  READ_LAST_DEFAULT,
  READ_MESSAGE_CHAR_CAP,
  LIST_LIMIT_MAX,
} from "../session-tools.js";
import { buildTools } from "../server.js";
import {
  attachSessionIdentity,
  ensureSessionCapability,
  JINN_SESSION_CAPABILITY_ENV,
  JINN_SESSION_ID_ENV,
  JINN_WORKFLOW_ATTEMPT_ENV,
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
} from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { sessionCommGuards, LATERAL_MAX_SENDS, LATERAL_MAX_HOPS } from "../../gateway/session-comm-guards.js";
import type { ResolvedMcpConfig } from "../../shared/types.js";

/**
 * GRS-017a — the sessions MCP tool group + the caller-identity seam.
 *
 * Three tiers:
 *   1. UNIT — every tool against a stub fetch: exact route/method/body/header,
 *      caps + truncation, scope refusals, local self-message refusal, decision-
 *      shaped hints, structured error mapping (400/403/404/429).
 *   2. IDENTITY SEAM — attachSessionIdentity purity + the header contract
 *      (present when ctx has callerSessionId, absent otherwise).
 *   3. INTEGRATION — the tools drive the REAL gateway session routes + registry
 *      (temp JINN_HOME): spawn→auto-parent-link→list children→read→lateral
 *      send→stop, plus the substrate guards provoked for real (self-message,
 *      rate-cap trip, hop-budget exhaustion, non-descendant stop refusal) and
 *      the operator paths (no header) unchanged.
 */

// Isolated registry DB for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-sess-home-"));

/* ── Unit-tier stub fetch ───────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId?: string,
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
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://127.0.0.1:7777",
    fetchFn,
    callerSessionId,
    sessionCapability,
  };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildSessionTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("session tools — registry + schemas", () => {
  it("exposes the 5 session tools with flat object schemas and required args", () => {
    const tools = buildSessionTools();
    expect(tools.map((t) => t.name)).toEqual([
      "spawn_session",
      "send_to_session",
      "read_session",
      "list_sessions",
      "stop_session",
    ]);
    expect(tool("spawn_session").inputSchema.required).toEqual(["prompt"]);
    expect(tool("send_to_session").inputSchema.required).toEqual(["sessionId", "message"]);
    expect(tool("read_session").inputSchema.required).toEqual(["sessionId"]);
    expect(tool("list_sessions").inputSchema.required).toBeUndefined();
    expect(tool("stop_session").inputSchema.required).toEqual(["sessionId"]);
  });

  it("the full belt registers the sessions group and still has NO delete tool (human-only authority)", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).toContain("spawn_session");
    expect(names).not.toContain("jinn_delete_session");
  });

  it("the protocol teaching (end turn, callback, no polling loops) lives on the spawn tool", () => {
    expect(tool("spawn_session").description).toMatch(/END YOUR TURN/);
    expect(tool("spawn_session").description).toMatch(/never poll/i);
    expect(tool("spawn_session").description).toMatch(/role\/persona fit/);
  });

  it("positions spawn as the quick untracked session verb, distinct from delegate_task", () => {
    expect(tool("spawn_session").description).toMatch(/quick untracked/i);
    expect(tool("spawn_session").description).toMatch(/tracked company work.*delegate_task/i);
  });

  it("teaches employee selection in the compact employee schema field", () => {
    const props = tool("spawn_session").inputSchema.properties as Record<string, { description?: string }>;
    expect(props.employee.description).toBe(
      "Employee slug; choose by role/persona fit from list_employees/find_employees. Omit for a plain session or if no employee fits.",
    );
  });
});

describe("session tools — unit (stub gateway)", () => {
  it("spawn_session POSTs the create route with only the provided fields and hints the callback protocol", async () => {
    const { calls, ctx } = stub(
      () => ({ status: 201, body: { id: "child-1", employee: "worker", engine: "codex", status: "running" } }),
      "parent-1",
    );
    const out = (await tool("spawn_session").handler({ prompt: "do X", employee: "worker" }, ctx)) as Record<string, unknown>;
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:7777/api/sessions",
      method: "POST",
      body: { prompt: "do X", employee: "worker" },
    });
    expect(calls[0].body).not.toHaveProperty("engine");
    expect(calls[0].body).not.toHaveProperty("parentSessionId"); // linkage is header-side, never body-side
    expect(out.sessionId).toBe("child-1");
    expect(String(out.hint)).toMatch(/linked to you as a child/);
    expect(String(out.hint)).toMatch(/END YOUR TURN/);
  });

  it("spawn/send/stop REFUSE locally when the server has no caller identity — fail closed, no round trip (GRS-017 finding 2)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    const cases: Array<[string, Record<string, unknown>]> = [
      ["spawn_session", { prompt: "p" }],
      ["send_to_session", { sessionId: "b", message: "hi" }],
      ["stop_session", { sessionId: "b" }],
    ];
    for (const [name, args] of cases) {
      await expect(tool(name).handler(args, ctx)).rejects.toThrow(/caller identity unavailable.*JINN_SESSION_ID/is);
    }
    expect(calls).toHaveLength(0);
  });

  it("spawn_session passes a structured 400 (unknown employee/engine/model) through readable", async () => {
    const { ctx } = stub(() => ({ status: 400, body: { error: 'unknown engine "warp"' } }), "p");
    await expect(tool("spawn_session").handler({ prompt: "p", engine: "warp" }, ctx)).rejects.toThrow(
      /rejected \(400\).*unknown engine/,
    );
  });

  it("send_to_session POSTs the message route; 429 and hop-budget 400 come back readable", async () => {
    const ok = stub(() => ({ status: 200, body: { status: "queued", sessionId: "b" } }), "a");
    const out = (await tool("send_to_session").handler({ sessionId: "b", message: "hi" }, ok.ctx)) as Record<string, unknown>;
    expect(ok.calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/sessions/b/message", method: "POST", body: { message: "hi" } });
    expect(out.status).toBe("queued");

    const rated = stub(() => ({ status: 429, body: { error: "lateral-send rate cap: 10 per 10 minutes. Retry in ~540s" } }), "a");
    await expect(tool("send_to_session").handler({ sessionId: "b", message: "hi" }, rated.ctx)).rejects.toThrow(
      /refused \(429\).*rate cap/,
    );

    const hopped = stub(() => ({ status: 400, body: { error: "hop budget exhausted: relay hop 5 (max 4)" } }), "a");
    await expect(tool("send_to_session").handler({ sessionId: "b", message: "hi" }, hopped.ctx)).rejects.toThrow(
      /rejected \(400\).*hop budget/,
    );
  });

  it("send_to_session refuses a self-message locally — no round trip", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }), "me");
    await expect(tool("send_to_session").handler({ sessionId: "me", message: "hi" }, ctx)).rejects.toThrow(/own session/i);
    expect(calls).toHaveLength(0);
  });

  it(`read_session defaults last=${READ_LAST_DEFAULT}, clamps to ${READ_LAST_MAX}, and truncates long messages with the intentional-cap marker`, async () => {
    const long = "y".repeat(READ_MESSAGE_CHAR_CAP + 500);
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: { id: "s", engine: "codex", status: "idle", messages: [{ role: "assistant", content: long, timestamp: 5 }] },
    }), "reader");
    const out = (await tool("read_session").handler({ sessionId: "s" }, ctx)) as {
      messages: Array<{ content: string }>;
      hint: string;
    };
    expect(calls[0].url).toBe(`http://127.0.0.1:7777/api/sessions/s?last=${READ_LAST_DEFAULT}`);
    expect(out.messages[0].content).toContain("…[truncated 500 chars");
    expect(out.messages[0].content.length).toBeLessThan(READ_MESSAGE_CHAR_CAP + 120);
    expect(out.hint).toMatch(/idle/i);

    await tool("read_session").handler({ sessionId: "s", last: 999 }, ctx);
    expect(calls[1].url).toBe(`http://127.0.0.1:7777/api/sessions/s?last=${READ_LAST_MAX}`);
    await tool("read_session").handler({ sessionId: "s", last: 0 }, ctx);
    expect(calls[2].url).toBe("http://127.0.0.1:7777/api/sessions/s?last=1");
  });

  it("read_session hints are decision-shaped per status (running → end turn / wake; error → surfaces lastError)", async () => {
    const running = stub(() => ({ status: 200, body: { id: "s", status: "running", messages: [] } }), "reader");
    const r1 = (await tool("read_session").handler({ sessionId: "s" }, running.ctx)) as { hint: string };
    expect(r1.hint).toMatch(/END YOUR TURN/);
    expect(r1.hint).toMatch(/never poll/i);
    expect(r1.hint.length).toBeLessThanOrEqual(80);

    const errored = stub(() => ({ status: 200, body: { id: "s", status: "error", lastError: "engine exploded", messages: [] } }), "reader");
    const r2 = (await tool("read_session").handler({ sessionId: "s" }, errored.ctx)) as { hint: string };
    expect(r2.hint).toContain("engine exploded");
    expect(r2.hint.length).toBeLessThanOrEqual(80);
  });

  it("read_session maps 404 to a discovery hint", async () => {
    const { ctx } = stub(() => ({ status: 404, body: { error: "not found" } }), "reader");
    await expect(tool("read_session").handler({ sessionId: "ghost" }, ctx)).rejects.toThrow(/404.*list_sessions/);
  });

  it("list_sessions: children scope hits /children with the caller id and returns summaries WITHOUT message bodies", async () => {
    const { calls, ctx } = stub(
      () => ({
        status: 200,
        body: [
          { id: "c1", employee: "w", engine: "codex", status: "idle", parentSessionId: "p", messages: [{ role: "user", content: "SECRET" }] },
        ],
      }),
      "p",
    );
    const out = (await tool("list_sessions").handler({}, ctx)) as { scope: string; sessions: Array<Record<string, unknown>> };
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/sessions/p/children");
    expect(out.scope).toBe("children");
    expect(out.sessions[0].id).toBe("c1");
    expect(JSON.stringify(out.sessions)).not.toContain("SECRET");
  });

  it("list_sessions: children scope without identity refuses with a scope suggestion", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: [] }));
    await expect(tool("list_sessions").handler({ scope: "children" }, ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("list_sessions: employee scope requires the employee arg and hits the group route; recent unwraps {sessions}", async () => {
    const emp = stub(() => ({ status: 200, body: [{ id: "e1", employee: "worker" }] }), "p");
    await expect(tool("list_sessions").handler({ scope: "employee" }, emp.ctx)).rejects.toThrow(/employee is required/);
    const out = (await tool("list_sessions").handler({ scope: "employee", employee: "worker", limit: 7 }, emp.ctx)) as {
      sessions: unknown[];
    };
    expect(emp.calls[0].url).toBe("http://127.0.0.1:7777/api/sessions?group=worker&limit=7");
    expect(out.sessions).toHaveLength(1);

    const rec = stub(() => ({ status: 200, body: { sessions: [{ id: "r1" }, { id: "r2" }], counts: {} } }), "p");
    const recent = (await tool("list_sessions").handler({ scope: "recent", limit: 1 }, rec.ctx)) as { sessions: unknown[] };
    expect(rec.calls[0].url).toBe("http://127.0.0.1:7777/api/sessions");
    expect(recent.sessions).toHaveLength(1); // limit applied tool-side

    expect(LIST_LIMIT_MAX).toBe(50);
  });

  it("stop_session POSTs the stop route; a 403 non-descendant refusal passes through readable", async () => {
    const ok = stub(() => ({ status: 200, body: { status: "stopped", sessionId: "c" } }), "p");
    const out = (await tool("stop_session").handler({ sessionId: "c" }, ok.ctx)) as Record<string, unknown>;
    expect(ok.calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/sessions/c/stop", method: "POST" });
    // GRS-017f: the return is an ACTION RESULT (`action`), not a `status` field
    // that would collide with the session's persistent state (read shows `idle`).
    expect(out.action).toBe("stopped");
    expect(out.status).toBeUndefined();
    expect(String(out.hint)).toMatch(/recoverable/i);

    const denied = stub(() => ({ status: 403, body: { error: "not a descendant of your session" } }), "p");
    await expect(tool("stop_session").handler({ sessionId: "x" }, denied.ctx)).rejects.toThrow(/403.*descendant/);
  });

  it("missing required args fail fast with the arg name (no gateway call)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }), "p");
    await expect(tool("spawn_session").handler({}, ctx)).rejects.toThrow(/prompt is required/);
    await expect(tool("send_to_session").handler({ sessionId: "s" }, ctx)).rejects.toThrow(/message is required/);
    await expect(tool("read_session").handler({}, ctx)).rejects.toThrow(/sessionId is required/);
    await expect(tool("stop_session").handler({}, ctx)).rejects.toThrow(/sessionId is required/);
    expect(calls).toHaveLength(0);
  });
});

describe("the identity seam", () => {
  it(`attachSessionIdentity stamps ${JINN_SESSION_ID_ENV} + ${JINN_SESSION_CAPABILITY_ENV} on the jinn server env — input untouched`, () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "node", args: ["server-entry.js"], env: { JINN_GATEWAY_URL: "http://127.0.0.1:7788" } },
        other: { command: "npx", args: ["x"] },
      },
    };
    const out = attachSessionIdentity(resolved, "sess-42");
    const jinn = out.mcpServers.jinn as { args?: string[]; env?: Record<string, string> };
    expect(jinn.env).toEqual({
      JINN_GATEWAY_URL: "http://127.0.0.1:7788",
      [JINN_SESSION_ID_ENV]: "sess-42",
      [JINN_SESSION_CAPABILITY_ENV]: expect.any(String),
    });
    expect(jinn.args).toEqual([
      "server-entry.js",
      "--jinn-session-id", "sess-42",
      "--jinn-home", expect.any(String),
      "--jinn-gateway-url", "http://127.0.0.1:7788",
    ]);
    expect(jinn.args?.join(" ")).not.toContain(jinn.env?.[JINN_SESSION_CAPABILITY_ENV]);
    // purity: the input object was not mutated
    expect((resolved.mcpServers.jinn as { env?: Record<string, string> }).env).toEqual({ JINN_GATEWAY_URL: "http://127.0.0.1:7788" });
    // other servers pass through by reference-equality (no gratuitous copies)
    expect(out.mcpServers.other).toBe(resolved.mcpServers.other);
  });

  it("attachSessionIdentity is a no-op without a jinn stdio server", () => {
    const noJinn: ResolvedMcpConfig = { mcpServers: { browser: { command: "npx" } } };
    expect(attachSessionIdentity(noJinn, "s")).toBe(noJinn);
  });

  it("stamps the attempt-only visibility hint only for workflow attempt sessions", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: { jinn: { command: "node", args: ["server-entry.js"] } },
    };
    const ordinary = attachSessionIdentity(resolved, "ordinary");
    const attempt = attachSessionIdentity(resolved, "attempt", { workflowAttempt: true });

    expect((ordinary.mcpServers.jinn as { env?: Record<string, string> }).env)
      .not.toHaveProperty(JINN_WORKFLOW_ATTEMPT_ENV);
    expect((attempt.mcpServers.jinn as { env?: Record<string, string> }).env)
      .toHaveProperty(JINN_WORKFLOW_ATTEMPT_ENV, "1");
  });

  it(`every gateway call carries ${CALLER_SESSION_HEADER} and ${CALLER_SESSION_CAPABILITY_HEADER} when the ctx has a bound identity`, async () => {
    const withId = stub(() => ({ status: 200, body: { id: "s", messages: [] } }), "sess-42");
    await tool("read_session").handler({ sessionId: "s" }, withId.ctx);
    expect(withId.calls[0].headers[CALLER_SESSION_HEADER]).toBe("sess-42");
    expect(withId.calls[0].headers[CALLER_SESSION_CAPABILITY_HEADER]).toBe("cap-test");
  });

  it(`read calls without identity fail locally before sending ${TOOL_CALL_HEADER}`, async () => {
    const without = stub(() => ({ status: 200, body: { id: "s", messages: [] } }));
    await expect(tool("read_session").handler({ sessionId: "s" }, without.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(without.calls).toHaveLength(0);
  });

  it(`every gateway call carries the tool-origin marker ${TOOL_CALL_HEADER} with a bound identity so routes can tell a tool call from the operator (GRS-017 finding 2)`, async () => {
    const withId = stub(() => ({ status: 200, body: { id: "s", messages: [] } }), "sess-42");
    await tool("read_session").handler({ sessionId: "s" }, withId.ctx);
    expect(withId.calls[0].headers[TOOL_CALL_HEADER]).toBe(TOOL_CALL_HEADER_VALUE);
  });
});

/* ── Integration: the tools drive the REAL session routes + registry ────────── */

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
type WorkItemStore = typeof import("../../work-items/store.js");
type WorkItemReconcile = typeof import("../../work-items/reconcile.js");
let workItems: WorkItemStore;
let workItemReconcile: WorkItemReconcile;

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

// A queue stub that never runs enqueued turns (engine dispatch is out of scope —
// GRS-015 pattern: the routes + stores are real, the engine is not).
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
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../../gateway/api.js").ApiContext;

/** A fetch that dispatches into handleApiRequest with HEADERS FORWARDED — the
 *  identity seam is the thing under test. */
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

function ctxFor(callerSessionId?: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: callerSessionId ? ensureSessionCapability(callerSessionId) : undefined,
  };
}

/** Create a session the operator way (no header) and return its id. */
async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await apiFetch()("http://gateway.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt, engine: "codex" }),
  });
  expect(resp.status).toBe(201);
  return (JSON.parse(await resp.text()) as { id: string }).id;
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  workItemReconcile = await import("../../work-items/reconcile.js");
});

beforeEach(() => {
  sessionCommGuards.reset();
  sessionCommGuards.setMaxHops(LATERAL_MAX_HOPS); // restore the default cap between tests
});

describe("session tools — integration against the real routes/registry", () => {
  it("refuses to erase a linked attempt and preserves its spend while interrupting unfinished work", async () => {
    const sessionId = await createOperatorSession("costly unfinished attempt");
    const item = workItems.createWorkItem({
      title: "Preserve attempt evidence",
      status: "executing",
      source: "cron",
      verifyPolicy: { mode: "trust" },
    });
    workItems.linkSession(item.id, sessionId);
    registry.accumulateSessionCost(sessionId, 4.25, 3);
    registry.updateSession(sessionId, { status: "running" });

    const response = await apiFetch()(`http://gateway.test/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(await response.text())).toMatchObject({ preserved: true, workItemId: item.id });
    expect(registry.getSession(sessionId)).toMatchObject({
      totalCost: 4.25,
      totalTurns: 3,
      status: "interrupted",
      attemptOutcome: "interrupted",
      workItemId: item.id,
    });
    expect(workItems.getWorkItem(item.id)?.status).toBe("blocked");
  });

  it.each(["stop", "reset"])("%s records interruption so linked unfinished TRUST work cannot reconcile to done", async (action) => {
    const sessionId = await createOperatorSession(`unfinished ${action}`);
    const item = workItems.createWorkItem({
      title: `Unfinished ${action}`,
      status: "executing",
      source: "cron",
      verifyPolicy: { mode: "trust" },
    });
    workItems.linkSession(item.id, sessionId);
    registry.updateSession(sessionId, { status: "running" });

    const response = await apiFetch()(`http://gateway.test/api/sessions/${sessionId}/${action}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    expect(registry.getSession(sessionId)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });

    const reconciled = workItemReconcile.reconcileWorkItem(item.id);
    expect(reconciled?.item.status).toBe("blocked");
    expect(workItems.getWorkItem(item.id)?.status).not.toBe("done");
  });

  it("the headline loop: spawn (auto parent link) → list children → read (capped) → lateral send (sender-tagged, wakes) → stop", async () => {
    const parentId = await createOperatorSession("I am the COO");
    const ctx = ctxFor(parentId);

    // 1. Spawn via MCP: parent linkage comes from the header, not the body.
    const spawned = (await tool("spawn_session").handler({ prompt: "child task", engine: "codex" }, ctx)) as {
      sessionId: string;
      hint: string;
    };
    expect(spawned.hint).toContain("linked to you as a child");
    const child = registry.getSession(spawned.sessionId)!;
    expect(child.parentSessionId).toBe(parentId);

    // 2. The child shows up under scope=children.
    const listed = (await tool("list_sessions").handler({}, ctx)) as { sessions: Array<{ id: string }> };
    expect(listed.sessions.map((s) => s.id)).toContain(spawned.sessionId);

    // 3. Read: the spawn prompt is there; the cap holds against a padded history.
    for (let i = 0; i < 30; i++) registry.insertMessage(spawned.sessionId, "assistant", `filler ${i}`);
    const read = (await tool("read_session").handler({ sessionId: spawned.sessionId, last: 999 }, ctx)) as {
      messages: Array<{ content: string }>;
      parentSessionId: string;
    };
    expect(read.messages.length).toBe(READ_LAST_MAX);
    expect(read.parentSessionId).toBe(parentId);

    // 4. Lateral/child send: persisted as a sender-tagged notification banner.
    await tool("send_to_session").handler({ sessionId: spawned.sessionId, message: "status update please" }, ctx);
    const messages = registry.getMessages(spawned.sessionId);
    const banner = messages[messages.length - 1];
    expect(banner.role).toBe("notification");
    expect(banner.content).toContain("📨");
    expect(banner.content).toContain("status update please");

    // 5. Stop the child (own descendant → allowed); the record survives.
    const stopped = (await tool("stop_session").handler({ sessionId: spawned.sessionId }, ctx)) as { action: string };
    expect(stopped.action).toBe("stopped");
    expect(registry.getSession(spawned.sessionId)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
  });

  it("an operator-authenticated relay (role:notification + from) lands as a 📨 relay banner, not a user message", async () => {
    const target = await createOperatorSession("REPS division top");
    // A COO routes a message between divisions via the operator API once the
    // lateral hop budget between them is spent. Before the fix this landed as a
    // bare `user` message that masqueraded as the operator typing.
    const relay = await apiFetch()(`http://gateway.test/api/sessions/${target}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        role: "notification",
        from: "yorio-lead",
        message: "GREEN-LIGHT: clear to merge reps/workspace-conversion.",
      }),
    });
    expect(relay.status).toBe(200);

    const messages = registry.getMessages(target);
    const banner = messages[messages.length - 1];
    expect(banner.role).toBe("notification");
    expect(banner.content).toContain("📨");
    expect(banner.content).toContain("GREEN-LIGHT: clear to merge");
    const meta = typeof banner.meta === "string" ? JSON.parse(banner.meta) : banner.meta;
    expect(meta).toMatchObject({ kind: "agent-relay", fromLabel: "yorio-lead", hops: 1 });
    expect(meta.fromSessionId).toBeUndefined();
  });

  it("an operator message WITHOUT role:notification is still a plain user message (unchanged)", async () => {
    const target = await createOperatorSession("a division top");
    const op = await apiFetch()(`http://gateway.test/api/sessions/${target}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ message: "operator says: wrap up" }),
    });
    expect(op.status).toBe(200);
    const messages = registry.getMessages(target);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("operator says: wrap up");
  });

  it("a tool spawn that lost identity or claims an unknown caller id is refused at the route", async () => {
    // Marker without identity → the route refuses even if a (buggy/old) tool build skipped the local check.
    const lost = await apiFetch()("http://gateway.test/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE },
      body: JSON.stringify({ prompt: "p", engine: "codex" }),
    });
    expect(lost.status).toBe(403);
    expect(await lost.text()).toMatch(/caller identity unavailable/i);

    await expect(tool("spawn_session").handler({ prompt: "p", engine: "codex" }, ctxFor("no-such-session"))).rejects.toThrow(
      /caller identity unavailable/i,
    );
  });

  it("an explicit body parentSessionId wins over the header (internal callers unchanged)", async () => {
    const a = await createOperatorSession("a");
    const b = await createOperatorSession("b");
    const resp = await apiFetch()("http://gateway.test/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", [CALLER_SESSION_HEADER]: a, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(a) },
      body: JSON.stringify({ prompt: "explicit", engine: "codex", parentSessionId: b }),
    });
    expect(resp.status).toBe(201);
    const created = JSON.parse(await resp.text()) as { id: string };
    expect(registry.getSession(created.id)!.parentSessionId).toBe(b);
  });

  it("self-message is refused at the route too (curl parity), and an unknown tool caller is a readable 403", async () => {
    const a = await createOperatorSession("a");
    const self = await apiFetch()(`http://gateway.test/api/sessions/${a}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", [CALLER_SESSION_HEADER]: a, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(a) },
      body: JSON.stringify({ message: "hi me" }),
    });
    expect(self.status).toBe(400);
    expect(await self.text()).toMatch(/own session/i);

    const ghost = await apiFetch()(`http://gateway.test/api/sessions/${a}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jinn-caller-session": "ghost" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(ghost.status).toBe(403);
    expect(await ghost.text()).toMatch(/caller identity unavailable/i);
  });

  it(`the rate cap trips on send ${LATERAL_MAX_SENDS + 1} with a 429 the agent can read`, async () => {
    const a = await createOperatorSession("sender");
    const b = await createOperatorSession("target");
    const ctx = ctxFor(a);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) {
      await tool("send_to_session").handler({ sessionId: b, message: `m${i}` }, ctx);
    }
    await expect(tool("send_to_session").handler({ sessionId: b, message: "one too many" }, ctx)).rejects.toThrow(
      /429.*rate cap/is,
    );
  });

  it(`a two-agent ping-pong dies on the hop budget (cap pinned to 4) at relay 5, and an operator message resets the chain`, async () => {
    // The default cap is now 12; pin it to 4 so this stays a compact 5-hop test.
    sessionCommGuards.setMaxHops(4);
    const a = await createOperatorSession("agent A");
    const b = await createOperatorSession("agent B");
    const ctxA = ctxFor(a);
    const ctxB = ctxFor(b);

    await tool("send_to_session").handler({ sessionId: b, message: "hop1" }, ctxA);
    await tool("send_to_session").handler({ sessionId: a, message: "hop2" }, ctxB);
    await tool("send_to_session").handler({ sessionId: b, message: "hop3" }, ctxA);
    await tool("send_to_session").handler({ sessionId: a, message: "hop4" }, ctxB);
    // A's next relay would be hop 5 → substrate refusal, no doctrine involved.
    await expect(tool("send_to_session").handler({ sessionId: b, message: "hop5" }, ctxA)).rejects.toThrow(
      /400.*hop budget/is,
    );
    // hop tags rode the delivered banners
    const hop4 = registry.getMessages(a).at(-1)!;
    expect(hop4.content).toContain(`hop 4/4`);

    // A genuine operator message to A resets its chain — A can send again.
    const op = await apiFetch()(`http://gateway.test/api/sessions/${a}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ message: "operator says: wrap up" }),
    });
    expect(op.status).toBe(200);
    const again = (await tool("send_to_session").handler({ sessionId: b, message: "fresh chain" }, ctxFor(a))) as {
      status: string;
    };
    expect(again.status).toBe("queued");
  });

  it("stop is scoped to descendants for agents: grandchild ok, peer 403, bearer operator unrestricted", async () => {
    const root = await createOperatorSession("root");
    const rootCtx = ctxFor(root);
    const child = (await tool("spawn_session").handler({ prompt: "c", engine: "codex" }, rootCtx)) as { sessionId: string };
    const grandchild = (await tool("spawn_session").handler({ prompt: "g", engine: "codex" }, ctxFor(child.sessionId))) as {
      sessionId: string;
    };
    const peer = await createOperatorSession("peer");

    // transitive descendant → allowed
    const ok = (await tool("stop_session").handler({ sessionId: grandchild.sessionId }, rootCtx)) as { action: string };
    expect(ok.action).toBe("stopped");

    // a peer is not root's descendant → 403 through the tool, readable
    await expect(tool("stop_session").handler({ sessionId: peer }, rootCtx)).rejects.toThrow(/403.*descendant/is);

    // authenticated operator authority keeps full access
    const op = await apiFetch()(`http://gateway.test/api/sessions/${peer}/stop`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(op.status).toBe(200);
  });
});

/* ── GRS-017 finding 2 — fail-closed session-tool authority at the routes ────── */

describe("fail-closed session-tool authority (codex review finding 2 regression)", () => {
  it("REVIEW REPRO: a tool-marked stop with NO caller identity is REFUSED and stops nothing — it must never fall through to the unrestricted operator route", async () => {
    const victim = await createOperatorSession("victim");
    registry.updateSession(victim, { status: "running" });
    const resp = await apiFetch()(`http://gateway.test/api/sessions/${victim}/stop`, {
      method: "POST",
      headers: { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE },
    });
    expect(resp.status).toBe(403);
    expect(await resp.text()).toMatch(/caller identity unavailable/i);
    // The review's proof of fail-open was {"status":"stopped"} + target idle. Now: untouched.
    expect(registry.getSession(victim)!.status).toBe("running");
  });

  it("a tool-marked message with NO caller identity is REFUSED — it must not become an unguarded, unprefixed user message", async () => {
    const target = await createOperatorSession("target");
    const before = registry.getMessages(target).length;
    const resp = await apiFetch()(`http://gateway.test/api/sessions/${target}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE },
      body: JSON.stringify({ message: "smuggled instruction" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.text()).toMatch(/caller identity unavailable/i);
    expect(registry.getMessages(target).length).toBe(before);
  });

  it("bearer operator requests keep parentless spawn, plain message, and unrestricted stop working", async () => {
    const anon = await apiFetch()("http://gateway.test/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ prompt: "operator spawn", engine: "codex" }),
    });
    expect(anon.status).toBe(201);
    const anonId = (JSON.parse(await anon.text()) as { id: string }).id;
    expect(registry.getSession(anonId)!.parentSessionId).toBeFalsy();

    const msg = await apiFetch()(`http://gateway.test/api/sessions/${anonId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ message: "operator note" }),
    });
    expect(msg.status).toBe(200);

    const stop = await apiFetch()(`http://gateway.test/api/sessions/${anonId}/stop`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(stop.status).toBe(200);
    expect((JSON.parse(await stop.text()) as { status: string }).status).toBe("stopped");
  });

  it("marker + VALID identity keeps working and stays scoped: child spawn linked, peer stop refused, own child stop allowed", async () => {
    const parent = await createOperatorSession("scoped parent");
    const ctx = ctxFor(parent); // the tools now always send the marker alongside the identity
    const child = (await tool("spawn_session").handler({ prompt: "c", engine: "codex" }, ctx)) as { sessionId: string };
    expect(registry.getSession(child.sessionId)!.parentSessionId).toBe(parent);

    const peer = await createOperatorSession("scoped peer");
    await expect(tool("stop_session").handler({ sessionId: peer }, ctx)).rejects.toThrow(/403.*descendant/is);

    const ok = (await tool("stop_session").handler({ sessionId: child.sessionId }, ctx)) as { action: string };
    expect(ok.action).toBe("stopped");
  });
});
