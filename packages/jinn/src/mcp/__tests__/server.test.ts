import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTools,
  gatewayGet,
  handleMcpRequest,
  JinnMcpToolError,
  type JinnMcpContext,
  type JinnMcpTool,
} from "../server.js";

/**
 * GRS-012b — the jinn MCP stdio server.
 *
 * The stdio loop (runJinnMcpServer) is a thin wrapper; the protocol logic lives in
 * the pure `handleMcpRequest` + the tool handlers, which is what these tests pin:
 * the JSON-RPC handshake, tool discovery, a real tool call (via a stub fetch), and
 * the error surfaces. No network, no subprocess.
 */

/** Build a context whose fetch returns a canned response for one URL. */
function stubCtx(
  responder: (url: string) => { status: number; body: unknown },
): JinnMcpContext {
  const fetchFn = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = responder(url);
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    gatewayUrl: "http://127.0.0.1:7777",
    token: "t0ken",
    callerSessionId: "session-test",
    sessionCapability: "cap-test",
    fetchFn,
  };
}

describe("gatewayGet", () => {
  it("joins base + path, sends bearer auth, and parses JSON", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://127.0.0.1:7788/",
      token: "abc",
      fetchFn: (async (input: string | URL, init?: RequestInit) => {
        seenUrl = typeof input === "string" ? input : input.toString();
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return { status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    const { status, body } = await gatewayGet(ctx, "/api/org");
    // Trailing slash on base is normalized (no `//api`).
    expect(seenUrl).toBe("http://127.0.0.1:7788/api/org");
    expect(seenAuth).toBe("Bearer abc");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("omits the auth header when no token (sandbox auth-disabled)", async () => {
    let seenAuth: string | undefined = "unset";
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://127.0.0.1:7799",
      fetchFn: (async (_input: string | URL, init?: RequestInit) => {
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return { status: 200, text: async () => "[]" } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    await gatewayGet(ctx, "/api/org");
    expect(seenAuth).toBeUndefined();
  });

  it("returns the raw text body when the response is not JSON", async () => {
    const ctx = stubCtx(() => ({ status: 500, body: "boom" }));
    const { status, body } = await gatewayGet(ctx, "/api/org");
    expect(status).toBe(500);
    expect(body).toBe("boom");
  });
});

describe("buildTools", () => {
  it("exposes exactly the admitted org/session/reference/knowledge/delegation/Todo/workflow groups (scope discipline; NO gate-resolve, NO session-delete, NO cancel Todo tool)", () => {
    const names = buildTools().map((t) => t.name).sort();
    expect(names).toEqual([
      "jinn_assign_work_item",
      "jinn_cost_report",
      "jinn_create_trigger",
      "jinn_create_work_item",
      "jinn_create_workflow",
      "jinn_decide_work_item_approval",
      "jinn_delegate_task",
      "jinn_delete_trigger",
      "jinn_escalate_work_item_approval",
      "jinn_find_employees",
      "jinn_get_cron_run_history",
      "jinn_get_employee",
      "jinn_get_message_context",
      "jinn_get_work_item",
      "jinn_get_workflow",
      "jinn_get_workflow_run",
      "jinn_list_cron_jobs",
      "jinn_list_employees",
      "jinn_list_files",
      "jinn_list_sessions",
      "jinn_list_triggers",
      "jinn_list_work_items",
      "jinn_list_workflow_runs",
      "jinn_list_workflows",
      "jinn_plan_workflow",
      "jinn_read_file",
      "jinn_read_knowledge",
      "jinn_read_session",
      "jinn_retire_workflow",
      "jinn_search_knowledge",
      "jinn_search_messages",
      "jinn_search_sessions",
      "jinn_search_work_items",
      "jinn_send_to_session",
      "jinn_spawn_session",
      "jinn_start_workflow_run",
      "jinn_stop_session",
      "jinn_update_work_item",
      "jinn_update_workflow",
      "jinn_validate_workflow",
    ]);
  });

  it("jinn_get_workflow declares workflowId as required", () => {
    const wf = buildTools().find((t) => t.name === "jinn_get_workflow")!;
    expect(wf.inputSchema.required).toEqual(["workflowId"]);
  });
});

describe("handleMcpRequest — protocol", () => {
  const tools = buildTools();
  const ctx = stubCtx(() => ({ status: 200, body: {} }));

  it("initialize echoes the client protocol version + advertises tools + serverInfo", async () => {
    const resp = await handleMcpRequest(
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      tools,
      ctx,
    );
    expect(resp).not.toBeNull();
    const result = resp!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as Record<string, unknown>).name).toBe("jinn");
  });

  it("initialize falls back to a default protocol version when the client omits one", async () => {
    const resp = await handleMcpRequest({ id: 1, method: "initialize", params: {} }, tools, ctx);
    expect((resp!.result as Record<string, unknown>).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("notifications/initialized produces no response", async () => {
    const resp = await handleMcpRequest({ method: "notifications/initialized" }, tools, ctx);
    expect(resp).toBeNull();
  });

  it("a no-id message (notification) gets NO response even for a normal method", async () => {
    // JSON-RPC: absent id ⇒ notification ⇒ must never be answered, whatever the method.
    expect(await handleMcpRequest({ method: "ping" }, tools, ctx)).toBeNull();
    expect(await handleMcpRequest({ method: "tools/list" }, tools, ctx)).toBeNull();
  });

  it("ping replies with an empty result", async () => {
    const resp = await handleMcpRequest({ id: 7, method: "ping" }, tools, ctx);
    expect(resp).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("tools/list returns every tool with name/description/inputSchema", async () => {
    const resp = await handleMcpRequest({ id: 2, method: "tools/list" }, tools, ctx);
    const list = (resp!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(list.map((t) => t.name)).toEqual(buildTools().map((t) => t.name));
    for (const t of list) expect(t).toHaveProperty("inputSchema");
  });

  it("unknown method (with id) yields a -32601 protocol error", async () => {
    const resp = await handleMcpRequest({ id: 9, method: "does/notExist" }, tools, ctx);
    expect(resp!.error?.code).toBe(-32601);
  });
});

describe("handleMcpRequest — tools/call", () => {
  it("jinn_list_employees returns real gateway data as text content", async () => {
    const org = { employees: [{ name: "chief-of-staff", rank: "manager" }] };
    const ctx = stubCtx((url) => {
      expect(url).toBe("http://127.0.0.1:7777/api/org");
      return { status: 200, body: org };
    });
    const resp = await handleMcpRequest(
      { id: 3, method: "tools/call", params: { name: "jinn_list_employees", arguments: {} } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual(org);
  });

  it("jinn_get_workflow encodes the id into the definitions path and returns the editable definition (GRS-015 semantics)", async () => {
    const def = { id: "sample-autonomy", title: "Sample Autonomy", version: 3, nodes: [], edges: [] };
    const ctx = stubCtx((url) => {
      expect(url).toBe("http://127.0.0.1:7777/api/workflow-definitions/sample-autonomy");
      return { status: 200, body: def };
    });
    const resp = await handleMcpRequest(
      { id: 4, method: "tools/call", params: { name: "jinn_get_workflow", arguments: { workflowId: "sample-autonomy" } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(def);
  });

  it("jinn_get_workflow with a missing id returns an isError tool result (not a crash)", async () => {
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 5, method: "tools/call", params: { name: "jinn_get_workflow", arguments: {} } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/workflowId is required/);
  });

  it("a gateway 404 becomes a readable isError tool result", async () => {
    const ctx = stubCtx(() => ({ status: 404, body: { error: "not found" } }));
    const resp = await handleMcpRequest(
      { id: 6, method: "tools/call", params: { name: "jinn_get_workflow", arguments: { workflowId: "nope" } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("an unknown tool name is an isError result, not a protocol error", async () => {
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 8, method: "tools/call", params: { name: "jinn_delete_everything", arguments: {} } },
      buildTools(),
      ctx,
    );
    expect(resp!.error).toBeUndefined();
    const result = resp!.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("JinnMcpToolError from a handler is surfaced as isError text", async () => {
    const throwing: JinnMcpTool = {
      name: "boom",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new JinnMcpToolError("kaboom");
      },
    };
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 10, method: "tools/call", params: { name: "boom", arguments: {} } },
      [throwing],
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: kaboom");
  });
});

/**
 * GRS-018 (§3b) — resolveServerToken: explicit → env → 0600 gateway.json.
 * The fallback is what makes an AUTHED codex→jinn call possible at all (codex
 * gives MCP servers a clean env, so inheritance never delivers the token).
 */
describe("resolveServerToken (gateway.json fallback)", () => {
  const ENV_KEYS = ["JINN_GATEWAY_TOKEN", "JINN_HOME"] as const;
  let backup: Record<string, string | undefined>;
  beforeEach(() => {
    backup = {};
    for (const k of ENV_KEYS) { backup[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  });

  it("explicit token wins over everything", async () => {
    const { resolveServerToken } = await import("../server.js");
    process.env.JINN_GATEWAY_TOKEN = "env-token-000000000000000000000000000000";
    expect(resolveServerToken("explicit-tok")).toBe("explicit-tok");
  });

  it("inherited env token wins over the file", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "file-token-00000000000000000000000000" }));
    process.env.JINN_HOME = home;
    process.env.JINN_GATEWAY_TOKEN = "env-token";
    expect(resolveServerToken()).toBe("env-token");
  });

  it("falls back to <JINN_HOME>/gateway.json when the env is clean (the codex case)", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    const fileToken = "file-token-0000000000000000000000000000"; // >= 32 chars
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: fileToken }));
    process.env.JINN_HOME = home;
    expect(resolveServerToken()).toBe(fileToken);
  });

  it("rejects short/malformed file tokens and survives a missing file", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    process.env.JINN_HOME = home;
    expect(resolveServerToken()).toBeUndefined(); // no file
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "short" }));
    expect(resolveServerToken()).toBeUndefined(); // too short (not a minted token)
    fs.writeFileSync(path.join(home, "gateway.json"), "not-json{");
    expect(resolveServerToken()).toBeUndefined(); // malformed
  });
});
