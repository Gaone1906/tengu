import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseDocument, Scalar } from "yaml";
import {
  JINN_HOME,
  CONFIG_PATH,
  TEMPLATE_MIGRATIONS_DIR,
} from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import {
  compareSemver,
  isStrictSemver,
  getPackageVersion,
  getInstanceVersion,
} from "../shared/version.js";
import {
  scanMigrationPrompts,
  composeMigrationPrompt,
  scanFutureMigrations,
  formatStagedFutureNotice,
  findMalformedMigrationDirs,
} from "./migrate-prompt.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export type StampResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Set `jinn.version` inside a config.yaml's text, preserving comments, quoting,
 * and formatting on every node we don't touch. This is a FORMAT-PRESERVING
 * document edit via the `yaml` package: `parseDocument` keeps the concrete
 * syntax tree (including comments) intact, `setIn` mutates only the target node,
 * and `toString` re-serializes with the untouched nodes verbatim.
 *
 * This replaces an earlier hand-rolled text patcher that played whack-a-mole
 * with edge shapes and, in the worst case, wrote a file that read back as a
 * different (or unset) marker while still exiting 0. The document model makes
 * every VALID shape correct in one path:
 *   - block-style `jinn:` with/without a direct `version:` → set/insert it.
 *   - inline/flow `jinn: { version: … }`                   → update in place.
 *   - `version:` written as a PARENT key (a nested map)     → collapse to the
 *     scalar (no orphaned deeper-indented children survive — the round-3 bug).
 *   - a nested `jinn.metadata.version`                      → left untouched;
 *     only the direct `jinn.version` child is the marker.
 *   - no `jinn:` block, or an empty file                    → created.
 *
 * Safety is layered so we NEVER write a file that succeeds-while-corrupting:
 *   1. refuse if the input isn't valid YAML (`doc.errors`) — no blind edit.
 *   2. refuse if serialization throws (e.g. replacing an anchored value orphans
 *      an alias elsewhere) — that shape can't be edited without breaking refs.
 *   3. parse the produced text BACK and refuse unless `jinn.version` reads back
 *      exactly the target — the write site only ever sees verified text.
 *
 * The value is emitted as a double-quoted string scalar so the marker is
 * unambiguously a string regardless of how numeric it looks.
 *
 * Exported for unit testing (pure string → StampResult).
 */
export function stampVersionInYaml(raw: string, version: string): StampResult {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      reason: `config.yaml isn't valid YAML (${firstLine(doc.errors[0].message)})`,
    };
  }

  // Force a double-quoted string scalar: the marker is always a string, and the
  // quoting keeps the write stable no matter the current node's shape.
  const node = new Scalar(version);
  node.type = Scalar.QUOTE_DOUBLE;
  // setIn replaces jinn.version wholesale — a scalar, an inline-mapping value,
  // or a version-as-parent map ({ major: 0 }) all collapse to this scalar, and
  // an absent `jinn:` map is created for us.
  doc.setIn(["jinn", "version"], node);

  let text: string;
  try {
    text = doc.toString();
  } catch (err) {
    return {
      ok: false,
      reason: `couldn't serialize the version update safely (${firstLine(
        (err as Error).message,
      )})`,
    };
  }

  // Parse-back guard: never return text we can't read the marker out of. This is
  // what makes "rc=0 while the file is corrupt" impossible.
  const check = parseDocument(text);
  if (check.errors.length > 0) {
    return {
      ok: false,
      reason: `the updated config.yaml failed to re-parse (${firstLine(
        check.errors[0].message,
      )})`,
    };
  }
  const readback = check.getIn(["jinn", "version"]);
  if (readback !== version) {
    return {
      ok: false,
      reason: `version marker didn't round-trip (read back "${String(readback)}")`,
    };
  }

  return { ok: true, text };
}

/** First line of a (possibly multi-line, caret-annotated) yaml error message. */
function firstLine(msg: string): string {
  return msg.split("\n")[0].trim();
}

/**
 * Stamp the jinn.version field in config.yaml — the instance's "last migrated"
 * marker. The live gateway hot-reloads config.yaml, so write atomically
 * (tmp file + rename) to avoid a partial-write corruption window. Returns false
 * (without writing) when the stamper refuses to edit the file's shape.
 */
function stampVersion(version: string): boolean {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const result = stampVersionInYaml(raw, version);

  if (!result.ok) {
    console.error(
      `${YELLOW}Couldn't safely update the version marker:${RESET} ${result.reason}.\n` +
        `Set ${DIM}jinn.version: "${version}"${RESET} in ${CONFIG_PATH} manually.`,
    );
    return false;
  }

  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, result.text, "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
  return true;
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
    if (!isStrictSemver(target)) {
      console.error(`${RED}Error:${RESET} --mark-done expects a plain X.Y.Z version (e.g. ${packageVersion}), got "${target}".`);
      process.exit(1);
    }
    if (!stampVersion(target)) process.exit(1); // stampVersion already explained why
    console.log(`${GREEN}Marked instance as migrated to ${target}.${RESET} ${DIM}(config.yaml jinn.version)${RESET}\n`);
    return;
  }

  // Guard the comparator's inputs: a non-plain package version or instance
  // marker (e.g. a prerelease `0.26.0-beta.1`) must not flow into range/future
  // scans. Fail loudly instead of scanning against an unreliable bound or
  // silently treating the marker as un-set. `--mark-done <version>` above is the
  // escape hatch for repairing a bad marker.
  if (!isStrictSemver(packageVersion)) {
    console.error(`${RED}Error:${RESET} package version "${packageVersion}" is not a plain X.Y.Z release; jinn migrate can't scan against it.`);
    process.exit(1);
  }
  if (!isStrictSemver(instanceVersion)) {
    console.error(
      `${RED}Error:${RESET} the instance marker ${DIM}jinn.version="${instanceVersion}"${RESET} in config.yaml is not a plain X.Y.Z release.\n` +
        `Fix it, or run ${DIM}jinn migrate --mark-done <version>${RESET} to reset it, before migrating.`,
    );
    process.exit(1);
  }

  console.log(`\n${DIM}Instance version:${RESET} ${instanceVersion}`);
  console.log(`${DIM}Package version:${RESET}  ${packageVersion}\n`);

  // Warn (by name) about any version-looking migration dir that isn't a plain
  // X.Y.Z — the scans skip these, so surface them rather than ignore silently.
  const malformed = findMalformedMigrationDirs(TEMPLATE_MIGRATIONS_DIR);
  if (malformed.length > 0) {
    console.warn(
      `${YELLOW}Skipping ${malformed.length} migration dir(s) with a non-plain-semver name:${RESET} ${malformed.join(", ")}\n`,
    );
  }

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

    // The migration already ran; if the marker can't be stamped safely, say so
    // without failing the whole apply (stampVersion printed the manual step).
    if (stampVersion(packageVersion)) {
      console.log(`\n${GREEN}Migration complete.${RESET} Marker advanced ${instanceVersion} → ${packageVersion}.\n`);
    } else {
      console.log(`\n${GREEN}Migration applied.${RESET} ${YELLOW}Marker NOT advanced${RESET} — set it manually per the message above.\n`);
    }
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
