import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Fail fast with a clear, actionable message when the native database module
 * (better-sqlite3) cannot load under the current Node runtime.
 *
 * better-sqlite3 is a native addon compiled for one specific Node ABI
 * (NODE_MODULE_VERSION). If jinn is installed under one Node major and later run
 * under a different one (an nvm switch, or a Homebrew node shadowing the nvm node),
 * the addon throws a cryptic `ERR_DLOPEN_FAILED` deep inside the gateway boot and
 * the process dies before any logging — the exact "gateway won't start after
 * upgrade" failure this guards against. Turning that into one plain instruction
 * is the whole point.
 *
 * Call this at every process entry that will load the session database (the CLI
 * dispatcher and the daemon entry), BEFORE anything imports better-sqlite3.
 */
export function assertNativeRuntime(): void {
  try {
    require("better-sqlite3");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const abiMismatch =
      /NODE_MODULE_VERSION|different Node\.js version|ERR_DLOPEN_FAILED|was compiled against|dlopen|invalid ELF header|Symbol not found/i.test(
        message,
      );
    if (!abiMismatch) throw err; // unrelated failure — don't mask it

    process.stderr.write(
      [
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
      ].join("\n"),
    );
    process.exit(1);
  }
}
