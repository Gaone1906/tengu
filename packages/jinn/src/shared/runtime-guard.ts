import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export type NativeDbFailure = "abi-mismatch" | "binding-missing" | "unknown";

/**
 * Classify why the native database addon could not be used.
 *
 * Two failure modes look nothing alike and need different instructions:
 *
 *  - `abi-mismatch`    — the addon exists but was compiled for a different Node
 *                        ABI (an nvm switch, or a Homebrew node shadowing nvm).
 *  - `binding-missing` — the addon was never produced at all. This is what an
 *                        install with lifecycle scripts disabled leaves behind:
 *                        better-sqlite3's `install` script
 *                        (`prebuild-install || node-gyp rebuild`) never ran, so
 *                        there is no `build/` directory to load from.
 */
export function classifyNativeDbFailure(message: string): NativeDbFailure {
  if (/Could not locate the bindings file|Cannot find module .*better_sqlite3\.node/i.test(message)) {
    return "binding-missing";
  }
  if (
    /NODE_MODULE_VERSION|different Node\.js version|ERR_DLOPEN_FAILED|was compiled against|dlopen|invalid ELF header|Symbol not found/i.test(
      message,
    )
  ) {
    return "abi-mismatch";
  }
  return "unknown";
}

/** Directory of the installed better-sqlite3 package, or null if unresolvable. */
function betterSqlite3Root(): string | null {
  try {
    return dirname(require.resolve("better-sqlite3/package.json"));
  } catch {
    return null;
  }
}

/** The stderr report shown for a native-database failure. */
export function nativeDbFailureReport(kind: NativeDbFailure, message: string): string {
  if (kind === "binding-missing") {
    const root = betterSqlite3Root();
    return [
      "",
      "✗ jinn cannot start: its native database module (better-sqlite3) was never built.",
      "",
      "  The compiled addon is missing entirely — this is not a version mismatch. It happens",
      "  when the install ran with lifecycle scripts disabled (`--ignore-scripts`), so",
      "  better-sqlite3's own install step never compiled or downloaded the binary.",
      "",
      "  Fix:",
      "    • Homebrew:  brew update && brew reinstall jinn",
      root
        ? `    • Otherwise: npm rebuild better-sqlite3 --prefix ${root}`
        : "    • Otherwise: npm rebuild better-sqlite3",
      "",
      `  Underlying error: ${message}`,
      "",
    ].join("\n");
  }

  return [
    "",
    "✗ jinn cannot start: its native database module (better-sqlite3) was built for a",
    "  different Node.js version than the one you're running.",
    "",
    `  Running:  Node ${process.version} (native ABI ${process.versions.modules})`,
    "",
    "  Fix (either one):",
    "    • Switch to the Node version you installed jinn with, e.g.  nvm use 24",
    "    • Or rebuild the addon for this Node:  npm rebuild better-sqlite3",
    "",
    `  Underlying error: ${message}`,
    "",
  ].join("\n");
}

/**
 * Fail fast with a clear, actionable message when the native database module
 * (better-sqlite3) cannot be used under the current Node runtime.
 *
 * IMPORTANT: this must actually *open* a database, not merely `require` the
 * module. better-sqlite3 resolves its binding lazily inside the `Database`
 * constructor, so `require("better-sqlite3")` succeeds even when no compiled
 * addon exists anywhere on disk. A require-only check is a false negative for
 * the most common broken install there is, and lets the raw `bindings` stack
 * trace escape from deep inside gateway boot instead.
 *
 * Call this at every process entry that will load the session database (the CLI
 * dispatcher and the daemon entry), BEFORE anything imports better-sqlite3.
 */
export function assertNativeRuntime(): void {
  try {
    const Database = require("better-sqlite3") as new (path: string) => { close(): void };
    // Constructing forces the binding to resolve; ":memory:" touches no disk.
    new Database(":memory:").close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyNativeDbFailure(message);
    if (kind === "unknown") throw err; // unrelated failure — don't mask it

    process.stderr.write(nativeDbFailureReport(kind, message));
    process.exit(1);
  }
}

/**
 * node-pty's own resolution order for its native artifacts
 * (`node_modules/node-pty/lib/utils.js`). `spawn-helper` is a sibling of
 * whichever directory `pty.node` was loaded from, so both the source-built
 * (`build/…`) and the shipped-prebuild layouts have to be covered.
 *
 * Kept in sync with `scripts/fix-node-pty-permissions.mjs`, which does the same
 * repair at install time when lifecycle scripts are allowed to run.
 */
function spawnHelperCandidates(nodePtyRoot: string): string[] {
  return [
    join(nodePtyRoot, "build", "Release", "spawn-helper"),
    join(nodePtyRoot, "build", "Debug", "spawn-helper"),
    join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
}

/**
 * Restore the executable bit on node-pty's `spawn-helper`.
 *
 * On macOS/Linux node-pty does not merely load `pty.node`; it `posix_spawn`s a
 * sibling binary called `spawn-helper`. node-pty 1.x ships that helper in its
 * published tarball WITHOUT the executable bit and relies on an install-time
 * script to restore it. Any install that skips lifecycle scripts leaves the
 * helper at mode 0644, and then every pty spawn dies with `posix_spawnp
 * failed.` — a message that names neither the file nor the permission problem,
 * so it reads as if the spawned CLI were missing.
 *
 * `jinn-cli`'s postinstall already fixes this, but postinstall is precisely what
 * such installs skip (Homebrew's `std_npm_args` passes `--ignore-scripts` by
 * default). Repairing at startup is therefore the only layer that holds for an
 * install we never got to run scripts in — including one already on disk, where
 * no packaging change helps retroactively.
 *
 * Best-effort by design: a missing helper or a read-only install is not a reason
 * to refuse to boot, and on a healthy install this is a no-op.
 *
 * @param nodePtyRoot Override for tests. Defaults to the resolved node-pty.
 * @returns paths whose mode this call actually changed.
 */
export function repairNodePtySpawnHelper(nodePtyRoot?: string): string[] {
  if (process.platform === "win32") return []; // no exec bit, no spawn-helper

  let root = nodePtyRoot;
  if (!root) {
    try {
      root = dirname(require.resolve("node-pty/package.json"));
    } catch {
      return []; // node-pty not installed (e.g. a trimmed environment)
    }
  }

  const repaired: string[] = [];
  for (const helper of spawnHelperCandidates(root)) {
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0o111) continue; // already executable
      chmodSync(helper, (mode & 0o7777) | 0o755);
      repaired.push(helper);
    } catch {
      // Absent for this build layout, or the install is read-only. Neither is
      // fatal: if the helper we actually need is broken, node-pty will say so.
    }
  }
  return repaired;
}
