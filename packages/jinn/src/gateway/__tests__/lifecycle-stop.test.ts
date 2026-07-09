import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Point JINN_HOME at a temp dir BEFORE importing the module under test so
// PID_FILE resolves inside it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-lifecycle-stop-"));
process.env.JINN_HOME = tmpHome;

const { buildGatewayChildEnv, lookupPidOnPort, shouldSignalPidFileProcess, stop, stopAndWait } = await import("../lifecycle.js");
const { PID_FILE } = await import("../../shared/paths.js");

/** Pick a free ephemeral port (nothing will be listening on it afterwards). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn a child that exits `delayMs` after receiving SIGTERM (simulating graceful shutdown). */
function spawnSlowShutdownChild(delayMs: number): ChildProcess {
  const script = `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${delayMs})); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

/** Spawn a child that ignores SIGTERM until force-killed. */
function spawnIgnoringSigtermChild(): ChildProcess {
  const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function spawnListeningGatewayChild(port: number, opts: { sigtermDelayMs?: number; ignoreSigterm?: boolean }): ChildProcess {
  const sigtermHandler = opts.ignoreSigterm
    ? `process.on("SIGTERM", () => {});`
    : `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${opts.sigtermDelayMs ?? 0}));`;
  const script = `
    const net = require("node:net");
    const server = net.createServer();
    server.listen(${port}, "127.0.0.1");
    ${sigtermHandler}
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function spawnClientChild(port: number): ChildProcess {
  const script = `
    const net = require("node:net");
    const socket = net.connect({ port: ${port}, host: "127.0.0.1" });
    socket.on("error", () => {});
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForListening(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(100, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} did not start listening`);
}

describe("stop / stopAndWait PID-file race", () => {
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForExit(child);
    }
    fs.rmSync(PID_FILE, { force: true });
  });

  it("stop() leaves the PID file in place while the process is still shutting down", async () => {
    const port = await freePort();
    const child = spawnListeningGatewayChild(port, { sigtermDelayMs: 500 });
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = stop(port);
    expect(stopped).toBe(true);
    // The fix: no early unlink — a concurrent start/status must keep seeing
    // the (still running) gateway until it actually exits.
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(child.exitCode).toBe(null); // still shutting down

    await waitForExit(child);
  });

  it("stopAndWait() waits for the process to exit, then removes the PID file", async () => {
    const port = await freePort();
    const child = spawnListeningGatewayChild(port, { sigtermDelayMs: 300 });
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = await stopAndWait(port, 5_000);
    expect(stopped).toBe(true);
    // Process must be gone by the time stopAndWait resolves…
    expect(() => process.kill(child.pid!, 0)).toThrow();
    // …and only then is the PID file removed.
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stopAndWait() force-kills a process that ignores SIGTERM", async () => {
    const port = await freePort();
    const child = spawnListeningGatewayChild(port, { ignoreSigterm: true });
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = await stopAndWait(port, 200);
    expect(stopped).toBe(true);
    await waitForExit(child);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stopAndWait() does not kill a stale PID-file process that does not own the gateway port", async () => {
    const child = spawnIgnoringSigtermChild();
    children.push(child);
    await waitForSpawn(child);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = await stopAndWait(await freePort(), 200);
    expect(stopped).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stop() cleans up a stale PID file and reports not running", async () => {
    const child = spawnSlowShutdownChild(0);
    children.push(child);
    await waitForSpawn(child);
    const deadPid = child.pid!;
    child.kill("SIGKILL");
    await waitForExit(child);

    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(deadPid));

    const stopped = stop(await freePort());
    expect(stopped).toBe(false);
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("lookupPidOnPort() returns the listener PID, not a connected client PID", async () => {
    const port = await freePort();
    const server = spawnListeningGatewayChild(port, { ignoreSigterm: true });
    children.push(server);
    await waitForSpawn(server);
    await waitForListening(port);

    const client = spawnClientChild(port);
    children.push(client);
    await waitForSpawn(client);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(lookupPidOnPort(port)).toEqual({ status: "found", pid: server.pid });
  });
});

describe("shouldSignalPidFileProcess", () => {
  it("does not trust a PID file when port ownership lookup is unknown and the command is not Jinn", () => {
    expect(shouldSignalPidFileProcess(123, { status: "unknown" }, false)).toBe(false);
  });

  it("trusts a PID file with unknown port ownership only when the command looks like Jinn", () => {
    expect(shouldSignalPidFileProcess(123, { status: "unknown" }, true)).toBe(true);
  });

  it("trusts a PID file when the process owns the gateway port", () => {
    expect(shouldSignalPidFileProcess(123, { status: "found", pid: 123 }, false)).toBe(true);
    expect(shouldSignalPidFileProcess(123, { status: "found", pid: 456 }, true)).toBe(false);
  });
});

describe("buildGatewayChildEnv", () => {
  it("overrides stale gateway env from another instance", () => {
    const env = buildGatewayChildEnv({
      gateway: { port: 7789, host: "127.0.0.1" },
      engines: { default: "claude" },
    } as any, {
      ...process.env,
      JINN_HOME: "/wrong/home",
      JINN_GATEWAY_URL: "http://127.0.0.1:7777",
      JINN_GATEWAY_TOKEN: "wrong-token",
    });

    expect(env.JINN_HOME).toBe(tmpHome);
    expect(env.JINN_GATEWAY_URL).toBe("http://127.0.0.1:7789");
    expect(env.JINN_GATEWAY_TOKEN).not.toBe("wrong-token");
    expect(env.JINN_GATEWAY_TOKEN).toBeTruthy();
  });

  it("scrubs inherited session and engine child env before spawning a daemon", () => {
    const env = buildGatewayChildEnv({
      gateway: { port: 7789, host: "127.0.0.1" },
      engines: { default: "claude" },
    } as any, {
      PATH: "/usr/bin",
      CODEX: "1",
      CODEX_HOME: "/tmp/jinn/tmp/codex-homes/session-1",
      CODEX_API_KEY: "should-not-parent-daemon",
      JINN_SESSION_ID: "session-1",
      JINN_SESSION_CAPABILITY: "capability-secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:12345",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      HERMES_YOLO_MODE: "1",
      HERMES_ACCEPT_HOOKS: "1",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.CODEX).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBeUndefined();
    expect(env.JINN_SESSION_CAPABILITY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
    expect(env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBeUndefined();
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBeUndefined();
    expect(env.HERMES_YOLO_MODE).toBeUndefined();
    expect(env.HERMES_ACCEPT_HOOKS).toBeUndefined();
    expect(env.JINN_HOME).toBe(tmpHome);
    expect(env.JINN_GATEWAY_URL).toBe("http://127.0.0.1:7789");
    expect(env.JINN_GATEWAY_TOKEN).toBeTruthy();
  });
});
