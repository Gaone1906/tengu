import crypto from "node:crypto";
import type { ResolvedMcpConfig, McpServerStdioConfig } from "../shared/types.js";

/**
 * GRS-017a — the caller-identity seam.
 *
 * The built-in `jinn` MCP server is spawned per session by the engine; for the
 * gateway to know WHICH session is calling (parent auto-linkage on spawn, the
 * no-self / rate-cap / hop-budget guards on lateral sends, own-descendant
 * scoping on stop), the session's id rides:
 *
 *   manager.route() ── JINN_SESSION_ID + JINN_SESSION_CAPABILITY env on the jinn server spec (this module)
 *     → MCP server ctx (server.ts reads the env)
 *     → `x-jinn-caller-session` + `x-jinn-session-capability` headers on every gateway call (toolkit.ts)
 *     → the session routes read the header (api.ts)
 *
 * The session id is descriptive; the capability is the server-minted proof that
 * this particular built-in MCP process was provisioned for that session. It is
 * defense-in-depth for local, single-user Jinn: it prevents a prompt-injected
 * tool caller from spoofing another session's id on scoped writes. It is not an
 * internet auth boundary; the operator/global-token path remains unchanged.
 *
 * BEST-EFFORT DOES NOT MEAN FAIL-OPEN (GRS-017 codex finding 2). The MCP tools
 * always run ON BEHALF OF a session, so a tool call whose identity/capability
 * got LOST (an engine stripping env from the server) must be REFUSED for scoped
 * session operations — never routed down the no-header operator path, which is
 * genuinely unrestricted. To tell the two apart, every tool request carries
 * {@link TOOL_CALL_HEADER}: marker + bound identity → scoped session call;
 * marker WITHOUT a valid bound identity → fail closed; no marker →
 * operator/UI/internal, unchanged. The gateway side of this rule lives in
 * `gateway/session-comm-guards.ts#resolveCallerIdentity`.
 */

/** Env var carrying the calling session's id into the jinn MCP server process. */
export const JINN_SESSION_ID_ENV = "JINN_SESSION_ID";

/** Env var carrying the per-session capability into that session's jinn MCP server. */
export const JINN_SESSION_CAPABILITY_ENV = "JINN_SESSION_CAPABILITY";

/** Header carrying the calling session's id on gateway requests. */
export const CALLER_SESSION_HEADER = "x-jinn-caller-session";

/** Header carrying the per-session capability on gateway requests. */
export const CALLER_SESSION_CAPABILITY_HEADER = "x-jinn-session-capability";

/** Header marking a gateway request as originating from a jinn MCP TOOL call
 *  (sent unconditionally by the toolkit's gatewayRequest). Presence is the
 *  signal; the value is documentation. */
export const TOOL_CALL_HEADER = "x-jinn-tool-call";
export const TOOL_CALL_HEADER_VALUE = "jinn-mcp";

/** The shared refusal for a tool call that lost its identity — thrown by the
 *  tool handlers (local pre-check) and returned as the routes' 403 body
 *  (substrate backstop, so even a buggy/old tool build cannot fail open). */
export const UNIDENTIFIED_TOOL_CALL_ERROR =
  "caller identity unavailable — this jinn MCP server was launched without JINN_SESSION_ID/JINN_SESSION_CAPABILITY " +
  "(the engine may be stripping it from the MCP server env), so a scoped session operation " +
  "cannot be authorized. Session tools fail closed rather than inherit the operator's " +
  "unrestricted access: fix the engine's env wiring (or launch the server with " +
  "JINN_SESSION_ID and JINN_SESSION_CAPABILITY), or perform the operation as the operator via the web UI / HTTP API.";

const sessionCapabilities = new Map<string, string>();

/**
 * Return the gateway-side capability for a session, minting one on first use.
 * Reusing the value matters: multiple warm/resumed MCP servers for the same
 * session should not invalidate each other.
 */
export function ensureSessionCapability(sessionId: string): string {
  const existing = sessionCapabilities.get(sessionId);
  if (existing) return existing;
  const minted = crypto.randomBytes(32).toString("base64url");
  sessionCapabilities.set(sessionId, minted);
  return minted;
}

export function verifySessionCapability(sessionId: string, capability: string): boolean {
  return sessionCapabilities.get(sessionId) === capability;
}

/**
 * Return a copy of a resolved MCP server set with the session's id and bound
 * capability added to the built-in `jinn` server's env. Never mutates the input
 * (the resolver's output may be shared/cached by callers). No-op when the set
 * has no stdio `jinn` server (gateway MCP disabled, or a URL-based custom
 * server shadowing is impossible — the name is reserved).
 */
export function attachSessionIdentity(resolved: ResolvedMcpConfig, sessionId: string): ResolvedMcpConfig {
  const jinn = resolved.mcpServers["jinn"];
  if (!jinn || !("command" in jinn)) return resolved;
  const stdio = jinn as McpServerStdioConfig;
  const capability = ensureSessionCapability(sessionId);
  return {
    ...resolved,
    mcpServers: {
      ...resolved.mcpServers,
      jinn: { ...stdio, env: { ...(stdio.env ?? {}), [JINN_SESSION_ID_ENV]: sessionId, [JINN_SESSION_CAPABILITY_ENV]: capability } },
    },
  };
}
