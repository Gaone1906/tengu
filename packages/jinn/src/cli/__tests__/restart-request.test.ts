import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-request-test-"));
const previousJinnHome = process.env.JINN_HOME;
process.env.JINN_HOME = tmpHome;

const { requestRestartFromGateway } = await import("../restart-request.js");

let runtimePort = 0;
let gatewayChild: ChildProcess;

beforeAll(async () => {
  runtimePort = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "::1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  gatewayChild = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${runtimePort}, "::1"); setInterval(() => {}, 1000);`], {
    stdio: "ignore",
    env: { ...process.env, JINN_HOME: tmpHome, JINN_HOME_IDENTITY: fs.realpathSync.native(tmpHome) },
  });
  await new Promise<void>((resolve, reject) => {
    gatewayChild.once("error", reject);
    gatewayChild.once("spawn", resolve);
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.connect(runtimePort, "::1", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (listening) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.JINN_SESSION_ID;
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "config.yaml"), `gateway:\n  host: ::1\n  port: ${runtimePort}\n`);
  fs.writeFileSync(path.join(tmpHome, "gateway.json"), JSON.stringify({
    port: runtimePort,
    host: "::1",
    pid: gatewayChild.pid,
    secret: "hook-secret",
    token: "gateway-token",
  }));
});

afterAll(async () => {
  gatewayChild.kill("SIGKILL");
  await new Promise<void>((resolve) => gatewayChild.once("exit", () => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (previousJinnHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = previousJinnHome;
});

describe("requestRestartFromGateway", () => {
  it("posts an authenticated restart request to the running gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "restarting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const ok = await requestRestartFromGateway(fetchMock as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://[::1]:${runtimePort}/api/system/restart`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("passes the current Jinn session id when available", async () => {
    process.env.JINN_SESSION_ID = "session-requesting-restart";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "restarting" }), { status: 200 }));

    const ok = await requestRestartFromGateway(fetchMock as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://[::1]:${runtimePort}/api/system/restart`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-jinn-session-id": "session-requesting-restart",
        }),
      }),
    );
  });

  it("returns false when the running gateway does not support the endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    await expect(requestRestartFromGateway(fetchMock as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("returns false when gateway connection metadata is unavailable", async () => {
    fs.rmSync(path.join(tmpHome, "gateway.json"), { force: true });
    const fetchMock = vi.fn();

    await expect(requestRestartFromGateway(fetchMock as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies JINN_HOST/JINN_PORT over config while ignoring an unowned runtime endpoint", async () => {
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), "gateway:\n  host: 127.0.0.1\n  port: 7777\n");
    fs.writeFileSync(path.join(tmpHome, "gateway.json"), JSON.stringify({
      port: 65530,
      host: "127.0.0.1",
      pid: process.pid,
      secret: "stale",
      token: "stale-bearer-must-not-leave-disk",
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "restarting" }), { status: 200 }));
    const previousHost = process.env.JINN_HOST;
    const previousPort = process.env.JINN_PORT;
    process.env.JINN_HOST = "::1";
    process.env.JINN_PORT = "8894";

    try {
      await expect(requestRestartFromGateway(fetchMock as unknown as typeof fetch)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://[::1]:8894/api/system/restart",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer stale-bearer-must-not-leave-disk" }),
        }),
      );
    } finally {
      if (previousHost === undefined) delete process.env.JINN_HOST;
      else process.env.JINN_HOST = previousHost;
      if (previousPort === undefined) delete process.env.JINN_PORT;
      else process.env.JINN_PORT = previousPort;
    }
  });
});
