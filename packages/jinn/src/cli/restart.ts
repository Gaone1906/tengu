import fs from "node:fs";
import { JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { assertPortTakeoverAllowed, restartDetached } from "../gateway/lifecycle.js";
import { requestRestartFromGateway } from "./restart-request.js";

/**
 * `jinn restart` — race-free, in-session-safe gateway restart.
 *
 * Forks a detached helper that does stop → wait-for-port-free → start out of
 * band, so it survives the gateway killing its own sessions. Safe to run from
 * inside a Jinn chat session: this command returns immediately, the helper
 * brings the gateway back, and the gateway resumes the interrupted session.
 */
export interface RestartOptions {
  takePort?: boolean;
}

function exitOnPortOwnershipError(err: unknown): never {
  if (err instanceof Error && (err.name === "PortOwnershipError" || err.name === "UnsafeContainerTakeoverError")) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

export async function runRestart(opts: RestartOptions = {}): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.error(`Error: ${JINN_HOME} does not exist. Run "jinn setup" first.`);
    process.exit(1);
  }

  const config = loadConfig();
  try {
    assertPortTakeoverAllowed(config.gateway.port || 7777, { takePort: opts.takePort });
  } catch (err) {
    exitOnPortOwnershipError(err);
  }

  if (await requestRestartFromGateway()) {
    console.log("Gateway restart requested from the running gateway. It will be back in a few seconds.");
    return;
  }

  restartDetached({ takePort: opts.takePort, port: config.gateway.port || 7777 });
  console.log("Gateway restarting in the background (detached). It will be back in a few seconds.");
}
