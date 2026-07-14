import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";
import type { JinnConfig } from "./types.js";

type ClaudeEngineConfig = JinnConfig["engines"]["claude"];

export function normalizeClaudeEngineConfig(raw: ClaudeEngineConfig): Required<Pick<ClaudeEngineConfig, "maxLivePtys">> & ClaudeEngineConfig {
  return {
    ...raw,
    maxLivePtys: raw.maxLivePtys ?? 8,
  };
}

/**
 * Lightweight shape validation for a parsed config.yaml. Returns a list of
 * problems (empty = valid). Deliberately minimal: only the fields whose
 * absence/wrong type would crash the gateway at startup are checked, so
 * configs that rely on downstream defaults keep working.
 */
export function validateConfigShape(config: unknown): string[] {
  if (config === null || config === undefined) {
    return ["file is empty or parsed to null — expected a YAML mapping"];
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return [`expected a YAML mapping, got ${Array.isArray(config) ? "an array" : typeof config}`];
  }

  const problems: string[] = [];
  const c = config as Record<string, any>;

  if (c.gateway !== undefined) {
    if (typeof c.gateway !== "object" || c.gateway === null || Array.isArray(c.gateway)) {
      problems.push("gateway must be a mapping");
    } else {
      if (c.gateway.port !== undefined && typeof c.gateway.port !== "number") {
        problems.push(`gateway.port must be a number (got ${typeof c.gateway.port})`);
      }
      if (c.gateway.host !== undefined && typeof c.gateway.host !== "string") {
        problems.push(`gateway.host must be a string (got ${typeof c.gateway.host})`);
      }
      if (c.gateway.notesEnabled !== undefined && typeof c.gateway.notesEnabled !== "boolean") {
        problems.push(`gateway.notesEnabled must be a boolean (got ${typeof c.gateway.notesEnabled})`);
      }
      if (c.gateway.allowFileCustomPaths !== undefined && typeof c.gateway.allowFileCustomPaths !== "boolean") {
        problems.push(`gateway.allowFileCustomPaths must be a boolean (got ${typeof c.gateway.allowFileCustomPaths})`);
      }
      if (c.gateway.allowFileOpen !== undefined && typeof c.gateway.allowFileOpen !== "boolean") {
        problems.push(`gateway.allowFileOpen must be a boolean (got ${typeof c.gateway.allowFileOpen})`);
      }
      if (c.gateway.authRequired !== undefined && typeof c.gateway.authRequired !== "boolean") {
        problems.push(`gateway.authRequired must be a boolean (got ${typeof c.gateway.authRequired})`);
      }
      if (c.gateway.authDisabled !== undefined && typeof c.gateway.authDisabled !== "boolean") {
        problems.push(`gateway.authDisabled must be a boolean (got ${typeof c.gateway.authDisabled})`);
      }
      if (c.gateway.insecureAllowUnauthenticatedNetwork !== undefined && typeof c.gateway.insecureAllowUnauthenticatedNetwork !== "boolean") {
        problems.push(`gateway.insecureAllowUnauthenticatedNetwork must be a boolean (got ${typeof c.gateway.insecureAllowUnauthenticatedNetwork})`);
      }
    }
  }

  if (typeof c.engines !== "object" || c.engines === null || Array.isArray(c.engines)) {
    problems.push("engines must be a mapping with at least an engines.claude entry");
  } else {
    if (c.engines.default !== undefined && typeof c.engines.default !== "string") {
      problems.push("engines.default must be a string");
    }
    if (typeof c.engines.claude !== "object" || c.engines.claude === null || Array.isArray(c.engines.claude)) {
      problems.push("engines.claude must be a mapping");
    }
  }

  return problems;
}

export function loadConfig(): JinnConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Jinn config not found at ${CONFIG_PATH}. Run "jinn setup" first.`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  const problems = validateConfigShape(parsed);
  if (problems.length > 0) {
    throw new Error(
      `Invalid config at ${CONFIG_PATH}:\n  - ${problems.join("\n  - ")}`
    );
  }
  const config = parsed as JinnConfig;
  config.engines.claude = normalizeClaudeEngineConfig(config.engines.claude);
  return config;
}

/**
 * Atomically persist a config object to config.yaml. The live gateway
 * hot-reloads config.yaml via a file watcher, so a torn write would be
 * consumed mid-write — write to a tmp file in the same directory, then rename.
 * `dumpOptions` is forwarded to yaml.dump so call sites keep their formatting.
 */
export function saveConfigAtomic(config: unknown, dumpOptions?: yaml.DumpOptions): void {
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, yaml.dump(config, dumpOptions), "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
}
