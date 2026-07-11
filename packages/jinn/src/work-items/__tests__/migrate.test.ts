import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  migrateWorkItemsSchema,
  WORK_ITEMS_TABLE_DDL,
  WORK_ITEMS_INDEX_DDL,
  WORK_ITEM_EVENTS_DDL,
} from "../migrate.js";

/** The GRS-002 shape, verbatim from the pre-021 registry DDL — what live DBs hold. */
const OLD_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','blocked','done','cancelled')),
  department  TEXT,
  assignee    TEXT,
  priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','cron','session','connector')),
  source_ref  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_items_status     ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_department ON work_items(department);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_source_ref
  ON work_items(source, source_ref) WHERE source_ref IS NOT NULL;
`;

function oldShapeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(OLD_DDL);
  return db;
}

function insertOld(
  db: Database.Database,
  id: string,
  status: string,
  source: string,
  sourceRef: string | null,
): void {
  db.prepare(
    `INSERT INTO work_items (id, title, status, source, source_ref, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', ?)`,
  ).run(id, `item ${id}`, status, source, sourceRef, status === "done" ? "2026-07-02T00:00:00.000Z" : null);
}

const statusOf = (db: Database.Database, id: string): Record<string, unknown> =>
  db.prepare("SELECT status, source, source_ref, rounds, approval_state, approval_target, approval_target_kind, approval_escalated_at FROM work_items WHERE id = ?").get(id) as Record<string, unknown>;

describe("migrateWorkItemsSchema — the GRS-021a vocabulary rebuild", () => {
  it("maps every old row onto the Todo vocabulary (open→backlog, active→executing, manual→human, delegate-shaped session→delegation)", () => {
    const db = oldShapeDb();
    insertOld(db, "wi_open", "open", "manual", null);
    insertOld(db, "wi_active", "active", "cron", "cron:job:1");
    insertOld(db, "wi_blocked", "blocked", "connector", null);
    insertOld(db, "wi_done", "done", "session", "delegate:abc:123");
    insertOld(db, "wi_sess", "cancelled", "session", "session-born"); // non-delegate session stays session

    const result = migrateWorkItemsSchema(db);
    expect(result.rebuilt).toBe(true);
    expect(result.rows).toBe(5);

    expect(statusOf(db, "wi_open")).toMatchObject({ status: "backlog", source: "human" });
    expect(statusOf(db, "wi_active")).toMatchObject({ status: "executing", source: "cron", source_ref: "cron:job:1" });
    expect(statusOf(db, "wi_blocked")).toMatchObject({ status: "blocked", source: "connector" });
    expect(statusOf(db, "wi_done")).toMatchObject({ status: "done", source: "delegation", source_ref: "delegate:abc:123" });
    expect(statusOf(db, "wi_sess")).toMatchObject({ status: "cancelled", source: "session" });
    // New columns exist with their defaults.
    expect(statusOf(db, "wi_open")).toMatchObject({ rounds: 0, approval_state: null, approval_target: null, approval_escalated_at: null });
    // closed_at carried through.
    const done = db.prepare("SELECT closed_at FROM work_items WHERE id = 'wi_done'").get() as { closed_at: string };
    expect(done.closed_at).toBe("2026-07-02T00:00:00.000Z");
  });

  it("recreates the indexes (incl. the partial UNIQUE and the recency index) and the new CHECKs hold", () => {
    const db = oldShapeDb();
    insertOld(db, "wi_1", "open", "cron", "cron:j:1");
    migrateWorkItemsSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_items' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    expect(new Set(indexes.map((i) => i.name))).toEqual(
      new Set([
        "idx_work_items_status",
        "idx_work_items_department",
        "idx_work_items_recent",
        "idx_work_items_default_order",
        "idx_work_items_manual_order",
        "uq_work_items_source_ref",
      ]),
    );
    // Partial UNIQUE still enforces machine-mint idempotency…
    expect(() =>
      db.prepare("INSERT INTO work_items (id,title,status,source,source_ref,created_at,updated_at) VALUES ('wi_dup','d','backlog','cron','cron:j:1','x','x')").run(),
    ).toThrow(/UNIQUE/);
    // …and the new CHECK rejects both the OLD vocabulary and garbage.
    for (const bad of ["open", "active", "weird"]) {
      expect(() =>
        db.prepare(`INSERT INTO work_items (id,title,status,created_at,updated_at) VALUES ('wi_${bad}','b','${bad}','x','x')`).run(),
      ).toThrow(/CHECK/);
    }
  });

  it("is idempotent: a second call is a no-op, and a fresh new-shape table is never rebuilt", () => {
    const db = oldShapeDb();
    insertOld(db, "wi_1", "open", "manual", null);
    expect(migrateWorkItemsSchema(db).rebuilt).toBe(true);
    expect(migrateWorkItemsSchema(db)).toEqual({ rebuilt: false, rows: 0 });

    const fresh = new Database(":memory:");
    fresh.exec(WORK_ITEMS_TABLE_DDL);
    fresh.exec(WORK_ITEMS_INDEX_DDL);
    expect(migrateWorkItemsSchema(fresh)).toEqual({ rebuilt: false, rows: 0 });

    const empty = new Database(":memory:");
    expect(migrateWorkItemsSchema(empty)).toEqual({ rebuilt: false, rows: 0 }); // no table — initDb creates it
  });

  it("adds approval routing columns to an already-migrated table without rebuilding rows", () => {
    const db = new Database(":memory:");
    db.exec(
      WORK_ITEMS_TABLE_DDL
        .replace("  approval_target     TEXT,\n", "")
        .replace("  approval_escalated_at TEXT,\n", ""),
    );
    db.exec(WORK_ITEMS_INDEX_DDL);
    db.prepare("INSERT INTO work_items (id,title,status,source,created_at,updated_at) VALUES ('wi_new','new','backlog','human','x','x')").run();

    expect(migrateWorkItemsSchema(db)).toEqual({ rebuilt: false, rows: 0 });

    const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["approval_target", "approval_escalated_at"]));
    expect(statusOf(db, "wi_new")).toMatchObject({ approval_target: null, approval_escalated_at: null });
  });

  it("adds nullable manual rank to an already-migrated table without rebuilding rows", () => {
    const db = new Database(":memory:");
    db.exec(WORK_ITEMS_TABLE_DDL.replace("  rank                REAL,\n", ""));
    db.prepare("INSERT INTO work_items (id,title,status,source,created_at,updated_at) VALUES ('wi_rankless','rankless','backlog','human','x','x')").run();

    expect(migrateWorkItemsSchema(db)).toEqual({ rebuilt: false, rows: 0 });

    const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("rank");
    expect((db.prepare("SELECT rank FROM work_items WHERE id = 'wi_rankless'").get() as { rank: number | null }).rank).toBeNull();
  });

  it("backfills legacy non-null approval targets as virtual when adding target kind", () => {
    const db = new Database(":memory:");
    db.exec(WORK_ITEMS_TABLE_DDL.replace("  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),\n", ""));
    db.exec(WORK_ITEMS_INDEX_DDL);
    db.prepare(
      `INSERT INTO work_items
         (id,title,status,source,approval_state,approval_request,approval_target,created_at,updated_at)
       VALUES ('wi_legacy_target','legacy','backlog','human','pending','approve','Legacy Root','x','x')`,
    ).run();

    expect(migrateWorkItemsSchema(db)).toEqual({ rebuilt: false, rows: 0 });

    expect(statusOf(db, "wi_legacy_target")).toMatchObject({
      approval_target: "Legacy Root",
      approval_target_kind: "virtual",
    });
  });

  it("is rollback-safe: a row that cannot map aborts the WHOLE rebuild and leaves the old table intact", () => {
    const db = oldShapeDb();
    insertOld(db, "wi_good", "open", "manual", null);
    // Simulate out-of-band corruption: a status the old CHECK would never allow,
    // inserted with constraint checking off. The rebuild's ELSE branch carries it
    // verbatim into the new CHECK, which must abort the transaction loudly.
    db.pragma("ignore_check_constraints = 1");
    insertOld(db, "wi_corrupt", "weird", "manual", null);
    db.pragma("ignore_check_constraints = 0");

    expect(() => migrateWorkItemsSchema(db)).toThrow(/CHECK/);

    // Rollback: the OLD table survives wholesale — same shape, both rows, old vocabulary.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='work_items'").get() as { sql: string }).sql;
    expect(sql).toContain("'open'");
    expect(sql).not.toContain("'backlog'");
    const rows = db.prepare("SELECT id, status FROM work_items ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: "wi_corrupt", status: "weird" },
      { id: "wi_good", status: "open" },
    ]);
    // And no half-built work_items_new is left behind.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='work_items_new'").get()).toBeUndefined();
  });
});

describe("migrateWorkItemsSchema — through the real initDb on an old-shape registry file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-migrate-"));

  beforeAll(() => {
    // Build a REAL old-shape registry DB file before the registry module loads,
    // then point JINN_HOME at it — initDb must rebuild it transparently.
    process.env.JINN_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    const raw = new Database(path.join(tmp, "sessions", "registry.db"));
    raw.exec(OLD_DDL);
    insertOld(raw, "wi_live_open", "open", "cron", "cron:nightly:2026-07-01T00:00:00.000Z");
    insertOld(raw, "wi_live_deleg", "active", "session", "delegate:coo:abcdef");
    raw.close();
  });

  it("initDb rebuilds the old table, keeps the rows, and the events table exists", async () => {
    const reg = await import("../../sessions/registry.js");
    const db = reg.initDb();

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='work_items'").get() as { sql: string }).sql;
    expect(sql).toContain("'backlog'");

    expect(statusOf(db, "wi_live_open")).toMatchObject({ status: "backlog", source: "cron" });
    expect(statusOf(db, "wi_live_deleg")).toMatchObject({ status: "executing", source: "delegation" });

    const events = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_events'").get();
    expect(events).toBeTruthy();
    void WORK_ITEM_EVENTS_DDL;
  });
});
