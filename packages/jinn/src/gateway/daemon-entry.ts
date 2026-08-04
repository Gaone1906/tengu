/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { assertNativeRuntime, repairNodePtySpawnHelper } from "../shared/runtime-guard.js";

// Verify the native DB addon loads under this Node BEFORE the imports below pull
// in better-sqlite3 (via lifecycle → server → registry). An ABI mismatch here
// would otherwise crash the daemon with no visible output (stdio is ignored in
// daemon mode). The static imports are therefore deferred to dynamic imports
// that run only after the guard passes.
assertNativeRuntime();

// Every engine spawn goes through node-pty. If an --ignore-scripts install left
// its spawn-helper non-executable, every session would die with an opaque
// `posix_spawnp failed.` — repair it here, before any session can start.
repairNodePtySpawnHelper();

const { loadConfig } = await import("../shared/config.js");
const { startForeground } = await import("./lifecycle.js");
const { logger } = await import("../shared/logger.js");

// Safety-net: log uncaught exceptions / unhandled rejections instead of letting them
// silently kill the daemon process (stdio is ignored in daemon mode, so these would
// otherwise disappear with no trace).
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err?.stack ?? err}`);
  // Do NOT re-throw or exit — keep the daemon alive.
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logger.error(`Unhandled promise rejection: ${msg}`);
});

const config = loadConfig();
startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
