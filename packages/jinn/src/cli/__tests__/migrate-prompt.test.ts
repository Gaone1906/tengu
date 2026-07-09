import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanMigrationPrompts, composeMigrationPrompt } from "../migrate-prompt.js";

/**
 * Build a fake template `migrations/` dir. Each entry is [version, hasMd].
 * When hasMd is true, a MIGRATION.md is written whose body names the version.
 */
function makeMigrationsDir(entries: Array<[string, boolean]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migrate-prompt-"));
  for (const [version, hasMd] of entries) {
    const vdir = path.join(dir, version);
    fs.mkdirSync(vdir, { recursive: true });
    if (hasMd) {
      fs.writeFileSync(
        path.join(vdir, "MIGRATION.md"),
        `# Migration ${version}\n\nDo the ${version} changes.\n`,
        "utf-8",
      );
    }
  }
  return dir;
}

describe("scanMigrationPrompts: version range scan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function fixture(entries: Array<[string, boolean]>): string {
    const d = makeMigrationsDir(entries);
    dirs.push(d);
    return d;
  }

  it("returns versions in (from, to] ascending by semver", () => {
    const dir = fixture([
      ["0.9.0", true],
      ["0.25.0", true],
      ["0.26.0", true],
      ["0.10.0", true],
    ]);
    expect(scanMigrationPrompts(dir, "0.9.0", "0.26.0")).toEqual([
      "0.10.0",
      "0.25.0",
      "0.26.0",
    ]);
  });

  it("excludes the from version (exclusive) and includes the to version (inclusive)", () => {
    const dir = fixture([
      ["0.24.0", true],
      ["0.25.0", true],
      ["0.26.0", true],
    ]);
    expect(scanMigrationPrompts(dir, "0.24.0", "0.25.0")).toEqual(["0.25.0"]);
  });

  it("spans multiple skipped releases when the marker is far behind", () => {
    const dir = fixture([
      ["0.10.0", true],
      ["0.20.0", true],
      ["0.25.0", true],
      ["0.26.0", true],
    ]);
    // Instance skipped 3 releases — all spanning prompts surface at once.
    expect(scanMigrationPrompts(dir, "0.9.0", "0.26.0")).toEqual([
      "0.10.0",
      "0.20.0",
      "0.25.0",
      "0.26.0",
    ]);
  });

  it("treats a missing marker as 0.0.0 (returns everything available)", () => {
    const dir = fixture([
      ["0.1.0", true],
      ["0.9.0", true],
    ]);
    expect(scanMigrationPrompts(dir, "0.0.0", "0.9.0")).toEqual(["0.1.0", "0.9.0"]);
  });

  it("returns an empty array when the range contains no versions", () => {
    const dir = fixture([
      ["0.9.0", true],
      ["0.25.0", true],
    ]);
    // Already at latest.
    expect(scanMigrationPrompts(dir, "0.25.0", "0.25.0")).toEqual([]);
  });

  it("skips version dirs that have no MIGRATION.md", () => {
    const dir = fixture([
      ["0.24.0", true],
      ["0.25.0", false], // release touched no instance surface
      ["0.26.0", true],
    ]);
    expect(scanMigrationPrompts(dir, "0.23.0", "0.26.0")).toEqual(["0.24.0", "0.26.0"]);
  });

  it("ignores non-semver directory names", () => {
    const dir = fixture([
      ["0.9.0", true],
      ["latest", true],
      ["0.10.0", true],
    ]);
    expect(scanMigrationPrompts(dir, "0.0.0", "0.10.0")).toEqual(["0.9.0", "0.10.0"]);
  });

  it("returns empty when the migrations dir does not exist", () => {
    expect(scanMigrationPrompts("/nonexistent/path/xyz", "0.0.0", "9.9.9")).toEqual([]);
  });
});

describe("composeMigrationPrompt: prompt composition", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function fixture(entries: Array<[string, boolean]>): string {
    const d = makeMigrationsDir(entries);
    dirs.push(d);
    return d;
  }

  it("concatenates MIGRATION.md bodies in ascending version order with a preamble", () => {
    const dir = fixture([
      ["0.25.0", true],
      ["0.26.0", true],
    ]);
    const prompt = composeMigrationPrompt({
      templateMigrationsDir: dir,
      versions: ["0.25.0", "0.26.0"],
      fromVersion: "0.24.0",
      toVersion: "0.26.0",
      instanceHome: "/home/user/.jinn",
    });

    // Preamble instructs the agent on how to behave.
    expect(prompt).toMatch(/preserve/i);
    expect(prompt).toMatch(/never delete/i);
    expect(prompt).toMatch(/report/i);
    expect(prompt).toContain("/home/user/.jinn");

    // Both bodies present, in ascending order.
    const idx25 = prompt.indexOf("Do the 0.25.0 changes.");
    const idx26 = prompt.indexOf("Do the 0.26.0 changes.");
    expect(idx25).toBeGreaterThan(-1);
    expect(idx26).toBeGreaterThan(-1);
    expect(idx25).toBeLessThan(idx26);

    // Each section is labeled with its version.
    expect(prompt).toContain("0.25.0");
    expect(prompt).toContain("0.26.0");
  });

  it("mentions the target version marker in the preamble/footer", () => {
    const dir = fixture([["0.26.0", true]]);
    const prompt = composeMigrationPrompt({
      templateMigrationsDir: dir,
      versions: ["0.26.0"],
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      instanceHome: "/home/user/.jinn",
    });
    expect(prompt).toContain("0.26.0");
    // Tells how the marker gets updated.
    expect(prompt).toMatch(/jinn\.version|mark-done|--apply/i);
  });
});
