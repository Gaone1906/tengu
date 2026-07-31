import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

export interface GatewayInfo { port: number; host?: string; secret: string; pid: number; token?: string; ptyPids?: number[]; namespace?: string; }

/** Identifies the pid namespace the recorded pids belong to. Under Docker this is
 *  the container id, so it changes on every recreate. */
function currentNamespace(): string {
  return os.hostname();
}

export function staleGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  currentPid = process.pid,
  namespace = currentNamespace(),
): number[] {
  if (!info) return [];
  // Pids are only meaningful in the namespace that recorded them. A container
  // restarts pids from 1, so a gateway.json left by an ungraceful stop names
  // numbers now held by unrelated live processes. Absent field: assume foreign.
  if (info.namespace !== namespace) return [];
  const candidates = [...(Array.isArray(info.ptyPids) ? info.ptyPids : []), info.pid];
  return candidates.filter((pid): pid is number =>
    typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid
  );
}

export function writeGatewayInfo(file: string, opts: { port: number; host?: string; pid: number; secret?: string; token?: string }): GatewayInfo {
  const previous = readGatewayInfo(file);
  const info: GatewayInfo = {
    port: opts.port,
    host: opts.host ?? previous?.host,
    pid: opts.pid,
    secret: opts.secret ?? previous?.secret ?? crypto.randomBytes(24).toString("hex"),
    token: opts.token ?? previous?.token,
    ptyPids: [],
    namespace: currentNamespace(),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename preserves the temp file's mode, but if the target already existed
  // with broader permissions some filesystems may not reset them — be explicit.
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

export function gatewayBaseUrl(info: Pick<GatewayInfo, "port" | "host">, fallbackHost?: string): string {
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
