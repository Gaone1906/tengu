import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnMcpContext, JinnMcpTool } from "./toolkit.js";
import { buildWorkflowTools } from "./workflow-tools.js";
import { buildSessionTools } from "./session-tools.js";
import { buildSearchTools } from "./search-tools.js";
import { buildKnowledgeTools } from "./knowledge-tools.js";
import { buildDelegationTools } from "./delegation-tools.js";
import { buildOrgTools } from "./org-tools.js";
import { buildWorkItemTools } from "./work-item-tools.js";
import { buildApprovalTools } from "./approval-tools.js";
import { buildCostTools } from "./cost-tools.js";
import { buildCronTools } from "./cron-tools.js";
import { buildFileTools } from "./file-tools.js";
import { JINN_SESSION_CAPABILITY_ENV, JINN_SESSION_ID_ENV } from "./identity.js";

/**
 * GRS-018 (§3b) — bearer resolution with a gateway.json fallback.
 *
 * Precedence: explicit opts.token → inherited JINN_GATEWAY_TOKEN env → the
 * `token` field of the 0600 `<JINN_HOME>/gateway.json`.
 *
 * Why the fallback exists: codex spawns MCP stdio servers with a CLEAN env
 * (probe-verified — ~8 baseline keys), so under codex the inherited-env channel
 * is cut and, with auth enabled, every builtin-jinn call would 401. The engine
 * adapters pass the non-secret JINN_HOME through their allowlisted per-session
 * config channel; this function then reads the token from the SAME 0600
 * same-uid file the gateway minted it into — the token itself never rides argv
 * or any jinn-written config. No widening: third-party servers get the scrubbed
 * env (no JINN_HOME grant), and a same-uid process could already read the file.
 */
export function resolveServerToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.JINN_GATEWAY_TOKEN) return process.env.JINN_GATEWAY_TOKEN;
  try {
    const home = process.env.JINN_HOME || path.join(os.homedir(), ".jinn");
    const raw = JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf-8")) as { token?: unknown };
    // Same shape check as auth.ts ensureGatewayAuthToken (>= 32 chars).
    if (typeof raw.token === "string" && raw.token.length >= 32) return raw.token;
  } catch {
    /* no file / unreadable / malformed — run unauthenticated as before */
  }
  return undefined;
}

/**
 * stderr-only diagnostics. An MCP stdio server MUST keep stdout pure for
 * newline-delimited JSON-RPC — the shared `logger` writes to stdout, so using it
 * here would corrupt the protocol stream (an engine would fail to parse the
 * server's first response). All server diagnostics go to stderr instead, which is
 * the MCP convention and where the spawning engine captures server logs.
 */
function serverLog(message: string): void {
  try {
    process.stderr.write(`[jinn-mcp] ${message}\n`);
  } catch {
    /* stderr closed — nothing we can do, and must not touch stdout */
  }
}

/**
 * GRS-012b + GRS-015 — the `jinn` MCP server.
 *
 * A minimal, hand-rolled MCP stdio server (JSON-RPC 2.0, newline-delimited) that
 * exposes typed Jinn company tools to any MCP-capable engine (Claude / Codex /
 * Hermes / Grok): the org read tool plus the GRS-015 workflow group (create /
 * inspect / run — gate RESOLUTION is deliberately human-only and stays on the
 * HTTP route; see `workflow-tools.ts`). It is a *thin HTTP client
 * to the local gateway* — it holds no state of its own (no org model, scheduler,
 * memory store, workflow runtime, or session engine) and simply calls the same
 * gateway routes the web UI and tests call. Workflow runs are live operations on
 * that gateway and may spawn real sessions; isolated instances are for experiments. This is the KISS
 * guardrail from `reports/research/GRS-012-mcp-auto-attach-design.md` §3/§8.
 *
 * Why hand-rolled instead of `@modelcontextprotocol/sdk`: the repo has no MCP SDK
 * dependency, and adding one would trip the machine's pnpm 7-day age gate and grow
 * the dependency surface. The MCP stdio wire protocol is small enough (a handful of
 * JSON-RPC methods) to implement directly and test as pure functions.
 *
 * Security: the gateway bearer token is read from the *inherited environment*
 * (`JINN_GATEWAY_TOKEN`), never serialized into argv, a config file, or a prompt.
 * The gateway URL (`JINN_GATEWAY_URL`, non-secret) may be passed via config/env.
 */

/** The MCP wire protocol version this server speaks. It echoes the client's
 *  requested version when present (forward/backward tolerant), else this default. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "jinn";
const SERVER_VERSION = "0.9.0"; // 0.9: GRS-020c/d cost+cron reads; 0.8: GRS-021c Todo/work-item verbs; 0.7: scoped knowledge; 0.6: company-reference search; 0.5: delegation transaction; 0.4: org group + measured diet; 0.3: sessions group + identity seam

// The tool/context contracts + gateway HTTP client live in toolkit.ts (shared by
// tool groups without an import cycle); re-exported here so existing importers
// keep working.
export { gatewayGet, gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

/**
 * Build the full tool set: the GRS-017b org group + the GRS-017a sessions
 * group + the GRS-020a company-reference search group + the GRS-020b scoped
 * knowledge group + GRS-020c cost-only read + GRS-020d cron reads + the
 * GRS-017d delegation transaction + the GRS-021c Todo/work-item group + the
 * COO-default approval decision group + managed-file reads + the GRS-015
 * workflow group.
 * Growth discipline: the belt budget lives in the GRS-017 design §7 and the
 * GRS-020 design §4 (net context diet positive — measured in
 * mcp/__tests__/context-diet.test.ts and knowledge-diet.test.ts); at this
 * size (44) the hand-rolled protocol below is still comfortably sufficient —
 * revisit the SDK question only if a future group needs capabilities beyond
 * tools/list + tools/call (resources, prompts, progress).
 */
export function buildTools(): JinnMcpTool[] {
  return [
    ...buildOrgTools(),
    ...buildSessionTools(),
    ...buildSearchTools(),
    ...buildKnowledgeTools(),
    ...buildCostTools(),
    ...buildCronTools(),
    ...buildDelegationTools(),
    ...buildWorkItemTools(),
    ...buildApprovalTools(),
    ...buildFileTools(),
    ...buildWorkflowTools(),
  ];
}

// --- JSON-RPC plumbing -------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle a single parsed JSON-RPC message. Returns the response to write, or
 * `null` for notifications (no `id`) and other no-reply messages. Pure except for
 * the gateway HTTP call a `tools/call` makes through `ctx` — so it is directly
 * unit-testable with a stub fetch.
 */
export async function handleMcpRequest(
  msg: JsonRpcRequest,
  tools: JinnMcpTool[],
  ctx: JinnMcpContext,
): Promise<JsonRpcResponse | null> {
  const method = msg.method;
  const id = msg.id ?? null;

  // A JSON-RPC message with no `id` is a NOTIFICATION and must never receive a
  // response — regardless of its method (an `initialized` notification, or even a
  // no-id `ping`). Requests always carry an id, so returning null here is safe for
  // the real request methods below (which the client always sends with an id).
  if (msg.id === undefined) return null;
  if (typeof method === "string" && method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    const requested = (msg.params?.protocolVersion as string | undefined) ?? undefined;
    return ok(id, {
      protocolVersion: typeof requested === "string" && requested ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (method === "tools/list") {
    return ok(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      // Unknown tool name is a tool-result error (the model can read + recover),
      // not a JSON-RPC protocol error.
      return ok(id, {
        content: [{ type: "text", text: `Error: unknown tool "${String(name)}"` }],
        isError: true,
      });
    }
    try {
      const result = await tool.handler(args, ctx);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return ok(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    }
  }

  // Unknown method on a request (id present): reply with a protocol error.
  return rpcError(id, -32601, `Method not found: ${String(method)}`);
}

/**
 * Run the stdio MCP server: read newline-delimited JSON-RPC from stdin, dispatch,
 * write newline-delimited JSON-RPC responses to stdout. Blocks (keeps the process
 * alive) until stdin closes.
 */
export function runJinnMcpServer(opts?: {
  gatewayUrl?: string;
  token?: string;
  callerSessionId?: string;
  sessionCapability?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): void {
  const ctx: JinnMcpContext = {
    gatewayUrl: opts?.gatewayUrl ?? process.env.JINN_GATEWAY_URL ?? "http://127.0.0.1:7777",
    token: resolveServerToken(opts?.token),
    // GRS-017/018/021c identity seam: the gateway stamps the calling session id
    // and its bound capability on the per-session server spec (mcp/identity.ts);
    // both ride every gateway call so scoped writes can reject spoofed ids.
    callerSessionId: opts?.callerSessionId ?? process.env[JINN_SESSION_ID_ENV] ?? undefined,
    sessionCapability: opts?.sessionCapability ?? process.env[JINN_SESSION_CAPABILITY_ENV] ?? undefined,
  };
  const tools = buildTools();
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  serverLog(
    `server started (gateway ${ctx.gatewayUrl}, ${tools.length} tools, auth ${ctx.token ? "on" : "off"}, caller ${ctx.callerSessionId ?? "none"})`,
  );

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      serverLog(`unparseable line: ${trimmed.slice(0, 120)}`);
      return;
    }
    // Each line is handled independently; a slow gateway call must not block
    // parsing subsequent lines, and each response is a single atomic write.
    void handleMcpRequest(msg, tools, ctx)
      .then((resp) => {
        if (resp) output.write(JSON.stringify(resp) + "\n");
      })
      .catch((e) => {
        serverLog(`handler error: ${e instanceof Error ? e.message : String(e)}`);
        if (msg.id !== undefined && msg.id !== null) {
          output.write(JSON.stringify(rpcError(msg.id, -32603, "Internal error")) + "\n");
        }
      });
  });
}
