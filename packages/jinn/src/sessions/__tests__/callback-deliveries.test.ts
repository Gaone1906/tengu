import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-deliveries-"));
process.env.JINN_HOME = home;

type Registry = typeof import("../registry.js");

let registry: Registry;

function callbackInput(overrides: Record<string, unknown> = {}) {
  return {
    parentSessionId: "parent-1",
    childSessionId: "child-1",
    attemptToken: "attempt-1",
    terminalOutcome: "succeeded",
    terminalVersion: 1,
    callbackKind: "parent-completion",
    payload: {
      message: "engine callback payload",
      displayMessage: "Worker replied\nDone",
      meta: {
        kind: "child-reply",
        employee: "worker",
        childSessionId: "child-1",
        fullMessage: "Done",
      },
    },
    ...overrides,
  } as Parameters<Registry["claimCallbackDelivery"]>[0];
}

function createSession(id: string, parentSessionId?: string) {
  const session = registry.createSession({
    engine: "stub",
    source: "web",
    sourceRef: `web:${id}`,
    sessionKey: `web:${id}`,
    connector: "web",
    parentSessionId,
    prompt: `session ${id}`,
  });
  registry.initDb().prepare("UPDATE sessions SET id = ? WHERE id = ?").run(id, session.id);
  return registry.getSession(id)!;
}

beforeAll(async () => {
  registry = await import("../registry.js");
  registry.initDb();
});

beforeEach(() => {
  const database = registry.initDb();
  const hasCallbackTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'")
    .get();
  if (hasCallbackTable) database.exec("DELETE FROM callback_deliveries");
  database.exec(`
      DELETE FROM queue_items;
      DELETE FROM messages;
      DELETE FROM sessions;
    `);
});

describe("callback delivery schema migration", () => {
  it("is idempotent and installs the durable composite uniqueness contract", () => {
    const database = new Database(":memory:");

    registry.migrateCallbackDeliveriesSchema(database);
    registry.migrateCallbackDeliveriesSchema(database);

    const columns = database.prepare("PRAGMA table_info(callback_deliveries)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "parent_session_id",
      "child_session_id",
      "attempt_token",
      "terminal_outcome",
      "terminal_version",
      "callback_kind",
      "payload",
      "status",
      "message_id",
      "queue_item_id",
    ]));
    const indexes = database.prepare("PRAGMA index_list(callback_deliveries)").all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_callback_delivery_identity", unique: 1 }),
      expect.objectContaining({ name: "idx_callback_deliveries_pending" }),
    ]));
  });

  it("rolls back index creation when an incompatible pre-existing table fails validation", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE callback_deliveries (id TEXT PRIMARY KEY)");

    expect(() => registry.migrateCallbackDeliveriesSchema(database)).toThrow(/incompatible callback_deliveries schema/i);

    const columns = database.prepare("PRAGMA table_info(callback_deliveries)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["id"]);
    const indexes = database.prepare("PRAGMA index_list(callback_deliveries)").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).not.toContain("uq_callback_delivery_identity");
  });
});

describe("callback delivery identity", () => {
  it("collapses six concurrent and sequential claims for one attempt outcome", async () => {
    const claims = await Promise.all(
      Array.from({ length: 6 }, async () => registry.claimCallbackDelivery(callbackInput())),
    );
    const retry = registry.claimCallbackDelivery(callbackInput());

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(new Set([...claims, retry].map((claim) => claim.delivery.id))).toHaveLength(1);
    expect(registry.listPendingCallbackDeliveries()).toHaveLength(1);
  });

  it.each([
    ["parent session", { parentSessionId: "parent-2" }],
    ["child session", { childSessionId: "child-2" }],
    ["attempt generation", { attemptToken: "attempt-2" }],
    ["terminal outcome", { terminalOutcome: "failed" }],
    ["terminal version", { terminalVersion: 2 }],
    ["callback kind", { callbackKind: "talk-attachment" }],
  ])("keeps a distinct %s deliverable exactly once", (_label, overrides) => {
    const first = registry.claimCallbackDelivery(callbackInput());
    const distinct = registry.claimCallbackDelivery(callbackInput(overrides));
    const duplicate = registry.claimCallbackDelivery(callbackInput(overrides));

    expect(first.claimed).toBe(true);
    expect(distinct.claimed).toBe(true);
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.delivery.id).toBe(distinct.delivery.id);
    expect(registry.listPendingCallbackDeliveries()).toHaveLength(2);
  });

  it("keeps a failed send pending and retryable under the original durable id", () => {
    const claimed = registry.claimCallbackDelivery(callbackInput());

    const retry = registry.claimCallbackDelivery(callbackInput());

    expect(claimed.claimed).toBe(true);
    expect(retry.claimed).toBe(false);
    expect(retry.delivery).toMatchObject({ id: claimed.delivery.id, status: "pending" });
    expect(registry.getCallbackDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
  });
});

describe("callback delivery acceptance", () => {
  it("atomically accepts one queue item and one durable notification message", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimCallbackDelivery(callbackInput());

    const accepted = registry.acceptCallbackDelivery(claimed.delivery.id, parent.id, parent.sessionKey);
    const responseLossRetry = registry.acceptCallbackDelivery(claimed.delivery.id, parent.id, parent.sessionKey);

    expect(accepted.accepted).toBe(true);
    expect(responseLossRetry.accepted).toBe(false);
    expect(responseLossRetry.delivery).toMatchObject({
      status: "accepted",
      messageId: accepted.delivery.messageId,
      queueItemId: accepted.delivery.queueItemId,
    });
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toEqual([
      expect.objectContaining({ content: "Worker replied\nDone" }),
    ]);
    expect(registry.listAllPendingQueueItems()).toEqual([
      expect.objectContaining({
        id: accepted.delivery.queueItemId,
        sessionId: parent.id,
        prompt: "engine callback payload",
        internal: true,
      }),
    ]);
  });

  it("rejects a receipt routed to a different parent without consuming it", () => {
    const parent = createSession("parent-1");
    const otherParent = createSession("parent-2");
    createSession("child-1", parent.id);
    const claimed = registry.claimCallbackDelivery(callbackInput());

    expect(() => registry.acceptCallbackDelivery(claimed.delivery.id, otherParent.id, otherParent.sessionKey))
      .toThrow(/callback parent mismatch/i);

    expect(registry.getCallbackDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
    expect(registry.getMessages(otherParent.id)).toHaveLength(0);
    expect(registry.listAllPendingQueueItems()).toHaveLength(0);
  });

  it("persists the callback block in the same transaction as queue and message acceptance", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    registry.applyBlockEnvelope(parent.id, {
      op: "put",
      block: {
        id: "dg-work-1",
        type: "delegation",
        version: 1,
        status: "running",
        payload: {
          employee: "worker",
          employeeDisplay: "Worker",
          title: "Complete bounded work",
          childSessionId: "child-1",
          workItemId: "work-1",
          dispatchedAt: 1_780_000_000_000,
        },
      },
    });
    const claimed = registry.claimCallbackDelivery(callbackInput({
      payload: {
        message: "engine callback payload",
        displayMessage: "Worker replied\nDone",
        block: {
          op: "patch",
          block: {
            id: "dg-work-1",
            type: "delegation",
            version: 1,
            status: "done",
            payload: { repliedAt: 1_780_000_120_000 },
          },
        },
      },
    }));

    registry.acceptCallbackDelivery(claimed.delivery.id, parent.id, parent.sessionKey);

    const delegation = registry.getMessages(parent.id)
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.id === "dg-work-1");
    expect(delegation).toMatchObject({ status: "done", payload: { repliedAt: 1_780_000_120_000 } });
  });

  it("rolls back queue, message, and receipt acceptance when callback block persistence fails", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimCallbackDelivery(callbackInput({
      payload: {
        message: "engine callback payload",
        displayMessage: "Worker replied\nDone",
        block: {
          op: "put",
          block: { id: "unsupported", type: "unsupported", version: 1, payload: {} },
        },
      } as never,
    }));

    expect(() => registry.acceptCallbackDelivery(claimed.delivery.id, parent.id, parent.sessionKey))
      .toThrow(/block type is invalid/i);

    expect(registry.getCallbackDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
    expect(registry.getMessages(parent.id)).toEqual([]);
    expect(registry.listAllPendingQueueItems()).toEqual([]);
  });

  it("removes pending callback receipts when their parent session is deleted", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimCallbackDelivery(callbackInput());

    expect(registry.deleteSession(parent.id)).toBe(true);

    expect(registry.getCallbackDelivery(claimed.delivery.id)).toBeUndefined();
    expect(registry.listPendingCallbackDeliveries()).toHaveLength(0);
  });
});

describe("session terminal versions", () => {
  it("upgrades a migrated tokenless terminal row from version zero when its first callback is claimed", () => {
    const child = createSession("child-1");
    registry.initDb().prepare(`
      UPDATE sessions
      SET status = 'idle', attempt_outcome = 'succeeded', attempt_token = NULL, attempt_terminal_version = 0
      WHERE id = ?
    `).run(child.id);

    const token = registry.ensureCallbackAttemptToken(child.id, "succeeded", 1);

    expect(token).toEqual(expect.any(String));
    expect(registry.getSession(child.id)).toMatchObject({
      attemptToken: token,
      attemptOutcome: "succeeded",
      attemptTerminalVersion: 1,
    });
  });

  it("mints one durable token for a matching legacy terminal attempt but not a stale generation", () => {
    const child = createSession("child-1");
    const legacyTerminal = registry.updateSession(child.id, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;

    const token = registry.ensureCallbackAttemptToken(child.id, "succeeded", legacyTerminal.attemptTerminalVersion!);
    expect(token).toEqual(expect.any(String));
    expect(registry.ensureCallbackAttemptToken(child.id, "succeeded", legacyTerminal.attemptTerminalVersion!)).toBe(token);

    registry.beginSessionAttempt(child.id);
    expect(registry.ensureCallbackAttemptToken(child.id, "succeeded", legacyTerminal.attemptTerminalVersion!)).toBeUndefined();
  });

  it("resets for a new attempt and advances when the same attempt receives a changed terminal receipt", () => {
    const child = createSession("child-1");
    const attemptOne = registry.beginSessionAttempt(child.id)!;
    const completedOne = registry.completeSessionAttempt(child.id, attemptOne.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;

    expect(completedOne).toMatchObject({ attemptTerminalVersion: 1 });
    const changedTerminal = registry.updateSession(child.id, { attemptOutcome: "failed", status: "error" })!;
    expect(changedTerminal).toMatchObject({
      attemptToken: attemptOne.attemptToken,
      attemptOutcome: "failed",
      attemptTerminalVersion: 2,
    });

    const attemptTwo = registry.beginSessionAttempt(child.id)!;
    expect(attemptTwo.attemptToken).not.toBe(attemptOne.attemptToken);
    expect(attemptTwo).toMatchObject({ attemptOutcome: null, attemptTerminalVersion: 0 });
  });
});
