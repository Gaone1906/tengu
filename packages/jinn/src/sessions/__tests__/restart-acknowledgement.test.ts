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
  registry.initDb();
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

  it("acknowledges ordinary sessions while leaving a legacy Workflow run marker and messages byte-identical", () => {
    const legacy = registry.createSession({
      engine: "workflow",
      source: "web",
      sourceRef: "workflow-run:restart-legacy:parent",
      sessionKey: "workflow-run:restart-legacy:parent",
      workflowProvenance: {
        kind: "run",
        workflowId: "restart-review",
        workflowName: "restart-review",
        runId: "restart-legacy",
        triggerSource: "manual",
      },
    });
    registry.updateSession(legacy.id, {
      transportMeta: {
        keep: "legacy",
        restartAcknowledgedAt: "2026-07-11T08:00:00.000Z",
      },
    });
    registry.insertMessage(legacy.id, "notification", "Historical restart evidence");

    const ordinary = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:restart-ordinary-control",
    });
    registry.updateSession(ordinary.id, {
      transportMeta: {
        keep: "ordinary",
        restartAcknowledgedAt: "2026-07-11T08:00:00.000Z",
      },
    });

    const database = registry.initDb();
    const legacySnapshot = () => ({
      session: database.prepare("SELECT * FROM sessions WHERE id = ?").get(legacy.id),
      messages: database.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(legacy.id),
    });
    const before = legacySnapshot();

    expect(registry.consumeRestartAcknowledgements()).toBe(1);
    expect(legacySnapshot()).toEqual(before);
    expect(registry.getMessages(ordinary.id).at(-1)).toMatchObject({
      role: "notification",
      content: "Gateway restarted successfully.",
    });
    expect(registry.getSession(ordinary.id)?.transportMeta).toEqual({ keep: "ordinary" });
  });
});
