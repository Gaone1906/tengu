import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-test-"));
process.env.JINN_HOME = tmpHome;

const lifecycle = vi.hoisted(() => ({
  assertPortTakeoverAllowed: vi.fn(),
  restartDetached: vi.fn(),
}));
const restartRequest = vi.hoisted(() => ({
  requestRestartFromGateway: vi.fn(async () => true),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../restart-request.js", () => restartRequest);
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 21877 }, engines: { default: "claude" } }),
}));

const { runRestart } = await import("../restart.js");

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(tmpHome, { recursive: true });
});

describe("runRestart", () => {
  it("asks the running gateway to spawn the restart helper", async () => {
    await runRestart();

    expect(restartRequest.requestRestartFromGateway).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
  });

  it("falls back to the detached helper when the gateway request is unavailable", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runRestart();

    expect(lifecycle.restartDetached).toHaveBeenCalledTimes(1);
  });

  it("passes --take-port to the detached helper when explicitly requested", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runRestart({ takePort: true });

    expect(lifecycle.restartDetached).toHaveBeenCalledWith({ takePort: true, port: 21877 });
  });
});
