import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "../..");

describe("generic Session delivery API boundary", () => {
  it("contains no callback-shaped lifecycle exports or recovery aliases", () => {
    const files = [
      path.join(sourceRoot, "sessions", "registry.ts"),
      path.join(sourceRoot, "sessions", "callbacks.ts"),
    ];
    const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    const forbidden = [
      "LegacyCallbackDelivery",
      "getCallbackDelivery",
      "getCallbackDeliveryByQueueItemId",
      "listPendingCallbackDeliveries",
      "listDeadLetterCallbackDeliveries",
      "requeueDeadLetterCallbackDelivery",
      "claimCallbackDelivery",
      "claimCallbackDeliveryAttempt",
      "recordCallbackDeliveryFailure",
      "acceptCallbackDelivery",
      "recoverPendingCallbackDeliveries",
      "recoverCallbackStateOnStartup",
    ];
    for (const symbol of forbidden) expect(source).not.toContain(symbol);
  });
});
