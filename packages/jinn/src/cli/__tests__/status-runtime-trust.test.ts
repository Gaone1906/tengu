import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-status-runtime-trust-"));
const previousJinnHome = process.env.JINN_HOME;
process.env.JINN_HOME = home;

const { runStatus } = await import("../status.js");

const server = net.createServer();
let durablePort = 0;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      durablePort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
  fs.writeFileSync(path.join(home, "config.yaml"), `gateway:\n  host: 127.0.0.1\n  port: ${durablePort}\n`);
  // Status intentionally does not trust gateway.json's pid. Seed the
  // authoritative process record so this routing test does not depend on an
  // unrelated listener already occupying its overridden port.
  fs.writeFileSync(path.join(home, "gateway.pid"), `${process.pid}\n`);
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
    port: 65527,
    host: "127.0.0.1",
    pid: process.pid,
    secret: "stale",
    token: "stale-status-token",
  }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
  if (previousJinnHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = previousJinnHome;
  vi.unstubAllGlobals();
});

describe("status runtime endpoint trust", () => {
  it("applies JINN_HOST/JINN_PORT over durable config without trusting runtime routing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const previousHost = process.env.JINN_HOST;
    const previousPort = process.env.JINN_PORT;
    process.env.JINN_HOST = "::1";
    process.env.JINN_PORT = "8892";

    try {
      await runStatus();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://[::1]:8892/api/status",
        expect.any(Object),
      );
    } finally {
      if (previousHost === undefined) delete process.env.JINN_HOST;
      else process.env.JINN_HOST = previousHost;
      if (previousPort === undefined) delete process.env.JINN_PORT;
      else process.env.JINN_PORT = previousPort;
    }
  });
});
