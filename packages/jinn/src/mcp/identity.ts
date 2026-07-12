import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedMcpConfig, McpServerStdioConfig } from "../shared/types.js";
import { resolveJinnHome, resolveMcpSessionCapabilityKeyFile } from "../shared/home.js";

export const MCP_SESSION_ID_ARG = "--jinn-session-id";
export const MCP_HOME_ARG = "--jinn-home";
export const MCP_GATEWAY_URL_ARG = "--jinn-gateway-url";
const MCP_BOOTSTRAP_ARGS = new Set([MCP_SESSION_ID_ARG, MCP_HOME_ARG, MCP_GATEWAY_URL_ARG]);

/** Remove per-session bootstrap flags before writing a process-global MCP config. */
export function stripMcpBootstrapArgs(args: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (MCP_BOOTSTRAP_ARGS.has(args[index])) {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
}

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

/** Per-tools/call correlation authored by the built-in Session-bound MCP server. */
export const ACTIVITY_OPERATION_HEADER = "x-jinn-activity-operation";
export const ACTIVITY_TOOL_HEADER = "x-jinn-activity-tool";

/** The shared refusal for a tool call that lost its identity — thrown by the
 *  tool handlers (local pre-check) and returned as the routes' 403 body
 *  (substrate backstop, so even a buggy/old tool build cannot fail open). */
export const UNIDENTIFIED_TOOL_CALL_ERROR =
  "caller identity unavailable — this jinn MCP server was launched without JINN_SESSION_ID/JINN_SESSION_CAPABILITY " +
  "(the engine may be stripping it from the MCP server env), so a scoped session operation " +
  "cannot be authorized. Session tools fail closed rather than inherit the operator's " +
  "unrestricted access: fix the engine's env wiring (or launch the server with " +
  "JINN_SESSION_ID and JINN_SESSION_CAPABILITY), or perform the operation as the operator via the web UI / HTTP API.";

const SESSION_CAPABILITY_KEY_BYTES = 32;
const SESSION_CAPABILITY_DOMAIN = "jinn:mcp-session-capability:v1\0";
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function decodeKey(raw: string, keyFile: string): Buffer {
  const encoded = raw.trim();
  if (!BASE64URL_256_PATTERN.test(encoded)) {
    throw new Error(`Invalid MCP session capability key at ${keyFile}`);
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== SESSION_CAPABILITY_KEY_BYTES) {
    throw new Error(`Invalid MCP session capability key at ${keyFile}`);
  }
  return key;
}

function readSessionCapabilityKey(keyFile: string): Buffer {
  return decodeKey(fs.readFileSync(keyFile, "utf-8"), keyFile);
}

function ensureSessionCapabilityKey(keyFile: string): Buffer {
  try {
    const key = readSessionCapabilityKey(keyFile);
    fs.chmodSync(keyFile, 0o600);
    return key;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const keyDir = path.dirname(keyFile);
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(keyDir, 0o700); } catch {}

  const encoded = crypto.randomBytes(SESSION_CAPABILITY_KEY_BYTES).toString("base64url");
  try {
    fs.writeFileSync(keyFile, `${encoded}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(keyFile, 0o600);
    return Buffer.from(encoded, "base64url");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another gateway process won the first-creation race. Its key is the
    // authority for both processes; never overwrite or silently rotate it.
    const key = readSessionCapabilityKey(keyFile);
    fs.chmodSync(keyFile, 0o600);
    return key;
  }
}

function deriveSessionCapability(sessionId: string, key: Buffer): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(SESSION_CAPABILITY_DOMAIN, "utf-8")
    .update(sessionId, "utf-8")
    .digest();
}

/**
 * Return the gateway-side capability for a session. The per-instance key is
 * persisted, but never propagated to engine children; only the derived,
 * session-scoped capability leaves the gateway. Determinism keeps warm/resumed
 * MCP servers valid across gateway process replacement.
 */
export function ensureSessionCapability(sessionId: string, keyFile = resolveMcpSessionCapabilityKeyFile()): string {
  if (!sessionId) throw new Error("Cannot derive an MCP session capability without a session id");
  return deriveSessionCapability(sessionId, ensureSessionCapabilityKey(keyFile)).toString("base64url");
}

export function verifySessionCapability(sessionId: string, capability: string, keyFile = resolveMcpSessionCapabilityKeyFile()): boolean {
  if (!sessionId || !BASE64URL_256_PATTERN.test(capability)) return false;
  try {
    const expected = deriveSessionCapability(sessionId, readSessionCapabilityKey(keyFile));
    const candidate = Buffer.from(capability, "base64url");
    if (candidate.toString("base64url") !== capability) return false;
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    // Missing, unreadable, or malformed authority state must never fall back to
    // operator access. The caller resolver treats false as unidentified-tool.
    return false;
  }
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
  const gatewayUrl = stdio.env?.JINN_GATEWAY_URL;
  return {
    ...resolved,
    mcpServers: {
      ...resolved.mcpServers,
      jinn: {
        ...stdio,
        args: [
          ...(stdio.args ?? []),
          MCP_SESSION_ID_ARG, sessionId,
          MCP_HOME_ARG, resolveJinnHome(),
          ...(gatewayUrl ? [MCP_GATEWAY_URL_ARG, gatewayUrl] : []),
        ],
        env: { ...(stdio.env ?? {}), [JINN_SESSION_ID_ENV]: sessionId, [JINN_SESSION_CAPABILITY_ENV]: capability },
      },
    },
  };
}
