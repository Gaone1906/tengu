import fs from "node:fs";
import path from "node:path";
import { compareSemver } from "../shared/version.js";

/**
 * Range-scan the template `migrations/` dir for versions whose MIGRATION.md
 * should be composed into the migration prompt. Returns semver directory names
 * in `(fromVersion, toVersion]` that actually ship a MIGRATION.md, sorted
 * ascending.
 *
 * A release only ships a MIGRATION.md when it touched instance surface
 * (CLAUDE.md/AGENTS.md, skills, config schema, org defaults, new instance
 * dirs), so a version dir without one is silently skipped — the user has
 * nothing to merge for that release.
 */
export function scanMigrationPrompts(
  templateMigrationsDir: string,
  fromVersion: string,
  toVersion: string,
): string[] {
  if (!fs.existsSync(templateMigrationsDir)) return [];

  return fs
    .readdirSync(templateMigrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0)
    .filter((v) => fs.existsSync(path.join(templateMigrationsDir, v, "MIGRATION.md")))
    .sort(compareSemver);
}

/**
 * Scan the template `migrations/` dir for version dirs staged ABOVE the current
 * package version — i.e. a MIGRATION.md whose directory version is greater than
 * `packageVersion`. Pre-staging the next release's migration dir during
 * development is intentional (the release skill verifies/renames it at release
 * time, and the next publish makes it reachable), so these are surfaced as an
 * informational notice rather than treated as reachable prompts. Ascending.
 */
export function scanFutureMigrations(
  templateMigrationsDir: string,
  packageVersion: string,
): string[] {
  if (!fs.existsSync(templateMigrationsDir)) return [];

  return fs
    .readdirSync(templateMigrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => compareSemver(v, packageVersion) > 0)
    .filter((v) => fs.existsSync(path.join(templateMigrationsDir, v, "MIGRATION.md")))
    .sort(compareSemver);
}

/**
 * Return version-LOOKING migration dir names that are not plain `X.Y.Z` (e.g. a
 * prerelease `0.26.0-beta.1`). The scans silently skip these — surfacing them
 * lets the CLI warn by name so a mis-named dir isn't invisibly ignored. Names
 * that don't even look like a version (`latest`, `next`) are not reported.
 */
export function findMalformedMigrationDirs(templateMigrationsDir: string): string[] {
  if (!fs.existsSync(templateMigrationsDir)) return [];

  return fs
    .readdirSync(templateMigrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((v) => /\d/.test(v) && v.includes(".") && !/^\d+\.\d+\.\d+$/.test(v))
    .sort();
}

/**
 * Build the one-line informational notice shown when migration prompts are
 * staged for a future release. Returns null when nothing is staged.
 */
export function formatStagedFutureNotice(
  futureVersions: string[],
  packageVersion: string,
): string | null {
  if (futureVersions.length === 0) return null;
  const n = futureVersions.length;
  const noun = n === 1 ? "migration" : "migrations";
  const release = n === 1 ? "a future release" : "future releases";
  const verb = n === 1 ? "activates" : "activate";
  const when = n === 1 ? "that version ships" : "those versions ship";
  return (
    `${n} ${noun} staged for ${release} (${futureVersions.join(", ")}) — ` +
    `${verb} when ${when} (current package v${packageVersion}).`
  );
}

export interface ComposeOptions {
  templateMigrationsDir: string;
  /** Versions to compose, already range-scanned. Composed in ascending order. */
  versions: string[];
  fromVersion: string;
  toVersion: string;
  /** The user-owned instance folder the agent will operate on (e.g. ~/.jinn). */
  instanceHome: string;
}

/**
 * Compose the per-version MIGRATION.md files into ONE agent-ready prompt.
 * Reads files only — performs no writes. Sections appear in the order given
 * (callers pass ascending-sorted versions from `scanMigrationPrompts`).
 */
export function composeMigrationPrompt(opts: ComposeOptions): string {
  const { templateMigrationsDir, versions, fromVersion, toVersion, instanceHome } = opts;

  const preamble = [
    `# Jinn instance migration: ${fromVersion} → ${toVersion}`,
    ``,
    `The jinn package was updated, but your instance folder at \`${instanceHome}\` is`,
    `user-owned and diverges from the shipped template (custom CLAUDE.md/AGENTS.md,`,
    `skills, config, org). It is NOT auto-updated. Below are the release notes for`,
    `every version between your instance's marker and the installed package, in`,
    `ascending order — each describes what changed on the instance surface and how`,
    `to bring your folder up to date.`,
    ``,
    `Apply them IN ORDER, following these rules:`,
    ``,
    `- **Merge intelligently.** Add new sections, keys, skills, and docs; update`,
    `  what the notes say to update.`,
    `- **Preserve the user's customizations.** Never overwrite the user's own edits`,
    `  to CLAUDE.md/AGENTS.md, config values, or skills with template defaults.`,
    `  When a section exists in both, keep the user's version unless a note says to`,
    `  replace it.`,
    `- **Never delete user content.** Only remove something if a note explicitly`,
    `  says to, and back it up first (\`<file>.pre-migration.bak\`).`,
    `- **Work only inside \`${instanceHome}\`.** Do not touch the jinn package itself.`,
    `- **Reading the template source is fine.** Each section below names the`,
    `  read-only template source directory for that release, on this same machine.`,
    `  Any \`files/…\` path a section mentions is relative to that directory (those`,
    `  payloads ship with the installed package) — read them straight from there.`,
    `  Nothing is staged into your instance folder; there is no copy to look for.`,
    `- **Report what you changed** at the end: files added, files merged (with a`,
    `  one-line summary of each), and anything you skipped or that needs the user's`,
    `  attention.`,
    ``,
    `- **Snapshot first.** Create and verify the idempotent migration snapshot`,
    `  before editing any instance path.`,
    `- **Completion is explicit.** Write a completion receipt listing every`,
    `  reviewed file and skipped/conflicted item. The automatic handoff supplies`,
    `  the expected migration key for the guarded \`jinn migrate --mark-done\``,
    `  step. An engine exit or interrupted session never advances`,
    `  \`${path.join(instanceHome, "config.yaml")}\` to \`"${toVersion}"\`.`,
    ``,
    `---`,
  ].join("\n");

  const sections = versions.map((v) => {
    const versionDir = path.join(templateMigrationsDir, v);
    const md = fs.readFileSync(path.join(versionDir, "MIGRATION.md"), "utf-8").trim();
    return [
      ``,
      `## ===== Migration ${v} =====`,
      ``,
      `> Template source (read-only, on this machine): \`${versionDir}\``,
      `> Any \`files/…\` path below is relative to that directory — read it there.`,
      ``,
      md,
      ``,
    ].join("\n");
  });

  return `${preamble}\n${sections.join("\n")}`;
}
