import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getInstanceStatus, resolveInstanceEndpoint } from "../lifecycle.js";

/**
 * getInstanceStatus is the single answer to "is this instance's gateway up". `jinn list`
 * used to ask with a bare kill(pid, 0), which answers for whatever process inherited the
 * recycled number and printed a dead instance green. The pid file alone is never enough.
 */

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    // A child that already exited will never emit "exit" again — waiting on one that
    // has would hang the hook until vitest's timeout.
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise((resolve) => child.once("exit", resolve).once("error", resolve));
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-instance-status-"));
  dirs.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function spawnChild(script: string, env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

function writePidFile(home: string, pid: number): string {
  const pidFile = path.join(home, "gateway.pid");
  fs.writeFileSync(pidFile, String(pid));
  return pidFile;
}

describe("getInstanceStatus", () => {
  it("reports stopped with no pid when there is no pid file and nothing on the port", async () => {
    const status = getInstanceStatus(path.join(tempHome(), "gateway.pid"), await freePort());
    expect(status).toEqual({ running: false, pid: null });
  });

  it("reports running when a process holds the port", async () => {
    const port = await freePort();
    const child = await spawnChild(
      `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`,
    );
    // Give the listener a moment to bind before asking who owns the port.
    for (let i = 0; i < 50; i++) {
      if (getInstanceStatus(path.join(tempHome(), "gateway.pid"), port, "127.0.0.1").running) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = getInstanceStatus(path.join(tempHome(), "gateway.pid"), port, "127.0.0.1");
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
  });

  it("reports a dead pid as stopped, with reason \"dead\"", async () => {
    const home = tempHome();
    const child = await spawnChild("process.exit(0)");
    await new Promise((resolve) => child.once("exit", resolve));
    const status = getInstanceStatus(writePidFile(home, child.pid!), await freePort());
    expect(status).toEqual({ running: false, pid: child.pid, reason: "dead" });
  });

  it.skipIf(process.platform === "win32")(
    "reports a live but unrelated pid as stopped, with reason \"not-ours\"",
    async () => {
      // The recycled-pid case: gateway.pid names a number a restart handed to some
      // other process. It answers kill(pid, 0) and is emphatically not the gateway —
      // it holds no port and its command line is not daemon-entry.js.
      const home = tempHome();
      const child = await spawnChild("setInterval(() => {}, 1000)");
      const status = getInstanceStatus(writePidFile(home, child.pid!), await freePort());
      expect(status.running).toBe(false);
      expect(status.pid).toBe(child.pid);
      // The distinction status.ts prints on: saying "process is not alive" here
      // would send an operator off to kill a stranger's process.
      expect(status.reason).toBe("not-ours");
    },
  );

  it("ignores a pid file that does not hold a usable pid", async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "gateway.pid"), "not-a-pid\n");
    const status = getInstanceStatus(path.join(home, "gateway.pid"), await freePort());
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});

/** `jinn list` resolves this per row: the defaults inside getInstanceStatus describe the
 *  AMBIENT instance, so rows printed red on a host or port mismatch. */
describe("resolveInstanceEndpoint", () => {
  it("ignores stale runtime binding when no matching live gateway owns it", async () => {
    const home = tempHome();
    const runtimePort = await freePort();
    const unrelated = await spawnChild(
      `require("node:net").createServer().listen(${runtimePort}, "::1"); setInterval(() => {}, 1000);`,
    );
    for (let i = 0; i < 50; i++) {
      if (getInstanceStatus(path.join(home, "gateway.pid"), runtimePort, "::1").running) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
      port: runtimePort,
      host: "::1",
      pid: unrelated.pid,
    }, null, 2));
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7778\n  host: 127.0.0.1\n");

    expect(resolveInstanceEndpoint(home, 7000)).toEqual({ host: "127.0.0.1", port: 7778 });
  });

  it("prefers what the instance's running gateway recorded", async () => {
    const home = tempHome();
    const port = await freePort();
    const child = await spawnChild(
      `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`,
      { ...process.env, JINN_HOME: home, JINN_HOME_IDENTITY: fs.realpathSync.native(home) },
    );
    for (let i = 0; i < 50; i++) {
      if (getInstanceStatus(path.join(home, "gateway.pid"), port, "127.0.0.1").running) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port, host: "127.0.0.1", pid: child.pid }, null, 2));
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7778\n  host: 100.64.0.3\n");
    expect(resolveInstanceEndpoint(home, 7778)).toEqual({ host: "127.0.0.1", port });
  });

  it("falls back to the instance's own config.yaml over the registry", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7900\n  host: 127.0.0.1\n");
    expect(resolveInstanceEndpoint(home, 7778)).toEqual({ host: "127.0.0.1", port: 7900 });
  });

  it("falls back to loopback and the registry's port when the home says nothing", () => {
    // Loopback, not a wildcard: listenerOverlapsHost treats a wildcard as matching every
    // listener, which reports an unrelated process on the port as the instance.
    expect(resolveInstanceEndpoint(tempHome(), 7778)).toEqual({ host: "127.0.0.1", port: 7778 });
  });

  it("ignores an unreadable or ill-typed config.yaml", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7778\n  host:\n");
    expect(resolveInstanceEndpoint(home, 7778)).toEqual({ host: "127.0.0.1", port: 7778 });

    const broken = tempHome();
    fs.writeFileSync(path.join(broken, "config.yaml"), "gateway: [unterminated\n");
    expect(resolveInstanceEndpoint(broken, 7778)).toEqual({ host: "127.0.0.1", port: 7778 });
  });
});
