import fs from "node:fs";
import { JINN_HOME } from "../shared/paths.js";
import { restartDetached } from "../gateway/lifecycle.js";
import { requestRestartFromGateway } from "./restart-request.js";

/**
 * `jinn restart` — race-free, in-session-safe gateway restart.
 *
 * Forks a detached helper that does stop → wait-for-port-free → start out of
 * band, so it survives the gateway killing its own sessions. Safe to run from
 * inside a Jinn chat session: this command returns immediately, the helper
 * brings the gateway back, and the gateway resumes the interrupted session.
 */
export async function runRestart(): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.error(`Error: ${JINN_HOME} does not exist. Run "jinn setup" first.`);
    process.exit(1);
  }

  if (await requestRestartFromGateway()) {
    console.log("Gateway restart requested from the running gateway. It will be back in a few seconds.");
    return;
  }

  restartDetached();
  console.log("Gateway restarting in the background (detached). It will be back in a few seconds.");
}
