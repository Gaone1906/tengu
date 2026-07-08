import { spawn } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

export interface AntigravityModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function labelAntigravityModel(id: string): string {
  return id.replace(/\s+\(([^)]+)\)\s*$/, " $1");
}

export function parseAntigravityModels(output: string): AntigravityModelDiscovery {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const id = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!id || seen.has(id) || /^usage:/i.test(id) || /^flags:/i.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: labelAntigravityModel(id),
      supportsEffort: false,
      effortLevels: [],
    });
  }
  return { defaultModel: models[0]?.id, models };
}

export async function discoverAntigravityModels(bin: string): Promise<AntigravityModelDiscovery> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const proc = spawn(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
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
        logger.warn(`agy models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      logger.warn(`agy models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });
  return parseAntigravityModels(output);
}
