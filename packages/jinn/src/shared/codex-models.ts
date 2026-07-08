import { spawn } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

export interface CodexModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function effortLevelsFromCodex(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const levels = raw
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const effort = (entry as Record<string, unknown>).effort;
        return typeof effort === "string" ? effort : "";
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(levels));
}

export function parseCodexModels(output: string): CodexModelDiscovery {
  let body: unknown;
  try {
    body = JSON.parse(output);
  } catch {
    return { models: [] };
  }
  const rows = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).models
    : undefined;
  if (!Array.isArray(rows)) return { models: [] };

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const obj = row as Record<string, unknown>;
    if (obj.visibility === "hide") continue;
    const id = typeof obj.slug === "string" ? obj.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const effortLevels = effortLevelsFromCodex(obj.supported_reasoning_levels);
    const contextWindow =
      typeof obj.context_window === "number" ? obj.context_window
        : typeof obj.contextWindow === "number" ? obj.contextWindow
          : undefined;
    models.push({
      id,
      label: typeof obj.display_name === "string" && obj.display_name.trim() ? obj.display_name.trim() : id,
      supportsEffort: effortLevels.length > 0,
      effortLevels,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return { defaultModel: models[0]?.id, models };
}

export async function discoverCodexModels(bin: string): Promise<CodexModelDiscovery> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const proc = spawn(bin, ["debug", "models"], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1000);
        finish(out);
      }, 14000);
      proc.on("close", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish(out);
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`codex debug models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      logger.warn(`codex debug models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });
  return parseCodexModels(output);
}
