import fs from "node:fs";
import path from "node:path";
import type { ResolvedMcpConfig, McpServerStdioConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { stripMcpBootstrapArgs } from "../mcp/identity.js";

/**
 * GRS-012c — attach the built-in `jinn` MCP server to a spawned Grok
 * (`grok-build`) session. Grok has NO per-invocation config flag (its `--cwd`
 * sets both the working directory AND the config-discovery directory; `grok mcp
 * add` writes to `~/.grok/config.toml` [user] or `./.grok/config.toml`
 * [project]). So — unlike Codex, which we drive via per-session `-c` argv
 * overrides — the only per-session lever for Grok is the PROJECT-scoped
 * `<cwd>/.grok/config.toml`, which grok reads from its working directory. Grok
 * merges project-scoped `[mcp_servers.*]` on top of user config without touching
 * global `~/.grok` (proven in the GRS-012c probe).
 *
 * IMPORTANT — the working directory is SHARED. Every jinn-spawned engine turn runs
 * with `cwd = JINN_HOME` (sessions/manager.ts + gateway/api.ts), so ALL concurrent
 * grok sessions read/write the SAME `<JINN_HOME>/.grok/config.toml`. Two design
 * consequences, both handled here:
 *   1. We emit ONLY the built-in `jinn` server (see {@link JINN_BUILTIN_SERVER}).
 *      Its spec is process-global (same node bin + entry + the non-secret
 *      `JINN_GATEWAY_URL`), so every concurrent session writes BYTE-IDENTICAL
 *      content — no last-writer-wins corruption. Restricting to `jinn` also means
 *      (a) no arbitrary custom-server name can produce invalid TOML table keys, and
 *      (b) no custom-server `command`/`args` secret is ever written to disk. Other
 *      MCP servers for grok are a deferred, separate slice.
 *   2. The shared file is REFERENCE-COUNTED ({@link activeConfigs}). The first
 *      attach writes it; concurrent attaches share it; only the LAST session to
 *      settle deletes it. This prevents one session's cleanup from deleting a file
 *      another session's grok is still starting against, while keeping the
 *      zero-residue property: once no grok session is active, the file (and a
 *      `.grok` dir we created) is gone. JINN_HOME is jinn's own home, never the
 *      user's project tree, so the run leaves zero new files in a user repo.
 *
 * A jinn-written file carries a first-line {@link JINN_GROK_MCP_MARKER}; we only
 * ever create/overwrite/delete a file bearing it. A NON-marked pre-existing
 * `.grok/config.toml` (a user's own) is left untouched and the attach is skipped —
 * no clobber, no fragile TOML merge.
 *
 * SECURITY: only the non-secret env allowlist ({@link GROK_SAFE_ENV_KEYS}) is
 * written into the config `env`; the bearer token reaches the server via grok's
 * INHERITED env, never a file (same contract as Codex).
 */
export const JINN_GROK_MCP_MARKER =
  "# jinn-managed: auto-generated MCP attach config (GRS-012c). Safe to delete.";

/** The one server this slice attaches to grok — matches the resolver's built-in
 *  server key (mcp/resolver.ts). */
export const JINN_BUILTIN_SERVER = "jinn";

/**
 * Env keys allowed into the on-disk `.grok/config.toml` (non-secret only).
 * This file only ever writes the BUILTIN `jinn` server ({@link JINN_BUILTIN_SERVER}).
 *
 * GRS-018 unified builtin-env model, grok's split:
 *   - JINN_GATEWAY_URL + JINN_HOME ride THIS file — both are process-global and
 *     therefore BYTE-IDENTICAL across concurrent sessions, which the shared-file
 *     refcount design requires (see module doc §1). JINN_HOME is the
 *     gateway.json token-fallback hint (mcp/server.ts), consistent with codex.
 *   - JINN_SESSION_ID + JINN_SESSION_CAPABILITY must NOT ride this file: they
 *     are PER-SESSION, and per-session values in the SHARED config would break
 *     byte-identity — the first writer's identity would be served to every
 *     concurrent session. They ride the grok CHILD process env instead
 *     ({@link grokJinnSessionEnv} — one grok process per session, and grok
 *     forwards its full env to the MCP servers it spawns, probe-verified in
 *     GRS-018-credential-scope-analysis.md).
 * The bearer token stays OFF this list forever — it reaches the server via
 * grok's inherited env, never the on-disk file.
 */
const GROK_SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  "JINN_GATEWAY_URL",
  "JINN_HOME",
]);

/**
 * Per-session env to add to the grok CHILD process so the builtin jinn server
 * (spawned by grok with grok's full env) receives the GRS-017/021c caller
 * identity + capability. Reads both from the identity-stamped jinn spec
 * (mcp/identity.ts is the single source; the engine does not invent identity).
 * Empty when no jinn server is attached or the spec carries no id/capability.
 */
export function grokJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnServer(resolvedMcp);
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  const workflowAttempt = spec?.env?.JINN_WORKFLOW_ATTEMPT;
  return sessionId && capability ? {
    JINN_SESSION_ID: sessionId,
    JINN_SESSION_CAPABILITY: capability,
    ...(workflowAttempt === "1" ? { JINN_WORKFLOW_ATTEMPT: workflowAttempt } : {}),
  } : {};
}

/**
 * Reference registry for the SHARED `<cwd>/.grok/config.toml` keyed by absolute
 * path. Node's single-threaded event loop makes the increment/decrement atomic
 * w.r.t. other turns. `createdDir` records whether jinn created the `.grok` dir
 * (so the last session out can remove it) — tracked here, not per-handle, because
 * ownership of the shared file/dir is shared across sessions.
 */
interface ConfigEntry {
  count: number;
  createdDir: boolean;
}
const activeConfigs = new Map<string, ConfigEntry>();

export type GrokMcpAttachHandle =
  | { attached: false }
  | { attached: true; configPath: string; grokDir: string; released?: boolean };

/** The built-in `jinn` stdio server from the resolved set, or null if absent.
 *  Requires a string `command` and NO `url` field, so a URL-transport server can
 *  never be mistaken for the built-in (defense-in-depth; the resolver already
 *  reserves the `jinn` name so a custom server cannot occupy this key). */
function jinnServer(resolvedMcp: ResolvedMcpConfig | undefined): McpServerStdioConfig | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (spec && typeof spec.command === "string" && spec.command && spec.url === undefined) return spec;
  return null;
}

/**
 * Render the `[mcp_servers.jinn]` TOML for a stdio server. `JSON.stringify` emits
 * a valid TOML basic string for the plain command/path/URL values involved. Only
 * the built-in `jinn` name is used → a valid bare TOML key.
 */
export function buildGrokMcpToml(name: string, spec: McpServerStdioConfig): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${JSON.stringify(spec.command)}`];
  const args = stripMcpBootstrapArgs(spec.args);
  lines.push(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
  lines.push("enabled = true");
  if (spec.env) {
    const safe = Object.entries(spec.env).filter(([k]) => GROK_SAFE_ENV_KEYS.has(k));
    if (safe.length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of safe) lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Write (or share) the `<cwd>/.grok/config.toml` that attaches the built-in `jinn`
 * MCP server to a spawned grok session. Reference-counted for the shared
 * JINN_HOME cwd. Returns a handle for {@link cleanupGrokProjectMcpConfig}. No-ops
 * (returns `{attached:false}`) when the resolved set has no `jinn` server, or when
 * a non-jinn-managed config already exists (never clobbers the user's own file).
 */
export function prepareGrokProjectMcpConfig(
  cwd: string | undefined,
  resolvedMcp: ResolvedMcpConfig | undefined,
): GrokMcpAttachHandle {
  const spec = jinnServer(resolvedMcp);
  if (!spec) return { attached: false };

  // Resolve to an absolute path so the refcount map key is stable regardless of a
  // relative cwd (two references to the same dir must share one entry).
  const grokDir = path.resolve(cwd || process.cwd(), ".grok");
  const configPath = path.join(grokDir, "config.toml");
  const toml = `${JINN_GROK_MCP_MARKER}\n${buildGrokMcpToml(JINN_BUILTIN_SERVER, spec)}\n`;

  // Skip when a NON-jinn-managed file occupies the path (a user's own config) —
  // never clobber it. Checked for BOTH the first and concurrent attach so a user
  // who replaces our file mid-run isn't falsely reported attached.
  const userFileBlocks = (): boolean => {
    if (!fs.existsSync(configPath)) return false;
    if (fs.readFileSync(configPath, "utf-8").startsWith(JINN_GROK_MCP_MARKER)) return false;
    logger.warn(
      `Grok MCP attach skipped: ${configPath} exists and is not jinn-managed; leaving it untouched (jinn tools unavailable this session).`,
    );
    return true;
  };

  try {
    const entry = activeConfigs.get(configPath);
    if (entry) {
      // Concurrent attach on the same shared path.
      if (userFileBlocks()) return { attached: false };
      // Content is byte-identical (jinn spec is process-global) — heal the file if
      // a stray delete raced it, then bump the refcount.
      if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, toml);
      entry.count += 1;
      return { attached: true, configPath, grokDir };
    }

    // First attach for this path this process.
    if (userFileBlocks()) return { attached: false };
    // else: no file, or a stale jinn-managed file from a crashed run → overwrite.

    const createdDir = !fs.existsSync(grokDir);
    if (createdDir) fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(configPath, toml);
    activeConfigs.set(configPath, { count: 1, createdDir });
    logger.info(`Grok MCP: wrote session-scoped ${configPath} (jinn server)`);
    return { attached: true, configPath, grokDir };
  } catch (err) {
    logger.warn(`Grok MCP attach failed to write config: ${err instanceof Error ? err.message : String(err)}`);
    return { attached: false };
  }
}

/**
 * Release one reference to the shared `.grok/config.toml`. Only the LAST active
 * session deletes the (marker-guarded) file and the `.grok` dir if jinn created it
 * and it is now empty. Idempotent + best-effort.
 */
export function cleanupGrokProjectMcpConfig(handle: GrokMcpAttachHandle | undefined): void {
  if (!handle || !handle.attached) return;
  // Per-handle idempotency: a second cleanup of the SAME handle must not decrement
  // the shared refcount again (which could delete a file another session is using).
  if (handle.released) return;
  handle.released = true;
  const entry = activeConfigs.get(handle.configPath);
  if (!entry) return; // already fully released
  entry.count -= 1;
  if (entry.count > 0) return; // other sessions still using the shared file
  activeConfigs.delete(handle.configPath);
  try {
    if (fs.existsSync(handle.configPath)) {
      const current = fs.readFileSync(handle.configPath, "utf-8");
      if (current.startsWith(JINN_GROK_MCP_MARKER)) fs.unlinkSync(handle.configPath);
    }
    if (entry.createdDir && fs.existsSync(handle.grokDir) && fs.readdirSync(handle.grokDir).length === 0) {
      fs.rmdirSync(handle.grokDir);
    }
  } catch {
    // best-effort; a leftover marked file is safe to delete manually.
  }
}
