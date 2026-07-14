import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-start-test-"));
process.env.JINN_HOME = tmpHome;

const childProcess = vi.hoisted(() => ({
  child: { on: vi.fn(), unref: vi.fn() },
  spawn: vi.fn(),
}));
childProcess.spawn.mockImplementation(() => childProcess.child);

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
const migration = vi.hoisted(() => ({
  getPendingInstanceMigration: vi.fn(() => ({
    required: false,
    fromVersion: "1.0.0",
    toVersion: "1.0.0",
    versions: [],
    changedFiles: [],
    prompt: null,
    migrationKey: null,
    materialization: null,
  })),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("node:child_process", () => ({ spawn: childProcess.spawn }));
vi.mock("../restart-request.js", () => restartRequest);
vi.mock("../../migrations/service.js", () => migration);
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 21877 }, engines: { default: "claude" } }),
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
  isStrictSemver: (value: string) => /^\d+\.\d+\.\d+$/.test(value),
}));

const { runStart } = await import("../start.js");
const { consumeLocalBootstrapGrant } = await import("../../gateway/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  migration.getPendingInstanceMigration.mockReturnValue({
    required: false,
    fromVersion: "1.0.0",
    toVersion: "1.0.0",
    versions: [],
    changedFiles: [],
    prompt: null,
    migrationKey: null,
    materialization: null,
  });
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("runStart", () => {
  it("validates migrations successfully without falling through the warning path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runStart({ daemon: false });

    expect(migration.getPendingInstanceMigration).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on migration validation failure while continuing normal startup", async () => {
    migration.getPendingInstanceMigration.mockImplementationOnce(() => { throw new Error("broken chain"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runStart({ daemon: false });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/broken chain/));
    expect(restartRequest.requestRestartFromGateway).toHaveBeenCalledTimes(1);
  });

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

    expect(lifecycle.restartDetached).toHaveBeenCalledWith({ takePort: true, port: 21877 });
  });

  it("opens an interactive dashboard with a valid one-time bootstrap grant", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });
    lifecycle.startForeground.mockResolvedValueOnce(undefined);
    const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.useFakeTimers();

    try {
      await runStart({ daemon: false });
      await vi.advanceTimersByTimeAsync(1_200);

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      const args = childProcess.spawn.mock.calls[0][1] as string[];
      const launched = new URL(args.at(-1)!);
      const grant = new URLSearchParams(launched.hash.slice(1)).get("jinn-bootstrap");
      expect(grant).toBeTruthy();
      expect(consumeLocalBootstrapGrant(grant)).toBe(true);
      expect(consumeLocalBootstrapGrant(grant)).toBe(false);
    } finally {
      vi.useRealTimers();
      if (originalTty) Object.defineProperty(process.stdout, "isTTY", originalTty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
});
