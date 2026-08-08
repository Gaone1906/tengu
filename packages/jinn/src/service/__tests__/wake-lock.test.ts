import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WakeLockSupervisor, defaultPacingStateReader, resolveWakeLockCommand } from "../wake-lock.js";

class FakeChildProcess extends EventEmitter {
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.emit("exit", 0);
  });
}

describe("resolveWakeLockCommand", () => {
  it("uses caffeinate -i on macOS", () => {
    expect(resolveWakeLockCommand("darwin")).toEqual({ command: "caffeinate", args: ["-i"] });
  });

  it("uses systemd-inhibit blocking idle:sleep on Linux", () => {
    const cmd = resolveWakeLockCommand("linux");
    expect(cmd?.command).toBe("systemd-inhibit");
    expect(cmd?.args).toContain("--what=idle:sleep");
    expect(cmd?.args).toContain("--mode=block");
  });

  it("has no inhibitor on unsupported platforms", () => {
    expect(resolveWakeLockCommand("win32")).toBeUndefined();
  });
});

describe("defaultPacingStateReader", () => {
  it("is conservative until shared/pacing-controller.ts lands: no signal, no wake lock", () => {
    expect(defaultPacingStateReader()).toEqual({ hasQueuedWork: false });
  });
});

describe("WakeLockSupervisor gating on pacing-controller state", () => {
  it("does NOT assert the wake lock when the pacing controller reports no queued work", async () => {
    const spawnFn = vi.fn();
    const reader = vi.fn(async () => ({ hasQueuedWork: false }));
    const supervisor = new WakeLockSupervisor({ reader, spawn: spawnFn as any, platform: "darwin" });

    const active = await supervisor.check();

    expect(active).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("asserts the wake lock via the platform command when queued work is reported", async () => {
    const child = new FakeChildProcess();
    const spawnFn = vi.fn(() => child as any);
    const reader = vi.fn(async () => ({ hasQueuedWork: true }));
    const supervisor = new WakeLockSupervisor({ reader, spawn: spawnFn as any, platform: "darwin" });

    const active = await supervisor.check();

    expect(active).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith("caffeinate", ["-i"], { stdio: "ignore" });
  });

  it("releases the wake lock once the pacing controller reports the queue drained", async () => {
    const child = new FakeChildProcess();
    const spawnFn = vi.fn(() => child as any);
    let hasQueuedWork = true;
    const reader = vi.fn(async () => ({ hasQueuedWork }));
    const supervisor = new WakeLockSupervisor({ reader, spawn: spawnFn as any, platform: "darwin" });

    await supervisor.check();
    expect(supervisor.active).toBe(true);

    hasQueuedWork = false;
    await supervisor.check();

    expect(supervisor.active).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("never spawns a second inhibitor while one is already active", async () => {
    const child = new FakeChildProcess();
    const spawnFn = vi.fn(() => child as any);
    const reader = vi.fn(async () => ({ hasQueuedWork: true }));
    const supervisor = new WakeLockSupervisor({ reader, spawn: spawnFn as any, platform: "darwin" });

    await supervisor.check();
    await supervisor.check();

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
