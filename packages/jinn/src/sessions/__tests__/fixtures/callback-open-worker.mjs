import { pathToFileURL } from "node:url";

const [home, registryPath, wave, index] = process.argv.slice(2);
process.env.JINN_HOME = home;

try {
  // The parent reads this worker's stdout and JSON.parses it. Registry init logs
  // an INFO line (e.g. "Pre-migration session DB backup created: …") via the shared
  // logger, which defaults to writeToStdout=true — that stray line ahead of our JSON
  // breaks the parse. Silence stdout logging BEFORE the registry loads. Resolve the
  // logger relative to the registry so this works regardless of CWD.
  const loggerUrl = new URL("../shared/logger.js", pathToFileURL(registryPath).href).href;
  const { configureLogger } = await import(loggerUrl);
  configureLogger({ stdout: false, file: false });
  const registry = await import(pathToFileURL(registryPath).href);
  const payload = { message: "concurrent callback", displayMessage: "Worker replied" };
  const common = registry.claimSessionDelivery({
    targetSessionId: `parent-${wave}`,
    sourceKind: "session",
    sourceId: `child-${wave}`,
    sourceAttempt: `attempt-${wave}`,
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    payload,
  });
  const distinct = registry.claimSessionDelivery({
    targetSessionId: `parent-${wave}`,
    sourceKind: "session",
    sourceId: `child-${wave}`,
    sourceAttempt: `attempt-${wave}-${index}`,
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    payload,
  });
  process.stdout.write(JSON.stringify({ commonId: common.delivery.id, distinctId: distinct.delivery.id }));
  (await import(new URL("../shared/db.js", pathToFileURL(registryPath).href).href)).__closeDbForTest();
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
