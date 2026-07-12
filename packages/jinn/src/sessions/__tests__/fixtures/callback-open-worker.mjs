import { pathToFileURL } from "node:url";

const [home, registryPath, wave, index] = process.argv.slice(2);
process.env.JINN_HOME = home;

try {
  const registry = await import(pathToFileURL(registryPath).href);
  const payload = { message: "concurrent callback", displayMessage: "Worker replied" };
  const common = registry.claimCallbackDelivery({
    parentSessionId: `parent-${wave}`,
    childSessionId: `child-${wave}`,
    attemptToken: `attempt-${wave}`,
    terminalOutcome: "succeeded",
    terminalVersion: 1,
    callbackKind: "parent-completion",
    payload,
  });
  const distinct = registry.claimCallbackDelivery({
    parentSessionId: `parent-${wave}`,
    childSessionId: `child-${wave}`,
    attemptToken: `attempt-${wave}-${index}`,
    terminalOutcome: "succeeded",
    terminalVersion: 1,
    callbackKind: "parent-completion",
    payload,
  });
  process.stdout.write(JSON.stringify({ commonId: common.delivery.id, distinctId: distinct.delivery.id }));
  registry.__closeDbForTest();
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
