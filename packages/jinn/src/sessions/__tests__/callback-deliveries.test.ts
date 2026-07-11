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
      "attempt_count",
      "next_attempt_at",
      "last_attempt_at",
      "last_error",
      "dead_lettered_at",
    ]));
    const indexes = database.prepare("PRAGMA index_list(callback_deliveries)").all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_callback_delivery_identity", unique: 1 }),
      expect.objectContaining({ name: "idx_callback_deliveries_pending" }),
    ]));
    const identityColumns = database
      .prepare("PRAGMA index_info(uq_callback_delivery_identity)")
      .all() as Array<{ name: string }>;
    expect(identityColumns.map((column) => column.name)).toEqual([
      "parent_session_id",
      "child_session_id",
      "attempt_token",
      "terminal_outcome",
      "terminal_version",
      "callback_kind",
    ]);
    const tableSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string }).sql;
    expect(tableSql).toMatch(/terminal_version\s+INTEGER\s+NOT NULL\s+CHECK\s*\(terminal_version\s*>=\s*1\)/i);
    expect(tableSql).toMatch(/json_valid\s*\(payload\)/i);
    expect(tableSql).toMatch(/status\s+IN\s*\('pending',\s*'accepted',\s*'dead_letter'\)/i);
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

  it("migrates a legacy outbox transactionally, canonicalizes valid rows, and quarantines poison", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE callback_deliveries (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        attempt_token TEXT NOT NULL,
        terminal_outcome TEXT NOT NULL,
        terminal_version INTEGER NOT NULL,
        callback_kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
        message_id TEXT,
        queue_item_id TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      );
      INSERT INTO callback_deliveries VALUES
        ('valid', ' parent ', ' child ', ' attempt ', ' succeeded ', 1, ' parent-completion ',
          '{"message":"valid","displayMessage":"valid"}', 'pending', NULL, NULL,
          '2026-01-01T00:00:00.000Z', NULL),
        ('poison', 'parent', 'child-poison', 'attempt-poison', 'failed', 1, 'parent-completion',
          '{broken', 'pending', NULL, NULL, '2026-01-01T00:00:01.000Z', NULL);
    `);

    registry.migrateCallbackDeliveriesSchema(database);
    registry.migrateCallbackDeliveriesSchema(database);

    expect(database.prepare(`
      SELECT parent_session_id AS parentSessionId, child_session_id AS childSessionId,
        attempt_token AS attemptToken, terminal_outcome AS terminalOutcome,
        callback_kind AS callbackKind, status
      FROM callback_deliveries WHERE id = 'valid'
    `).get()).toEqual({
      parentSessionId: "parent",
      childSessionId: "child",
      attemptToken: "attempt",
      terminalOutcome: "succeeded",
      callbackKind: "parent-completion",
      status: "pending",
    });
    expect(database.prepare(`
      SELECT status, last_error AS lastError, dead_lettered_at AS deadLetteredAt
      FROM callback_deliveries WHERE id = 'poison'
    `).get()).toMatchObject({
      status: "dead_letter",
      lastError: expect.stringMatching(/invalid callback delivery payload json/i),
      deadLetteredAt: expect.any(Number),
    });
  });

  it("rebuilds an all-column table whose canonical and payload-shape constraints are incomplete", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE callback_deliveries (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        attempt_token TEXT NOT NULL,
        terminal_outcome TEXT NOT NULL,
        terminal_version INTEGER NOT NULL CHECK (terminal_version >= 1),
        callback_kind TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dead_letter')),
        message_id TEXT,
        queue_item_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_attempt_at INTEGER,
        last_error TEXT,
        dead_lettered_at INTEGER,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      );
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, attempt_count, created_at
      ) VALUES ('bad-lifecycle', 'parent', 'child', 'attempt', 'failed', 1,
        'parent-completion', '{"message":"valid","displayMessage":"valid"}',
        'pending', -2, '2026-01-01T00:00:00.000Z');
    `);

    registry.migrateCallbackDeliveriesSchema(database);

    expect(() => database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES ('noncanonical', ' parent ', 'child', 'attempt', 'succeeded', 1,
        'parent-completion', '{"message":"ok","displayMessage":"ok"}', 'pending',
        '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES ('bad-shape', 'parent', 'child', 'attempt', 'succeeded', 1,
        'parent-completion', '{"message":"missing display"}', 'pending',
        '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
    expect(database.prepare(`
      SELECT status, attempt_count AS attemptCount, last_error AS lastError
      FROM callback_deliveries WHERE id = 'bad-lifecycle'
    `).get()).toMatchObject({
      status: "dead_letter",
      attemptCount: 0,
      lastError: expect.stringMatching(/attempt count/i),
    });
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

  it("canonicalizes whitespace and Unicode before insert and conflict lookup", () => {
    const decomposed = "cafe\u0301";
    const composed = "caf\u00e9";
    const first = registry.claimCallbackDelivery(callbackInput({
      parentSessionId: " parent-1 ",
      childSessionId: ` ${decomposed} `,
      attemptToken: " attempt-1 ",
      terminalOutcome: " succeeded ",
      callbackKind: " parent-completion ",
    }));
    const duplicate = registry.claimCallbackDelivery(callbackInput({
      parentSessionId: "parent-1",
      childSessionId: composed,
      attemptToken: "attempt-1",
      terminalOutcome: "succeeded",
      callbackKind: "parent-completion",
    }));

    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({ claimed: false, delivery: { id: first.delivery.id } });
    expect(first.delivery).toMatchObject({
      parentSessionId: "parent-1",
      childSessionId: composed,
      attemptToken: "attempt-1",
      terminalOutcome: "succeeded",
      callbackKind: "parent-completion",
    });
  });

  it.each([
    ["blank parent", "parent_session_id", "   ", 1],
    ["tab-padded parent", "parent_session_id", "\tparent-sql\t", 1],
    ["NBSP-only parent", "parent_session_id", "\u00a0", 1],
    ["decomposed Unicode child", "child_session_id", "cafe\u0301", 1],
    ["padded token", "attempt_token", " token ", 1],
    ["zero terminal version", "terminal_version", "attempt-2", 0],
  ])("rejects direct SQL identities that violate canonical constraints: %s", (_label, column, value, version) => {
    const database = registry.initDb();
    const row = callbackInput({
      parentSessionId: column === "parent_session_id" ? value : "parent-sql",
      childSessionId: column === "child_session_id" ? value : "child-sql",
      attemptToken: column === "attempt_token" ? value : "attempt-sql",
      terminalVersion: version,
    });
    expect(() => database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      `sql-${column}`,
      row.parentSessionId,
      row.childSessionId,
      row.attemptToken,
      row.terminalOutcome,
      row.terminalVersion,
      row.callbackKind,
      JSON.stringify(row.payload),
      new Date().toISOString(),
    )).toThrow();
  });
});

describe("callback delivery retry lifecycle", () => {
  it("leases one due attempt, persists backoff, and dead-letters at bounded exhaustion", () => {
    const delivery = registry.claimCallbackDelivery(callbackInput()).delivery;

    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 1_000, 500)).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: 1_000,
      nextAttemptAt: 1_500,
    });
    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 1_000, 500)).toBeUndefined();
    expect(registry.recordCallbackDeliveryFailure(delivery.id, "timeout one", {
      now: 1_000,
      nextAttemptAt: 2_000,
      maxAttempts: 3,
    })).toMatchObject({ status: "pending", attemptCount: 1, nextAttemptAt: 2_000, lastError: "timeout one" });

    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 2_000, 500)).toMatchObject({ attemptCount: 2 });
    registry.recordCallbackDeliveryFailure(delivery.id, "timeout two", {
      now: 2_000,
      nextAttemptAt: 4_000,
      maxAttempts: 3,
    });
    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 4_000, 500)).toMatchObject({ attemptCount: 3 });
    expect(registry.recordCallbackDeliveryFailure(delivery.id, "timeout three", {
      now: 4_000,
      nextAttemptAt: 8_000,
      maxAttempts: 3,
    })).toMatchObject({
      status: "dead_letter",
      attemptCount: 3,
      lastError: "timeout three",
      deadLetteredAt: 4_000,
    });
    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 8_000, 500)).toBeUndefined();
  });

  it("never resets or releases an accepted receipt after a late failure", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimCallbackDelivery(callbackInput()).delivery;
    registry.claimCallbackDeliveryAttempt(delivery.id, 1_000, 500);
    registry.acceptCallbackDelivery(delivery.id, parent.id, parent.sessionKey);

    const afterFailure = registry.recordCallbackDeliveryFailure(delivery.id, "response lost", {
      now: 1_100,
      nextAttemptAt: 2_000,
      maxAttempts: 3,
    });

    expect(afterFailure).toMatchObject({ status: "accepted", attemptCount: 1 });
    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 2_000, 500)).toBeUndefined();
  });

  it("lists an exhausted receipt and atomically requeues the same durable id after recovery", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimCallbackDelivery(callbackInput()).delivery;

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(registry.claimCallbackDeliveryAttempt(delivery.id, attempt * 1_000, 100))
        .toMatchObject({ id: delivery.id, attemptCount: attempt });
      registry.recordCallbackDeliveryFailure(delivery.id, `outage ${attempt}`, {
        now: attempt * 1_000,
        nextAttemptAt: (attempt + 1) * 1_000,
        maxAttempts: 4,
      });
    }

    expect(registry.listDeadLetterCallbackDeliveries()).toEqual([
      expect.objectContaining({
        id: delivery.id,
        status: "dead_letter",
        attemptCount: 4,
        lastError: "outage 4",
      }),
    ]);

    const requeued = registry.requeueDeadLetterCallbackDelivery(delivery.id);
    expect(requeued).toMatchObject({
      id: delivery.id,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastError: null,
      deadLetteredAt: null,
      messageId: null,
      queueItemId: null,
      acceptedAt: null,
    });
    expect(registry.claimCallbackDeliveryAttempt(delivery.id, 5_000, 100))
      .toMatchObject({ id: delivery.id, attemptCount: 1 });
    const accepted = registry.acceptCallbackDelivery(delivery.id, parent.id, parent.sessionKey);
    expect(accepted).toMatchObject({ accepted: true, delivery: { id: delivery.id, status: "accepted" } });
    expect(registry.acceptCallbackDelivery(delivery.id, parent.id, parent.sessionKey))
      .toMatchObject({ accepted: false, delivery: { id: delivery.id, status: "accepted" } });
  });

  it("never permits an accepted callback receipt to be requeued", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimCallbackDelivery(callbackInput()).delivery;
    const accepted = registry.acceptCallbackDelivery(delivery.id, parent.id, parent.sessionKey).delivery;

    expect(() => registry.requeueDeadLetterCallbackDelivery(delivery.id)).toThrow(/dead.?letter/i);
    expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({
      id: delivery.id,
      status: "accepted",
      messageId: accepted.messageId,
      queueItemId: accepted.queueItemId,
    });
  });

  it("quarantines a poison pending row and continues returning later valid receipts", () => {
    const database = registry.initDb();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES ('poison', 'parent-poison', 'child-poison', 'attempt-poison', 'failed',
        1, 'parent-completion', '{bad json', 'pending', '2026-01-01T00:00:00.000Z')
    `).run();
    database.pragma("ignore_check_constraints = OFF");
    const valid = registry.claimCallbackDelivery(callbackInput({
      parentSessionId: "parent-valid",
      childSessionId: "child-valid",
    })).delivery;

    expect(registry.listPendingCallbackDeliveries()).toEqual([
      expect.objectContaining({ id: valid.id, status: "pending" }),
    ]);
    expect(database.prepare(`
      SELECT status, last_error AS lastError, dead_lettered_at AS deadLetteredAt
      FROM callback_deliveries WHERE id = 'poison'
    `).get()).toMatchObject({
      status: "dead_letter",
      lastError: expect.stringMatching(/invalid payload json/i),
      deadLetteredAt: expect.any(Number),
    });
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
