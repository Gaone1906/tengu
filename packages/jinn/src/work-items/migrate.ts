import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import {
  deriveTodoIdPrefix,
  formatTodoId,
  isTodoId,
  todoIdOrdinal,
  todoIdPrefix,
  TODO_ID_PREFIX_PATTERN,
} from "./id.js";

export const UNSUPPORTED_PRERELEASE_TODO_DATA =
  "Unsupported prerelease Todo data detected. This release cannot start or migrate it.\n" +
  "Use the separately reviewed offline converter, or restore a supported public-version backup.";

const CANONICAL_ID_SQL = `
  id GLOB '[A-Z][A-Z][A-Z]-[1-9]*'
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND CAST(substr(id, 5) AS INTEGER) BETWEEN 1 AND 9007199254740991
  AND printf('%lld', CAST(substr(id, 5) AS INTEGER)) = substr(id, 5)
`;

/** Clean first-release Todo table. There is no prerelease row migration path. */
export const WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
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

export const WORK_ITEMS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_work_items_status     ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_department ON work_items(department);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_source_ref
  ON work_items(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_recent     ON work_items(updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_default_order
  ON work_items((rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_work_items_manual_order
  ON work_items(status, (rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
`;

export const WORK_ITEM_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_events (
  id           TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL CHECK (${CANONICAL_ID_SQL.replaceAll("id", "work_item_id")}),
  kind         TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL
)
`;

export const WORK_ITEM_EVENTS_DDL = `
${WORK_ITEM_EVENTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_events_item ON work_item_events(work_item_id, created_at);
`;

export const WORK_ITEM_EDIT_RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS work_item_edit_receipts (
  key_digest          TEXT PRIMARY KEY CHECK (length(key_digest) = 64),
  request_fingerprint TEXT NOT NULL,
  result_version      INTEGER NOT NULL CHECK (result_version >= 1),
  created_at          TEXT NOT NULL
);
`;

export const WORK_ITEM_ID_ALLOCATOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  prefix TEXT CHECK (prefix IS NULL OR (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]')),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)
`;

export const WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL
)
`;

export const WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL
)
`;

export const WORK_ITEM_IDENTITY_TABLES_DDL = `
${WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
INSERT INTO work_item_id_allocator (singleton, prefix, high_water)
  SELECT 1, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator);
${WORK_ITEM_ID_BURNS_TABLE_DDL};
${WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
`;

export const WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS work_items_id_immutable
BEFORE UPDATE OF id ON work_items
BEGIN
  SELECT RAISE(ABORT, 'Todo ID is immutable');
END`;

/** One statement per entry. The installed DDL and the startup verifier's expected SQL are both
 *  derived from this list, so a trigger body can never drift out of the schema it is checked against. */
const WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_insert
BEFORE INSERT ON work_item_id_allocator
WHEN EXISTS (SELECT 1 FROM work_item_id_allocator)
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_update
BEFORE UPDATE ON work_item_id_allocator
WHEN NEW.singleton != OLD.singleton
  OR NEW.high_water != OLD.high_water + 1
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != COALESCE(OLD.prefix, jinn_work_item_claim_prefix())
  OR (OLD.prefix IS NOT NULL AND NEW.prefix != OLD.prefix)
  OR jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns
    WHERE ordinal = NEW.high_water AND claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocator mutation refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_delete
BEFORE DELETE ON work_item_id_allocator
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_guard_insert
BEFORE INSERT ON work_item_id_burns
WHEN NEW.ordinal != (SELECT high_water + 1 FROM work_item_id_allocator WHERE singleton = 1)
  OR jinn_work_item_claim_digest() IS NULL
  OR NEW.claim_digest != jinn_work_item_claim_digest()
BEGIN SELECT RAISE(ABORT, 'Todo burn claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_update
BEFORE UPDATE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_delete
BEFORE DELETE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_guard_insert
BEFORE INSERT ON work_item_id_issuances
WHEN jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    JOIN work_items w ON CAST(substr(w.id, 5) AS INTEGER) = b.ordinal
    WHERE b.ordinal = NEW.ordinal AND b.claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo issuance claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_update
BEFORE UPDATE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_delete
BEFORE DELETE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL,
  `CREATE TRIGGER IF NOT EXISTS work_items_claim_required
BEFORE INSERT ON work_items
WHEN jinn_work_item_claim_digest() IS NULL
  OR jinn_work_item_claim_prefix() IS NULL
  OR substr(NEW.id, 1, 3) != (SELECT prefix FROM work_item_id_allocator WHERE singleton = 1)
  OR substr(NEW.id, 1, 3) != jinn_work_item_claim_prefix()
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    WHERE b.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
      AND b.claim_digest = jinn_work_item_claim_digest()
  )
  OR EXISTS (
    SELECT 1 FROM work_item_id_issuances i
    WHERE i.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocation claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_mark_issued
AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_id_issuances (ordinal, issued_at)
  VALUES (CAST(substr(NEW.id, 5) AS INTEGER), NEW.created_at);
END`,
];

export const WORK_ITEM_IDENTITY_TRIGGERS_DDL =
  WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => `${statement};`).join("\n");

const REQUIRED_TRIGGER_SQL = new Map<string, string>(
  WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => {
    const name = /^CREATE TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i.exec(statement)?.[1];
    if (!name) throw new Error("unnamed Todo identity trigger");
    return [name, statement] as const;
  }),
);

const activeClaims = new WeakMap<DatabaseType, string>();
const activeClaimPrefixes = new WeakMap<DatabaseType, string>();
const registeredDatabases = new WeakSet<DatabaseType>();

function claimDigest(rawClaim: string): string {
  return createHash("sha256").update(rawClaim).digest("hex");
}

export function registerWorkItemIdentityFunctions(db: DatabaseType): void {
  if (registeredDatabases.has(db)) return;
  db.function("jinn_work_item_claim_digest", () => {
    const claim = activeClaims.get(db);
    return claim ? claimDigest(claim) : null;
  });
  db.function("jinn_work_item_claim_prefix", () => activeClaimPrefixes.get(db) ?? null);
  registeredDatabases.add(db);
}

function withClaim<T>(db: DatabaseType, rawClaim: string, prefix: string, fn: () => T): T {
  if (activeClaims.has(db)) throw new Error("nested Todo allocation claim");
  activeClaims.set(db, rawClaim);
  activeClaimPrefixes.set(db, prefix);
  try {
    return fn();
  } finally {
    activeClaims.delete(db);
    activeClaimPrefixes.delete(db);
  }
}

export interface WorkItemAllocationClaim {
  id: string;
  prefix: string;
  ordinal: number;
  /** One-time raw claim. It is never persisted. */
  rawClaim: string;
}

/** Commit the burn independently; a later failed create permanently leaves a gap. */
export function allocateWorkItemId(
  db: DatabaseType,
  now = new Date().toISOString(),
  companyName: unknown = "Jinn",
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    const current = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
      .get() as { prefix: string | null; high_water: number };
    const prefix = current.prefix ?? deriveTodoIdPrefix(companyName);
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (ordinal, claim_digest, burned_at) VALUES (?, ?, ?)")
        .run(next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET prefix = ?, high_water = ? WHERE singleton = 1")
        .run(prefix, next);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

export function useWorkItemAllocationClaim<T>(db: DatabaseType, claim: WorkItemAllocationClaim, fn: () => T): T {
  return withClaim(db, claim.rawClaim, claim.prefix, fn);
}

export type WorkItemSchemaPreflight = "absent" | "empty-prerelease" | "current";

function sqlShape(sql: string | null | undefined): string {
  return (sql ?? "")
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

const REQUIRED_TABLE_SQL = new Map<string, string>([
  ["work_items", WORK_ITEMS_TABLE_DDL],
  ["work_item_events", WORK_ITEM_EVENTS_TABLE_DDL],
  ["work_item_edit_receipts", WORK_ITEM_EDIT_RECEIPTS_DDL],
  ["work_item_id_allocator", WORK_ITEM_ID_ALLOCATOR_TABLE_DDL],
  ["work_item_id_burns", WORK_ITEM_ID_BURNS_TABLE_DDL],
  ["work_item_id_issuances", WORK_ITEM_ID_ISSUANCES_TABLE_DDL],
]);

function tableExists(db: DatabaseType, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function tableCount(db: DatabaseType, name: string): number {
  if (!tableExists(db, name)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) FROM "${name}"`).pluck().get());
}

function hasNonNullSessionTodoRefs(db: DatabaseType): boolean {
  if (!tableExists(db, "sessions")) return false;
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "work_item_id")) return false;
  return !!db.prepare("SELECT 1 FROM sessions WHERE work_item_id IS NOT NULL LIMIT 1").get();
}

function refusal(): never {
  throw new Error(UNSUPPORTED_PRERELEASE_TODO_DATA);
}

function currentTableSql(db: DatabaseType, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined)?.sql;
}

const PRERELEASE_WORK_ITEMS_TABLE_SQL = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department TEXT, assignee TEXT, priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank REAL, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref TEXT, acceptance TEXT, verify_policy TEXT, rounds INTEGER NOT NULL DEFAULT 0, budget_usd REAL,
  approval_state TEXT CHECK (approval_state IN ('pending','approved','rejected')), approval_request TEXT, approval_ref TEXT,
  approval_target TEXT, approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT, approval_decided_by TEXT, approval_decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`;

function recognizedEmptyPrerelease(db: DatabaseType): boolean {
  if (tableCount(db, "work_items") !== 0 || tableCount(db, "work_item_events") !== 0
    || tableCount(db, "work_item_edit_receipts") !== 0 || tableCount(db, "workflow_todo_event_claims") !== 0
    || hasNonNullSessionTodoRefs(db)) return false;
  if (tableExists(db, "work_items")
    && sqlShape(currentTableSql(db, "work_items")) !== sqlShape(PRERELEASE_WORK_ITEMS_TABLE_SQL)) return false;
  return true;
}

function triggerSql(db: DatabaseType, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined)?.sql;
}

export function verifyCurrentWorkItemSchema(db: DatabaseType): void {
  for (const [name, expected] of REQUIRED_TABLE_SQL) {
    if (sqlShape(currentTableSql(db, name)) !== sqlShape(expected)) refusal();
  }
  for (const [name, expected] of REQUIRED_TRIGGER_SQL) {
    if (sqlShape(triggerSql(db, name)) !== sqlShape(expected)) refusal();
  }
  const allocator = db.prepare("SELECT singleton, prefix, high_water FROM work_item_id_allocator").all() as Array<{
    singleton: number;
    prefix: string | null;
    high_water: number;
  }>;
  if (allocator.length !== 1 || allocator[0].singleton !== 1 || !Number.isSafeInteger(allocator[0].high_water)) refusal();
  const { prefix, high_water: highWater } = allocator[0];
  if (highWater === 0 ? prefix !== null : typeof prefix !== "string" || !TODO_ID_PREFIX_PATTERN.test(prefix)) refusal();
  const burns = db.prepare("SELECT ordinal FROM work_item_id_burns ORDER BY ordinal").pluck().all() as number[];
  if (burns.length !== highWater || burns.some((ordinal, index) => ordinal !== index + 1)) refusal();
  const issuances = new Set(db.prepare("SELECT ordinal FROM work_item_id_issuances").pluck().all() as number[]);
  if ([...issuances].some((ordinal) => ordinal < 1 || ordinal > highWater)) refusal();
  const ids = db.prepare("SELECT id FROM work_items").pluck().all() as string[];
  if (ids.some((id) => !isTodoId(id) || todoIdPrefix(id) !== prefix || !issuances.has(todoIdOrdinal(id)))) refusal();
  for (const table of ["work_item_events", "sessions"] as const) {
    if (!tableExists(db, table)) continue;
    const column = table === "sessions" ? "work_item_id" : "work_item_id";
    const refs = db.prepare(`SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`).pluck().all() as string[];
    if (refs.some((id) => !isTodoId(id) || !ids.includes(id))) refusal();
  }
}

function classifyOpenWorkItemsDatabase(db: DatabaseType): WorkItemSchemaPreflight {
  const todoTables = [
    "work_items", "work_item_events", "work_item_edit_receipts", "workflow_todo_event_claims",
    "work_item_id_allocator", "work_item_id_burns", "work_item_id_issuances",
  ].filter((name) => tableExists(db, name));
  if (!tableExists(db, "work_items")) {
    if (todoTables.some((name) => name.startsWith("work_item_id_"))) refusal();
    if (recognizedEmptyPrerelease(db)) return todoTables.length > 0 || tableExists(db, "sessions")
      ? "empty-prerelease"
      : "absent";
    return refusal();
  }
  try {
    verifyCurrentWorkItemSchema(db);
    return "current";
  } catch {
    if (todoTables.some((name) => name.startsWith("work_item_id_"))) refusal();
    if (recognizedEmptyPrerelease(db)) return "empty-prerelease";
    return refusal();
  }
}

/** Read-only and side-effect free. It runs before WAL mode or any schema write. */
export function preflightWorkItemsDatabase(filename: string): WorkItemSchemaPreflight {
  if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) return "absent";
  let db: DatabaseType;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
  } catch {
    return refusal();
  }
  try {
    return classifyOpenWorkItemsDatabase(db);
  } finally {
    db.close();
  }
}

export interface WorkItemsMigrationResult { rebuilt: boolean; rows: number }

/** Replace only a previously classified empty prerelease shape. */
export function migrateWorkItemsSchema(
  db: DatabaseType,
  _preflight: WorkItemSchemaPreflight = tableExists(db, "work_items") ? "current" : "absent",
): WorkItemsMigrationResult {
  registerWorkItemIdentityFunctions(db);
  const migrate = db.transaction((): WorkItemsMigrationResult => {
    // The read-only preflight necessarily precedes the write lock. Reclassify after
    // BEGIN IMMEDIATE so a concurrent winner's committed schema is never dropped.
    const liveShape = classifyOpenWorkItemsDatabase(db);
    if (liveShape === "empty-prerelease") {
      for (const name of ["workflow_todo_event_claims", "work_item_edit_receipts", "work_item_events", "work_items"]) {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      if (tableExists(db, "meta")) {
        db.prepare("DELETE FROM meta WHERE key IN ('todo_status_event_claims_migrated','todo_status_replay_watermark')").run();
      }
    } else if (liveShape === "current") {
      return { rebuilt: false, rows: 0 };
    }
    db.exec(WORK_ITEM_IDENTITY_TABLES_DDL);
    db.exec(WORK_ITEMS_TABLE_DDL);
    db.exec(WORK_ITEMS_INDEX_DDL);
    db.exec(WORK_ITEM_EVENTS_DDL);
    db.exec(WORK_ITEM_EDIT_RECEIPTS_DDL);
    db.exec(WORK_ITEM_IDENTITY_TRIGGERS_DDL);
    verifyCurrentWorkItemSchema(db);
    return { rebuilt: liveShape === "empty-prerelease", rows: 0 };
  });
  return migrate.immediate();
}
