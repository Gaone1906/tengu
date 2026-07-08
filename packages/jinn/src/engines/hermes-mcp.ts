// packages/jinn/src/engines/hermes-mcp.ts
import type { ResolvedMcpConfig, McpServerStdioConfig } from "../shared/types.js";

/**
 * GRS-018 — map the resolved MCP server set onto the ACP `mcpServers` param of
 * `session/new` / `session/load`, making Hermes the third non-Claude consumer
 * (after Codex argv `-c` overrides and Grok's project `.grok/config.toml`).
 *
 * Wire shape (ACP `McpServerStdio`, verified against the deployed Hermes
 * v0.17.0 venv's `acp.schema`): `{name, command, args, env}` where `env` is an
 * ARRAY of `{name, value}` pairs — not a map. Hermes's ACP adapter converts
 * these back into a config map and registers them at session start
 * (`acp_adapter/server.py _register_session_mcp_servers`); no `type`
 * discriminator is needed for the stdio variant. URL-transport servers are
 * skipped this slice (same boundary as codex/grok).
 *
 * TOKEN CONTRACT — why this file, uniquely, injects JINN_GATEWAY_TOKEN:
 * Hermes spawns MCP stdio subprocesses with a FILTERED environment
 * (`tools/mcp_tool.py _build_safe_env`: PATH/HOME/XDG_* + explicitly-configured
 * keys only; its config-file `${VAR}` interpolation does NOT run on the ACP
 * registration path). So the inherited-env channel that carries the bearer
 * token to the jinn server under codex/grok is CUT under Hermes. The only way
 * the token reaches the server is as an explicit env entry in the ACP message.
 * That is safe where argv/config-file serialization was not: the ACP channel is
 * an in-memory stdin pipe between the gateway and its child — the token never
 * touches argv (world-readable via `ps`) or any file (Hermes registers
 * ACP-provided servers in memory only; its save-path is dashboard/CLI-only).
 * The injection is restricted to the built-in `jinn` server so the secret is
 * never handed to third-party server processes.
 */

/** ACP EnvVariable — env crosses the wire as name/value PAIRS. */
export interface AcpEnvVariable {
  name: string;
  value: string;
}

/** ACP McpServerStdio as `session/new`/`session/load` expect it. */
export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
}

/** The built-in gateway server key (matches mcp/resolver.ts, reserved there). */
const JINN_BUILTIN_SERVER = "jinn";

/** Build the ACP `mcpServers` array from the resolved set (stdio only). */
export function buildAcpMcpServers(resolvedMcp: ResolvedMcpConfig | undefined): AcpMcpServerStdio[] {
  const servers = resolvedMcp?.mcpServers;
  if (!servers) return [];

  const out: AcpMcpServerStdio[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const stdio = spec as McpServerStdioConfig & { url?: unknown };
    // stdio servers only — a `url` marks the SSE/HTTP transport, skipped this
    // slice (and defends against a spec carrying both fields).
    if (typeof stdio.command !== "string" || !stdio.command || stdio.url !== undefined) continue;

    const env: AcpEnvVariable[] = Object.entries(stdio.env ?? {}).map(([k, v]) => ({ name: k, value: v }));

    // Built-in jinn server: thread the bearer token through the in-memory ACP
    // channel, because Hermes's filtered subprocess env drops inherited vars
    // (see module doc). An explicit config value always wins over injection.
    if (name === JINN_BUILTIN_SERVER && !env.some((e) => e.name === "JINN_GATEWAY_TOKEN")) {
      const token = process.env.JINN_GATEWAY_TOKEN;
      if (token) env.push({ name: "JINN_GATEWAY_TOKEN", value: token });
    }

    out.push({ name, command: stdio.command, args: stdio.args ? [...stdio.args] : [], env });
  }
  return out;
}
