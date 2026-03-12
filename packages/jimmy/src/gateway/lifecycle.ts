import { execSync, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PID_FILE, JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { startGateway } from "./server.js";
import { loadConfig } from "../shared/config.js";

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
  const entryScript = path.resolve(
    path.dirname(__filename),
    "..",
    "..",
    "dist",
    "src",
    "gateway",
    "daemon-entry.js",
  );

  // Fork a child process that will run the gateway
  const child = fork(entryScript, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JINN_HOME },
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.unref();
}

export function stop(port?: number): boolean {
  // Try PID file first
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Sent SIGTERM to gateway process ${pid}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
      } else {
        throw err;
      }
    }

    fs.unlinkSync(PID_FILE);
    return true;
  }

  // No PID file — try to kill whatever is listening on the port
  const targetPort = port ?? resolvePort();
  const pid = findPidOnPort(targetPort);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Killed process ${pid} on port ${targetPort}`);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} already gone.`);
        return true;
      }
      throw err;
    }
  }

  logger.warn(`No PID file found and nothing listening on port ${targetPort}.`);
  return false;
}

function resolvePort(): number {
  try {
    const config = loadConfig();
    return config.gateway?.port || 7777;
  } catch {
    return 7777;
  }
}

function findPidOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" }).trim();
      if (!output) return null;
      // netstat output: proto  local_addr  foreign_addr  state  PID
      const parts = output.split("\n")[0].trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      return isNaN(pid) ? null : pid;
    } else {
      const output = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8" }).trim();
      if (!output) return null;
      const pid = parseInt(output.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export function getStatus(): GatewayStatus {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false, pid: null };
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process not alive, stale PID file
    return { running: false, pid };
  }
}
