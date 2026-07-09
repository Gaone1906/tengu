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
 * Surgically set `jinn.version` inside a config.yaml's text, preserving every
 * other byte. A full `yaml.load` → `yaml.dump` round-trip strips comments and
 * re-quotes a user-owned file, so instead this is a SAFE-SUBSET text patcher:
 * it handles the three shapes it can edit without ambiguity and REFUSES every
 * other shape rather than risk corrupting the file. Refusing is acceptable;
 * corrupting (duplicating the `jinn:` key, or rewriting an unrelated nested
 * `version:`) is not.
 *
 * Handled (→ `{ ok: true, text }`):
 *   1. block-style `jinn:` with a DIRECT-child `version:` → replace its value.
 *   2. block-style `jinn:` without a direct `version:`   → insert one first.
 *   3. no top-level `jinn:` key at all                    → append a fresh block.
 *
 * Refused (→ `{ ok: false, reason }`, no write):
 *   - `jinn:` written as an inline/flow mapping (`jinn: { ... }`), a scalar, an
 *     anchor/alias, or anything other than a plain block-mapping header.
 *   - a direct-child `version:` whose value is an anchor/alias/merge or a block
 *     scalar (editing it could break references elsewhere).
 * Nested keys (e.g. `jinn.metadata.version`) are never matched — only the
 * DIRECT child at the block's own child indentation.
 *
 * Exported for unit testing (pure string → StampResult).
 */
export function stampVersionInYaml(raw: string, version: string): StampResult {
  const value = JSON.stringify(version); // safe double-quoted scalar, e.g. "0.26.0"
  const lines = raw.split("\n");

  const stripCr = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);

  // Locate a top-level `jinn:` key line (column 0). Capture whatever follows the
  // colon so we can tell a plain block header from an inline/flow/scalar value.
  let jinnIdx = -1;
  let jinnRest = "";
  for (let i = 0; i < lines.length; i++) {
    const m = stripCr(lines[i]).match(/^jinn:(.*)$/);
    if (m) {
      jinnIdx = i;
      jinnRest = m[1];
      break;
    }
  }

  // Case 3: no jinn key at all — append a minimal block, one trailing newline.
  if (jinnIdx === -1) {
    const block = `jinn:\n  version: ${value}\n`;
    if (raw.length === 0) return { ok: true, text: block };
    return { ok: true, text: raw.endsWith("\n") ? `${raw}${block}` : `${raw}\n${block}` };
  }

  // The jinn line must be a plain block-mapping header: nothing after the colon
  // except optional whitespace and a comment. Anything else (inline `{ ... }`,
  // a scalar value, `&anchor`, `*alias`) is a shape we won't edit blind.
  if (!/^\s*(#.*)?$/.test(jinnRest)) {
    return {
      ok: false,
      reason: `jinn is written as an inline/flow mapping or scalar ("jinn:${jinnRest}"), not a plain block`,
    };
  }

  // Block body: from jinnIdx+1 until the next column-0 line that is a real key
  // (non-space, non-comment). Blank and column-0 comment lines stay in the block
  // so a stray comment can't prematurely end it and hide an existing key.
  let blockEnd = lines.length;
  for (let i = jinnIdx + 1; i < lines.length; i++) {
    const line = stripCr(lines[i]);
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // indented → still in block
    if (line.startsWith("#")) continue; // column-0 comment → still in block
    blockEnd = i;
    break;
  }

  // The block's direct-child indentation = the indent of its first real member.
  let childIndent: string | null = null;
  for (let i = jinnIdx + 1; i < blockEnd; i++) {
    const line = stripCr(lines[i]);
    if (line.trim() === "" || line.startsWith("#")) continue;
    const indentMatch = line.match(/^(\s+)\S/);
    if (indentMatch) {
      childIndent = indentMatch[1];
      break;
    }
  }
  const indent = childIndent ?? "  ";

  // Case 1: replace an existing DIRECT-child `version:` (exactly `indent`, not a
  // deeper nested key). Preserve indentation and any trailing CR.
  for (let i = jinnIdx + 1; i < blockEnd; i++) {
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    const bare = stripCr(lines[i]);
    if (!bare.startsWith(`${indent}version:`)) continue;
    // Guard against a deeper-indented `version:` sharing the prefix.
    if (bare[indent.length] === " ") continue;
    const after = bare.slice(`${indent}version:`.length);
    if (after !== "" && !/^\s/.test(after)) continue; // e.g. `versioning:` — not our key
    const valuePart = after.trim();
    if (/^[&*]|^<<|^[|>]/.test(valuePart)) {
      return {
        ok: false,
        reason: `jinn.version uses a YAML anchor/alias/block scalar ("${bare.trim()}") that can't be edited safely`,
      };
    }
    lines[i] = `${indent}version: ${value}${cr}`;
    return { ok: true, text: lines.join("\n") };
  }

  // Case 2: block exists but has no direct `version:` — insert as the first
  // member, at the block's own child indentation.
  lines.splice(jinnIdx + 1, 0, `${indent}version: ${value}`);
  return { ok: true, text: lines.join("\n") };
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
