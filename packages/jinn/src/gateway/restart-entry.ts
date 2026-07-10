/**
 * Entry point for the DETACHED restart helper.
 * Spawned by lifecycle.ts restartDetached().
 *
 * Runs in its own reparented process (PPID 1), so it is immune to the gateway's
 * killAll() when the old gateway shuts down. Performs the restart out of band:
 *   stop the running gateway → wait for the port to free → start a fresh daemon.
 * The returning gateway resumes any sessions it marked "interrupted" on shutdown.
 */
import { loadConfig } from "../shared/config.js";
import { stopAndWait, startDaemon, waitForDashboardReady, waitForPortFree, waitForPortListening } from "./lifecycle.js";
import { closeLogger, configureLogger, logger } from "../shared/logger.js";
import { restartEntryTakePortFromArgv } from "./restart-entry-options.js";

// stdio is ignored in detached mode — surface crashes to the log file instead of
// letting them vanish.
process.on("uncaughtException", (err) => {
  logger.error(`restart-entry uncaught exception: ${err?.stack ?? err}`);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logger.error(`restart-entry unhandled rejection: ${msg}`);
});

async function main(): Promise<number> {
  const config = loadConfig();
  configureLogger({ level: config.logging.level, stdout: false, file: true });
  const port = config.gateway?.port ?? 7777;
  const takePort = restartEntryTakePortFromArgv();

  logger.info("restart-entry: stopping current gateway…");
  // Waits for the old process to actually exit before removing the PID file,
  // so a concurrent start/status never sees "not running" while the port is
  // still held. Best-effort; no-op if already down.
  await stopAndWait(port, 10_000, { takePort });

  const freed = await waitForPortFree(port);
  if (!freed) {
    logger.warn(`restart-entry: port ${port} still bound after timeout — starting anyway`);
  }

  logger.info("restart-entry: starting fresh daemon…");
  startDaemon(config);
  const configuredHost = config.gateway?.host;
  const connectHost = !configuredHost || configuredHost === "0.0.0.0"
    ? "127.0.0.1"
    : configuredHost === "::"
      ? "::1"
      : configuredHost;
  const listening = await waitForPortListening(port, connectHost);
  if (!listening) {
    logger.error(`restart-entry: fresh daemon did not bind port ${port} before timeout`);
    return 1;
  }
  const dashboardReady = await waitForDashboardReady(port, connectHost);
  if (!dashboardReady) {
    logger.error(`restart-entry: fresh daemon bound port ${port}, but the dashboard did not become ready`);
    return 1;
  }
  logger.info("restart-entry: done");
  return 0;
}

main()
  .then(async (code) => {
    await closeLogger();
    process.exit(code);
  })
  .catch(async (err) => {
    logger.error(`restart-entry failed: ${err instanceof Error ? err.stack : err}`);
    await closeLogger();
    process.exit(1);
  });
