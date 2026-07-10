import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the home directory for the current instance from the environment at
 * call time. `JINN_HOME` below captures this once at module load (the value
 * never changes during a gateway's life); callers that need the live env value
 * — e.g. tests that set `process.env.JINN_HOME` before exercising a code path —
 * call this directly instead of reading the frozen constant.
 */
export function resolveJinnHome(): string {
  if (process.env.JINN_HOME) return path.resolve(process.env.JINN_HOME);
  const instance = process.env.JINN_INSTANCE || "jinn";
  return path.resolve(path.join(os.homedir(), `.${instance}`));
}

export function resolveHomeIdentity(home: string): string {
  const absolute = path.resolve(home);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export const JINN_HOME = resolveJinnHome();
export const JINN_HOME_IDENTITY = resolveHomeIdentity(JINN_HOME);
export const CONFIG_PATH = path.join(JINN_HOME, "config.yaml");
export const SESSIONS_DB = path.join(JINN_HOME, "sessions", "registry.db");
export const CRON_JOBS = path.join(JINN_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(JINN_HOME, "cron", "runs");
export const ORG_DIR = path.join(JINN_HOME, "org");
export const SKILLS_DIR = path.join(JINN_HOME, "skills");
export const DOCS_DIR = path.join(JINN_HOME, "docs");
export const LOGS_DIR = path.join(JINN_HOME, "logs");
export const TMP_DIR = path.join(JINN_HOME, "tmp");
/** Durable, bounded terminal snapshots used to restore CLI views after restart. */
export const PTY_SNAPSHOTS_DIR = path.join(JINN_HOME, "state", "pty-snapshots");
export const ENGINE_LIMITS_DIR = path.join(TMP_DIR, "engine-limits");
export const CLAUDE_LIMITS_DIR = path.join(ENGINE_LIMITS_DIR, "claude");
export const MODELS_DIR = path.join(JINN_HOME, "models");
export const STT_MODELS_DIR = path.join(JINN_HOME, "models", "whisper");
export const PID_FILE = path.join(JINN_HOME, "gateway.pid");
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export const GATEWAY_INFO_FILE = path.join(JINN_HOME, "gateway.json");
/** Per-session Claude Code --settings files. */
export const CLAUDE_SETTINGS_DIR = path.join(JINN_HOME, "tmp", "settings");
/**
 * Per-session Codex CODEX_HOME overlays. Each jinn session that runs the builtin
 * `jinn` MCP server with a capability token gets a stable dir here whose
 * `config.toml` carries the server stanza (token off argv) — fresh and resume
 * both point CODEX_HOME here so the thread rollout persists across turns.
 */
export const CODEX_HOMES_DIR = path.join(JINN_HOME, "tmp", "codex-homes");
/** The hook-relay script written once at boot. */
export const HOOK_RELAY_SCRIPT = path.join(JINN_HOME, "hook-relay.mjs");
export const CLAUDE_SKILLS_DIR = path.join(JINN_HOME, ".claude", "skills");
export const AGENTS_SKILLS_DIR = path.join(JINN_HOME, ".agents", "skills");
export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "..", "template");
export const FILES_DIR = path.join(JINN_HOME, "files");
/** Date-bucketed storage for files attached to / emitted by sessions. */
export const UPLOADS_DIR = path.join(JINN_HOME, "uploads");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

/** Path to the global multi-instance registry. Override only for isolated tests. */
export const INSTANCES_REGISTRY = process.env.JINN_INSTANCES_REGISTRY || path.join(os.homedir(), ".jinn", "instances.json");
