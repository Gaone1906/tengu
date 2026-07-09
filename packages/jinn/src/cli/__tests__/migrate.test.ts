import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs to control filesystem responses and assert on writes.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      // config.yaml read by stampVersion
      readFileSync: vi.fn(() => "jinn:\n  version: 1.0.0\n"),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
  };
});

// Mock shared modules
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({
    engines: {
      default: "claude",
      claude: { bin: "/usr/local/bin/claude" },
    },
  })),
}));

vi.mock("../../shared/version.js", () => ({
  compareSemver: vi.fn(() => -1), // instance behind package by default
  getPackageVersion: vi.fn(() => "1.1.0"),
  getInstanceVersion: vi.fn(() => "1.0.0"),
}));

// Mock the pure prompt module so migrate.ts orchestration is tested in isolation.
vi.mock("../migrate-prompt.js", () => ({
  scanMigrationPrompts: vi.fn(() => ["1.1.0"]),
  composeMigrationPrompt: vi.fn(() => "COMPOSED migration prompt body"),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { scanMigrationPrompts } from "../migrate-prompt.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRenameSync = vi.mocked(fs.renameSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockCopyFileSync = vi.mocked(fs.copyFileSync);
const mockRmSync = vi.mocked(fs.rmSync);
const mockScan = vi.mocked(scanMigrationPrompts);

function assertNoFsWrites() {
  expect(mockWriteFileSync).not.toHaveBeenCalled();
  expect(mockRenameSync).not.toHaveBeenCalled();
  expect(mockMkdirSync).not.toHaveBeenCalled();
  expect(mockCopyFileSync).not.toHaveBeenCalled();
  expect(mockRmSync).not.toHaveBeenCalled();
}

describe("migrate: prompt dispenser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockScan.mockReturnValue(["1.1.0"]);
  });

  describe("default (print) mode", () => {
    it("prints the composed prompt and MUTATES NOTHING", async () => {
      const { runMigrate } = await import("../migrate.js");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({});

      // No agent launched, no filesystem writes at all.
      expect(mockExecFileSync).not.toHaveBeenCalled();
      assertNoFsWrites();

      // The composed prompt was printed.
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("COMPOSED migration prompt body");
      log.mockRestore();
    });

    it("prints an up-to-date message and writes nothing when the range is empty", async () => {
      mockScan.mockReturnValue([]);
      const { runMigrate } = await import("../migrate.js");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({});

      expect(mockExecFileSync).not.toHaveBeenCalled();
      assertNoFsWrites();
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/up to date/i);
      log.mockRestore();
    });
  });

  describe("--apply mode", () => {
    it("launches the agent with the composed prompt, then stamps the marker", async () => {
      const { runMigrate } = await import("../migrate.js");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({ apply: true });

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [, args, options] = mockExecFileSync.mock.calls[0];
      const argsArray = args as string[];

      // cwd via options, never a --cwd CLI flag.
      expect(argsArray).not.toContain("--cwd");
      expect((options as any).cwd).toBeTypeOf("string");

      // Subsidy-safe claude spawn: no headless -p/--print.
      expect(argsArray).not.toContain("-p");
      expect(argsArray).not.toContain("--print");
      expect(argsArray).toContain("--dangerously-skip-permissions");

      // The composed prompt is the last positional arg.
      expect(argsArray[argsArray.length - 1]).toBe("COMPOSED migration prompt body");

      // Marker advanced after a successful agent run (atomic write).
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockRenameSync).toHaveBeenCalledTimes(1);
    });

    it("does NOT stamp the marker when the agent exits with an error", async () => {
      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error("agent failed");
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ apply: true })).rejects.toThrow("process.exit called");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe("--mark-done mode", () => {
    it("stamps an explicit version without scanning or launching an agent", async () => {
      const { runMigrate } = await import("../migrate.js");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({ markDone: "1.1.0" });

      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockScan).not.toHaveBeenCalled();
      // Atomic stamp write.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockRenameSync).toHaveBeenCalledTimes(1);
      const written = String(mockWriteFileSync.mock.calls[0][1]);
      expect(written).toContain("1.1.0");
    });

    it("defaults to the package version when no explicit version is given", async () => {
      const { runMigrate } = await import("../migrate.js");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({ markDone: true });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const written = String(mockWriteFileSync.mock.calls[0][1]);
      expect(written).toContain("1.1.0"); // package version from mock
    });

    it("rejects a non-semver mark-done value", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ markDone: "latest" })).rejects.toThrow("process.exit called");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});
