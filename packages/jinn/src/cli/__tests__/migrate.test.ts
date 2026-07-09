import { describe, it, expect, vi, beforeEach } from "vitest";
import jsYaml from "js-yaml";

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
  isStrictSemver: vi.fn((v: string) => /^\d+\.\d+\.\d+$/.test(v)), // real predicate
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
import { getInstanceVersion } from "../../shared/version.js";
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
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockGetInstanceVersion = vi.mocked(getInstanceVersion);

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

    it("errors clearly (not a silent 0.0.0) when the instance marker is a prerelease", async () => {
      mockGetInstanceVersion.mockReturnValueOnce("1.0.0-beta.1");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({})).rejects.toThrow("process.exit called");
      assertNoFsWrites();
      expect(mockExecFileSync).not.toHaveBeenCalled();
      const printed = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/not a plain X\.Y\.Z/i);
      expect(printed).toContain("1.0.0-beta.1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
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

    it("applies but does NOT write when the config shape can't be safely stamped", async () => {
      // Agent runs fine, but the marker can't be advanced (config.yaml is not
      // valid YAML — tab indentation — so the stamper refuses rather than guess).
      mockReadFileSync.mockReturnValueOnce("jinn:\n\tversion: 1.0.0\n");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ apply: true });

      // Agent was launched; no marker write; no crash.
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/Marker NOT advanced/i);
      log.mockRestore();
    });

    it("does NOT crash and prints 'Marker NOT advanced' when jinn is a bare scalar", async () => {
      // `jinn: false` is valid YAML but not a collection — setIn would throw.
      // The agent runs successfully; the marker refuses cleanly; --apply must
      // finish normally and print its message rather than crash with a trace.
      mockReadFileSync.mockReturnValueOnce("jinn: false\n");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ apply: true })).resolves.toBeUndefined();

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/Marker NOT advanced/i);
      log.mockRestore();
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

    it("exits without writing when --mark-done can't safely stamp the config shape", async () => {
      mockReadFileSync.mockReturnValueOnce("jinn:\n\tversion: 1.0.0\n");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ markDone: "1.1.0" })).rejects.toThrow("process.exit called");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it("exits 1 cleanly (no stack trace) when jinn is a bare scalar like `false`", async () => {
      // Previously setIn threw here and --mark-done died with a stack trace.
      // Now it refuses cleanly → exit(1), no write, and the only error thrown is
      // the mocked process.exit (proving the refusal path, not a raw setIn throw).
      mockReadFileSync.mockReturnValueOnce("jinn: false\n");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ markDone: "1.1.0" })).rejects.toThrow("process.exit called");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockRenameSync).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
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
 * hot-reloads. Stamping is a FORMAT-PRESERVING document edit (the `yaml` package):
 * comments and quoting on untouched nodes must survive, EVERY valid shape of
 * `jinn.version` must end up correct, and the function must NEVER return text
 * that reads back as a different (or unset) marker — the exact
 * succeeds-while-corrupting failure this replaced. This is the shared path
 * behind both --mark-done and --apply.
 */
describe("stampVersionInYaml: format-preserving version stamp", () => {
  /** Unwrap a successful stamp, failing the test if it refused. */
  function okText(res: ReturnType<typeof stampVersionInYaml>): string {
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok stamp, refused: ${res.reason}`); // narrows the union
    return res.text;
  }

  /** Read jinn.version back out of stamped text with an independent parser. */
  function markerOf(text: string): unknown {
    return (jsYaml.load(text) as { jinn?: { version?: unknown } } | null)?.jinn?.version;
  }

  it("updates the version and preserves comments and odd quoting on other nodes", () => {
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

    const after = okText(stampVersionInYaml(before, "0.26.0"));

    // The marker is updated and reads back exactly.
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The old value is gone.
    expect(after).not.toContain("0.20.0");

    // Comments and quoting on untouched nodes survive (the yaml lib may
    // normalize whitespace before an inline comment, so assert the comment text,
    // not byte-exact spacing).
    expect(after).toContain("# top-of-file comment");
    expect(after).toContain("# inline comment stays");
    expect(after).toContain("# marker for the last applied migration");
    expect(after).toContain("model: 'opus'");
    expect(after).toContain('slack: { token: "xoxb-abc" }');
    // Sibling keys are untouched.
    expect(after).toContain("telemetry: false");
  });

  it("appends version into an existing jinn block that lacks the key", () => {
    const before = ["jinn:", "  telemetry: false", "other:", "  x: 1", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The new key landed inside the jinn block, not under `other:`.
    expect(after.indexOf('version: "0.26.0"')).toBeLessThan(after.indexOf("other:"));
    expect(after).toContain("  telemetry: false");
    expect(after).toContain("  x: 1");
  });

  it("creates a jinn block when none exists, keeping the rest intact", () => {
    const before = ["engines:", "  default: claude", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain("engines:");
    expect(after).toContain("  default: claude");
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toMatch(/jinn:\n {2}version: "0\.26\.0"\n$/);
  });

  it("creates the jinn block from a completely empty file", () => {
    const after = okText(stampVersionInYaml("", "0.26.0"));
    expect(after).toBe('jinn:\n  version: "0.26.0"\n');
    expect(markerOf(after)).toBe("0.26.0");
  });

  it("updates a CRLF file (line endings may normalize to LF, marker still correct)", () => {
    const before = "jinn:\r\n  version: 0.20.0\r\n";
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
  });

  // Round-3 QA HIGH: version written as a PARENT key (its value is a nested map).
  // The old text patcher wrote `version: "0.26.0"` then left the orphaned deeper-
  // indented `major: 0` behind → invalid YAML that read back as 0.0.0 while
  // exiting 0. setIn collapses the whole map to the scalar — no orphan survives.
  it("collapses a version-as-parent-key map to the scalar with no orphaned children", () => {
    const before = ["jinn:", "  version:", "    major: 0", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(after).not.toContain("major: 0"); // the orphan is gone
    expect(after).toContain("telemetry: false");
    // Crucially, the output is valid YAML and the marker reads back exactly.
    expect(markerOf(after)).toBe("0.26.0");
  });

  it("collapses a version parent-key that has a comment then a deeper child", () => {
    const before = ["jinn:", "  version: # stale", "    major: 0", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).not.toContain("major: 0");
    expect(after).toContain("telemetry: false");
    expect(markerOf(after)).toBe("0.26.0");
  });

  // Round-3 HIGH → now IMPROVED: an inline/flow `jinn: { … }` UPDATES in place
  // (the document model edits the flow mapping) rather than refusing.
  it("updates an inline/flow jinn mapping in place", () => {
    const before = 'jinn: { version: "0.20.0", telemetry: false }\nother: 1\n';
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // Still a single jinn key, sibling preserved, unrelated key intact.
    expect((after.match(/^jinn:/gm) ?? []).length).toBe(1);
    expect(after).toContain("telemetry: false");
    expect(after).toContain("other: 1");
  });

  // A nested `metadata.version` must NEVER be mistaken for the marker — only the
  // DIRECT `jinn.version` child is the marker.
  it("adds a direct-child version and leaves a nested metadata.version untouched", () => {
    const before = [
      "jinn:",
      "  metadata:",
      "    version: custom-metadata",
      "  telemetry: false",
      "",
    ].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    // The nested value is preserved verbatim.
    expect(after).toContain("    version: custom-metadata");
    // The direct-child jinn.version is what reads back — not the nested one.
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toContain('version: "0.26.0"');
  });

  it("REFUSES (no text) when the config isn't valid YAML — a tab-indented file", () => {
    const before = "jinn:\n\tversion: 0.20.0\n";
    const res = stampVersionInYaml(before, "0.26.0");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toMatch(/valid YAML|parse|tab/i);
  });

  it("REFUSES a jinn.version written as a YAML anchor referenced by an alias", () => {
    // Replacing the anchored node orphans the `*v` alias; serialization throws
    // and the stamper refuses rather than emit broken YAML.
    const before = "jinn:\n  version: &v 0.20.0\nrefs:\n  x: *v\n";
    const res = stampVersionInYaml(before, "0.26.0");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toMatch(/anchor|alias|serialize/i);
  });

  it("does not confuse a `versioning:` sibling key for `version:`", () => {
    const before = ["jinn:", "  versioning: semver", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain("versioning: semver"); // untouched
    expect(after).toContain('version: "0.26.0"'); // added as a new direct child
    expect(markerOf(after)).toBe("0.26.0");
  });

  // MEDIUM (a): an empty `jinn:` (null value) is a sane user shape — the marker
  // just hasn't been written yet. setIn can't descend into a null scalar, so we
  // materialize an empty map first and SET the version (success, not refusal).
  it("treats an empty `jinn:` (null value) as an empty block and sets the version", () => {
    const after = okText(stampVersionInYaml("jinn:\n", "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0"); // valid YAML out (independent parse)
  });

  it("sets the version on an empty `jinn:` that has sibling keys after it", () => {
    const before = ["jinn:", "other:", "  x: 1", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The new key landed under jinn, not merged into `other:`.
    expect(after.indexOf('version: "0.26.0"')).toBeLessThan(after.indexOf("other:"));
    expect(after).toContain("  x: 1");
  });

  // MEDIUM (b): a genuinely non-collection `jinn` (a non-null scalar) can't hold
  // a version child. setIn throws; the stamper must REFUSE cleanly (no throw
  // escapes) so both call sites stay on their no-stack-trace paths.
  it("REFUSES cleanly (no throw) when `jinn` is a non-null scalar like `false`", () => {
    let res: ReturnType<typeof stampVersionInYaml>;
    expect(() => {
      res = stampVersionInYaml("jinn: false\n", "0.26.0");
    }).not.toThrow();
    expect(res!.ok).toBe(false);
    if (res!.ok) throw new Error("expected refusal");
    expect(res!.reason).toMatch(/jinn|mapping|collection/i);
  });

  it("REFUSES cleanly when `jinn` is a sequence, not a mapping", () => {
    const before = ["jinn:", "  - a", "  - b", ""].join("\n");
    let res: ReturnType<typeof stampVersionInYaml>;
    expect(() => {
      res = stampVersionInYaml(before, "0.26.0");
    }).not.toThrow();
    expect(res!.ok).toBe(false);
  });

  // LOW: an inline comment attached to the version VALUE node is dropped by a
  // naive setIn (which replaces the value wholesale). Carry it onto the new
  // scalar so it survives like every other comment does.
  it("preserves an inline comment attached to the version value", () => {
    const before = "jinn:\n  version: '0.20.0' # version inline comment\nother: 1\n";
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(after).toContain("# version inline comment");
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toContain("other: 1");
  });
});
