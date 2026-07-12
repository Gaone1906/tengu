import type Database from "better-sqlite3";
import type { ActivityRow } from "./store.js";

export interface ActivityProjectionSchemaObject {
  type: "index";
  name: string;
  sql: string;
}

const STORY_ID_CHECK = "length(story_id) = 30 AND substr(story_id, 1, 6) = 'story_' AND substr(story_id, 7) NOT GLOB '*[^0-9a-f]*'";
const EVENT_ID_CHECK = "length(latest_event_id) = 40 AND substr(latest_event_id, 1, 4) = 'act_'";
const TIMESTAMP_CHECK = "length(occurred_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at";

export const ACTIVITY_STORIES_TABLE_SQL = `
CREATE TABLE activity_stories (
  story_id TEXT PRIMARY KEY CHECK (${STORY_ID_CHECK}),
  latest_event_id TEXT NOT NULL UNIQUE CHECK (${EVENT_ID_CHECK}),
  latest_seq INTEGER NOT NULL CHECK (latest_seq >= 1),
  last_append_seq INTEGER NOT NULL CHECK (last_append_seq >= latest_seq),
  occurred_at TEXT NOT NULL CHECK (${TIMESTAMP_CHECK}),
  event_count INTEGER NOT NULL CHECK (event_count >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('session','delegation','todo','workflow','approval','cron','system')),
  outcome_state TEXT NOT NULL CHECK (outcome_state IN ('running','succeeded','failed','attention','cancelled','info'))
) WITHOUT ROWID`;

export const ACTIVITY_STORY_VERSIONS_TABLE_SQL = `
CREATE TABLE activity_story_versions (
  story_id TEXT NOT NULL CHECK (${STORY_ID_CHECK}),
  append_seq INTEGER NOT NULL CHECK (append_seq >= 1),
  latest_event_id TEXT NOT NULL CHECK (${EVENT_ID_CHECK}),
  latest_seq INTEGER NOT NULL CHECK (latest_seq >= 1),
  occurred_at TEXT NOT NULL CHECK (${TIMESTAMP_CHECK}),
  event_count INTEGER NOT NULL CHECK (event_count >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('session','delegation','todo','workflow','approval','cron','system')),
  outcome_state TEXT NOT NULL CHECK (outcome_state IN ('running','succeeded','failed','attention','cancelled','info')),
  PRIMARY KEY (story_id, append_seq)
) WITHOUT ROWID`;

export const ACTIVITY_SEARCH_TABLE_SQL = `
CREATE VIRTUAL TABLE activity_event_search USING fts5(
  event_id UNINDEXED,
  story_id UNINDEXED,
  seq UNINDEXED,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

export const ACTIVITY_PROJECTION_INDEXES: ActivityProjectionSchemaObject[] = [
  { type: "index", name: "idx_activity_stories_order", sql: "CREATE INDEX idx_activity_stories_order ON activity_stories (occurred_at DESC, latest_event_id DESC)" },
  { type: "index", name: "idx_activity_stories_kind_order", sql: "CREATE INDEX idx_activity_stories_kind_order ON activity_stories (kind, outcome_state, occurred_at DESC, latest_event_id DESC)" },
  { type: "index", name: "idx_activity_stories_outcome_order", sql: "CREATE INDEX idx_activity_stories_outcome_order ON activity_stories (outcome_state, kind, occurred_at DESC, latest_event_id DESC)" },
  { type: "index", name: "idx_activity_stories_append", sql: "CREATE INDEX idx_activity_stories_append ON activity_stories (last_append_seq, story_id)" },
  { type: "index", name: "idx_activity_story_versions_snapshot", sql: "CREATE INDEX idx_activity_story_versions_snapshot ON activity_story_versions (story_id, append_seq DESC)" },
  { type: "index", name: "idx_activity_story_versions_append", sql: "CREATE INDEX idx_activity_story_versions_append ON activity_story_versions (append_seq, story_id)" },
];

/**
 * Locale-neutral search folding: NFKD decomposition, Unicode lowercase,
 * combining-mark removal, Greek final-sigma folding, and Turkish dotless-I folding.
 */
export function normalizeActivitySearch(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("und")
    .replace(/\p{M}+/gu, "")
    .replace(/ς/g, "σ")
    .replace(/ı/g, "i");
}

export function activitySearchQuery(value: string): string {
  const tokens = normalizeActivitySearch(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].map((token) => `"${token}"`).join(" AND ");
}

function searchText(row: ActivityRow): string {
  return normalizeActivitySearch([
    row.summary,
    row.action,
    row.actor_display_name,
    row.actor_id,
    row.object_label,
    row.object_id,
    row.outcome_label,
  ].join(" "));
}

interface CurrentStoryRow {
  latest_event_id: string;
  latest_seq: number;
  occurred_at: string;
  event_count: number;
  kind: ActivityRow["kind"];
  outcome_state: ActivityRow["outcome_state"];
}

interface ProjectionStatements {
  current: Database.Statement<[string], CurrentStoryRow>;
  version: Database.Statement;
  story: Database.Statement;
  search: Database.Statement;
}

const statementCache = new WeakMap<Database.Database, ProjectionStatements>();

function statements(database: Database.Database): ProjectionStatements {
  const cached = statementCache.get(database);
  if (cached) return cached;
  const prepared: ProjectionStatements = {
    current: database.prepare("SELECT latest_event_id, latest_seq, occurred_at, event_count, kind, outcome_state FROM activity_stories WHERE story_id = ?"),
    version: database.prepare(`
      INSERT INTO activity_story_versions (
        story_id, append_seq, latest_event_id, latest_seq, occurred_at, event_count, kind, outcome_state
      ) VALUES (@storyId, @appendSeq, @latestEventId, @latestSeq, @occurredAt, @eventCount, @kind, @outcomeState)
    `),
    story: database.prepare(`
      INSERT INTO activity_stories (
        story_id, latest_event_id, latest_seq, last_append_seq, occurred_at, event_count, kind, outcome_state
      ) VALUES (@storyId, @latestEventId, @latestSeq, @appendSeq, @occurredAt, @eventCount, @kind, @outcomeState)
      ON CONFLICT(story_id) DO UPDATE SET
        latest_event_id = excluded.latest_event_id,
        latest_seq = excluded.latest_seq,
        last_append_seq = excluded.last_append_seq,
        occurred_at = excluded.occurred_at,
        event_count = excluded.event_count,
        kind = excluded.kind,
        outcome_state = excluded.outcome_state
    `),
    search: database.prepare("INSERT INTO activity_event_search (event_id, story_id, seq, search_text) VALUES (?, ?, ?, ?)"),
  };
  statementCache.set(database, prepared);
  return prepared;
}

export function projectActivityEvent(database: Database.Database, row: ActivityRow): void {
  const prepared = statements(database);
  const current = prepared.current.get(row.story_id);
  const isNewer = !current || row.occurred_at > current.occurred_at ||
    (row.occurred_at === current.occurred_at && row.id > current.latest_event_id);
  const projection = {
    storyId: row.story_id,
    appendSeq: row.seq,
    latestEventId: isNewer ? row.id : current.latest_event_id,
    latestSeq: isNewer ? row.seq : current.latest_seq,
    occurredAt: isNewer ? row.occurred_at : current.occurred_at,
    eventCount: (current?.event_count ?? 0) + 1,
    kind: isNewer ? row.kind : current.kind,
    outcomeState: isNewer ? row.outcome_state : current.outcome_state,
  };
  prepared.version.run(projection);
  prepared.story.run(projection);
  prepared.search.run(row.id, row.story_id, row.seq, searchText(row));
}

export function rebuildActivityProjections(database: Database.Database): void {
  database.exec("DELETE FROM activity_event_search; DELETE FROM activity_story_versions; DELETE FROM activity_stories;");
  const page = database.prepare("SELECT * FROM activity_events WHERE seq > ? ORDER BY seq LIMIT 1000");
  let afterSeq = 0;
  while (true) {
    const rows = page.all(afterSeq) as ActivityRow[];
    if (rows.length === 0) break;
    for (const row of rows) projectActivityEvent(database, row);
    afterSeq = rows[rows.length - 1]!.seq;
  }
}
