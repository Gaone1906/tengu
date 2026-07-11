import type Database from "better-sqlite3";
import { activityPayloadHashFromRow } from "./payload.js";

interface SchemaObject {
  type: "index" | "trigger";
  name: string;
  sql: string;
}

export interface ActivityMigrationOptions {
  /** Fault-injection seam used by migration rehearsal tooling. */
  failAfterStep?: number;
}

export class ActivityMigrationError extends Error {
  constructor(message = "activity schema migration failed") {
    super(message);
    this.name = "ActivityMigrationError";
  }
}

const CURRENT_TABLE_SQL = `
CREATE TABLE activity_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (
    length(id) = 40 AND substr(id, 1, 4) = 'act_' AND
    substr(id, 5) NOT GLOB '*[^0-9a-f-]*' AND
    substr(id, 13, 1) = '-' AND substr(id, 18, 1) = '-' AND
    substr(id, 23, 1) = '-' AND substr(id, 28, 1) = '-'
  ),
  story_id TEXT NOT NULL CHECK (
    length(story_id) = 30 AND substr(story_id, 1, 6) = 'story_' AND
    substr(story_id, 7) NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) = 24 AND
    occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at
  ),
  kind TEXT NOT NULL CHECK (kind IN ('session','delegation','todo','workflow','approval','cron','system')),
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator','employee','system')),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_label TEXT NOT NULL,
  object_href TEXT,
  outcome_state TEXT NOT NULL CHECK (outcome_state IN ('running','succeeded','failed','attention','cancelled','info')),
  outcome_label TEXT NOT NULL,
  summary TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  root_event_id TEXT,
  attempt INTEGER CHECK (attempt IS NULL OR attempt >= 1),
  idempotency_key TEXT UNIQUE CHECK (
    idempotency_key IS NULL OR (
      idempotency_key GLOB '?*:?*:?*' AND
      instr(idempotency_key, ' ') = 0 AND instr(idempotency_key, char(9)) = 0 AND
      instr(idempotency_key, char(10)) = 0 AND instr(idempotency_key, char(13)) = 0
    )
  ),
  detail_ref TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  links_json TEXT CHECK (links_json IS NULL OR (json_valid(links_json) AND json_type(links_json) = 'array')),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  )
)`;

const LEGACY_TABLE_SQL = `
CREATE TABLE activity_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  story_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session','delegation','todo','workflow','approval','cron','system')),
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator','employee','system')),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_label TEXT NOT NULL,
  object_href TEXT,
  outcome_state TEXT NOT NULL CHECK (outcome_state IN ('running','succeeded','failed','attention','cancelled','info')),
  outcome_label TEXT NOT NULL,
  summary TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  root_event_id TEXT,
  attempt INTEGER CHECK (attempt IS NULL OR attempt >= 1),
  idempotency_key TEXT UNIQUE,
  detail_ref TEXT,
  detail_json TEXT,
  links_json TEXT
)`;

const COMMON_INDEXES: SchemaObject[] = [
  { type: "index", name: "idx_activity_order", sql: "CREATE INDEX idx_activity_order ON activity_events (occurred_at DESC, id DESC)" },
  { type: "index", name: "idx_activity_story_order", sql: "CREATE INDEX idx_activity_story_order ON activity_events (story_id, occurred_at DESC, id DESC)" },
  { type: "index", name: "idx_activity_kind_order", sql: "CREATE INDEX idx_activity_kind_order ON activity_events (kind, occurred_at DESC, id DESC)" },
  { type: "index", name: "idx_activity_outcome_order", sql: "CREATE INDEX idx_activity_outcome_order ON activity_events (outcome_state, occurred_at DESC, id DESC)" },
];

const LEGACY_TRIGGERS: SchemaObject[] = [
  { type: "trigger", name: "activity_events_immutable_update", sql: "CREATE TRIGGER activity_events_immutable_update BEFORE UPDATE ON activity_events BEGIN SELECT RAISE(ABORT, 'activity events are immutable'); END" },
  { type: "trigger", name: "activity_events_immutable_delete", sql: "CREATE TRIGGER activity_events_immutable_delete BEFORE DELETE ON activity_events BEGIN SELECT RAISE(ABORT, 'activity events are immutable'); END" },
];

const CURRENT_TRIGGERS: SchemaObject[] = [
  ...LEGACY_TRIGGERS,
  {
    type: "trigger",
    name: "activity_events_immutable_insert_id",
    sql: `CREATE TRIGGER activity_events_immutable_insert_id
      BEFORE INSERT ON activity_events
      WHEN EXISTS (SELECT 1 FROM activity_events WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'activity event id already exists'); END`,
  },
  {
    type: "trigger",
    name: "activity_events_immutable_insert_idempotency",
    sql: `CREATE TRIGGER activity_events_immutable_insert_idempotency
      BEFORE INSERT ON activity_events
      WHEN NEW.idempotency_key IS NOT NULL AND EXISTS (
        SELECT 1 FROM activity_events WHERE idempotency_key = NEW.idempotency_key
      )
      BEGIN SELECT RAISE(ABORT, 'activity event idempotency key already exists'); END`,
  },
];

const CURRENT_OBJECTS = [...COMMON_INDEXES, ...CURRENT_TRIGGERS];
const LEGACY_OBJECTS = [...COMMON_INDEXES, ...LEGACY_TRIGGERS];

export const ACTIVITY_SCHEMA_DDL = [CURRENT_TABLE_SQL, ...CURRENT_OBJECTS.map((object) => object.sql)].join(";\n") + ";";
export const ACTIVITY_LEGACY_SCHEMA_DDL = [LEGACY_TABLE_SQL, ...LEGACY_OBJECTS.map((object) => object.sql)].join(";\n") + ";";

function normalizedSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

function objectSql(database: Database.Database, type: string, name: string): string | undefined {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

function verifyObjects(database: Database.Database, objects: SchemaObject[]): void {
  for (const object of objects) {
    const actual = objectSql(database, object.type, object.name);
    if (!actual || normalizedSql(actual) !== normalizedSql(object.sql)) {
      throw new ActivityMigrationError(`activity schema object ${object.name} has an unexpected shape`);
    }
  }
  const actualNames = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE tbl_name = 'activity_events' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY name
  `).all() as Array<{ name: string }>;
  const expectedNames = objects.map((object) => object.name).sort();
  if (JSON.stringify(actualNames.map((row) => row.name)) !== JSON.stringify(expectedNames)) {
    throw new ActivityMigrationError("activity_events has unexpected schema objects");
  }
}

function verifyNoReservedObjects(database: Database.Database): void {
  const names = ["activity_events", ...CURRENT_OBJECTS.map((object) => object.name)];
  const placeholders = names.map(() => "?").join(",");
  const existing = database.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`).all(...names);
  if (existing.length > 0) throw new ActivityMigrationError("reserved activity schema objects already exist");
}

function insertLegacyRows(database: Database.Database, rows: Record<string, unknown>[]): void {
  const insert = database.prepare(`
    INSERT INTO activity_events (
      seq, id, story_id, occurred_at, kind, action,
      actor_type, actor_id, actor_display_name,
      object_type, object_id, object_label, object_href,
      outcome_state, outcome_label, summary, correlation_id,
      causation_id, root_event_id, attempt, idempotency_key,
      detail_ref, detail_json, links_json, payload_hash
    ) VALUES (
      @seq, @id, @story_id, @occurred_at, @kind, @action,
      @actor_type, @actor_id, @actor_display_name,
      @object_type, @object_id, @object_label, @object_href,
      @outcome_state, @outcome_label, @summary, @correlation_id,
      @causation_id, @root_event_id, @attempt, @idempotency_key,
      @detail_ref, @detail_json, @links_json, @payload_hash
    )
  `);
  for (const row of rows) insert.run({ ...row, payload_hash: activityPayloadHashFromRow(row) });
}

export function migrateActivitySchema(database: Database.Database, options: ActivityMigrationOptions = {}): void {
  let step = 0;
  const apply = (sql: string): void => {
    database.exec(sql);
    step += 1;
    if (options.failAfterStep === step) throw new ActivityMigrationError("injected activity migration failure");
  };

  try {
    const currentTable = objectSql(database, "table", "activity_events");
    if (currentTable && normalizedSql(currentTable) === normalizedSql(CURRENT_TABLE_SQL)) {
      verifyObjects(database, CURRENT_OBJECTS);
      database.pragma("recursive_triggers = ON");
      return;
    }
    const migration = database.transaction(() => {
      if (!currentTable) {
        verifyNoReservedObjects(database);
        apply(CURRENT_TABLE_SQL);
        for (const object of CURRENT_OBJECTS) apply(object.sql);
      } else if (normalizedSql(currentTable) === normalizedSql(LEGACY_TABLE_SQL)) {
        verifyObjects(database, LEGACY_OBJECTS);
        const rows = database.prepare("SELECT * FROM activity_events ORDER BY seq").all() as Record<string, unknown>[];
        for (const object of [...LEGACY_TRIGGERS, ...COMMON_INDEXES]) apply(`DROP ${object.type.toUpperCase()} ${object.name}`);
        apply("ALTER TABLE activity_events RENAME TO activity_events_legacy");
        apply(CURRENT_TABLE_SQL);
        for (const object of CURRENT_OBJECTS) apply(object.sql);
        insertLegacyRows(database, rows);
        apply("DROP TABLE activity_events_legacy");
      } else {
        throw new ActivityMigrationError("activity_events has an unexpected shape");
      }
      verifyObjects(database, CURRENT_OBJECTS);
      const migratedTable = objectSql(database, "table", "activity_events");
      if (!migratedTable || normalizedSql(migratedTable) !== normalizedSql(CURRENT_TABLE_SQL)) {
        throw new ActivityMigrationError("activity_events verification failed");
      }
    });
    migration();
    database.pragma("recursive_triggers = ON");
  } catch (error) {
    if (error instanceof ActivityMigrationError) throw error;
    throw new ActivityMigrationError();
  }
}
