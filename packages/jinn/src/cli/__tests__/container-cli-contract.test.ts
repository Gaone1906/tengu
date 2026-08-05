import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const handlers = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  setup: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
}));

vi.mock("../start.js", () => ({ runStart: handlers.start }));
vi.mock("../setup.js", () => ({ runSetup: handlers.setup }));
vi.mock("../restart.js", () => ({ runRestart: handlers.restart }));
vi.mock("../../shared/runtime-guard.js", () => ({
  assertNativeRuntime: vi.fn(),
  repairNodePtySpawnHelper: vi.fn(),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-container-cli-contract-"));
const primaryHome = path.join(root, "primary");
const alternateHome = path.join(root, "alternate");
fs.mkdirSync(primaryHome, { recursive: true });
fs.mkdirSync(alternateHome, { recursive: true });

const previous = {
  container: process.env.JINN_CONTAINER,
  primaryHome: process.env.JINN_CONTAINER_PRIMARY_HOME,
  home: process.env.JINN_HOME,
  instance: process.env.JINN_INSTANCE,
};

process.env.JINN_CONTAINER = "1";
process.env.JINN_CONTAINER_PRIMARY_HOME = primaryHome;

const { buildProgram } = await import("../../../bin/jinn.js");
const program = buildProgram();

beforeAll(() => {
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === "container" ? "JINN_CONTAINER"
      : key === "primaryHome" ? "JINN_CONTAINER_PRIMARY_HOME"
        : key === "home" ? "JINN_HOME" : "JINN_INSTANCE";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("container CLI single-instance contract", () => {
  it("allows restart against the primary container home", async () => {
    handlers.restart.mockClear();
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await program.parseAsync(["node", "jinn", "restart"]);

    expect(handlers.restart).toHaveBeenCalledOnce();
  });

  it("rejects setup against an alternate JINN_HOME before the handler runs", async () => {
    process.env.JINN_HOME = alternateHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "setup"])).rejects.toThrow(/one Jinn instance|primary container home/i);
    expect(handlers.setup).not.toHaveBeenCalled();
  });

  it("rejects -i alternate start before the handler runs", async () => {
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "-i", "alternate", "start"])).rejects.toThrow(/one Jinn instance|primary container home/i);
    expect(handlers.start).not.toHaveBeenCalled();
  });

  it("rejects even -i jinn so registry remapping cannot escape the primary home", async () => {
    handlers.start.mockClear();
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "-i", "jinn", "start"])).rejects.toThrow(/one Jinn instance|primary container home/i);
    expect(handlers.start).not.toHaveBeenCalled();
  });

  it("rejects restart against an alternate JINN_HOME before the handler runs", async () => {
    handlers.restart.mockClear();
    process.env.JINN_HOME = alternateHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "restart"])).rejects.toThrow(/one Jinn instance|primary container home/i);
    expect(handlers.restart).not.toHaveBeenCalled();
  });

  it("rejects -i alternate restart before the handler runs", async () => {
    handlers.restart.mockClear();
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "-i", "alternate", "restart"])).rejects.toThrow(/one Jinn instance|primary container home/i);
    expect(handlers.restart).not.toHaveBeenCalled();
  });
});
