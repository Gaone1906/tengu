import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export interface GatewayInfo {
  port: number;
  host?: string;
  url?: string;
  secret: string;
  pid: number;
  token?: string;
  ptyPids?: number[];
  namespace?: string;
  processIncarnations?: Record<string, string>;
}

/**
 * A stable identity for one lifetime of a PID. Linux exposes the exact kernel
 * start tick; POSIX `ps` exposes the process start instant. Platforms where
 * neither can be read return null so callers fail closed instead of trusting a
 * PID number that may have been recycled.
 */
export function processIncarnation(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fieldsFromState = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fieldsFromState[19]; // proc_pid_stat(5), field 22
      if (/^\d+$/.test(startTicks ?? "")) return `linux-start-ticks:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: 1_000,
    }).trim().replace(/\s+/g, " ");
    return started ? `ps-lstart:${started}` : null;
  } catch {
    return null;
  }
}

/**
 * How far two derived boot instants may sit apart and still be one boot: `now - uptime`
 * jitters by a tick between reads, while firmware and init put many seconds between real
 * boots. Not widened to cover an NTP step or a Windows suspend, which move the derived
 * instant by the whole correction — that would trade a bounded miss for an unbounded one
 * in the dangerous direction. The miss stays on the safe side: pids of this boot read as
 * foreign and are left alone. Linux answers exactly, see computeBootIdentity().
 */
const BOOT_INSTANT_TOLERANCE_MS = 3_000;

/**
 * A boot identity to pair with the hostname, because pid numbers survive neither a reboot
 * nor a namespace swap. Linux answers exactly: the pid-namespace inode is needed because a
 * container shares the host's boot_id, so `docker restart` would look like the same
 * namespace. Elsewhere it is derived from uptime and deliberately NOT bucketed — a window
 * puts a short reboot on the previous boot's value, which is the dangerous direction.
 */
function computeBootIdentity(): string {
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    return `${bootId}/${fs.readlinkSync("/proc/self/ns/pid")}`; // "pid:[4026531836]"
  } catch {
    return `boot-${Math.round(Date.now() - os.uptime() * 1000)}`;
  }
}

// Memoised so every write from one process stamps one value; only the comparison
// across processes has to tolerate the jitter.
let cachedBootIdentity: string | undefined;
function bootIdentity(): string {
  return (cachedBootIdentity ??= computeBootIdentity());
}

/** Identifies the pid namespace the recorded pids belong to. Under Docker the
 *  hostname is the container id, so it changes on every recreate; the boot identity
 *  covers the cases where it does not (host reboot, restart of the same container). */
export function currentNamespace(): string {
  return `${os.hostname()}:${bootIdentity()}`;
}

/** Whether the pids recorded in `info` belong to the namespace we are running in — the
 *  one place that answers "may I signal what this file names". gateway.json outlives an
 *  ungraceful stop, and both a reboot and a container restart recycle its numbers. */
export function recordedInThisNamespace(
  info: Pick<GatewayInfo, "namespace"> | null | undefined,
  namespace = currentNamespace(),
): boolean {
  return !!info && sameNamespace(info.namespace, namespace);
}

/** Split "<hostname>:boot-<ms>". Null for the exact Linux form (boot_id + namespace
 *  inode, which contains its own colon) and for anything else, both of which are
 *  compared verbatim. */
function parseDerivedBootNamespace(namespace: string): { host: string; bootMs: number } | null {
  const separator = namespace.lastIndexOf(":");
  if (separator < 0) return null;
  const derived = /^boot-(-?\d+)$/.exec(namespace.slice(separator + 1));
  if (!derived) return null;
  return { host: namespace.slice(0, separator), bootMs: Number(derived[1]) };
}

/** Whether pids recorded under `recorded` are pids of the namespace `current` names. */
export function sameNamespace(recorded: string | undefined, current: string): boolean {
  // Written before namespaces were recorded at all: assume foreign.
  if (!recorded) return false;
  if (recorded === current) return true;
  const a = parseDerivedBootNamespace(recorded);
  const b = parseDerivedBootNamespace(current);
  if (!a || !b || a.host !== b.host) return false;
  return Math.abs(a.bootMs - b.bootMs) <= BOOT_INSTANT_TOLERANCE_MS;
}

/** Every signalable pid the file names, WITHOUT the namespace check. Only for
 *  reporting what a foreign-namespace file held — never for deciding what to kill. */
export function recordedGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  currentPid = process.pid,
): number[] {
  if (!info) return [];
  const candidates = [...(Array.isArray(info.ptyPids) ? info.ptyPids : []), info.pid];
  return candidates.filter((pid): pid is number =>
    typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid
  );
}

export function staleGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  currentPid = process.pid,
  namespace = currentNamespace(),
  readIncarnation: (pid: number) => string | null = processIncarnation,
): number[] {
  if (!info) return [];
  // Pids are only meaningful in the namespace that recorded them. A container
  // restarts pids from 1, so a gateway.json left by an ungraceful stop names
  // numbers now held by unrelated live processes. Absent field: assume foreign.
  if (!recordedInThisNamespace(info, namespace)) return [];
  return recordedGatewayPids(info, currentPid).filter((pid) =>
    recordedProcessMatches(info, pid, readIncarnation)
  );
}

export function recordedProcessMatches(
  info: Pick<GatewayInfo, "processIncarnations"> | null | undefined,
  pid: number,
  readIncarnation: (pid: number) => string | null = processIncarnation,
): boolean {
  const recorded = info?.processIncarnations?.[String(pid)];
  if (!recorded) return false;
  const current = readIncarnation(pid);
  return current !== null && current === recorded;
}

export function writeGatewayInfo(file: string, opts: { port: number; host?: string; pid: number; secret?: string; token?: string }): GatewayInfo {
  const previous = readGatewayInfo(file);
  const host = opts.host ?? previous?.host;
  const info: GatewayInfo = {
    port: opts.port,
    host,
    // Recorded so consumers outside this module — docker-healthcheck.sh notably — do not
    // re-derive "bind address -> reachable URL" in another language.
    url: gatewayBaseUrl({ port: opts.port, host }),
    pid: opts.pid,
    secret: opts.secret ?? previous?.secret ?? crypto.randomBytes(24).toString("hex"),
    token: opts.token ?? previous?.token,
    ptyPids: [],
    namespace: currentNamespace(),
  };
  const incarnation = processIncarnation(opts.pid);
  if (incarnation) info.processIncarnations = { [String(opts.pid)]: incarnation };
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

/**
 * Where a gateway is reachable. What the running one recorded wins over config, which
 * may have been edited — or overridden by --port — since boot. One implementation
 * because pair, restart-request, workflow and status each had their own, and status's
 * skipped gateway.json entirely.
 */
export function resolveGatewayEndpoint(
  info: Pick<GatewayInfo, "port" | "host"> | null | undefined,
  fallback: { port?: number; host?: string } = {},
): { port: number; host?: string } {
  return {
    port: info?.port ?? fallback.port ?? 7777,
    host: info?.host ?? fallback.host,
  };
}

export function updateGatewayPtyPids(file: string, ptyPids: number[]): void {
  const info = readGatewayInfo(file);
  if (!info) return;
  info.ptyPids = ptyPids;
  const processIncarnations: Record<string, string> = {};
  for (const pid of [info.pid, ...ptyPids]) {
    const incarnation = processIncarnation(pid);
    if (incarnation) processIncarnations[String(pid)] = incarnation;
  }
  info.processIncarnations = processIncarnations;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
