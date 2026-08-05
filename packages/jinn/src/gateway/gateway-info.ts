import fs from "node:fs";
import crypto from "node:crypto";

export interface GatewayInfo {
  port: number;
  host?: string;
  url?: string;
  secret: string;
  pid: number;
  token?: string;
  ptyPids?: number[];
}

/** Current-main host behavior: runtime PID records are candidates for orphan cleanup. */
export function staleGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  currentPid = process.pid,
): number[] {
  if (!info) return [];
  const candidates = [...(Array.isArray(info.ptyPids) ? info.ptyPids : []), info.pid];
  return candidates.filter((pid): pid is number =>
    typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid
  );
}

/**
 * Container startup is a separate trust boundary: a persisted PID belongs to a
 * previous container and must never be signaled. Host startup retains the
 * established stale-PID cleanup behavior.
 */
export function startupGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  currentPid = process.pid,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  return env.JINN_CONTAINER === "1" ? [] : staleGatewayPids(info, currentPid);
}

export function writeGatewayInfo(
  file: string,
  opts: { port: number; host?: string; pid: number; secret?: string; token?: string },
): GatewayInfo {
  const previous = readGatewayInfo(file);
  const host = opts.host ?? previous?.host;
  const info: GatewayInfo = {
    port: opts.port,
    host,
    // Keep the URL for the container healthcheck; it is descriptive output,
    // never authority used by local CLI commands.
    url: gatewayBaseUrl({ port: opts.port, host }),
    pid: opts.pid,
    secret: opts.secret ?? previous?.secret ?? crypto.randomBytes(24).toString("hex"),
    token: opts.token ?? previous?.token,
    ptyPids: [],
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return info;
}

export function readGatewayInfo(file: string): GatewayInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GatewayInfo;
  } catch {
    return null;
  }
}

function isWildcardHost(host: string | undefined): boolean {
  return !host || host === "0.0.0.0" || host === "::";
}

function formatHttpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function gatewayBaseUrl(
  info: Pick<GatewayInfo, "port" | "host">,
  fallbackHost?: string,
): string {
  const host = isWildcardHost(info.host)
    ? (isWildcardHost(fallbackHost) ? "127.0.0.1" : fallbackHost!)
    : info.host!;
  return `http://${formatHttpHost(host)}:${info.port}`;
}

export function updateGatewayPtyPids(file: string, ptyPids: number[]): void {
  const info = readGatewayInfo(file);
  if (!info) return;
  info.ptyPids = ptyPids;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
