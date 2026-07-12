import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ACTIVITY_LEGACY_SCHEMA_DDL, ACTIVITY_SCHEMA_DDL, ActivityMigrationError, migrateActivitySchema } from "../migrate.js";
import { appendActivityEvent } from "../store.js";
import type { ActivityEventInput } from "../types.js";

function fixture(): ActivityEventInput {
  return {
    occurredAt: "2026-07-11T12:00:00.000Z",
    kind: "system",
    action: "system.checked",
    actor: { type: "system", id: "gateway", displayName: "Gateway" },
    object: { type: "diagnostic", id: "opaque-reference", label: "Health" },
    outcome: { state: "info", label: "Checked" },
    summary: "Health checked",
    correlationId: "system:health:check-1",
    idempotencyKey: "system:health:check-1",
  };
}

function clonedInsert(database: Database.Database, changes: Record<string, unknown>): () => unknown {
  const row = database.prepare("SELECT * FROM activity_events LIMIT 1").get() as Record<string, unknown>;
  const clone: Record<string, unknown> = {
    ...row,
    seq: null,
    id: "act_00000000-0000-4000-8000-000000000099",
    idempotency_key: "system:test:clone-99",
    ...changes,
  };
  const columns = Object.keys(clone).filter((key) => key !== "seq");
  const statement = database.prepare(`INSERT INTO activity_events (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map((key) => `@${key}`).join(",")})`);
  return () => statement.run(Object.fromEntries(columns.map((key) => [key, clone[key]])));
}

function seedLegacy(database: Database.Database): void {
  database.exec(ACTIVITY_LEGACY_SCHEMA_DDL);
  database.prepare(`
    INSERT INTO activity_events (
      seq, id, story_id, occurred_at, kind, action, actor_type, actor_id, actor_display_name,
      object_type, object_id, object_label, outcome_state, outcome_label, summary, correlation_id,
      idempotency_key, detail_json, links_json
    ) VALUES (7, ?, ?, ?, 'system', 'system.checked', 'system', 'gateway', 'Gateway',
      'diagnostic', 'opaque/reference:with*symbols', 'Health', 'info', 'Checked', 'Health checked',
      'system:health:check-1', 'system:health:check-1', '{"safe":true}', '[]')
  `).run(
    "act_00000000-0000-4000-8000-000000000007",
    "story_000000000000000000000007",
    "2026-07-11T12:00:00.000Z",
  );
}

function seedGate1(database: Database.Database): void {
  database.exec(ACTIVITY_SCHEMA_DDL);
  const insert = database.prepare(`
    INSERT INTO activity_events (
      id, story_id, occurred_at, kind, action, actor_type, actor_id, actor_display_name,
      object_type, object_id, object_label, outcome_state, outcome_label, summary,
      correlation_id, idempotency_key, payload_hash
    ) VALUES (?, 'story_000000000000000000000000', '2026-07-11T12:00:00.000Z', ?,
      'event.completed', 'system', 'gateway', 'Gateway', 'run', ?, 'Run', 'succeeded',
      'Completed', 'Completed', 'source:local:collision', ?, ?)
  `);
  insert.run("act_00000000-0000-4000-8000-000000000001", "todo", "opaque-one", "todo:event:collision", "1".repeat(64));
  insert.run("act_00000000-0000-4000-8000-000000000002", "workflow", "opaque-two", "workflow:event:collision", "2".repeat(64));
}

function seedGate2(database: Database.Database): void {
  migrateActivitySchema(database);
  appendActivityEvent(fixture(), { database, idFactory: () => "00000000-0000-4000-8000-000000000003" });
  database.exec("DROP TABLE activity_event_search; DROP TABLE activity_story_versions; DROP TABLE activity_stories;");
}

describe("activity schema migration", () => {
  it("rolls back every created object when an injected migration step fails", () => {
    for (let failAfterStep = 1; failAfterStep <= 22; failAfterStep++) {
      const database = new Database(":memory:");
      expect(() => migrateActivitySchema(database, { failAfterStep })).toThrow(ActivityMigrationError);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'activity_%'").all()).toEqual([]);
    }
  });

  it("transactionally upgrades the Gate 1 ledger, rekeys source-local stories, and protects its durable cursor secret", () => {
    const database = new Database(":memory:");
    seedGate1(database);
    migrateActivitySchema(database);

    const stories = database.prepare("SELECT DISTINCT story_id FROM activity_events").all();
    expect(stories).toHaveLength(2);
    const secret = database.prepare("SELECT value FROM activity_ledger_meta WHERE key = 'cursor_hmac_v1'").get() as { value: string };
    expect(secret.value).toMatch(/^[a-f0-9]{64}$/);
    expect(() => database.prepare("INSERT OR REPLACE INTO activity_ledger_meta (key, value) VALUES ('cursor_hmac_v1', ?)").run("0".repeat(64))).toThrow(/immutable|already exists/i);
    expect(database.prepare("SELECT value FROM activity_ledger_meta WHERE key = 'cursor_hmac_v1'").get()).toEqual(secret);
  });

  it("rolls every Gate 1 upgrade DDL step back without exposing a partial cursor contract", () => {
    for (let failAfterStep = 1; failAfterStep <= 15; failAfterStep++) {
      const database = new Database(":memory:");
      seedGate1(database);
      expect(() => migrateActivitySchema(database, { failAfterStep })).toThrow(ActivityMigrationError);
      expect(database.prepare("SELECT COUNT(DISTINCT story_id) AS n FROM activity_events").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'activity_ledger_meta'").get()).toBeUndefined();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'activity_events_immutable_update'").get()).toBeDefined();
    }
  });

  it("transactionally upgrades the Gate 2 ledger and rebuilds story and search projections", () => {
    const database = new Database(":memory:");
    seedGate2(database);
    migrateActivitySchema(database);
    expect(database.prepare("SELECT story_id, event_count FROM activity_stories").get()).toMatchObject({ event_count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_story_versions").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_event_search WHERE activity_event_search MATCH 'health'").get()).toEqual({ n: 1 });
  });

  it("rolls every Gate 2 projection DDL step back to an intact authoritative ledger", () => {
    for (let failAfterStep = 1; failAfterStep <= 9; failAfterStep++) {
      const database = new Database(":memory:");
      seedGate2(database);
      expect(() => migrateActivitySchema(database, { failAfterStep })).toThrow(ActivityMigrationError);
      expect(database.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('activity_stories','activity_story_versions','activity_event_search')").all()).toEqual([]);
    }
  });

  it("rejects a same-name projection index with the wrong shape without repairing it", () => {
    const database = new Database(":memory:");
    migrateActivitySchema(database);
    database.exec("DROP INDEX idx_activity_stories_order; CREATE INDEX idx_activity_stories_order ON activity_stories (story_id)");
    expect(() => migrateActivitySchema(database)).toThrow(ActivityMigrationError);
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_activity_stories_order'").get() as { sql: string };
    expect(row.sql).toContain("story_id");
  });

  it("rejects a same-name trigger with the wrong body without repairing it", () => {
    const database = new Database(":memory:");
    migrateActivitySchema(database);
    database.exec(`
      DROP TRIGGER activity_events_immutable_update;
      CREATE TRIGGER activity_events_immutable_update
        BEFORE UPDATE ON activity_events BEGIN SELECT RAISE(ABORT, 'wrong contract'); END;
    `);
    expect(() => migrateActivitySchema(database)).toThrow(ActivityMigrationError);
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'activity_events_immutable_update'").get() as { sql: string };
    expect(row.sql).toContain("wrong contract");
  });

  it("migrates the committed legacy ledger transactionally and preserves sequence and opaque references", () => {
    const database = new Database(":memory:");
    seedLegacy(database);
    migrateActivitySchema(database);
    const row = database.prepare("SELECT seq, object_id, payload_hash FROM activity_events").get() as { seq: number; object_id: string; payload_hash: string };
    expect(row).toMatchObject({ seq: 7, object_id: "opaque/reference:with*symbols", payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => migrateActivitySchema(database)).not.toThrow();
  });

  it("rolls every legacy migration DDL step back to the intact legacy ledger", () => {
    for (let failAfterStep = 1; failAfterStep <= 30; failAfterStep++) {
      const database = new Database(":memory:");
      seedLegacy(database);
      expect(() => migrateActivitySchema(database, { failAfterStep })).toThrow(ActivityMigrationError);
      expect(database.prepare("SELECT seq, object_id FROM activity_events").get()).toEqual({ seq: 7, object_id: "opaque/reference:with*symbols" });
      expect((database.prepare("PRAGMA table_info(activity_events)").all() as Array<{ name: string }>).some((column) => column.name === "payload_hash")).toBe(false);
    }
  });

  it("rejects same-name wrong-shape objects without mutating them", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE activity_events (private_marker TEXT)");
    expect(() => migrateActivitySchema(database)).toThrow(ActivityMigrationError);
    expect(database.prepare("PRAGMA table_info(activity_events)").all()).toMatchObject([{ name: "private_marker" }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'activity_%'").all()).toEqual([
      expect.objectContaining({ name: "activity_events" }),
    ]);
  });

  it("enforces ledger IDs, canonical timestamps, JSON, and namespaced idempotency in SQLite while leaving object IDs opaque", () => {
    const database = new Database(":memory:");
    migrateActivitySchema(database);
    appendActivityEvent(fixture(), { database, idFactory: () => "00000000-0000-4000-8000-000000000001" });

    expect(clonedInsert(database, { id: "event-99" })).toThrow(/constraint|id/i);
    expect(clonedInsert(database, { story_id: "story-bad" })).toThrow(/constraint|story/i);
    expect(clonedInsert(database, { occurred_at: "2026-07-11 12:00:00" })).toThrow(/constraint|timestamp/i);
    expect(clonedInsert(database, { detail_json: "{not-json" })).toThrow(/constraint|json/i);
    expect(clonedInsert(database, { links_json: "{}" })).toThrow(/constraint|json|array/i);
    expect(clonedInsert(database, { idempotency_key: "retry" })).toThrow(/constraint|idempotency/i);
    expect(clonedInsert(database, { object_id: "opaque/reference:with*symbols" })).not.toThrow();
  });
});
