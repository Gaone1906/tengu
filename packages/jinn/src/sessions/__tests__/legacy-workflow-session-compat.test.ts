import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-legacy-workflow-session-"));
process.env.JINN_HOME = home;

type Registry = typeof import("../registry.js");
let registry: Registry;

function legacyRowsChecksum(): string {
  const database = registry.initDb();
  const snapshot = {
    sessions: database.prepare(`
      SELECT * FROM sessions
      WHERE id IN ('legacy-run-session', 'legacy-phase-session')
      ORDER BY id
    `).all(),
    messages: database.prepare(`
      SELECT * FROM messages
      WHERE session_id = 'legacy-run-session'
      ORDER BY id
    `).all(),
    queueItems: database.prepare(`
      SELECT * FROM queue_items
      WHERE session_id = 'legacy-run-session'
      ORDER BY id
    `).all(),
    callbackDeliveries: database.prepare(`
      SELECT * FROM callback_deliveries
      WHERE parent_session_id = 'legacy-run-session'
      ORDER BY id
    `).all(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

beforeAll(async () => {
  registry = await import("../registry.js");
  registry.initDb();
});

afterAll(() => {
  registry.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("legacy Workflow run Session compatibility", () => {
  it("reopens the exact historical projection without rewriting its evidence", () => {
    const database = registry.initDb();
    const createdParent = registry.createSession({
      engine: "workflow",
      source: "web",
      sourceRef: "workflow-run:run-old:parent",
      sessionKey: "workflow-run:run-old:parent",
      title: "Workflow: release-review · run run-old",
      workflowProvenance: {
        kind: "run",
        workflowId: "release-review",
        workflowName: "release-review",
        runId: "run-old",
        triggerSource: "manual",
      },
    });
    database.prepare(`
      UPDATE sessions
      SET id = 'legacy-run-session', status = 'running', last_activity = '2026-01-02T03:04:05.000Z',
          transport_meta = '{"keep":"legacy-evidence","restartAcknowledgedAt":"2026-01-02T03:04:05.000Z"}'
      WHERE id = ?
    `).run(createdParent.id);

    const createdPhase = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "workflow-run:run-old:review:1",
      sessionKey: "workflow-run:run-old:review:1",
      title: "[Workflow] release-review / REVIEW",
      parentSessionId: "legacy-run-session",
      workflowProvenance: {
        kind: "phase",
        workflowId: "release-review",
        workflowName: "release-review",
        runId: "run-old",
        triggerSource: "manual",
        phase: { nodeId: "review", name: "REVIEW", index: 1, round: 1, attempt: 1 },
      },
    });
    database.prepare("UPDATE sessions SET id = 'legacy-phase-session' WHERE id = ?").run(createdPhase.id);

    database.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, partial)
      VALUES
        ('legacy-message', 'legacy-run-session', 'notification', 'Historical callback', 1767323045000, NULL),
        ('legacy-partial', 'legacy-run-session', 'assistant', 'Historical partial evidence', 1767323045001, 1)
    `).run();
    database.prepare(`
      INSERT INTO queue_items (
        id, session_id, session_key, prompt, status, internal, position, created_at
      ) VALUES
        (
          'legacy-queue', 'legacy-run-session', 'workflow-run:run-old:parent',
          'Historical queued callback', 'pending', 0, 1, '2026-01-02T03:04:05.000Z'
        ),
        (
          'legacy-queue-running', 'legacy-run-session', 'workflow-run:run-old:parent',
          'Historical in-flight callback', 'running', 1, 2, '2026-01-02T03:04:05.000Z'
        )
    `).run();
    database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, message_id, queue_item_id,
        attempt_count, next_attempt_at, last_attempt_at, last_error, dead_lettered_at,
        created_at, accepted_at
      ) VALUES
        (
          'legacy-delivery', 'legacy-run-session', 'legacy-phase-session', 'attempt-old',
          'succeeded', 1, 'parent-completion',
          '{"message":"Historical pending callback","displayMessage":"Historical pending callback"}',
          'pending', NULL, NULL, 0, 1767323045000, NULL, NULL, NULL,
          '2026-01-02T03:04:05.000Z', NULL
        ),
        (
          'legacy-delivery-accepted', 'legacy-run-session', 'legacy-phase-session',
          'attempt-accepted', 'succeeded', 1, 'parent-completion',
          '{"message":"Historical callback","displayMessage":"Historical callback"}',
          'accepted', 'legacy-message', 'legacy-queue', 1, NULL, 1767323045000,
          NULL, NULL, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:06.000Z'
        )
    `).run();

    const ordinary = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:ordinary-boot-cleanup",
      sessionKey: "web:ordinary-boot-cleanup",
    });
    registry.updateSession(ordinary.id, {
      transportMeta: {
        keep: "ordinary",
        restartAcknowledgedAt: "2026-01-02T03:04:05.000Z",
      },
    });
    database.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, partial)
      VALUES ('ordinary-partial', ?, 'assistant', 'Stranded ordinary stream', 1767323045002, 1)
    `).run(ordinary.id);

    const checksumBeforeReopen = legacyRowsChecksum();
    registry.__closeDbForTest();
    registry.initDb();
    const checksumAfterReopen = legacyRowsChecksum();

    expect(checksumAfterReopen).toBe(checksumBeforeReopen);
    expect(registry.recoverStaleSessions()).toBe(0);
    expect(registry.recoverStaleQueueItems()).toBe(0);
    expect(legacyRowsChecksum()).toBe(checksumBeforeReopen);
    expect(registry.clearAllPartialMessages()).toBe(1);
    expect(legacyRowsChecksum()).toBe(checksumBeforeReopen);
    expect(registry.consumeRestartAcknowledgements()).toBe(1);
    expect(legacyRowsChecksum()).toBe(checksumBeforeReopen);
    expect(registry.getMessages(ordinary.id).map((message) => message.content)).toEqual([
      "Gateway restarted successfully.",
    ]);
    expect(registry.getSession(ordinary.id)?.transportMeta).toEqual({ keep: "ordinary" });

    const legacyParent = registry.getSession("legacy-run-session")!;
    const phase = registry.getSession("legacy-phase-session")!;
    expect(legacyParent.workflowProvenance?.kind).toBe("run");
    expect(registry.getMessages(legacyParent.id).map((message) => message.id)).toEqual([
      "legacy-message",
      "legacy-partial",
    ]);
    expect(legacyParent.transportMeta).toEqual({
      keep: "legacy-evidence",
      restartAcknowledgedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(registry.getQueueItems(legacyParent.sessionKey).map((item) => item.id)).toEqual(["legacy-queue"]);
    expect(registry.getCallbackDelivery("legacy-delivery")).toBeDefined();
    expect(registry.getCallbackDelivery("legacy-delivery-accepted")).toMatchObject({
      messageId: "legacy-message",
      queueItemId: "legacy-queue",
      status: "accepted",
    });
    expect(phase.parentSessionId).toBe(legacyParent.id);

    const classifier = (registry as Registry & {
      isLegacyWorkflowRunSession?: (session: typeof legacyParent) => boolean;
    }).isLegacyWorkflowRunSession;
    const location = (registry as Registry & {
      legacyWorkflowRunLocation?: (session: typeof legacyParent) => unknown;
    }).legacyWorkflowRunLocation;
    expect(classifier, "isLegacyWorkflowRunSession export").toBeTypeOf("function");
    expect(location, "legacyWorkflowRunLocation export").toBeTypeOf("function");
    expect(classifier!(legacyParent)).toBe(true);
    expect(location!(legacyParent)).toEqual({
      workflowId: "release-review",
      runId: "run-old",
      openPath: "/workflow/release-review?mode=runs&run=run-old",
    });
  });
});
