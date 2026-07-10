import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, UNIDENTIFIED_TOOL_CALL_ERROR } from "./identity.js";

/**
 * Shared plumbing for jinn MCP tools (GRS-015): the tool/context contracts and the
 * thin gateway HTTP client every tool group builds on. Extracted from `server.ts`
 * so tool groups (`workflow-tools.ts`, later org/session groups) and the protocol
 * server can share them without an import cycle. `server.ts` re-exports everything
 * here, so existing importers are unaffected.
 *
 * The KISS guardrail stands: tools are deterministic HTTP wrappers over gateway
 * routes — no state, no scheduler, no LLM inside the tool server
 * (`reports/research/GRS-012d-0-typed-mcp-catalog.md` admission rule 1).
 */

/** Runtime context handed to every tool: how to reach the gateway. */
export interface JinnMcpContext {
  /** Base URL of the local gateway, e.g. `http://127.0.0.1:7777`. */
  gatewayUrl: string;
  /** Bearer token for privileged gateway endpoints. Undefined when the gateway
   *  runs with auth disabled (sandbox/QA). Read from inherited env, never argv. */
  token?: string;
  /** The calling session's id (GRS-017a identity seam — from the JINN_SESSION_ID
   *  env the gateway stamps on the per-session server spec). */
  callerSessionId?: string;
  /** Per-session capability minted by the gateway and stamped into the built-in
   *  jinn server env. Scoped write routes verify this value against
   *  callerSessionId before treating a tool-marked call as that session. */
  sessionCapability?: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-request budget in ms (default {@link GATEWAY_TIMEOUT_MS}); tests shrink it. */
  timeoutMs?: number;
}

/**
 * Default per-request budget (Codex GRS-015 finding 3 — a wedged gateway must
 * never hang a tool call forever). 30s, argued: the slowest tool-backed route is
 * POST …/run, which drives a full advancement pass INCLUDING a real engine-session
 * spawn — seconds on a loaded machine, never minutes — so 30s clears every honest
 * request with wide margin while still bounding a stalled socket within one
 * conversational beat. Everything else on the belt is a file-backed read/write
 * that answers in milliseconds.
 */
export const GATEWAY_TIMEOUT_MS = 30_000;

/** A Jinn MCP tool. `handler` throws `JinnMcpToolError` (or any Error) on failure;
 *  the dispatcher converts that into an MCP `isError` tool result. */
export interface JinnMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: JinnMcpContext) => Promise<unknown>;
}

/** A tool-level failure surfaced to the engine as an MCP error result (not a
 *  protocol error) so the model can read and react to it. */
export class JinnMcpToolError extends Error {}

export function assertBoundCaller(ctx: JinnMcpContext): asserts ctx is JinnMcpContext & { callerSessionId: string; sessionCapability: string } {
  if (!ctx.callerSessionId || !ctx.sessionCapability) throw new JinnMcpToolError(UNIDENTIFIED_TOOL_CALL_ERROR);
}

/**
 * Send one gateway request and parse the JSON response (non-JSON bodies come back
 * as raw text). Never throws on HTTP status — callers decide what each status
 * means for their tool (a 400's structured validation errors are DATA the agent
 * self-corrects from, not an exception to swallow).
 *
 * TRANSPORT failures, however, are wrapped here (Codex GRS-015 findings 2+3):
 *   - the whole request INCLUDING the response body is raced against a timeout
 *     (Promise.race + AbortController — the race bounds even a fetch stub/impl
 *     that ignores the signal; the abort lets real implementations clean up);
 *   - a fetch rejection (ECONNREFUSED, socket reset mid-upload, DNS) is rethrown
 *     as a structured JinnMcpToolError carrying method/route/gateway context —
 *     a bare "fetch failed" never reaches the agent.
 */
export async function gatewayRequest(
  ctx: JinnMcpContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const base = ctx.gatewayUrl.replace(/\/+$/, "");
  const url = `${base}${pathAndQuery}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  // Tool-origin marker + bound identity (GRS-017/018/021c). The marker rides on
  // EVERY tool request — with it, the gateway can tell "tool call that LOST its
  // identity/capability" (fail closed on scoped writes) from a genuine
  // operator/UI request (no marker, unrestricted). See mcp/identity.ts.
  headers[TOOL_CALL_HEADER] = TOOL_CALL_HEADER_VALUE;
  if (ctx.callerSessionId) headers[CALLER_SESSION_HEADER] = ctx.callerSessionId;
  if (ctx.sessionCapability) headers[CALLER_SESSION_CAPABILITY_HEADER] = ctx.sessionCapability;
  const ac = new AbortController();
  const init: RequestInit = { method, headers, signal: ac.signal };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const doFetch = ctx.fetchFn ?? fetch;
  const timeoutMs = ctx.timeoutMs ?? GATEWAY_TIMEOUT_MS;

  const attempt = (async () => {
    const res = await doFetch(url, init);
    return { status: res.status, text: await res.text() };
  })();
  // The raced-out attempt may still settle later (e.g. the abort rejects it) —
  // swallow that so a timeout never becomes an unhandled rejection.
  attempt.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(
        new JinnMcpToolError(
          `gateway ${method} ${pathAndQuery} timed out after ${timeoutMs}ms — the gateway at ${base} may be wedged or unhealthy. Retry; if it persists, check the gateway process.`,
        ),
      );
    }, timeoutMs);
  });

  let result: { status: number; text: string };
  try {
    result = await Promise.race([attempt, timeout]);
  } catch (e) {
    if (e instanceof JinnMcpToolError) throw e; // the timeout above
    const cause = e instanceof Error ? e.message : String(e);
    throw new JinnMcpToolError(
      `gateway ${method} ${pathAndQuery} failed before a response: ${cause} — could not reach the gateway at ${base}; check that it is running (and JINN_GATEWAY_URL points at it), then retry.`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let parsed: unknown = result.text;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    /* non-JSON body: keep the raw text */
  }
  return { status: result.status, body: parsed };
}

/** GET a gateway path (already including any query string) and parse JSON. */
export async function gatewayGet(
  ctx: JinnMcpContext,
  pathAndQuery: string,
): Promise<{ status: number; body: unknown }> {
  return gatewayRequest(ctx, "GET", pathAndQuery);
}
