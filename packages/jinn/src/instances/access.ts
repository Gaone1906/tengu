import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { InstanceAccessUrls } from "./directory.js";

const execFileAsync = promisify(nodeExecFile);

export interface TailscaleServeMapping {
  internalPort: number;
  externalUrl: string;
}

export type AccessProvisionResult =
  | { status: "configured"; url: string }
  | { status: "not-detected" }
  | { status: "failed"; warning: string };

export type ExecFileResult = { stdout: string; stderr: string };
export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecFileResult>;

function cleanOrigin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

export function parseTailscaleServeStatus(contents: string): TailscaleServeMapping[] {
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const web = (parsed as { Web?: unknown }).Web;
  if (!web || typeof web !== "object" || Array.isArray(web)) return [];
  const mappings: TailscaleServeMapping[] = [];
  for (const [authority, rawConfig] of Object.entries(web as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== "object") continue;
    const handlers = (rawConfig as { Handlers?: unknown }).Handlers;
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) continue;
    const root = (handlers as Record<string, unknown>)["/"];
    if (!root || typeof root !== "object") continue;
    const proxy = (root as { Proxy?: unknown }).Proxy;
    if (typeof proxy !== "string") continue;
    try {
      const target = new URL(proxy);
      const internalPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
      if (!Number.isSafeInteger(internalPort)) continue;
      const externalUrl = cleanOrigin(`https://${authority}`);
      mappings.push({ internalPort, externalUrl });
    } catch {
      continue;
    }
  }
  return mappings;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "127.0.0.1" || normalized === "::1";
}

function urlWithPort(origin: URL, port: number): string {
  const next = new URL(origin.origin);
  next.port = String(port);
  return next.origin;
}

export function resolveInstanceSwitchUrl(options: {
  instance: { port: number; accessUrls?: InstanceAccessUrls };
  currentOrigin: string;
  tailscaleMappings?: TailscaleServeMapping[];
}): string {
  const current = new URL(options.currentOrigin);
  const local = isLoopbackHostname(current.hostname);
  const learned = local ? options.instance.accessUrls?.local : options.instance.accessUrls?.remote;
  if (learned) return cleanOrigin(learned);
  const provider = options.tailscaleMappings?.find((mapping) => mapping.internalPort === options.instance.port);
  if (provider) return provider.externalUrl;
  if (local) return `http://127.0.0.1:${options.instance.port}`;
  return urlWithPort(current, options.instance.port);
}

function inferredTailscaleUrl(currentUrl: string, newPort: number): string {
  return urlWithPort(new URL(currentUrl), newPort);
}

export async function cloneCurrentTailscaleServe(options: {
  currentPort: number;
  newPort: number;
  execFile?: ExecFileFn;
}): Promise<AccessProvisionResult> {
  const execFile: ExecFileFn = options.execFile ?? (async (file, args, execOptions) => {
    const result = await execFileAsync(file, args, { ...execOptions, encoding: "utf8" });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  });
  let mappings: TailscaleServeMapping[];
  try {
    const status = await execFile("tailscale", ["serve", "status", "--json"], { timeout: 5_000 });
    mappings = parseTailscaleServeStatus(status.stdout);
  } catch {
    return { status: "not-detected" };
  }
  const current = mappings.find((mapping) => mapping.internalPort === options.currentPort);
  if (!current) return { status: "not-detected" };
  const existing = mappings.find((mapping) => mapping.internalPort === options.newPort);
  if (existing) return { status: "configured", url: existing.externalUrl };
  try {
    await execFile("tailscale", [
      "serve",
      "--bg",
      "--yes",
      `--https=${options.newPort}`,
      `http://127.0.0.1:${options.newPort}`,
    ]);
    return { status: "configured", url: inferredTailscaleUrl(current.externalUrl, options.newPort) };
  } catch (error) {
    return {
      status: "failed",
      warning: `Workspace started locally, but Tailscale Serve could not be configured: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readTailscaleServeMappings(execFile?: ExecFileFn): Promise<TailscaleServeMapping[]> {
  try {
    const runner = execFile ?? (async (file: string, args: string[]) => {
      const result = await execFileAsync(file, args, { encoding: "utf8", timeout: 5_000 });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    });
    const result = await runner("tailscale", ["serve", "status", "--json"]);
    return parseTailscaleServeStatus(result.stdout);
  } catch {
    return [];
  }
}
