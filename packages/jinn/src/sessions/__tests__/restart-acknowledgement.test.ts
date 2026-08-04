import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-ack-"));
process.env.JINN_HOME = tmp;

type Registry = typeof import("../registry.js");
let registry: Registry;

beforeAll(async () => {
  registry = await import("../registry.js");
  (await import("../../shared/db.js")).initDb();
});

describe("consumeRestartAcknowledgements", () => {
  it("persists a visible notification and clears the one-shot restart marker", () => {
    const session = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:restart-notice",
    });
    registry.updateSession(session.id, {
      transportMeta: {
        keep: "value",
        restartAcknowledgedAt: "2026-07-11T08:00:00.000Z",
      },
    });

    expect(registry.consumeRestartAcknowledgements()).toBe(1);
    expect(registry.getMessages(session.id).at(-1)).toMatchObject({
      role: "notification",
      content: "Gateway restarted successfully.",
    });
    expect(registry.getSession(session.id)?.transportMeta).toEqual({ keep: "value" });

    expect(registry.consumeRestartAcknowledgements()).toBe(0);
    expect(registry.getMessages(session.id).filter((message) => message.content === "Gateway restarted successfully.")).toHaveLength(1);
  });

});
