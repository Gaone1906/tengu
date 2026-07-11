import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { activityStoryId } from "./identity.js";
import { activityPayloadHashFromRow } from "./payload.js";
import {
  ACTIVITY_PROJECTION_INDEXES,
  ACTIVITY_SEARCH_TABLE_SQL,
  ACTIVITY_STORIES_TABLE_SQL,
  ACTIVITY_STORY_VERSIONS_TABLE_SQL,
  rebuildActivityProjections,
} from "./projection.js";

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
  constructor(message = "activity schema migration failed", options?: ErrorOptions) {
    super(message, options);
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

const META_TABLE_SQL = `
CREATE TABLE activity_ledger_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID`;

const META_OBJECTS: SchemaObject[] = [
  {
    type: "trigger",
    name: "activity_ledger_meta_immutable_update",
    sql: "CREATE TRIGGER activity_ledger_meta_immutable_update BEFORE UPDATE ON activity_ledger_meta BEGIN SELECT RAISE(ABORT, 'activity ledger metadata is immutable'); END",
  },
  {
    type: "trigger",
    name: "activity_ledger_meta_immutable_delete",
    sql: "CREATE TRIGGER activity_ledger_meta_immutable_delete BEFORE DELETE ON activity_ledger_meta BEGIN SELECT RAISE(ABORT, 'activity ledger metadata is immutable'); END",
  },
  {
    type: "trigger",
    name: "activity_ledger_meta_immutable_insert",
    sql: `CREATE TRIGGER activity_ledger_meta_immutable_insert
      BEFORE INSERT ON activity_ledger_meta
      WHEN EXISTS (SELECT 1 FROM activity_ledger_meta WHERE key = NEW.key)
      BEGIN SELECT RAISE(ABORT, 'activity ledger metadata key already exists'); END`,
  },
];

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

function verifyObjects(database: Database.Database, tableName: string, objects: SchemaObject[]): void {
  for (const object of objects) {
    const actual = objectSql(database, object.type, object.name);
    if (!actual || normalizedSql(actual) !== normalizedSql(object.sql)) {
      throw new ActivityMigrationError(`activity schema object ${object.name} has an unexpected shape`);
    }
  }
  const actualNames = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY name
  `).all(tableName) as Array<{ name: string }>;
  const expectedNames = objects.map((object) => object.name).sort();
  if (JSON.stringify(actualNames.map((row) => row.name)) !== JSON.stringify(expectedNames)) {
    throw new ActivityMigrationError(`${tableName} has unexpected schema objects`);
  }
}

function verifyMeta(database: Database.Database): void {
  const table = objectSql(database, "table", "activity_ledger_meta");
  if (!table || normalizedSql(table) !== normalizedSql(META_TABLE_SQL)) {
    throw new ActivityMigrationError("activity_ledger_meta has an unexpected shape");
  }
  verifyObjects(database, "activity_ledger_meta", META_OBJECTS);
  const rows = database.prepare("SELECT key, value FROM activity_ledger_meta").all() as Array<{ key: string; value: string }>;
  if (rows.length !== 1 || rows[0]?.key !== "cursor_hmac_v1" || !/^[a-f0-9]{64}$/.test(rows[0].value)) {
    throw new ActivityMigrationError("activity ledger metadata is invalid");
  }
}

function verifyProjection(database: Database.Database): void {
  const tables = [
    ["activity_stories", ACTIVITY_STORIES_TABLE_SQL],
    ["activity_story_versions", ACTIVITY_STORY_VERSIONS_TABLE_SQL],
    ["activity_event_search", ACTIVITY_SEARCH_TABLE_SQL],
  ] as const;
  for (const [name, expected] of tables) {
    const actual = objectSql(database, "table", name);
    if (!actual || normalizedSql(actual) !== normalizedSql(expected)) {
      throw new ActivityMigrationError(`activity projection ${name} has an unexpected shape`);
    }
  }
  verifyObjects(database, "activity_stories", ACTIVITY_PROJECTION_INDEXES.filter((object) => object.name.startsWith("idx_activity_stories_")));
  verifyObjects(database, "activity_story_versions", ACTIVITY_PROJECTION_INDEXES.filter((object) => object.name.startsWith("idx_activity_story_versions_")));
}

function verifyNoReservedObjects(database: Database.Database): void {
  const names = [
    "activity_events",
    "activity_ledger_meta",
    "activity_stories",
    "activity_story_versions",
    "activity_event_search",
    ...CURRENT_OBJECTS.map((object) => object.name),
    ...META_OBJECTS.map((object) => object.name),
    ...ACTIVITY_PROJECTION_INDEXES.map((object) => object.name),
  ];
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
  for (const row of rows) {
    insert.run({
      ...row,
      story_id: activityStoryId(
        String(row.kind) as Parameters<typeof activityStoryId>[0],
        String(row.correlation_id),
        row.root_event_id === null ? undefined : String(row.root_event_id),
      ),
      payload_hash: activityPayloadHashFromRow(row),
    });
  }
}

function createMeta(database: Database.Database, apply: (sql: string) => void): void {
  apply(META_TABLE_SQL);
  database.prepare("INSERT INTO activity_ledger_meta (key, value) VALUES ('cursor_hmac_v1', ?)").run(randomBytes(32).toString("hex"));
  for (const object of META_OBJECTS) apply(object.sql);
}

function createProjection(database: Database.Database, apply: (sql: string) => void): void {
  apply(ACTIVITY_STORIES_TABLE_SQL);
  apply(ACTIVITY_STORY_VERSIONS_TABLE_SQL);
  apply(ACTIVITY_SEARCH_TABLE_SQL);
  for (const object of ACTIVITY_PROJECTION_INDEXES) apply(object.sql);
  rebuildActivityProjections(database);
}

function rekeyCurrentStories(database: Database.Database, apply: (sql: string) => void): void {
  const updateTrigger = CURRENT_TRIGGERS.find((object) => object.name === "activity_events_immutable_update")!;
  apply(`DROP TRIGGER ${updateTrigger.name}`);
  const rows = database.prepare("SELECT seq, kind, correlation_id, root_event_id FROM activity_events").all() as Array<{
    seq: number;
    kind: Parameters<typeof activityStoryId>[0];
    correlation_id: string;
    root_event_id: string | null;
  }>;
  const update = database.prepare("UPDATE activity_events SET story_id = ? WHERE seq = ?");
  for (const row of rows) update.run(activityStoryId(row.kind, row.correlation_id, row.root_event_id ?? undefined), row.seq);
  apply(updateTrigger.sql);
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
    const metaTable = objectSql(database, "table", "activity_ledger_meta");
    const projectionTables = ["activity_stories", "activity_story_versions", "activity_event_search"]
      .map((name) => objectSql(database, "table", name));
    const hasCompleteProjection = projectionTables.every(Boolean);
    const hasPartialProjection = projectionTables.some(Boolean) && !hasCompleteProjection;
    if (hasPartialProjection) throw new ActivityMigrationError("activity projection is only partially installed");
    if (currentTable && normalizedSql(currentTable) === normalizedSql(CURRENT_TABLE_SQL) && metaTable && hasCompleteProjection) {
      verifyObjects(database, "activity_events", CURRENT_OBJECTS);
      verifyMeta(database);
      verifyProjection(database);
      database.pragma("recursive_triggers = ON");
      return;
    }
    const migration = database.transaction(() => {
      if (!currentTable) {
        verifyNoReservedObjects(database);
        apply(CURRENT_TABLE_SQL);
        for (const object of CURRENT_OBJECTS) apply(object.sql);
      } else if (normalizedSql(currentTable) === normalizedSql(LEGACY_TABLE_SQL)) {
        if (metaTable) throw new ActivityMigrationError("legacy activity ledger has unexpected metadata");
        verifyObjects(database, "activity_events", LEGACY_OBJECTS);
        const rows = database.prepare("SELECT * FROM activity_events ORDER BY seq").all() as Record<string, unknown>[];
        for (const object of [...LEGACY_TRIGGERS, ...COMMON_INDEXES]) apply(`DROP ${object.type.toUpperCase()} ${object.name}`);
        apply("ALTER TABLE activity_events RENAME TO activity_events_legacy");
        apply(CURRENT_TABLE_SQL);
        for (const object of CURRENT_OBJECTS) apply(object.sql);
        insertLegacyRows(database, rows);
        apply("DROP TABLE activity_events_legacy");
      } else if (normalizedSql(currentTable) === normalizedSql(CURRENT_TABLE_SQL) && metaTable) {
        verifyObjects(database, "activity_events", CURRENT_OBJECTS);
        verifyMeta(database);
      } else if (normalizedSql(currentTable) === normalizedSql(CURRENT_TABLE_SQL)) {
        verifyObjects(database, "activity_events", CURRENT_OBJECTS);
        rekeyCurrentStories(database, apply);
      } else {
        throw new ActivityMigrationError("activity_events has an unexpected shape");
      }
      if (!metaTable) createMeta(database, apply);
      createProjection(database, apply);
      verifyObjects(database, "activity_events", CURRENT_OBJECTS);
      verifyMeta(database);
      verifyProjection(database);
      const migratedTable = objectSql(database, "table", "activity_events");
      if (!migratedTable || normalizedSql(migratedTable) !== normalizedSql(CURRENT_TABLE_SQL)) {
        throw new ActivityMigrationError("activity_events verification failed");
      }
    });
    migration();
    database.pragma("recursive_triggers = ON");
  } catch (error) {
    if (error instanceof ActivityMigrationError) throw error;
    throw new ActivityMigrationError("activity schema migration failed", { cause: error });
  }
}
