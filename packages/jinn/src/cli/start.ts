import fs from "node:fs";
import { spawn } from "node:child_process";
import { JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { assertPortTakeoverAllowed, startForeground, startDaemon, getStatus, restartDetached } from "../gateway/lifecycle.js";
import { getPackageVersion } from "../shared/version.js";
import { TEMPLATE_MIGRATIONS_DIR } from "../shared/paths.js";
import { getPendingInstanceMigration } from "../migrations/service.js";
import { migrationNoticeOptionsForProcess, renderMigrationNotice } from "./migration-notice.js";
import { requestRestartFromGateway } from "./restart-request.js";
import { issueLocalBootstrapGrant } from "../gateway/auth.js";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";

/** Best-effort: open the dashboard in the default browser. Never throws. */
function openBrowser(url: string): void {
  try {
    const isWin = process.platform === "win32";
    const cmd = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
    const args = isWin ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort — never block startup on a missing opener */
  }
}

export interface StartOptions {
  daemon?: boolean;
  port?: number;
  takePort?: boolean;
}

function exitOnPortOwnershipError(err: unknown): never {
  if (err instanceof Error && (err.name === "PortOwnershipError" || err.name === "UnsafeContainerTakeoverError")) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

export async function runStart(opts: StartOptions): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.error(
      `Error: ${JINN_HOME} does not exist. Run "jinn setup" first.`
    );
    process.exit(1);
  }

  const config = loadConfig();

  // Migration discovery is automatic and read-only. A malformed bundle warns
  // without preventing the gateway from starting; the API exposes the detail.
  try {
    const migration = getPendingInstanceMigration({
      instanceHome: JINN_HOME,
      packageVersion: getPackageVersion(),
      migrationsDir: TEMPLATE_MIGRATIONS_DIR,
    })
    const rendered = renderMigrationNotice(migration, migrationNoticeOptionsForProcess({
      isTTY: Boolean(process.stdout.isTTY),
      columns: process.stdout.columns,
      env: process.env,
      daemon: Boolean(opts.daemon),
    }))
    if (rendered.notice) console.log(rendered.notice)
    if (rendered.prompt) console.log(`\n${rendered.prompt}`)
  } catch (error) {
    console.warn(`[migration] Unable to validate the installed migration bundle: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Allow CLI --port to override config
  if (opts.port) {
    config.gateway.port = opts.port;
  }

  try {
    assertPortTakeoverAllowed(config.gateway.port || 7777, { takePort: opts.takePort });
  } catch (err) {
    exitOnPortOwnershipError(err);
  }

  // If a gateway is already running, `start` becomes a clean restart. Prefer
  // asking the gateway to spawn the helper itself; when this CLI is running
  // inside a Jinn session, that keeps the restart handoff out of the engine
  // process tree that the old gateway is about to interrupt.
  if (getStatus().running) {
    if (await requestRestartFromGateway()) {
      console.log("Gateway already running — restart requested from gateway.");
      return;
    }
    restartDetached({ takePort: opts.takePort, port: config.gateway.port || 7777 });
    console.log("Gateway already running — restarting in background.");
    return;
  }

  if (opts.daemon) {
    startDaemon(config);
    console.log("Gateway started in background.");
  } else {
    const url = gatewayBaseUrl({ host: config.gateway.host, port: config.gateway.port });
    console.log(`Starting gateway on ${config.gateway.host}:${config.gateway.port}...`);
    // Open the dashboard once the server is up. Interactive foreground only, so
    // it never fires for the detached daemon child or in CI; opt out via
    // JINN_NO_OPEN=1. The timer fires after startForeground yields to the loop.
    // unref so it never keeps the process alive; cleared if startup throws so we
    // don't open a browser to a gateway that failed to bind.
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    if (process.stdout.isTTY && !process.env.JINN_NO_OPEN) {
      const launchUrl = new URL(url);
      launchUrl.hash = new URLSearchParams({ "jinn-bootstrap": issueLocalBootstrapGrant() }).toString();
      openTimer = setTimeout(() => openBrowser(launchUrl.toString()), 1200);
      openTimer.unref?.();
    }
    try {
      await startForeground(config);
    } catch (err) {
      if (openTimer) clearTimeout(openTimer);
      throw err;
    }
  }
}
