import { pathToFileURL } from "node:url";

const [home, registryPath, wave, index] = process.argv.slice(2);
process.env.JINN_HOME = home;

try {
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
  registry.__closeDbForTest();
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
