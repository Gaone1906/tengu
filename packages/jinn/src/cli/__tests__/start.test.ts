import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-start-test-"));
process.env.JINN_HOME = tmpHome;

const lifecycle = vi.hoisted(() => ({
  assertPortTakeoverAllowed: vi.fn(),
  getStatus: vi.fn(() => ({ running: true, pid: 123 })),
  restartDetached: vi.fn(),
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
}));
const restartRequest = vi.hoisted(() => ({
  requestRestartFromGateway: vi.fn(async () => true),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../restart-request.js", () => restartRequest);
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 7777 }, engines: { default: "claude" } }),
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));

const { runStart } = await import("../start.js");

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("runStart", () => {
  it("asks the running gateway to own the restart when one is already running", async () => {
    await runStart({ daemon: false });

    expect(restartRequest.requestRestartFromGateway).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
    expect(lifecycle.startForeground).not.toHaveBeenCalled();
    expect(lifecycle.startDaemon).not.toHaveBeenCalled();
  });

  it("falls back to the detached restart helper when the gateway request fails", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runStart({ daemon: false });

    expect(lifecycle.restartDetached).toHaveBeenCalledTimes(1);
  });

  it("passes --take-port to the detached restart helper when explicitly requested", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runStart({ daemon: false, takePort: true });

    expect(lifecycle.restartDetached).toHaveBeenCalledWith({ takePort: true });
  });
});
