import fs from "node:fs";
import path from "node:path";

function canonicalHome(home: string): string {
  const resolved = path.resolve(home);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Guard the destructive/launching CLI commands themselves, including commands
 * reached through `docker exec` where the entrypoint's argument checks do not run. */
export function assertContainerPrimaryCommand(
  command: string,
  selectedInstance: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.JINN_CONTAINER !== "1" || !["setup", "start", "restart"].includes(command)) return;

  if (command === "restart") {
    throw new Error(
      "jinn restart is disabled inside Docker because an internal self-restart would release "
      + "the service lock before its replacement owns it. Use docker compose restart jinn instead.",
    );
  }

  if (env._JINN_CONTAINER_SERVICE_START !== "1") {
    throw new Error(
      "Only the marked container service start may run setup/start at the primary container home. "
      + "Use docker compose up/restart for the service; docker compose run and docker exec are one-off command paths.",
    );
  }

  const primaryHome = env.JINN_CONTAINER_PRIMARY_HOME?.trim();
  const selectedHome = env.JINN_HOME?.trim();
  const instance = selectedInstance?.trim() || env.JINN_INSTANCE?.trim();
  const targetsPrimary = primaryHome
    && selectedHome
    && canonicalHome(primaryHome) === canonicalHome(selectedHome)
    && !selectedInstance
    && (!instance || instance === "jinn");
  if (targetsPrimary) return;

  throw new Error(
    "The Docker image supports one Jinn instance at its primary container home. "
    + "Do not retarget setup/start with -i, JINN_INSTANCE, or JINN_HOME; run another instance "
    + "in its own container with dedicated Jinn/Claude volumes and a separately published port.",
  );
}
