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
    `- **Report what you changed** at the end: files added, files merged (with a`,
    `  one-line summary of each), and anything you skipped or that needs the user's`,
    `  attention.`,
    ``,
    `When finished, set \`jinn.version\` in \`${path.join(instanceHome, "config.yaml")}\``,
    `to \`"${toVersion}"\`. If you were launched by \`jinn migrate --apply\`, jinn`,
    `updates that marker for you after you finish — otherwise run`,
    `\`jinn migrate --mark-done ${toVersion}\` once the changes look right.`,
    ``,
    `---`,
  ].join("\n");

  const sections = versions.map((v) => {
    const md = fs
      .readFileSync(path.join(templateMigrationsDir, v, "MIGRATION.md"), "utf-8")
      .trim();
    return [``, `## ===== Migration ${v} =====`, ``, md, ``].join("\n");
  });

  return `${preamble}\n${sections.join("\n")}`;
}
