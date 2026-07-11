import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { stripMcpBootstrapArgs } from "../mcp/identity.js";

const JINN_BUILTIN_SERVER = "jinn";
const MANAGED_ENV_KEY = "JINN_MCP_MANAGED_BY";
const SAFE_ENV_KEYS = new Set(["JINN_GATEWAY_URL", "JINN_HOME"]);

export const ANTIGRAVITY_JINN_MCP_MARKER = "jinn-managed-antigravity";

export type AntigravityMcpConfigHandle =
  | { attached: false; reason?: string }
  | { attached: true; configPath: string; released?: boolean };

interface ActiveConfig {
  count: number;
}

const activeConfigs = new Map<string, ActiveConfig>();

function defaultConfigPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

function jinnServer(resolvedMcp: ResolvedMcpConfig | undefined): McpServerStdioConfig | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (spec && typeof spec.command === "string" && spec.command && spec.url === undefined) return spec;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isManagedJinnServer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const env = value.env;
  return isRecord(env) && env[MANAGED_ENV_KEY] === ANTIGRAVITY_JINN_MCP_MARKER;
}

function readConfig(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    logger.warn(`Antigravity MCP attach skipped: ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function renderJinnServer(spec: McpServerStdioConfig): McpServerStdioConfig {
  const env: Record<string, string> = { [MANAGED_ENV_KEY]: ANTIGRAVITY_JINN_MCP_MARKER };
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (SAFE_ENV_KEYS.has(key)) env[key] = value;
  }
  return {
    command: spec.command,
    args: stripMcpBootstrapArgs(spec.args),
    env,
  };
}

export function antigravityJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnServer(resolvedMcp);
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  return sessionId && capability ? { JINN_SESSION_ID: sessionId, JINN_SESSION_CAPABILITY: capability } : {};
}

export function ensureAntigravityJinnMcpConfig(
  resolvedMcp: ResolvedMcpConfig | undefined,
  opts?: { configPath?: string },
): AntigravityMcpConfigHandle {
  const spec = jinnServer(resolvedMcp);
  if (!spec) return { attached: false, reason: "no built-in jinn MCP server in resolved config" };

  const configPath = opts?.configPath ?? defaultConfigPath();
  const active = activeConfigs.get(configPath);
  if (active) {
    active.count += 1;
    return { attached: true, configPath };
  }

  const config = readConfig(configPath);
  if (!config) return { attached: false, reason: "invalid config JSON" };

  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  if (servers[JINN_BUILTIN_SERVER] !== undefined && !isManagedJinnServer(servers[JINN_BUILTIN_SERVER])) {
    logger.warn(`Antigravity MCP attach skipped: ${configPath} already has a non-Jinn-managed "jinn" server.`);
    return { attached: false, reason: "non-managed jinn server exists" };
  }

  servers[JINN_BUILTIN_SERVER] = renderJinnServer(spec);
  const next = { ...config, mcpServers: servers };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  activeConfigs.set(configPath, { count: 1 });
  return { attached: true, configPath };
}

export function cleanupAntigravityJinnMcpConfig(handle: AntigravityMcpConfigHandle | undefined): void {
  if (!handle || !handle.attached || handle.released) return;
  handle.released = true;
  const active = activeConfigs.get(handle.configPath);
  if (!active) return;
  active.count -= 1;
  if (active.count > 0) return;
  activeConfigs.delete(handle.configPath);

  const config = readConfig(handle.configPath);
  if (!config) return;
  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  if (!isManagedJinnServer(servers[JINN_BUILTIN_SERVER])) return;
  delete servers[JINN_BUILTIN_SERVER];
  const next = { ...config, mcpServers: servers };
  try {
    fs.writeFileSync(handle.configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* best effort cleanup */
  }
}
