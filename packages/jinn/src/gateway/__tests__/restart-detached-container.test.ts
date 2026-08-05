import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => {
  const child = { pid: 4321, unref: vi.fn() };
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
}));
vi.mock("../../shared/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/config.js")>()),
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 21877 }, engines: { default: "claude" } }),
}));
vi.mock("../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth.js")>()),
  ensureGatewayAuthToken: () => "test-gateway-token",
}));

const previousContainer = process.env.JINN_CONTAINER;
const { restartDetached } = await import("../lifecycle.js");

beforeEach(() => {
  childProcess.spawn.mockClear();
  childProcess.child.unref.mockClear();
});

afterEach(() => {
  if (previousContainer === undefined) delete process.env.JINN_CONTAINER;
  else process.env.JINN_CONTAINER = previousContainer;
});

describe("restartDetached container boundary", () => {
  it("refuses to spawn a detached replacement inside Docker", () => {
    process.env.JINN_CONTAINER = "1";

    expect(() => restartDetached()).toThrow(/docker compose restart jinn/i);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("preserves detached restart behavior on a host", () => {
    delete process.env.JINN_CONTAINER;

    expect(() => restartDetached()).not.toThrow();
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(childProcess.child.unref).toHaveBeenCalledOnce();
  });
});
