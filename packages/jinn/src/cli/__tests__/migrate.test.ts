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
// formatStagedFutureNotice stays real (pure text) so the notice wiring is
// exercised end-to-end; only the fs-scanning functions are stubbed.
vi.mock("../migrate-prompt.js", async () => {
  const actual = await vi.importActual<typeof import("../migrate-prompt.js")>(
    "../migrate-prompt.js",
  );
  return {
    ...actual,
    scanMigrationPrompts: vi.fn(() => ["1.1.0"]),
    composeMigrationPrompt: vi.fn(() => "COMPOSED migration prompt body"),
    scanFutureMigrations: vi.fn(() => []),
  };
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { scanMigrationPrompts, scanFutureMigrations } from "../migrate-prompt.js";
import { stampVersionInYaml } from "../migrate.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRenameSync = vi.mocked(fs.renameSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockCopyFileSync = vi.mocked(fs.copyFileSync);
const mockRmSync = vi.mocked(fs.rmSync);
const mockScan = vi.mocked(scanMigrationPrompts);
const mockScanFuture = vi.mocked(scanFutureMigrations);

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
    mockScanFuture.mockReturnValue([]);
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

    it("prints a future-staged notice when a migration dir sits above the package version", async () => {
      // Instance up to date, but the next release's dir is pre-staged.
      mockScan.mockReturnValue([]);
      mockScanFuture.mockReturnValue(["1.2.0"]);
      const { runMigrate } = await import("../migrate.js");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await runMigrate({});

      assertNoFsWrites();
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/staged for a future release/i);
      expect(printed).toContain("1.2.0");
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

/**
 * The version marker lives in the user-owned config.yaml, which the live gateway
 * hot-reloads. Stamping must be a surgical text edit — comments, quoting, and
 * key order are the user's and must survive byte-for-byte. Only the version line
 * may change. This is the shared path behind both --mark-done and --apply.
 */
describe("stampVersionInYaml: surgical, comment-preserving version stamp", () => {
  /** Assert exactly one line differs between two texts, and return it. */
  function soleChangedLine(before: string, after: string): { from: string; to: string } {
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b.length).toBe(a.length);
    const changed: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
    expect(changed).toHaveLength(1);
    return { from: a[changed[0]], to: b[changed[0]] };
  }

  it("changes ONLY the version line, preserving comments and odd quoting", () => {
    const before = [
      "# top-of-file comment",
      "engines:",
      "  default: claude   # inline comment stays",
      "  claude:",
      "    model: 'opus'",
      "jinn:",
      "  # marker for the last applied migration",
      "  version: 0.20.0",
      "  telemetry: false",
      "connectors:",
      '  slack: { token: "xoxb-abc" }',
      "",
    ].join("\n");

    const after = stampVersionInYaml(before, "0.26.0");
    const { from, to } = soleChangedLine(before, after);
    expect(from).toBe("  version: 0.20.0");
    expect(to).toBe('  version: "0.26.0"');

    // Everything else is byte-identical.
    expect(after).toContain("# top-of-file comment");
    expect(after).toContain("  default: claude   # inline comment stays");
    expect(after).toContain("    model: 'opus'");
    expect(after).toContain("  # marker for the last applied migration");
    expect(after).toContain('  slack: { token: "xoxb-abc" }');
  });

  it("appends version into an existing jinn block that lacks the key", () => {
    const before = ["jinn:", "  telemetry: false", "other:", "  x: 1", ""].join("\n");
    const after = stampVersionInYaml(before, "0.26.0");

    expect(after).toContain('  version: "0.26.0"');
    // Inserted inside the jinn block (before the next top-level key), key kept.
    expect(after.indexOf('version: "0.26.0"')).toBeLessThan(after.indexOf("other:"));
    expect(after).toContain("  telemetry: false");
    expect(after).toContain("  x: 1");
  });

  it("appends a jinn block when none exists, keeping the rest intact", () => {
    const before = ["engines:", "  default: claude", ""].join("\n");
    const after = stampVersionInYaml(before, "0.26.0");

    expect(after).toContain("engines:");
    expect(after).toContain("  default: claude");
    expect(after).toMatch(/jinn:\n {2}version: "0\.26\.0"\n$/);
  });

  it("preserves a trailing CR on a CRLF version line", () => {
    const before = "jinn:\r\n  version: 0.20.0\r\n";
    const after = stampVersionInYaml(before, "0.26.0");
    expect(after).toBe('jinn:\r\n  version: "0.26.0"\r\n');
  });
});
