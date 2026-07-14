import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { McpGlobalConfig, McpServerConfig, McpServerStdioConfig, McpServerUrlConfig, Employee, ResolvedMcpConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { wrapServersWithScrub } from "./env-scrub.js";
import { decideJinnAttachment } from "./attachment.js";

export type { ResolvedMcpConfig } from "../shared/types.js";

// The capability set lives in mcp/attachment.ts (the attachment decision
// consults it; keeping it there avoids an import cycle) and is re-exported
// here so existing importers (sessions/manager, gateway/api, engine adapters,
// tests) keep their single accustomed source.
export { MCP_CAPABLE_ENGINES, isMcpCapableEngine } from "./attachment.js";

/**
 * Resolve the MCP servers that should be available for a given employee
 * based on global config and employee-level overrides.
 *
 * GRS-017e: membership of the built-in `jinn` server is decided in exactly ONE
 * place — `decideJinnAttachment` (mcp/attachment.ts), composing the master
 * flag × engine capability × per-engine opt-out × per-employee override × the
 * authed-smoke gate. `engine` is optional for backward compatibility: when
 * omitted, the caller has already gated on `isMcpCapableEngine` (both
 * production call sites do) and per-engine opt-outs cannot apply.
 */
export function resolveMcpServers(
  globalMcp: McpGlobalConfig | undefined,
  employee?: Employee,
  engine?: string,
): ResolvedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};
  const jinnDecision = decideJinnAttachment({ globalMcp, employee, engine });

  if (!globalMcp) {
    // No `mcp:` section at all. A per-employee force-on (jinnMcp: true) still
    // attaches the builtin — the pilot needs no other MCP config — otherwise
    // today's empty set, byte-identical.
    if (jinnDecision.attach) servers.jinn = buildJinnServerSpec();
    return { mcpServers: servers };
  }

  // Build the full set of available MCP servers from global config
  const available = buildAvailableServers(globalMcp, jinnDecision.attach);

  // Determine which servers this employee gets
  const employeeMcp = employee?.mcp;

  if (employeeMcp === false) {
    // Employee explicitly opted out of all MCP servers. jinnMcp: true is more
    // specific and wins for the builtin only (decided above).
    return { mcpServers: jinnDecision.attach ? { jinn: available.jinn ?? buildJinnServerSpec() } : {} };
  }

  if (Array.isArray(employeeMcp)) {
    // Employee wants only specific servers
    for (const name of employeeMcp) {
      if (name === "jinn") {
        // The builtin is governed by the attachment decision, not availability;
        // copying here (list order) keeps the pre-017e set shape when attached.
        if (jinnDecision.attach) servers.jinn = available.jinn ?? buildJinnServerSpec();
        else logger.warn(`Employee ${employee?.name} requests MCP server "jinn" but it is not attached: ${jinnDecision.reason}`);
        continue;
      }
      if (available[name]) {
        servers[name] = available[name];
      } else {
        logger.warn(`Employee ${employee?.name} requests MCP server "${name}" but it's not configured`);
      }
    }
    // Force-on (jinnMcp: true) attaches even when the allowlist omits "jinn".
    if (jinnDecision.attach && !servers.jinn) servers.jinn = available.jinn ?? buildJinnServerSpec();
  } else {
    // Employee gets all enabled servers (default behavior, or mcp: true)
    Object.assign(servers, available);
  }

  return { mcpServers: servers };
}

/**
 * The built-in `jinn` MCP server spec — command = the same node running the
 * gateway; args = the compiled entry that sits next to this module in dist
 * (`import.meta.url` resolves it robustly across worktree/dist without a
 * hardcoded path). REQUIRED non-secret env (GRS-018 unified model):
 *   - JINN_GATEWAY_URL: so a non-default sandbox port is reachable.
 *   - JINN_HOME: so the server can fall back to reading its bearer from the
 *     0600 <JINN_HOME>/gateway.json when the engine gives MCP subprocesses a
 *     CLEAN env (codex does — probe-verified) and the token therefore cannot
 *     arrive by inheritance. Same-uid trust boundary the token already lives
 *     in; the token itself is still NEVER serialized into a config file or
 *     CLI arg (design doc §3, Codex [Major]).
 *   - JINN_SESSION_ID joins this set per session via attachSessionIdentity
 *     (mcp/identity.ts), not here — the resolver output is session-agnostic.
 */
function buildJinnServerSpec(): McpServerStdioConfig {
  const entry = fileURLToPath(new URL("./server-entry.js", import.meta.url));
  const server: McpServerStdioConfig = { command: process.execPath, args: [entry] };
  const url = process.env.JINN_GATEWAY_URL;
  server.env = { ...(url ? { JINN_GATEWAY_URL: url } : {}), JINN_HOME };
  return server;
}

/**
 * Build the map of all available (enabled) MCP servers from global config.
 * `attachJinn` is the GRS-017e attachment decision (decideJinnAttachment) —
 * jinn membership is decided there, never here; this function only places the
 * spec at its pre-017e position so attached sets keep their exact shape.
 */
function buildAvailableServers(config: McpGlobalConfig, attachJinn: boolean): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Browser automation via Playwright
  // NOTE: these must be REAL npm packages. The previous specs pointed at
  // @anthropic-ai/mcp-server-{playwright,puppeteer}, which do not exist on
  // npm — the server never attached, and worse, engine adapters serialized the
  // dead spec as a per-session override that SHADOWED a working browser MCP in
  // the engine's own user config (found via FitBot QA browser-hands test,
  // 2026-07-11). @playwright/mcp is the official Playwright MCP server.
  if (config.browser?.enabled !== false) {
    const provider = config.browser?.provider || "playwright";
    if (provider === "playwright") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      };
    } else if (provider === "puppeteer") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      };
    }
  }

  // Web search via Brave
  if (config.search?.enabled) {
    const apiKey = resolveEnvVar(config.search.apiKey);
    if (apiKey) {
      servers.search = {
        command: "npx",
        args: ["-y", "brave-search-mcp"],
        env: { BRAVE_API_KEY: apiKey },
      };
    } else {
      logger.warn("MCP search enabled but no API key configured (set mcp.search.apiKey or BRAVE_API_KEY env var)");
    }
  }

  // Web fetch (content extraction)
  // NOTE: the official reference fetch server (mcp-server-fetch) is a Python
  // package run via uvx; the previous @anthropic-ai/mcp-server-fetch npm spec
  // does not exist on npm and never attached (same class of bug as browser
  // above). Requires uv to be installed (https://docs.astral.sh/uv/).
  if (config.fetch?.enabled) {
    servers.fetch = {
      command: "uvx",
      args: ["mcp-server-fetch"],
    };
  }

  // Built-in `jinn` MCP server — exposes company primitives (org, sessions,
  // work items, workflows, …) to MCP-capable engines as a thin HTTP client to
  // the local gateway (GRS-012b). Membership was decided by
  // decideJinnAttachment (GRS-017e): v0.26 defaults the built-in belt ON for
  // upgraded instances with no new MCP block. `mcp.gateway.enabled: false`
  // remains the explicit kill switch.
  if (attachJinn) {
    servers.jinn = buildJinnServerSpec();
  }

  // Custom user-defined MCP servers
  if (config.custom) {
    for (const [name, serverConfig] of Object.entries(config.custom)) {
      if (serverConfig.enabled === false) continue;
      // `jinn` is a RESERVED name for the built-in gateway server. A custom server
      // must never override it — otherwise engine adapters that treat `jinn` as the
      // trusted built-in (e.g. the grok/codex MCP wiring, which assume it carries no
      // secret in command/args) could serialize a user-controlled spec's secret args
      // to disk/argv. Skip a custom `jinn` with a warning (GRS-012c, Codex review).
      if (name === "jinn") {
        logger.warn(`Ignoring custom MCP server "jinn": that name is reserved for the built-in gateway server.`);
        continue;
      }
      const { enabled, ...rest } = serverConfig;

      // URL-based MCP server (HTTP/SSE transport)
      // Claude Code requires "type": "sse" for URL-based servers
      if ("url" in rest && (rest as McpServerUrlConfig).url) {
        servers[name] = { type: "sse", ...rest } as McpServerConfig;
        continue;
      }

      // Stdio-based MCP server — resolve env vars into a FRESH object. The
      // `...rest` spread is shallow, so `rest.env` still aliases the shared config's
      // nested env; mutating it in place would permanently expand `${SECRET}` into
      // the live config (and, now that this resolver runs for every MCP-capable
      // engine per session, do so repeatedly on shared state). Build a new map so
      // the resolver stays pure and idempotent.
      if ("env" in rest && rest.env) {
        const resolvedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(rest.env)) {
          resolvedEnv[key] = resolveEnvVar(value) || value;
        }
        (rest as McpServerStdioConfig).env = resolvedEnv;
      }
      servers[name] = rest as McpServerConfig;
    }
  }

  // GRS-018 hardening (§3a): wrap every NON-builtin stdio server's command in
  // the env-scrub launcher so the vendor CLI cannot forward JINN_GATEWAY_TOKEN
  // to the third-party server subprocess it spawns. The builtin `jinn` server
  // is exempt (its inherited token is the proven auth path); URL servers have
  // no command to wrap. Applied here — the single choke point every engine's
  // resolved set flows through — so the guarantee is engine-independent.
  return wrapServersWithScrub(servers);
}

/**
 * Write a resolved MCP config to a temp file and return the path.
 * Claude Code reads this via --mcp-config <path>.
 */
export function writeMcpConfigFile(config: ResolvedMcpConfig, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const tmpDir = path.join(JINN_HOME, "tmp", "mcp", safeSessionId);
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(tmpDir, 0o700); } catch { /* best effort on filesystems without POSIX modes */ }
  const filePath = path.join(tmpDir, "config.json");
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on filesystems without POSIX modes */ }
  return filePath;
}

/**
 * Clean up a temp MCP config file.
 */
export function cleanupMcpConfigFile(sessionId: string): void {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const dirPath = path.join(JINN_HOME, "tmp", "mcp", safeSessionId);
  const filePath = path.join(dirPath, "config.json");
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.rmdirSync(dirPath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resolve a value that may reference an environment variable.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
