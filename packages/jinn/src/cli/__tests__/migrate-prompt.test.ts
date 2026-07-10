import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanMigrationPrompts,
  composeMigrationPrompt,
  scanFutureMigrations,
  formatStagedFutureNotice,
  findMalformedMigrationDirs,
} from "../migrate-prompt.js";

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

  it("includes each version's resolved template source dir, and no dead staging path", () => {
    const dir = fixture([
      ["0.3.0", true],
      ["0.26.0", true],
    ]);
    const prompt = composeMigrationPrompt({
      templateMigrationsDir: dir,
      versions: ["0.3.0", "0.26.0"],
      fromVersion: "0.2.0",
      toVersion: "0.26.0",
      instanceHome: "/home/user/.jinn",
    });

    // Each section names the read-only template source dir the agent can read,
    // so relative `files/…` payloads that ship with the package are resolvable.
    expect(prompt).toContain(path.join(dir, "0.3.0"));
    expect(prompt).toContain(path.join(dir, "0.26.0"));

    // The dead pre-repurpose staging pattern (~/.jinn/migrations/<v>/files) must
    // not appear anywhere in the composed output.
    expect(prompt).not.toMatch(/\.jinn\/migrations/);
  });
});

describe("composeMigrationPrompt: against the REAL shipped template migrations", () => {
  // packages/jinn/src/cli/__tests__ → packages/jinn/template/migrations
  const templateMigrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../template/migrations",
  );

  it("makes the current package's autonomy migration reachable and complete", () => {
    const packageJsonPath = path.resolve(templateMigrationsDir, "../../package.json");
    const packageVersion = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")).version as string;
    const versions = scanMigrationPrompts(templateMigrationsDir, "0.25.0", packageVersion);
    const autonomyVersion = "0.26.0";

    expect(fs.existsSync(path.join(templateMigrationsDir, autonomyVersion, "MIGRATION.md"))).toBe(true);
    expect(versions).toContain(autonomyVersion);
    expect(scanFutureMigrations(templateMigrationsDir, packageVersion)).not.toContain(autonomyVersion);

    const releaseReferences = [
      "../../CLAUDE.md",
      "../../docs/company-doctrine.md",
      "../../docs/mcp.md",
      "../../docs/org.md",
      "../../docs/overview.md",
      "../../docs/self-modification.md",
      "../../docs/cron.md",
      "../../skills/management/SKILL.md",
      "../../skills/self-heal/SKILL.md",
      "../../skills/cron-manager/SKILL.md",
      "../../skills/migrate/SKILL.md",
    ];
    for (const ref of releaseReferences) {
      expect(fs.existsSync(path.resolve(templateMigrationsDir, autonomyVersion, ref)), ref).toBe(true);
    }

    const prompt = composeMigrationPrompt({
      templateMigrationsDir,
      versions,
      fromVersion: "0.25.0",
      toVersion: packageVersion,
      instanceHome: "/home/user/.jinn",
    });

    expect(prompt).toContain("Employees, Todos, Workflows, and Triggers");
    expect(prompt).toContain("replace legacy board-first");
    expect(prompt).toContain("raw-HTTP-first");
    expect(prompt).toContain("manager is notified");
    expect(prompt).toContain("CLAUDE.md is canonical");
    expect(prompt).toContain("preserve every user-specific and operator-specific section");
    expect(prompt).toContain(`jinn.version\` should read \`"${autonomyVersion}"`);
    expect(prompt).not.toContain("confirmed release version");
  });

  it("composes every shipped migration with no dead ~/.jinn/migrations staging references", () => {
    const versions = scanMigrationPrompts(templateMigrationsDir, "0.0.0", "999.0.0");
    expect(versions.length).toBeGreaterThan(0);

    const prompt = composeMigrationPrompt({
      templateMigrationsDir,
      versions,
      fromVersion: "0.0.0",
      toVersion: "999.0.0",
      instanceHome: "/home/user/.jinn",
    });

    // The sweep rewrote every legacy `files/…` copy instruction to point at the
    // template source dir — no MD body may still imply the old staging copy.
    expect(prompt).not.toMatch(/\.jinn\/migrations/);

    // Every composed section names its resolved read-only template source dir.
    for (const v of versions) {
      expect(prompt).toContain(path.join(templateMigrationsDir, v));
    }
  });
});

describe("scanFutureMigrations: dirs staged above the package version", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function fixture(entries: Array<[string, boolean]>): string {
    const d = makeMigrationsDir(entries);
    dirs.push(d);
    return d;
  }

  it("returns MIGRATION.md dirs strictly above the package version, ascending", () => {
    const dir = fixture([
      ["0.24.0", true],
      ["0.25.0", true],
      ["0.27.0", true],
      ["0.26.0", true],
    ]);
    // Pre-staging the next release's dir during development is intentional; it
    // should be SURFACED, not treated as an error.
    expect(scanFutureMigrations(dir, "0.25.0")).toEqual(["0.26.0", "0.27.0"]);
  });

  it("returns empty when nothing is staged above the package version", () => {
    const dir = fixture([
      ["0.24.0", true],
      ["0.25.0", true],
    ]);
    expect(scanFutureMigrations(dir, "0.25.0")).toEqual([]);
  });

  it("skips future dirs that ship no MIGRATION.md, and non-semver names", () => {
    const dir = fixture([
      ["0.26.0", false],
      ["0.27.0", true],
      ["next", true],
    ]);
    expect(scanFutureMigrations(dir, "0.25.0")).toEqual(["0.27.0"]);
  });

  it("returns empty when the migrations dir does not exist", () => {
    expect(scanFutureMigrations("/nonexistent/xyz", "0.25.0")).toEqual([]);
  });
});

describe("findMalformedMigrationDirs: version-looking but not plain X.Y.Z", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function fixture(entries: Array<[string, boolean]>): string {
    const d = makeMigrationsDir(entries);
    dirs.push(d);
    return d;
  }

  it("reports prerelease/build dir names, ignores plain semver and non-version names", () => {
    const dir = fixture([
      ["0.25.0", true],
      ["0.26.0-beta.1", true], // prerelease → would NaN the naive comparator
      ["0.27.0+build", true], // build metadata
      ["latest", true], // not version-looking → not reported
      ["next", false],
    ]);
    expect(findMalformedMigrationDirs(dir)).toEqual(["0.26.0-beta.1", "0.27.0+build"]);
  });

  it("returns empty when every dir is a plain X.Y.Z", () => {
    const dir = fixture([
      ["0.9.0", true],
      ["0.10.0", true],
    ]);
    expect(findMalformedMigrationDirs(dir)).toEqual([]);
  });

  it("returns empty when the migrations dir does not exist", () => {
    expect(findMalformedMigrationDirs("/nonexistent/xyz")).toEqual([]);
  });
});

describe("scanMigrationPrompts / scanFutureMigrations: prerelease dirs are skipped", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function fixture(entries: Array<[string, boolean]>): string {
    const d = makeMigrationsDir(entries);
    dirs.push(d);
    return d;
  }

  it("never surfaces a prerelease-named dir as a reachable or future prompt", () => {
    const dir = fixture([
      ["0.25.0", true],
      ["0.26.0-beta.1", true],
      ["0.26.0", true],
    ]);
    // The prerelease dir is excluded from both scans (only plain X.Y.Z pass).
    expect(scanMigrationPrompts(dir, "0.24.0", "0.26.0")).toEqual(["0.25.0", "0.26.0"]);
    expect(scanFutureMigrations(dir, "0.26.0")).toEqual([]);
  });
});

describe("formatStagedFutureNotice: informational notice text", () => {
  it("returns null when nothing is staged", () => {
    expect(formatStagedFutureNotice([], "0.25.0")).toBeNull();
  });

  it("phrases a single staged migration", () => {
    const notice = formatStagedFutureNotice(["0.26.0"], "0.25.0");
    expect(notice).toMatch(/1 migration staged for a future release/i);
    expect(notice).toContain("0.26.0");
    expect(notice).toContain("0.25.0"); // current package version, for context
  });

  it("phrases multiple staged migrations", () => {
    const notice = formatStagedFutureNotice(["0.26.0", "0.27.0"], "0.25.0");
    expect(notice).toMatch(/2 migrations staged for future releases/i);
    expect(notice).toContain("0.26.0");
    expect(notice).toContain("0.27.0");
  });
});
