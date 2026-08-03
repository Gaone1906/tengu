import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

// The ten indexes the removed Activity ledger created. SQLite drops a table's
// indexes and triggers with it, so the drop step names only the five tables.
const ACTIVITY_INDEXES: Record<string, string[]> = {
  activity_events: ["idx_activity_order", "idx_activity_story_order", "idx_activity_kind_order", "idx_activity_outcome_order"],
  activity_stories: ["idx_activity_stories_order", "idx_activity_stories_kind_order", "idx_activity_stories_outcome_order", "idx_activity_stories_append"],
  activity_story_versions: ["idx_activity_story_versions_snapshot", "idx_activity_story_versions_append"],
};

const LEGACY_SCHEMA = `
CREATE TABLE activity_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, story_id TEXT NOT NULL, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, outcome_state TEXT NOT NULL, summary TEXT NOT NULL);
CREATE TABLE activity_stories (story_id TEXT PRIMARY KEY, latest_event_id TEXT NOT NULL, last_append_seq INTEGER NOT NULL, occurred_at TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE activity_story_versions (story_id TEXT NOT NULL, append_seq INTEGER NOT NULL, occurred_at TEXT NOT NULL);
CREATE VIRTUAL TABLE activity_event_search USING fts5(event_id UNINDEXED, search_text);
CREATE TABLE activity_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TRIGGER activity_events_immutable_delete BEFORE DELETE ON activity_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
${Object.entries(ACTIVITY_INDEXES)
  .flatMap(([table, names]) => names.map((name) => `CREATE INDEX ${name} ON ${table} (occurred_at);`))
  .join("\n")}
`;

const originalHome = process.env.JINN_HOME;
const homes: string[] = [];

afterAll(() => {
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

const dbPath = (home: string): string => path.join(home, "sessions", "registry.db");

/** A throwaway home, optionally pre-seeded with the legacy Activity schema. */
function makeHome(seed?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-actdrop-"));
  homes.push(home);
  if (seed !== undefined) {
    fs.mkdirSync(path.dirname(dbPath(home)), { recursive: true });
    const database = new Database(dbPath(home));
    database.exec(seed);
    database.close();
  }
  return home;
}

/** Boot the registry against `home` in a fresh module graph — SESSIONS_DB is
 * resolved once per module instance from JINN_HOME. Returns logged warnings. */
async function bootRegistry(home: string): Promise<string[]> {
  process.env.JINN_HOME = home;
  vi.resetModules();
  const warnings: string[] = [];
  const { logger } = await import("../../shared/logger.js");
  vi.spyOn(logger, "warn").mockImplementation((message: string) => { warnings.push(message); });
  const registry = await import("../registry.js");
  registry.initDb();
  registry.__closeDbForTest();
  return warnings;
}

/** Pluck one column out of the home's registry db, without a write handle. */
function readHome<T>(home: string, sql: string): T[] {
  const database = new Database(dbPath(home), { readonly: true });
  try { return database.prepare(sql).pluck().all() as T[]; } finally { database.close(); }
}

/** Every surviving activity table (incl. FTS shadow tables) and index. */
const activitySchemaIn = (home: string): string[] =>
  readHome(home, "SELECT name FROM sqlite_master WHERE name LIKE 'activity!_%' ESCAPE '!' OR name LIKE 'idx!_activity!_%' ESCAPE '!' ORDER BY name");

describe("activity ledger schema drop", () => {
  it("creates no activity_* object on a fresh home", async () => {
    const home = makeHome();
    await bootRegistry(home);
    expect(activitySchemaIn(home)).toEqual([]);
  });

  it("drops all five tables and their ten indexes from a legacy home", async () => {
    const home = makeHome(LEGACY_SCHEMA);
    expect(activitySchemaIn(home).length).toBeGreaterThanOrEqual(15);
    const warnings = await bootRegistry(home);
    expect(activitySchemaIn(home)).toEqual([]);
    expect(warnings.filter((w) => w.includes("activity_events"))).toEqual([]);
  });

  it("keeps every table and warns loudly when activity_events holds rows", async () => {
    const home = makeHome(`${LEGACY_SCHEMA}
INSERT INTO activity_events (id, story_id, occurred_at, kind, outcome_state, summary)
VALUES ('act_0', 'story_0', '2026-01-01T00:00:00.000Z', 'system', 'info', 'seeded');`);
    const before = activitySchemaIn(home);
    const warnings = await bootRegistry(home);
    expect(activitySchemaIn(home)).toEqual(before);
    expect(readHome(home, "SELECT COUNT(*) FROM activity_events")).toEqual([1]);
    expect(warnings.some((w) => w.includes("activity_events") && w.includes("1"))).toBe(true);
  });
});
