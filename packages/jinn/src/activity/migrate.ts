import type Database from "better-sqlite3";

export const ACTIVITY_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS activity_events (
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
);
CREATE INDEX IF NOT EXISTS idx_activity_order ON activity_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_story_order ON activity_events (story_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind_order ON activity_events (kind, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_outcome_order ON activity_events (outcome_state, occurred_at DESC, id DESC);
CREATE TRIGGER IF NOT EXISTS activity_events_immutable_update
  BEFORE UPDATE ON activity_events BEGIN SELECT RAISE(ABORT, 'activity events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS activity_events_immutable_delete
  BEFORE DELETE ON activity_events BEGIN SELECT RAISE(ABORT, 'activity events are immutable'); END;
`;

export function migrateActivitySchema(database: Database.Database): void {
  database.exec(ACTIVITY_SCHEMA_DDL);
}
