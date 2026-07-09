import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  JINN_HOME,
  CONFIG_PATH,
  TEMPLATE_MIGRATIONS_DIR,
} from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import {
  compareSemver,
  getPackageVersion,
  getInstanceVersion,
} from "../shared/version.js";
import {
  scanMigrationPrompts,
  composeMigrationPrompt,
  scanFutureMigrations,
  formatStagedFutureNotice,
} from "./migrate-prompt.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Surgically set `jinn.version` inside a config.yaml's text, preserving every
 * other byte — comments, quoting style, key order, and blank lines are the
 * user's, so a full `yaml.load` → `yaml.dump` round-trip (which strips comments
 * and re-quotes) is wrong for a user-owned file. Only the version line changes.
 *
 *   - `jinn:` block with a `version:` key → replace that line's value only.
 *   - `jinn:` block without a `version:` key → insert one as its first member.
 *   - no `jinn:` block → append a minimal `jinn:` block at the end.
 *
 * Exported for unit testing (pure string → string).
 */
export function stampVersionInYaml(raw: string, version: string): string {
  const value = JSON.stringify(version); // safe double-quoted scalar, e.g. "0.26.0"

  const lines = raw.split("\n");

  // Locate the top-level `jinn:` mapping key (column 0, optional trailing comment).
  let jinnIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^jinn:\s*(#.*)?$/.test(lines[i])) {
      jinnIdx = i;
      break;
    }
  }

  if (jinnIdx === -1) {
    // No jinn block — append a minimal one, keeping exactly one trailing newline.
    const block = `jinn:\n  version: ${value}\n`;
    if (raw.length === 0) return block;
    return raw.endsWith("\n") ? `${raw}${block}` : `${raw}\n${block}`;
  }

  // The block body runs until the next column-0, non-space line (next top-level
  // key or a `---` document marker); blank and indented lines stay in the block.
  let blockEnd = lines.length;
  for (let i = jinnIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue;
    blockEnd = i;
    break;
  }

  // Replace an existing indented `version:` key's value, preserving indentation
  // (and a trailing CR on CRLF files); drop only that line's old value/comment.
  for (let i = jinnIdx + 1; i < blockEnd; i++) {
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    const bare = cr ? lines[i].slice(0, -1) : lines[i];
    const m = bare.match(/^(\s+)version:(?:\s.*|)$/);
    if (m) {
      lines[i] = `${m[1]}version: ${value}${cr}`;
      return lines.join("\n");
    }
  }

  // jinn block exists but has no version key — insert one as the first member.
  lines.splice(jinnIdx + 1, 0, `  version: ${value}`);
  return lines.join("\n");
}

/**
 * Stamp the jinn.version field in config.yaml — the instance's "last migrated"
 * marker. The live gateway hot-reloads config.yaml, so write atomically
 * (tmp file + rename) to avoid a partial-write corruption window.
 */
function stampVersion(version: string): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const updated = stampVersionInYaml(raw, version);

  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, updated, "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/**
 * Build engine-specific CLI args for running the composed migration prompt as a
 * one-shot. Each engine CLI uses different flags for prompt input.
 */
function buildMigrateArgs(engine: string, prompt: string): string[] {
  switch (engine) {
    case "codex":
      // `codex exec` is Codex's own non-interactive mode (not a claude `-p`).
      return ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt];
    case "grok":
      return ["--no-auto-update", "--always-approve", "-p", prompt];
    case "claude":
    default:
      // No `-p`: launch the interactive claude TUI (cc_entrypoint=cli, subsidy-safe)
      // instead of the headless Agent-SDK `--print` pool. `jinn migrate --apply` is
      // an operator-run, supervised one-shot launched from a real terminal, so the
      // inherited TTY (stdio: "inherit") renders the TUI and the operator watches
      // the migration apply. The TUI does not self-exit after the turn — the
      // operator closes it (e.g. /exit) once the migration looks complete.
      return ["--dangerously-skip-permissions", prompt];
  }
}

export interface MigrateOptions {
  /** Pipe the composed prompt into the instance's agent, then stamp the marker. */
  apply?: boolean;
  /** Mark the instance as migrated to a version without running anything. */
  markDone?: string | boolean;
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<void> {
  // Ensure instance exists
  if (!fs.existsSync(JINN_HOME)) {
    console.error(`${RED}Error:${RESET} ${JINN_HOME} does not exist. Run "jinn setup" first.`);
    process.exit(1);
  }

  const packageVersion = getPackageVersion();
  const instanceVersion = getInstanceVersion();

  // --mark-done: just stamp the marker and exit. Value defaults to the package
  // version when the flag is passed without an explicit version.
  if (opts.markDone !== undefined && opts.markDone !== false) {
    const target = typeof opts.markDone === "string" ? opts.markDone : packageVersion;
    if (!/^\d+\.\d+\.\d+$/.test(target)) {
      console.error(`${RED}Error:${RESET} --mark-done expects a semver version (e.g. ${packageVersion}), got "${target}".`);
      process.exit(1);
    }
    stampVersion(target);
    console.log(`${GREEN}Marked instance as migrated to ${target}.${RESET} ${DIM}(config.yaml jinn.version)${RESET}\n`);
    return;
  }

  console.log(`\n${DIM}Instance version:${RESET} ${instanceVersion}`);
  console.log(`${DIM}Package version:${RESET}  ${packageVersion}\n`);

  // Surface migrations staged for a future release (dirs above the package
  // version). Pre-staging the next release's dir is intentional — make the state
  // visible instead of leaving it silently unreachable.
  const futureNotice = formatStagedFutureNotice(
    scanFutureMigrations(TEMPLATE_MIGRATIONS_DIR, packageVersion),
    packageVersion,
  );
  if (futureNotice) console.log(`${DIM}${futureNotice}${RESET}\n`);

  // Range-scan the template migrations for prompts in (instance, package].
  const versions = scanMigrationPrompts(TEMPLATE_MIGRATIONS_DIR, instanceVersion, packageVersion);

  if (versions.length === 0) {
    const range =
      compareSemver(instanceVersion, packageVersion) >= 0
        ? `v${packageVersion}`
        : `(${instanceVersion}, ${packageVersion}]`;
    console.log(`${GREEN}You're up to date${RESET} — no instance migrations for ${range}.\n`);

    // If the instance marker lags but no prompts apply (releases touched no
    // instance surface), advance the marker so we don't re-scan every run.
    if (compareSemver(instanceVersion, packageVersion) < 0 && !opts.apply) {
      console.log(`${DIM}Tip: run${RESET} jinn migrate --mark-done ${packageVersion} ${DIM}to advance the version marker.${RESET}\n`);
    }
    return;
  }

  const prompt = composeMigrationPrompt({
    templateMigrationsDir: TEMPLATE_MIGRATIONS_DIR,
    versions,
    fromVersion: instanceVersion,
    toVersion: packageVersion,
    instanceHome: JINN_HOME,
  });

  // --apply: pipe the composed prompt into the instance's own agent, then stamp.
  if (opts.apply) {
    console.log(`${YELLOW}Applying migrations${RESET} for ${versions.join(", ")} via the instance agent...\n`);

    const config = loadConfig();
    const defaultEngine = config.engines.default ?? "claude";
    const engineConfig = config.engines[defaultEngine] ?? config.engines.claude;
    const args = buildMigrateArgs(defaultEngine, prompt);
    // `bin` may be absent for engines with optional config (e.g. antigravity);
    // fall back to the engine name so spawn resolves via PATH (or fails clearly).
    // Note: antigravity (`agy`) has no headless mode, so migrate is unsupported there.
    const migrateBin = engineConfig.bin ?? defaultEngine;
    console.log(`${DIM}Engine: ${defaultEngine} (${migrateBin})${RESET}\n`);

    try {
      execFileSync(migrateBin, args, { stdio: "inherit", cwd: JINN_HOME });
    } catch {
      console.error(`\n${RED}Migration agent exited with an error.${RESET} The version marker was NOT advanced.`);
      console.error(`Re-run ${DIM}jinn migrate --apply${RESET}, or apply manually with ${DIM}jinn migrate${RESET} and then ${DIM}jinn migrate --mark-done ${packageVersion}${RESET}.\n`);
      process.exit(1);
    }

    stampVersion(packageVersion);
    console.log(`\n${GREEN}Migration complete.${RESET} Marker advanced ${instanceVersion} → ${packageVersion}.\n`);
    return;
  }

  // Default: print the composed prompt. Mutates nothing.
  console.log(`${DIM}Migration prompt for ${versions.join(", ")} (copy into an agent, or run ${RESET}jinn migrate --apply${DIM}):${RESET}\n`);
  console.log(prompt);
  console.log(
    `\n${DIM}────────${RESET}\n` +
      `${DIM}This printed a prompt only — nothing was changed. Options:${RESET}\n` +
      `  ${DIM}•${RESET} ${DIM}jinn migrate --apply${RESET}              run it via this instance's agent (advances the marker)\n` +
      `  ${DIM}•${RESET} apply the changes yourself, then ${DIM}jinn migrate --mark-done ${packageVersion}${RESET}\n`,
  );
}
