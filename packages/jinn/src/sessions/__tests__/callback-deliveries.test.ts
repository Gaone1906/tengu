import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-deliveries-"));
process.env.JINN_HOME = home;

type Registry = typeof import("../registry.js");

let registry: Registry;

const UNICODE_WHITE_SPACE = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
] as const;

function callbackInput(overrides: Record<string, unknown> = {}) {
  return {
    targetSessionId: "parent-1",
    sourceKind: "session" as const,
    sourceId: "child-1",
    sourceAttempt: "attempt-1",
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    payload: overrides.payload ?? {
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
  } as Parameters<Registry["claimSessionDelivery"]>[0];
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

function installExactChildDeliverySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE callback_deliveries (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL CHECK (length(parent_session_id) > 0 AND parent_session_id = jinn_callback_identity(parent_session_id)),
      child_session_id TEXT NOT NULL CHECK (length(child_session_id) > 0 AND child_session_id = jinn_callback_identity(child_session_id)),
      attempt_token TEXT NOT NULL CHECK (length(attempt_token) > 0 AND attempt_token = jinn_callback_identity(attempt_token)),
      terminal_outcome TEXT NOT NULL CHECK (length(terminal_outcome) > 0 AND terminal_outcome = jinn_callback_identity(terminal_outcome)),
      terminal_version INTEGER NOT NULL CHECK (terminal_version >= 1),
      callback_kind TEXT NOT NULL CHECK (length(callback_kind) > 0 AND callback_kind = jinn_callback_identity(callback_kind)),
      payload TEXT NOT NULL CHECK (
        json_valid(payload)
        AND json_type(payload) = 'object'
        AND json_type(payload, '$.message') IS 'text'
        AND json_type(payload, '$.displayMessage') IS 'text'
      ),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dead_letter')),
      message_id TEXT,
      queue_item_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      last_attempt_at INTEGER,
      last_error TEXT,
      dead_lettered_at INTEGER,
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE UNIQUE INDEX uq_callback_delivery_identity
      ON callback_deliveries (
        parent_session_id,
        child_session_id,
        attempt_token,
        terminal_outcome,
        terminal_version,
        callback_kind
      );
    CREATE INDEX idx_callback_deliveries_pending
      ON callback_deliveries (status, next_attempt_at, created_at)
      WHERE status = 'pending';
  `);
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
  it("preserves every valid lifecycle field byte-for-byte and quarantines the complete poison matrix", () => {
    const database = new Database(":memory:");
    database.function("jinn_callback_identity", { deterministic: true }, (value: unknown) => value);
    installExactChildDeliverySchema(database);
    const payload = JSON.stringify({ message: "exact payload", displayMessage: "Exact payload", meta: { exact: true } });
    const insert = database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, message_id, queue_item_id,
        attempt_count, next_attempt_at, last_attempt_at, last_error, dead_lettered_at,
        created_at, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("valid-pending", "parent", "child-p", "attempt-p", "succeeded", 2, "parent-completion", payload,
      "pending", null, null, 3, 1_700_000_000_500, 1_700_000_000_000, "retry later", null,
      "2026-01-01T00:00:00.000Z", null);
    insert.run("valid-accepted", "parent", "child-a", "attempt-a", "succeeded", 3, "parent-completion", payload,
      "accepted", "message-a", "queue-a", 2, null, 1_700_000_001_000, null, null,
      "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z");
    insert.run("valid-dead", "parent", "child-d", "attempt-d", "failed", 4, "parent-completion", payload,
      "dead_letter", null, null, 4, null, 1_700_000_002_000, "exhausted", 1_700_000_002_500,
      "2026-01-01T00:00:03.000Z", null);

    const poisonRows = [
      ["poison-accepted-missing-queue", "accepted", "message", null, 1, null, 10, null, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"],
      ["poison-pending-acceptance", "pending", "message", "queue", 0, null, null, null, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"],
      ["poison-dead-no-time", "dead_letter", null, null, 4, null, 10, "exhausted", null, "2026-01-01T00:00:00.000Z", null],
      ["poison-created-at", "pending", null, null, 0, null, null, null, null, "not-a-time", null],
      ["poison-accepted-at", "accepted", "message", "queue", 1, null, 10, null, null, "2026-01-01T00:00:00.000Z", "not-a-time"],
      ["poison-retry-order", "pending", null, null, 1, 5, 10, "retry", null, "2026-01-01T00:00:00.000Z", null],
      ["poison-attempt-timestamps", "pending", null, null, 0, 10, 5, null, null, "2026-01-01T00:00:00.000Z", null],
      ["poison-dead-order", "dead_letter", null, null, 4, null, 10, "exhausted", 5, "2026-01-01T00:00:00.000Z", null],
    ] as const;
    for (const [id, status, messageId, queueItemId, attemptCount, nextAttemptAt, lastAttemptAt, lastError, deadLetteredAt, createdAt, acceptedAt] of poisonRows) {
      insert.run(id, "parent", `child-${id}`, `attempt-${id}`, "failed", 1, "parent-completion", payload,
        status, messageId, queueItemId, attemptCount, nextAttemptAt, lastAttemptAt, lastError, deadLetteredAt, createdAt, acceptedAt);
    }

    const validBefore = database.prepare("SELECT * FROM callback_deliveries WHERE id LIKE 'valid-%' ORDER BY id").all();
    registry.migrateCallbackDeliveriesSchema(database);

    const validAfter = database.prepare(`
      SELECT id, target_session_id AS parent_session_id, source_id AS child_session_id,
        source_attempt AS attempt_token, source_outcome AS terminal_outcome,
        source_version AS terminal_version, delivery_kind AS callback_kind,
        payload, status, message_id, queue_item_id, attempt_count, next_attempt_at,
        last_attempt_at, last_error, dead_lettered_at, created_at, accepted_at
      FROM callback_deliveries WHERE id LIKE 'valid-%' ORDER BY id
    `).all();
    expect(validAfter).toEqual(validBefore);

    const quarantined = database.prepare(`
      SELECT id, status, delivery_kind AS deliveryKind, last_error AS lastError,
        dead_lettered_at AS deadLetteredAt
      FROM callback_deliveries WHERE id LIKE 'poison-%' ORDER BY id
    `).all() as Array<{ id: string; status: string; deliveryKind: string; lastError: string | null; deadLetteredAt: number | null }>;
    expect(quarantined).toHaveLength(poisonRows.length);
    expect(quarantined).toEqual(expect.arrayContaining(poisonRows.map(([id]) => expect.objectContaining({
      id,
      status: "dead_letter",
      deliveryKind: "quarantined",
      lastError: expect.stringContaining("migration quarantine:"),
      deadLetteredAt: expect.any(Number),
    }))));
    for (const row of quarantined) {
      expect(() => registry.requeueDeadLetterSessionDelivery(row.id)).toThrow(/not found|quarantined|invalid/i);
    }
  });

  it("rolls back the child-specific schema and every original row on a forced mid-copy failure", () => {
    const database = new Database(":memory:");
    database.function("jinn_callback_identity", { deterministic: true }, (value: unknown) => value);
    installExactChildDeliverySchema(database);
    database.exec(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES
        ('row-1', 'parent', 'child-1', 'attempt-1', 'succeeded', 1, 'parent-completion',
          '{"message":"one","displayMessage":"one"}', 'pending', '2026-01-01T00:00:00.000Z'),
        ('row-2', 'parent', 'child-2', 'attempt-2', 'succeeded', 1, 'parent-completion',
          '{"message":"two","displayMessage":"two"}', 'pending', '2026-01-01T00:00:01.000Z');
    `);
    const beforeSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'").get();
    const beforeRows = database.prepare("SELECT * FROM callback_deliveries ORDER BY id").all();
    const originalPrepare = database.prepare.bind(database);
    let copied = 0;
    const prepareSpy = vi.spyOn(database, "prepare").mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("INSERT INTO callback_deliveries_v2")) return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== "run") return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            copied++;
            if (copied === 2) throw new Error("forced mid-copy failure");
            return target.run(...args);
          };
        },
      });
    }) as Database.Database["prepare"]);

    expect(() => registry.migrateCallbackDeliveriesSchema(database)).toThrow("forced mid-copy failure");
    prepareSpy.mockRestore();
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'").get()).toEqual(beforeSql);
    expect(database.prepare("SELECT * FROM callback_deliveries ORDER BY id").all()).toEqual(beforeRows);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries_v2'").get()).toBeUndefined();
  });

  it("reopens the current child-session schema as one generic session delivery without rewriting its receipt", () => {
    const database = registry.initDb();
    database.exec(`
      DROP TABLE callback_deliveries;
      CREATE TABLE callback_deliveries (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL CHECK (length(parent_session_id) > 0 AND parent_session_id = jinn_callback_identity(parent_session_id)),
        child_session_id TEXT NOT NULL CHECK (length(child_session_id) > 0 AND child_session_id = jinn_callback_identity(child_session_id)),
        attempt_token TEXT NOT NULL CHECK (length(attempt_token) > 0 AND attempt_token = jinn_callback_identity(attempt_token)),
        terminal_outcome TEXT NOT NULL CHECK (length(terminal_outcome) > 0 AND terminal_outcome = jinn_callback_identity(terminal_outcome)),
        terminal_version INTEGER NOT NULL CHECK (terminal_version >= 1),
        callback_kind TEXT NOT NULL CHECK (length(callback_kind) > 0 AND callback_kind = jinn_callback_identity(callback_kind)),
        payload TEXT NOT NULL CHECK (
          json_valid(payload)
          AND json_type(payload) = 'object'
          AND json_type(payload, '$.message') IS 'text'
          AND json_type(payload, '$.displayMessage') IS 'text'
        ),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dead_letter')),
        message_id TEXT,
        queue_item_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER,
        last_attempt_at INTEGER,
        last_error TEXT,
        dead_lettered_at INTEGER,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      );
      CREATE UNIQUE INDEX uq_callback_delivery_identity
        ON callback_deliveries (
          parent_session_id,
          child_session_id,
          attempt_token,
          terminal_outcome,
          terminal_version,
          callback_kind
        );
      CREATE INDEX idx_callback_deliveries_pending
        ON callback_deliveries (status, next_attempt_at, created_at)
        WHERE status = 'pending';
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, attempt_count, created_at
      ) VALUES (
        'delivery-old', 'parent-a', 'child-a', 'attempt-a', 'succeeded', 1,
        'parent-completion', '{"message":"existing payload","displayMessage":"Existing payload"}',
        'pending', 0, '2026-07-12T00:00:00.000Z'
      );
    `);

    registry.__closeDbForTest();
    registry.initDb();

    expect(registry.getSessionDelivery("delivery-old")).toMatchObject({
      targetSessionId: "parent-a",
      sourceKind: "session",
      sourceId: "child-a",
      sourceAttempt: "attempt-a",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      status: "pending",
      payload: { message: "existing payload", displayMessage: "Existing payload" },
    });
    expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
  });

  it("is idempotent and installs the durable composite uniqueness contract", () => {
    const database = new Database(":memory:");

    registry.migrateCallbackDeliveriesSchema(database);
    registry.migrateCallbackDeliveriesSchema(database);

    const columns = database.prepare("PRAGMA table_info(callback_deliveries)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "target_session_id",
      "source_kind",
      "source_id",
      "source_attempt",
      "source_outcome",
      "source_version",
      "delivery_kind",
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
      "target_session_id",
      "source_kind",
      "source_id",
      "source_attempt",
      "source_outcome",
      "source_version",
      "delivery_kind",
    ]);
    const tableSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string }).sql;
    expect(tableSql).toMatch(/source_version\s+INTEGER\s+NOT NULL\s+CHECK\s*\(source_version\s*>=\s*1\)/i);
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
      SELECT target_session_id AS targetSessionId, source_kind AS sourceKind,
        source_id AS sourceId, source_attempt AS sourceAttempt,
        source_outcome AS sourceOutcome, delivery_kind AS deliveryKind, status
      FROM callback_deliveries WHERE id = 'valid'
    `).get()).toEqual({
      targetSessionId: "parent",
      sourceKind: "session",
      sourceId: "child",
      sourceAttempt: "attempt",
      sourceOutcome: "succeeded",
      deliveryKind: "parent-completion",
      status: "pending",
    });
    expect(database.prepare(`
      SELECT status, last_error AS lastError, dead_lettered_at AS deadLetteredAt
      FROM callback_deliveries WHERE id = 'poison'
    `).get()).toMatchObject({
      status: "dead_letter",
      lastError: expect.stringMatching(/invalid payload json/i),
      deadLetteredAt: expect.any(Number),
    });
  });

  it("canonicalizes every Unicode White_Space edge during migration and after reopen", () => {
    const dbPath = path.join(home, `unicode-migration-${Date.now()}.db`);
    let database = new Database(dbPath);
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
      )
    `);
    const insert = database.prepare(`
      INSERT INTO callback_deliveries VALUES (?, ?, ?, ?, 'succeeded', 1,
        'parent-completion', '{"message":"ok","displayMessage":"ok"}',
        'pending', NULL, NULL, ?, NULL)
    `);
    for (const codePoint of UNICODE_WHITE_SPACE) {
      const edge = String.fromCodePoint(codePoint);
      const hex = codePoint.toString(16);
      insert.run(`ws-${hex}`, `${edge}parent-${hex}${edge}`, `child-${hex}`, `attempt-${hex}`, new Date().toISOString());
    }

    registry.migrateCallbackDeliveriesSchema(database);
    database.close();
    database = new Database(dbPath);
    registry.migrateCallbackDeliveriesSchema(database);

    const rows = database.prepare(`
      SELECT id, target_session_id AS targetSessionId FROM callback_deliveries ORDER BY id
    `).all() as Array<{ id: string; targetSessionId: string }>;
    expect(rows).toHaveLength(UNICODE_WHITE_SPACE.length);
    for (const row of rows) {
      expect(row.targetSessionId).toBe(`parent-${row.id.slice(3)}`);
      expect(row.targetSessionId).not.toMatch(/^\p{White_Space}|\p{White_Space}$/u);
    }
    database.close();
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
      Array.from({ length: 6 }, async () => registry.claimSessionDelivery(callbackInput())),
    );
    const retry = registry.claimSessionDelivery(callbackInput());

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(new Set([...claims, retry].map((claim) => claim.delivery.id))).toHaveLength(1);
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it.each([
    ["target session", { targetSessionId: "parent-2" }],
    ["source session", { sourceId: "child-2" }],
    ["source attempt", { sourceAttempt: "attempt-2" }],
    ["source outcome", { sourceOutcome: "failed" }],
    ["source version", { sourceVersion: 2 }],
    ["delivery kind", { deliveryKind: "talk-attachment" }],
  ])("keeps a distinct %s deliverable exactly once", (_label, overrides) => {
    const first = registry.claimSessionDelivery(callbackInput());
    const distinct = registry.claimSessionDelivery(callbackInput(overrides));
    const duplicate = registry.claimSessionDelivery(callbackInput(overrides));

    expect(first.claimed).toBe(true);
    expect(distinct.claimed).toBe(true);
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.delivery.id).toBe(distinct.delivery.id);
    expect(registry.listPendingSessionDeliveries()).toHaveLength(2);
  });

  it("keeps a failed send pending and retryable under the original durable id", () => {
    const claimed = registry.claimSessionDelivery(callbackInput());

    const retry = registry.claimSessionDelivery(callbackInput());

    expect(claimed.claimed).toBe(true);
    expect(retry.claimed).toBe(false);
    expect(retry.delivery).toMatchObject({ id: claimed.delivery.id, status: "pending" });
    expect(registry.getSessionDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
  });

  it("canonicalizes whitespace and Unicode before insert and conflict lookup", () => {
    const decomposed = "cafe\u0301";
    const composed = "caf\u00e9";
    const first = registry.claimSessionDelivery(callbackInput({
      targetSessionId: " parent-1 ",
      sourceId: ` ${decomposed} `,
      sourceAttempt: " attempt-1 ",
      sourceOutcome: " succeeded ",
      deliveryKind: " parent-completion ",
    }));
    const duplicate = registry.claimSessionDelivery(callbackInput({
      targetSessionId: "parent-1",
      sourceId: composed,
      sourceAttempt: "attempt-1",
      sourceOutcome: "succeeded",
      deliveryKind: "parent-completion",
    }));

    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({ claimed: false, delivery: { id: first.delivery.id } });
    expect(first.delivery).toMatchObject({
      targetSessionId: "parent-1",
      sourceId: composed,
      sourceAttempt: "attempt-1",
      sourceOutcome: "succeeded",
      deliveryKind: "parent-completion",
    });
  });

  it("uses the complete Unicode White_Space set for claims and SQLite constraints", () => {
    const database = registry.initDb();
    for (const codePoint of UNICODE_WHITE_SPACE) {
      const edge = String.fromCodePoint(codePoint);
      const hex = codePoint.toString(16);
      const padded = registry.claimSessionDelivery(callbackInput({
        targetSessionId: `${edge}parent-${hex}${edge}`,
        sourceId: `child-${hex}`,
        sourceAttempt: `attempt-${hex}`,
      }));
      const canonical = registry.claimSessionDelivery(callbackInput({
        targetSessionId: `parent-${hex}`,
        sourceId: `child-${hex}`,
        sourceAttempt: `attempt-${hex}`,
      }));

      expect(canonical).toMatchObject({ claimed: false, delivery: { id: padded.delivery.id } });
      expect(padded.delivery.targetSessionId).toBe(`parent-${hex}`);
      expect(() => registry.claimSessionDelivery(callbackInput({
        targetSessionId: edge,
        sourceId: `blank-child-${hex}`,
        sourceAttempt: `blank-attempt-${hex}`,
      }))).toThrow(/targetSessionId is required/i);
      expect(() => database.prepare(`
        INSERT INTO callback_deliveries (
          id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
          source_version, delivery_kind, payload, status, created_at
        ) VALUES (?, ?, 'session', ?, ?, 'succeeded', 1, 'parent-completion', ?, 'pending', ?)
      `).run(
        `direct-${hex}`,
        `${edge}direct-parent-${hex}${edge}`,
        `direct-child-${hex}`,
        `direct-attempt-${hex}`,
        JSON.stringify({ message: "ok", displayMessage: "ok" }),
        new Date().toISOString(),
      )).toThrow();
    }

    const sensitive = registry.claimSessionDelivery(callbackInput({
      targetSessionId: "Case-Sensitive",
      sourceId: "case-child",
      sourceAttempt: "case-attempt",
    }));
    const distinctCase = registry.claimSessionDelivery(callbackInput({
      targetSessionId: "case-sensitive",
      sourceId: "case-child",
      sourceAttempt: "case-attempt",
    }));
    expect(sensitive.delivery.id).not.toBe(distinctCase.delivery.id);
  });

  it.each([
    ["blank target", "target_session_id", "   ", 1],
    ["tab-padded target", "target_session_id", "\tparent-sql\t", 1],
    ["NBSP-only target", "target_session_id", "\u00a0", 1],
    ["decomposed Unicode source", "source_id", "cafe\u0301", 1],
    ["padded source attempt", "source_attempt", " token ", 1],
    ["zero source version", "source_version", "attempt-2", 0],
  ])("rejects direct SQL identities that violate canonical constraints: %s", (_label, column, value, version) => {
    const database = registry.initDb();
    const row = callbackInput({
      targetSessionId: column === "target_session_id" ? value : "parent-sql",
      sourceId: column === "source_id" ? value : "child-sql",
      sourceAttempt: column === "source_attempt" ? value : "attempt-sql",
      sourceVersion: version,
    });
    expect(() => database.prepare(`
      INSERT INTO callback_deliveries (
        id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
        source_version, delivery_kind, payload, status, created_at
      ) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      `sql-${column}`,
      row.targetSessionId,
      row.sourceId,
      row.sourceAttempt,
      row.sourceOutcome,
      row.sourceVersion,
      row.deliveryKind,
      JSON.stringify(row.payload),
      new Date().toISOString(),
    )).toThrow();
  });
});

describe("callback delivery retry lifecycle", () => {
  it("leases one due attempt, persists backoff, and dead-letters at bounded exhaustion", () => {
    const delivery = registry.claimSessionDelivery(callbackInput()).delivery;

    expect(registry.claimSessionDeliveryAttempt(delivery.id, 1_000, 500)).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: 1_000,
      nextAttemptAt: 1_500,
    });
    expect(registry.claimSessionDeliveryAttempt(delivery.id, 1_000, 500)).toBeUndefined();
    expect(registry.recordSessionDeliveryFailure(delivery.id, "timeout one", {
      now: 1_000,
      nextAttemptAt: 2_000,
      maxAttempts: 3,
    })).toMatchObject({ status: "pending", attemptCount: 1, nextAttemptAt: 2_000, lastError: "timeout one" });

    expect(registry.claimSessionDeliveryAttempt(delivery.id, 2_000, 500)).toMatchObject({ attemptCount: 2 });
    registry.recordSessionDeliveryFailure(delivery.id, "timeout two", {
      now: 2_000,
      nextAttemptAt: 4_000,
      maxAttempts: 3,
    });
    expect(registry.claimSessionDeliveryAttempt(delivery.id, 4_000, 500)).toMatchObject({ attemptCount: 3 });
    expect(registry.recordSessionDeliveryFailure(delivery.id, "timeout three", {
      now: 4_000,
      nextAttemptAt: 8_000,
      maxAttempts: 3,
    })).toMatchObject({
      status: "dead_letter",
      attemptCount: 3,
      lastError: "timeout three",
      deadLetteredAt: 4_000,
    });
    expect(registry.claimSessionDeliveryAttempt(delivery.id, 8_000, 500)).toBeUndefined();
  });

  it("never resets or releases an accepted receipt after a late failure", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimSessionDelivery(callbackInput()).delivery;
    registry.claimSessionDeliveryAttempt(delivery.id, 1_000, 500);
    registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey);

    const afterFailure = registry.recordSessionDeliveryFailure(delivery.id, "response lost", {
      now: 1_100,
      nextAttemptAt: 2_000,
      maxAttempts: 3,
    });

    expect(afterFailure).toMatchObject({ status: "accepted", attemptCount: 1 });
    expect(registry.claimSessionDeliveryAttempt(delivery.id, 2_000, 500)).toBeUndefined();
  });

  it("lists an exhausted receipt and atomically requeues the same durable id after recovery", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimSessionDelivery(callbackInput()).delivery;

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(registry.claimSessionDeliveryAttempt(delivery.id, attempt * 1_000, 100))
        .toMatchObject({ id: delivery.id, attemptCount: attempt });
      registry.recordSessionDeliveryFailure(delivery.id, `outage ${attempt}`, {
        now: attempt * 1_000,
        nextAttemptAt: (attempt + 1) * 1_000,
        maxAttempts: 4,
      });
    }

    expect(registry.listDeadLetterSessionDeliveries()).toEqual([
      expect.objectContaining({
        id: delivery.id,
        status: "dead_letter",
        attemptCount: 4,
        lastError: "outage 4",
      }),
    ]);

    const requeued = registry.requeueDeadLetterSessionDelivery(delivery.id);
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
    expect(registry.claimSessionDeliveryAttempt(delivery.id, 5_000, 100))
      .toMatchObject({ id: delivery.id, attemptCount: 1 });
    const accepted = registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey);
    expect(accepted).toMatchObject({ accepted: true, delivery: { id: delivery.id, status: "accepted" } });
    expect(registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey))
      .toMatchObject({ accepted: false, delivery: { id: delivery.id, status: "accepted" } });
  });

  it("never permits an accepted callback receipt to be requeued", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const delivery = registry.claimSessionDelivery(callbackInput()).delivery;
    const accepted = registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey).delivery;

    expect(() => registry.requeueDeadLetterSessionDelivery(delivery.id)).toThrow(/dead.?letter/i);
    expect(registry.getSessionDelivery(delivery.id)).toMatchObject({
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
        id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
        source_version, delivery_kind, payload, status, created_at
      ) VALUES ('poison', 'parent-poison', 'session', 'child-poison', 'attempt-poison', 'failed',
        1, 'parent-completion', '{bad json', 'pending', '2026-01-01T00:00:00.000Z')
    `).run();
    database.pragma("ignore_check_constraints = OFF");
    const valid = registry.claimSessionDelivery(callbackInput({
      targetSessionId: "parent-valid",
      sourceId: "child-valid",
    })).delivery;

    expect(registry.listPendingSessionDeliveries()).toEqual([
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

  it("quarantines mixed identity and lifecycle poison per row and continues after reopen", () => {
    const database = registry.initDb();
    const baseValues = {
      payload: JSON.stringify({ message: "poison", displayMessage: "poison" }),
      createdAt: new Date().toISOString(),
    };
    const poisonRows = [
      { id: "poison-padded", parent: " parent-poison ", child: "child", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: 0, next: null, last: null },
      { id: "poison-nfd", parent: "parent", child: "cafe\u0301", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: 0, next: null, last: null },
      { id: "poison-empty", parent: "", child: "child", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: 0, next: null, last: null },
      { id: "poison-version", parent: "parent", child: "child", token: "attempt", outcome: "failed", version: 0, kind: "parent-completion", attempts: 0, next: null, last: null },
      { id: "poison-attempts", parent: "parent", child: "child", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: -1, next: null, last: null },
      { id: "poison-next", parent: "parent", child: "child", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: 1, next: -5, last: null },
      { id: "poison-last", parent: "parent", child: "child", token: "attempt", outcome: "failed", version: 1, kind: "parent-completion", attempts: 1, next: null, last: -5 },
    ];
    database.pragma("ignore_check_constraints = ON");
    const insert = database.prepare(`
      INSERT INTO callback_deliveries (
        id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
        source_version, delivery_kind, payload, status, attempt_count,
        next_attempt_at, last_attempt_at, created_at
      ) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);
    for (const row of poisonRows) {
      insert.run(
        row.id, row.parent, row.child, `${row.token}-${row.id}`, row.outcome, row.version, row.kind,
        baseValues.payload, row.attempts, row.next, row.last, baseValues.createdAt,
      );
    }
    database.pragma("ignore_check_constraints = OFF");
    const valid = registry.claimSessionDelivery(callbackInput({
      targetSessionId: "valid-after-poison",
      sourceId: "valid-child-after-poison",
      sourceAttempt: "valid-attempt-after-poison",
    })).delivery;

    expect(registry.listPendingSessionDeliveries()).toEqual([
      expect.objectContaining({ id: valid.id }),
    ]);
    expect(database.prepare(`
      SELECT id, status, last_error AS lastError FROM callback_deliveries
      WHERE id LIKE 'poison-%' ORDER BY id
    `).all()).toEqual(poisonRows.map((row) => row.id).sort().map((id) => ({
      id,
      status: "dead_letter",
      lastError: expect.stringMatching(/(?:callback|session) delivery/i),
    })));

    registry.__closeDbForTest();
    expect(registry.listPendingSessionDeliveries()).toEqual([
      expect.objectContaining({ id: valid.id }),
    ]);
    expect(registry.listDeadLetterSessionDeliveries().filter((row) => row.id.startsWith("poison-")))
      .toHaveLength(poisonRows.length);
  });
});

describe("callback delivery acceptance", () => {
  it("atomically accepts one queue item and one durable notification message", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimSessionDelivery(callbackInput());

    const accepted = registry.acceptSessionDelivery(claimed.delivery.id, parent.id, parent.sessionKey);
    const responseLossRetry = registry.acceptSessionDelivery(claimed.delivery.id, parent.id, parent.sessionKey);

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
    const claimed = registry.claimSessionDelivery(callbackInput());

    expect(() => registry.acceptSessionDelivery(claimed.delivery.id, otherParent.id, otherParent.sessionKey))
      .toThrow(/session delivery target mismatch/i);

    expect(registry.getSessionDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
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
    const claimed = registry.claimSessionDelivery(callbackInput({
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

    registry.acceptSessionDelivery(claimed.delivery.id, parent.id, parent.sessionKey);

    const delegation = registry.getMessages(parent.id)
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.id === "dg-work-1");
    expect(delegation).toMatchObject({ status: "done", payload: { repliedAt: 1_780_000_120_000 } });
  });

  it("rolls back queue, message, and receipt acceptance when callback block persistence fails", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimSessionDelivery(callbackInput({
      payload: {
        message: "engine callback payload",
        displayMessage: "Worker replied\nDone",
        block: {
          op: "put",
          block: { id: "unsupported", type: "unsupported", version: 1, payload: {} },
        },
      } as never,
    }));

    expect(() => registry.acceptSessionDelivery(claimed.delivery.id, parent.id, parent.sessionKey))
      .toThrow(/block type is invalid/i);

    expect(registry.getSessionDelivery(claimed.delivery.id)).toMatchObject({ status: "pending" });
    expect(registry.getMessages(parent.id)).toEqual([]);
    expect(registry.listAllPendingQueueItems()).toEqual([]);
  });

  it("retains pending session-delivery receipts when their target session is deleted", () => {
    const parent = createSession("parent-1");
    createSession("child-1", parent.id);
    const claimed = registry.claimSessionDelivery(callbackInput());

    expect(registry.deleteSession(parent.id)).toBe(true);

    expect(registry.getSessionDelivery(claimed.delivery.id)).toMatchObject({
      id: claimed.delivery.id,
      targetSessionId: parent.id,
      status: "pending",
    });
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
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
