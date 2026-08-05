import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  serviceStart: process.env._JINN_CONTAINER_SERVICE_START,
};

process.env.JINN_CONTAINER = "1";
process.env.JINN_CONTAINER_PRIMARY_HOME = primaryHome;

const { buildProgram } = await import("../../../bin/jinn.js");
const program = buildProgram();

beforeAll(() => {
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
});

beforeEach(() => {
  delete process.env._JINN_CONTAINER_SERVICE_START;
  handlers.start.mockClear();
  handlers.setup.mockClear();
  handlers.restart.mockClear();
});

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === "container" ? "JINN_CONTAINER"
      : key === "primaryHome" ? "JINN_CONTAINER_PRIMARY_HOME"
        : key === "home" ? "JINN_HOME"
          : key === "instance" ? "JINN_INSTANCE" : "_JINN_CONTAINER_SERVICE_START";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("container CLI single-instance contract", () => {
  it.each(["setup", "start"])("allows the entrypoint's marked service %s against the primary container home", async (command) => {
    process.env.JINN_HOME = primaryHome;
    process.env._JINN_CONTAINER_SERVICE_START = "1";
    delete process.env.JINN_INSTANCE;

    await program.parseAsync(["node", "jinn", command]);

    expect(handlers[command as "setup" | "start"]).toHaveBeenCalledOnce();
  });

  it("consumes the service marker before the gateway handler can pass it to children", async () => {
    process.env.JINN_HOME = primaryHome;
    process.env._JINN_CONTAINER_SERVICE_START = "1";
    delete process.env.JINN_INSTANCE;

    await program.parseAsync(["node", "jinn", "start"]);

    expect(handlers.start).toHaveBeenCalledOnce();
    expect(process.env._JINN_CONTAINER_SERVICE_START).toBeUndefined();
  });

  it("rejects restart inside a container even with the service marker", async () => {
    process.env.JINN_HOME = primaryHome;
    process.env._JINN_CONTAINER_SERVICE_START = "1";
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "restart"])).rejects.toThrow(/docker compose restart|container restart/i);
    expect(handlers.restart).not.toHaveBeenCalled();
  });

  it.each(["setup", "start", "restart"])("rejects docker exec jinn %s without the private service marker", async (command) => {
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", command])).rejects.toThrow(/service start|already-running|container service|docker compose restart/i);
    expect(handlers[command as keyof typeof handlers]).not.toHaveBeenCalled();
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

    await expect(program.parseAsync(["node", "jinn", "restart"])).rejects.toThrow(/docker compose restart|container restart/i);
    expect(handlers.restart).not.toHaveBeenCalled();
  });

  it("rejects -i alternate restart before the handler runs", async () => {
    handlers.restart.mockClear();
    process.env.JINN_HOME = primaryHome;
    delete process.env.JINN_INSTANCE;

    await expect(program.parseAsync(["node", "jinn", "-i", "alternate", "restart"])).rejects.toThrow(/docker compose restart|container restart/i);
    expect(handlers.restart).not.toHaveBeenCalled();
  });
});
