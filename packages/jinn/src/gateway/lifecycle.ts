import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, PID_FILE, JINN_HOME, JINN_HOME_IDENTITY, resolveHomeIdentity } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { startGateway } from "./server.js";
import { loadConfig } from "../shared/config.js";
import { gatewayBaseUrl } from "./gateway-info.js";
import { ensureGatewayAuthToken } from "./auth.js";
import { buildRestartEntryArgv } from "./restart-entry-options.js";

export async function startForeground(config: JinnConfig): Promise<void> {
  const cleanup = await startGateway(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("Shutting down gateway...");

    // Force exit if graceful shutdown takes too long
    const forceTimer = setTimeout(() => {
      logger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startDaemon(config: JinnConfig): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    // When running from a built bundle, __filename is dist/src/gateway/lifecycle.js
    path.resolve(path.dirname(__filename), "daemon-entry.js"),
    // Fallback for unusual layouts
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "daemon-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const child = spawn(process.execPath, [entryScript], {
    detached: true,
    stdio: "ignore",
    env: buildGatewayChildEnv(config),
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.unref();
}

/**
 * Restart the gateway from a DETACHED, reparented helper process.
 *
 * The whole point: a `jinn stop && jinn start` run from *inside* a gateway
 * session fails because `stop` kills the gateway, whose shutdown kills all PTYs
 * — including the very session running the command — so `start` never executes.
 * This spawns a helper (restart-entry.js) detached + unref'd with no IPC, so it
 * is reparented to launchd/init and SURVIVES the gateway's killAll(). The
 * helper does stop → waitForPortFree → startDaemon out of band. The returning
 * gateway then resumes the interrupted session.
 */
export interface LifecycleKillOptions {
  takePort?: boolean;
}

export interface RestartDetachedOptions extends LifecycleKillOptions {
  port?: number;
}

export function restartDetached(options: RestartDetachedOptions = {}): void {
  const loadedConfig = loadConfig();
  const port = options.port ?? loadedConfig.gateway.port ?? 7777;
  const config: JinnConfig = {
    ...loadedConfig,
    gateway: { ...loadedConfig.gateway, port },
  };
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    path.resolve(path.dirname(__filename), "restart-entry.js"),
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "restart-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const args = buildRestartEntryArgv(entryScript, { port, takePort: options.takePort });

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: buildGatewayChildEnv(config),
  });

  if (child.pid) {
    logger.info(`Gateway restart helper started with PID ${child.pid}`);
  }

  child.unref();
}

export function buildGatewayChildEnv(
  config: JinnConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (shouldScrubGatewayChildEnv(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    JINN_HOME,
    JINN_HOME_IDENTITY,
    JINN_GATEWAY_URL: gatewayBaseUrl({ port, host }),
    JINN_GATEWAY_TOKEN: ensureGatewayAuthToken(JINN_HOME),
  };
}

const GATEWAY_CHILD_ENV_SCRUB_EXACT: ReadonlySet<string> = new Set([
  "CODEX",
  "CLAUDECODE",
  "JINN_SESSION_ID",
  "JINN_SESSION_CAPABILITY",
  "JINN_HOME_IDENTITY",
  "JINN_TAKE_PORT",
  "ANTHROPIC_BASE_URL",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "HERMES_YOLO_MODE",
  "HERMES_ACCEPT_HOOKS",
]);

function shouldScrubGatewayChildEnv(key: string): boolean {
  return (
    GATEWAY_CHILD_ENV_SCRUB_EXACT.has(key) ||
    key.startsWith("CODEX_") ||
    key.startsWith("CLAUDE_CODE_")
  );
}

/**
 * Send SIGTERM to the running gateway. Returns the PID that was signaled (or
 * was found already gone), or null if nothing was running.
 *
 * Deliberately does NOT delete the PID file after a successful SIGTERM: the
 * gateway keeps shutting down (gracefully, up to ~5s) after the signal, and
 * unlinking early opens a race window where the gateway is still running and
 * holding the port but a concurrent start/status sees "not running". The file
 * self-heals once the process exits: getStatus() and stop() both verify
 * liveness with kill(pid, 0) and treat a dead PID as stale, and startDaemon()
 * overwrites the file. stopAndWait() removes it once the process has exited.
 */
export type PortOwnerLookup =
  | { status: "found"; pid: number }
  | { status: "none" }
  | { status: "unknown" };

export type ProcessJinnHomeLookup =
  | { status: "found"; jinnHome: string; identity: string }
  | { status: "none" }
  | { status: "unknown" };

export function selectPortOwnerPid(
  pids: number[],
  commandLooksLikeGateway: (pid: number) => boolean = pidLooksLikeGateway,
): number | undefined {
  return pids.find(commandLooksLikeGateway) ?? pids[0];
}

export class PortOwnershipError extends Error {
  constructor(port: number, ownerJinnHome: string) {
    super(formatPortOwnedByAnotherInstanceError(port, ownerJinnHome));
    this.name = "PortOwnershipError";
  }
}

export function formatPortOwnedByAnotherInstanceError(port: number, ownerJinnHome: string): string {
  return `port ${port} is owned by another jinn instance (JINN_HOME=${ownerJinnHome}); change this instance's port in ${CONFIG_PATH}, or pass --take-port to override.`;
}

export function shouldSignalPidFileProcess(
  pid: number,
  portOwner: PortOwnerLookup,
  commandLooksLikeGateway: boolean,
): boolean {
  if (portOwner.status === "found") return portOwner.pid === pid;
  return commandLooksLikeGateway;
}

export function assertPortTakeoverAllowed(port: number, options: LifecycleKillOptions = {}): void {
  if (options.takePort) return;

  const portOwner = lookupPidOnPort(port);
  if (portOwner.status === "none") return;
  if (portOwner.status === "unknown") throw new PortOwnershipError(port, "unknown");

  assertPidBelongsToThisInstance(portOwner.pid, port, options);
}

export function readProcessJinnHome(pid: number): ProcessJinnHomeLookup {
  if (process.platform === "win32") return { status: "unknown" };

  const procEnvPath = `/proc/${pid}/environ`;
  if (fs.existsSync(procEnvPath)) {
    try {
      const raw = fs.readFileSync(procEnvPath, "utf-8");
      return jinnHomeFromEnvEntries(raw.split("\0"));
    } catch {
      return { status: "unknown" };
    }
  }

  try {
    const output = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1_000,
    });
    return jinnHomeFromEnvEntries(output.split(/\s+/));
  } catch {
    return { status: "unknown" };
  }
}

function jinnHomeFromEnvEntries(entries: string[]): ProcessJinnHomeLookup {
  let jinnHome: string | undefined;
  let identity: string | undefined;
  for (const entry of entries) {
    if (entry.startsWith("JINN_HOME=")) {
      jinnHome = entry.slice("JINN_HOME=".length);
    } else if (entry.startsWith("JINN_HOME_IDENTITY=")) {
      identity = entry.slice("JINN_HOME_IDENTITY=".length);
    }
  }
  if (jinnHome || identity) {
    const publicHome = jinnHome ?? identity!;
    return { status: "found", jinnHome: publicHome, identity: identity ?? resolveHomeIdentity(publicHome) };
  }
  return { status: "none" };
}

function assertPidBelongsToThisInstance(
  pid: number,
  port: number,
  options: LifecycleKillOptions,
): void {
  if (options.takePort) return;

  const owner = readProcessJinnHome(pid);
  if (owner.status === "found" && owner.identity === JINN_HOME_IDENTITY) return;

  if (!pidIsAlive(pid)) return;
  throw new PortOwnershipError(port, owner.status === "found" ? owner.jinnHome : "unknown");
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGateway(port?: number, options: LifecycleKillOptions = {}): number | null {
  const targetPort = port ?? resolvePort();

  // Try PID file first
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    const portOwner = lookupPidOnPort(targetPort);
    const commandLooksLikeGateway = pidLooksLikeGateway(pid);
    if (!shouldSignalPidFileProcess(pid, portOwner, commandLooksLikeGateway)) {
      logger.warn(
        portOwner.status === "none"
          ? `PID file points to ${pid}, but no process owns port ${targetPort}. Cleaning up stale PID file.`
          : portOwner.status === "unknown"
            ? `PID file points to ${pid}, but port ${targetPort} ownership could not be verified and the process does not look like Jinn. Cleaning up stale PID file.`
            : `PID file points to ${pid}, but port ${targetPort} is owned by ${portOwner.pid}. Cleaning up stale PID file.`,
      );
      fs.unlinkSync(PID_FILE);
    } else {
      assertPidBelongsToThisInstance(pid, targetPort, options);
      try {
        process.kill(pid, "SIGTERM");
        logger.info(`Sent SIGTERM to gateway process ${pid}`);
        return pid;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
          fs.unlinkSync(PID_FILE);
        } else {
          throw err;
        }
      }
    }

    // PID file existed but was stale; fall through to kill by port.
  }

  // No PID file — try to kill whatever is listening on the port
  const portOwner = lookupPidOnPort(targetPort);
  if (portOwner.status === "found") {
    const pid = portOwner.pid;
    assertPidBelongsToThisInstance(pid, targetPort, options);
    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Killed process ${pid} on port ${targetPort}`);
      return pid;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} already gone.`);
        return pid;
      }
      throw err;
    }
  }
  if (portOwner.status === "unknown") {
    logger.warn(`Could not determine process listening on port ${targetPort}.`);
    return null;
  }

  logger.warn(`No PID file found and nothing listening on port ${targetPort}.`);
  return null;
}

export function stop(port?: number, options: LifecycleKillOptions = {}): boolean {
  return signalGateway(port, options) !== null;
}

/**
 * Stop the gateway and wait until the process has actually exited (bounded by
 * `timeoutMs`), then remove the PID file. This is the race-free variant used
 * by the restart path: the PID file stays on disk for the whole shutdown so a
 * concurrent start/status keeps seeing "running" until the port is truly
 * released. Returns true if something was signaled, false if nothing was
 * running.
 */
export async function stopAndWait(
  port?: number,
  timeoutMs = 10_000,
  options: LifecycleKillOptions = {},
): Promise<boolean> {
  const targetPort = port ?? resolvePort();
  const pid = signalGateway(targetPort, options);
  if (pid === null) return false;

  const exited = await waitForPidExit(pid, timeoutMs);
  if (!exited) {
    const portOwner = lookupPidOnPort(targetPort);
    if (!shouldSignalPidFileProcess(pid, portOwner, pidLooksLikeGateway(pid))) {
      logger.warn(`Process ${pid} no longer verifies as the gateway for port ${targetPort} after SIGTERM — not force-killing it`);
      try {
        if (
          fs.existsSync(PID_FILE) &&
          parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) === pid
        ) {
          fs.unlinkSync(PID_FILE);
        }
      } catch {
        // best-effort cleanup; a leftover stale file self-heals (see signalGateway)
      }
      return true;
    }
    assertPidBelongsToThisInstance(pid, targetPort, options);
    logger.warn(`Process ${pid} still alive after ${timeoutMs}ms — forcing exit`);
    try {
      process.kill(pid, "SIGKILL");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw err;
    }
    const killed = await waitForPidExit(pid, 3_000);
    if (!killed) {
      logger.warn(`Process ${pid} still alive after SIGKILL — leaving PID file in place`);
      return true;
    }
  }

  // Only remove the PID file if it still refers to the process we stopped —
  // a fresh daemon may have overwritten it already.
  try {
    if (
      fs.existsSync(PID_FILE) &&
      parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) === pid
    ) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // best-effort cleanup; a leftover stale file self-heals (see signalGateway)
  }
  return true;
}

/** Poll kill(pid, 0) until the process is gone, or `timeoutMs` elapses. */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH (or EPERM on a recycled PID) — treat as exited
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function resolvePort(): number {
  try {
    const config = loadConfig();
    return config.gateway?.port || 7777;
  } catch {
    return 7777;
  }
}

export function lookupPidOnPort(port: number): PortOwnerLookup {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" }).trim();
      if (!output) return { status: "none" };
      // netstat output: proto  local_addr  foreign_addr  state  PID
      const parts = output.split("\n")[0].trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      return isNaN(pid) ? { status: "unknown" } : { status: "found", pid };
    } else {
      const output = execSync(
        process.platform === "darwin"
          ? `/usr/sbin/lsof -nP -iTCP:${port} -sTCP:LISTEN -t`
          : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`,
        { encoding: "utf-8" },
      ).trim();
      if (!output) return { status: "none" };
      const pids = output
        .split("\n")
        .map((line) => parseInt(line, 10))
        .filter((pid) => !isNaN(pid));
      const pid = selectPortOwnerPid(pids);
      return pid === undefined ? { status: "unknown" } : { status: "found", pid };
    }
  } catch (err: unknown) {
    const status = (err as { status?: number | null }).status;
    return status === 1 ? { status: "none" } : { status: "unknown" };
  }
}

function findPidOnPort(port: number): number | null {
  const lookup = lookupPidOnPort(port);
  return lookup.status === "found" ? lookup.pid : null;
}

function pidLooksLikeGateway(pid: number): boolean {
  try {
    if (process.platform === "win32") return false;
    const output = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
    return output.includes("daemon-entry.js");
  } catch {
    return false;
  }
}

/**
 * Poll until nothing is listening on `port`, or `timeoutMs` elapses.
 * Returns true if the port became free, false on timeout (caller should start
 * anyway — startGateway will surface EADDRINUSE if it's still bound). This is
 * the race-killer: it prevents a fresh daemon from racing the old one's
 * graceful shutdown (up to 5s) into an EADDRINUSE crash.
 */
export async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findPidOnPort(port) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function waitForPortListening(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function waitForDashboardReady(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dashboardIsReady(port, host)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function dashboardIsReady(port: number, host: string): Promise<boolean> {
  try {
    const baseUrl = gatewayBaseUrl({ port, host });
    const root = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) });
    if (!root.ok) return false;

    const html = await root.text();
    if (!html.includes('id="root"')) return false;

    const assetRefs = new Set([...html.matchAll(/["']\/assets\/([^"']+)["']/g)].map((match) => match[1]));
    if (assetRefs.size === 0) return false;

    for (const assetRef of assetRefs) {
      const asset = await fetch(`${baseUrl}/assets/${assetRef}`, { signal: AbortSignal.timeout(1_000) });
      if (!asset.ok) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export function getStatus(): GatewayStatus {
  const targetPort = resolvePort();

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      // Process not alive, stale PID file — fall back to port check.
      const portPid = findPidOnPort(targetPort);
      if (portPid) return { running: true, pid: portPid };
      return { running: false, pid };
    }
  }

  const portPid = findPidOnPort(targetPort);
  if (portPid) return { running: true, pid: portPid };
  return { running: false, pid: null };
}
