import type { Database } from 'better-sqlite3';

/**
 * GRS-021a — the Todo vocabulary migration (design §1.2).
 *
 * Elevates the GRS-002 `work_items` table to the Todos model: the 8-status
 * vocabulary (`backlog → assigned → executing → in_review → done | blocked |
 * escalated | cancelled`), the 7-value provenance enum, and the new columns
 * (acceptance, verify_policy, rounds, budget_usd, the approval fields).
 *
 * SQLite cannot ALTER a CHECK constraint, so expanding the enums is a guarded
 * table REBUILD: create `work_items_new` with the new DDL, `INSERT…SELECT` with
 * the CASE maps, drop the old table, rename — all inside ONE transaction, so a
 * failure at any point rolls back to the old table wholesale (rollback-safe by
 * construction; DDL is transactional in SQLite). Data maps:
 *
 *   status  open   → backlog        source  manual → human
 *   status  active → executing      source  session + source_ref 'delegate:%'
 *   (blocked/done/cancelled keep)           → delegation (GRS-017d formalized)
 *
 * Idempotent: the rebuild runs only when the live table's DDL predates the new
 * vocabulary (its CHECK lacks 'backlog'); fresh installs create the new shape
 * directly via WORK_ITEMS_TABLE_DDL and are never rebuilt. A row that maps onto
 * an invalid value (possible only via out-of-band corruption — the old CHECKs
 * forbid it) fails the new table's CHECK, aborts the transaction LOUDLY, and
 * leaves the old table fully intact: migration integrity over silent coercion.
 */

/** The Todos-model DDL — single source of truth, executed by initDb for fresh
 *  installs and by the rebuild for migrated ones. Keep the string 'backlog' in
 *  the status CHECK: it is the migration's already-migrated sentinel. */
export const WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  approval_state      TEXT CHECK (approval_state IN ('pending','approved','rejected')),
  approval_request    TEXT,
  approval_ref        TEXT,
  approval_target     TEXT,
  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT,
  approval_decided_by TEXT,
  approval_decided_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

/** Indexes for work_items — recreated by the rebuild (DROP TABLE removes them). */
export const WORK_ITEMS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_work_items_status     ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_department ON work_items(department);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_source_ref
  ON work_items(source, source_ref) WHERE source_ref IS NOT NULL;
-- Backs the default list/search ORDER BY (updated_at DESC, created_at DESC) so a
-- LIMIT-ed read walks the index tail instead of sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_work_items_recent     ON work_items(updated_at DESC, created_at DESC);
-- Covers the unfiltered dashboard page's complete deterministic ordering.
CREATE INDEX IF NOT EXISTS idx_work_items_default_order
  ON work_items((rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
-- Ranked rows lead within a raw-status group; unranked rows retain the stable
-- newest-first fallback used before manual ordering existed.
CREATE INDEX IF NOT EXISTS idx_work_items_manual_order
  ON work_items(status, (rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
`;

/** Append-only audit of Todo lifecycle (design §1.2 — earned by the approvals/
 *  bounces/escalations this phase ships). Queryable sibling of the cron-runs
 *  JSONL philosophy. `detail` is a JSON payload (critique text, session id, …). */
export const WORK_ITEM_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS work_item_events (
  id           TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wi_events_item ON work_item_events(work_item_id, created_at);
`;

/** Columns copied straight through by the rebuild (everything the old shape had,
 *  minus the two CASE-mapped ones). New columns take their DDL defaults. */
const CARRIED_COLUMNS = 'id, title, body, department, assignee, priority, source_ref, created_at, updated_at, closed_at';

export interface WorkItemsMigrationResult {
  /** True when the rebuild actually ran (old vocabulary found and remapped). */
  rebuilt: boolean;
  /** Rows carried through the rebuild (0 when not rebuilt). */
  rows: number;
}

function columnNames(db: Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
  return new Set(cols.map((col) => col.name));
}

function ensureAdditiveWorkItemColumns(db: Database): void {
  const cols = columnNames(db);
  const alters: string[] = [];
  if (!cols.has('rank')) alters.push('ALTER TABLE work_items ADD COLUMN rank REAL');
  if (!cols.has('approval_target')) alters.push('ALTER TABLE work_items ADD COLUMN approval_target TEXT');
  if (!cols.has('approval_target_kind')) alters.push("ALTER TABLE work_items ADD COLUMN approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none'))");
  if (!cols.has('approval_escalated_at')) alters.push('ALTER TABLE work_items ADD COLUMN approval_escalated_at TEXT');
  for (const sql of alters) db.exec(sql);

  const nextCols = alters.length ? columnNames(db) : cols;
  if (nextCols.has('approval_target') && nextCols.has('approval_target_kind')) {
    db.exec("UPDATE work_items SET approval_target_kind = 'virtual' WHERE approval_target IS NOT NULL AND approval_target_kind IS NULL");
  }
}

/**
 * Rebuild `work_items` to the Todo vocabulary if (and only if) the live table
 * still has the GRS-002 shape. Called from initDb BEFORE the CREATE IF NOT
 * EXISTS of the new DDL (order is irrelevant for correctness — the guard keys
 * off the table's own SQL — but running first keeps "one table, one shape" true
 * at every point in the sequence). Throws on failure with the transaction
 * rolled back; the caller (initDb) lets that propagate — a half-migrated store
 * must never serve requests.
 */
export function migrateWorkItemsSchema(db: Database): WorkItemsMigrationResult {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'")
    .get() as { sql: string } | undefined;
  if (!row) return { rebuilt: false, rows: 0 }; // fresh install — initDb creates the new shape
  if (row.sql.includes("'backlog'")) {
    ensureAdditiveWorkItemColumns(db);
    return { rebuilt: false, rows: 0 }; // already migrated
  }

  const rebuild = db.transaction((): number => {
    db.exec(WORK_ITEMS_TABLE_DDL.replace('CREATE TABLE IF NOT EXISTS work_items', 'CREATE TABLE work_items_new'));
    const copied = db
      .prepare(
        `INSERT INTO work_items_new (${CARRIED_COLUMNS}, status, source)
         SELECT ${CARRIED_COLUMNS},
           CASE status WHEN 'open' THEN 'backlog' WHEN 'active' THEN 'executing' ELSE status END,
           CASE
             WHEN source = 'manual' THEN 'human'
             WHEN source = 'session' AND source_ref LIKE 'delegate:%' THEN 'delegation'
             ELSE source
           END
         FROM work_items`,
      )
      .run();
    db.exec('DROP TABLE work_items');
    db.exec('ALTER TABLE work_items_new RENAME TO work_items');
    db.exec(WORK_ITEMS_INDEX_DDL);
    ensureAdditiveWorkItemColumns(db);
    return copied.changes;
  });
  return { rebuilt: true, rows: rebuild() };
}
