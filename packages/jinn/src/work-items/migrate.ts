import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import {
  resolveTodoIdPrefix,
  parseTodoIdPrefix,
  formatTodoId,
  isTodoId,
  todoIdOrdinal,
  todoIdPrefix,
  TODO_ID_PREFIX_PATTERN,
} from "./id.js";

export const UNSUPPORTED_PRERELEASE_TODO_DATA =
  "Unsupported prerelease Todo data detected. This release cannot start or migrate it.\n" +
  "Use the separately reviewed offline converter, or restore a supported public-version backup.";

export const CORRUPT_SESSIONS_DATABASE =
  "The session database appears to be corrupt or is not a valid SQLite file — this is NOT a Todo-data\n" +
  "problem. Restore it from a backup (check the 'backups/' folder next to registry.db, or your most\n" +
  "recent copy) and restart.";

/** File-copy backup suffix written next to the registry before a v1→v2 rebuild. */
export const WORK_ITEMS_BACKUP_SUFFIX = ".pre-todos-v2";

/** SQLite surfaces file corruption via these substrings. */
function isSqliteCorruption(message: string): boolean {
  return /malformed|file is not a database|not a database|disk image is malformed|database is locked.*corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(
    message,
  );
}

const CANONICAL_ID_SQL = `
  id GLOB '[A-Z][A-Z][A-Z]-[1-9]*'
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND CAST(substr(id, 5) AS INTEGER) BETWEEN 1 AND 9007199254740991
  AND printf('%lld', CAST(substr(id, 5) AS INTEGER)) = substr(id, 5)
`;

/* ── Frozen v1 schema (recognizer for pre-migration databases) ─────────────── */

/** v1 (first public Todo release) work_items shape, byte-identical to what it
 *  installed — the v1→v2 migration recognizes existing databases against it. */
export const V1_WORK_ITEMS_TABLE_DDL = `
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

export const V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  prefix TEXT CHECK (prefix IS NULL OR (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]')),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)
`;

export const V1_WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_IDENTITY_TABLES_DDL = `
${V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
INSERT INTO work_item_id_allocator (singleton, prefix, high_water)
  SELECT 1, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator);
${V1_WORK_ITEM_ID_BURNS_TABLE_DDL};
${V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
`;

/* ── Current (v2) schema — Todos v2 slice 1 ────────────────────────────────── */

/** v2 (Todos v2 slice 1): per-department prefixes + sub-task tree columns. */
export const WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
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
CREATE INDEX IF NOT EXISTS idx_work_items_parent     ON work_items(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_root       ON work_items(root_id);
CREATE INDEX IF NOT EXISTS idx_work_items_created_by ON work_items(created_by, (parent_id IS NULL), updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_due        ON work_items(due_at) WHERE due_at IS NOT NULL;
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
  prefix TEXT PRIMARY KEY CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)`;

export const WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  prefix TEXT NOT NULL CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL,
  PRIMARY KEY (prefix, ordinal)
)`;

export const WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  prefix TEXT NOT NULL CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (prefix, ordinal)
)`;

export const DEPARTMENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS departments (
  slug TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  created_at TEXT NOT NULL
)`;

export const WORK_ITEM_IDENTITY_TABLES_DDL = `
${WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
${WORK_ITEM_ID_BURNS_TABLE_DDL};
${WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
${DEPARTMENTS_TABLE_DDL};
`;

export const WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS work_items_id_immutable
BEFORE UPDATE OF id ON work_items
BEGIN
  SELECT RAISE(ABORT, 'Todo ID is immutable');
END`;

/* ── Identity triggers ─────────────────────────────────────────────────────── */

/** Frozen v1 trigger set (singleton allocator) — fixture builders + recognition only. */
const V1_WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS: readonly string[] = [
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

export const V1_WORK_ITEM_IDENTITY_TRIGGERS_DDL =
  V1_WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => `${statement};`).join("\n");

/** One statement per entry. The installed DDL and the startup verifier's expected SQL are both
 *  derived from this list, so a trigger body can never drift out of the schema it is checked against. */
const WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_insert
BEFORE INSERT ON work_item_id_allocator
WHEN NEW.high_water != 0
BEGIN SELECT RAISE(ABORT, 'Todo allocator namespaces start at zero'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_update
BEFORE UPDATE ON work_item_id_allocator
WHEN NEW.prefix != OLD.prefix
  OR NEW.high_water != OLD.high_water + 1
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != jinn_work_item_claim_prefix()
  OR jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns
    WHERE prefix = NEW.prefix AND ordinal = NEW.high_water
      AND claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocator mutation refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_delete
BEFORE DELETE ON work_item_id_allocator
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_guard_insert
BEFORE INSERT ON work_item_id_burns
WHEN NEW.ordinal != (SELECT high_water + 1 FROM work_item_id_allocator WHERE prefix = NEW.prefix)
  OR jinn_work_item_claim_digest() IS NULL
  OR NEW.claim_digest != jinn_work_item_claim_digest()
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != jinn_work_item_claim_prefix()
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
    JOIN work_items w ON w.id = NEW.prefix || '-' || NEW.ordinal
    WHERE b.prefix = NEW.prefix AND b.ordinal = NEW.ordinal
      AND b.claim_digest = jinn_work_item_claim_digest()
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
  OR substr(NEW.id, 1, 3) != jinn_work_item_claim_prefix()
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    WHERE b.prefix = substr(NEW.id, 1, 3)
      AND b.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
      AND b.claim_digest = jinn_work_item_claim_digest()
  )
  OR EXISTS (
    SELECT 1 FROM work_item_id_issuances i
    WHERE i.prefix = substr(NEW.id, 1, 3) AND i.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocation claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_mark_issued
AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_id_issuances (prefix, ordinal, issued_at)
  VALUES (substr(NEW.id, 1, 3), CAST(substr(NEW.id, 5) AS INTEGER), NEW.created_at);
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
  prefix: string = "JIN",
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  parseTodoIdPrefix(prefix);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    db.prepare(
      "INSERT INTO work_item_id_allocator (prefix, high_water) SELECT ?, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator WHERE prefix = ?)",
    ).run(prefix, prefix);
    const current = db.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = ?")
      .get(prefix) as { high_water: number };
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES (?, ?, ?, ?)")
        .run(prefix, next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET high_water = ? WHERE prefix = ?").run(next, prefix);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

/** @internal test fixture builder — v1 semantics, do not use in product code. */
export function allocateWorkItemIdV1ForTest(
  db: DatabaseType,
  now = new Date().toISOString(),
  companyName: unknown = "Jinn",
  companyPrefix?: unknown,
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    const current = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
      .get() as { prefix: string | null; high_water: number };
    const prefix = current.prefix ?? resolveTodoIdPrefix(companyName, companyPrefix);
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

export type WorkItemSchemaPreflight = "absent" | "empty-prerelease" | "v1" | "current";

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
  ["departments", DEPARTMENTS_TABLE_DDL],
]);

const V1_REQUIRED_TABLE_SQL = new Map<string, string>([
  ["work_items", V1_WORK_ITEMS_TABLE_DDL],
  ["work_item_events", WORK_ITEM_EVENTS_TABLE_DDL],
  ["work_item_edit_receipts", WORK_ITEM_EDIT_RECEIPTS_DDL],
  ["work_item_id_allocator", V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL],
  ["work_item_id_burns", V1_WORK_ITEM_ID_BURNS_TABLE_DDL],
  ["work_item_id_issuances", V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL],
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

function recognizedV1(db: DatabaseType): boolean {
  for (const [name, expected] of V1_REQUIRED_TABLE_SQL) {
    if (sqlShape(currentTableSql(db, name)) !== sqlShape(expected)) return false;
  }
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
  const allocator = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator").all() as Array<{
    prefix: string;
    high_water: number;
  }>;
  for (const row of allocator) {
    if (!TODO_ID_PREFIX_PATTERN.test(row.prefix) || !Number.isSafeInteger(row.high_water)) refusal();
    const burns = db.prepare("SELECT ordinal FROM work_item_id_burns WHERE prefix = ? ORDER BY ordinal")
      .pluck().all(row.prefix) as number[];
    if (burns.length !== row.high_water || burns.some((ordinal, index) => ordinal !== index + 1)) refusal();
  }
  const knownPrefixes = new Set(allocator.map((row) => row.prefix));
  const orphanBurn = db.prepare("SELECT 1 FROM work_item_id_burns WHERE prefix NOT IN (SELECT prefix FROM work_item_id_allocator) LIMIT 1").get();
  if (orphanBurn) refusal();
  const issuances = db.prepare("SELECT prefix, ordinal FROM work_item_id_issuances").all() as Array<{ prefix: string; ordinal: number }>;
  const issued = new Set(issuances.map((row) => `${row.prefix}-${row.ordinal}`));
  for (const row of issuances) {
    const water = allocator.find((a) => a.prefix === row.prefix)?.high_water ?? 0;
    if (row.ordinal < 1 || row.ordinal > water) refusal();
  }
  const items = db.prepare("SELECT id, parent_id, root_id, depth FROM work_items").all() as Array<{
    id: string;
    parent_id: string | null;
    root_id: string;
    depth: number;
  }>;
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (!isTodoId(item.id) || !knownPrefixes.has(todoIdPrefix(item.id)) || !issued.has(`${todoIdPrefix(item.id)}-${todoIdOrdinal(item.id)}`)) refusal();
    if (item.parent_id === null) {
      if (item.root_id !== item.id || item.depth !== 0) refusal();
    } else {
      const parent = byId.get(item.parent_id);
      if (!parent || item.depth !== parent.depth + 1 || item.root_id !== parent.root_id) refusal();
    }
  }
  for (const table of ["work_item_events", "sessions"] as const) {
    if (!tableExists(db, table)) continue;
    const column = table === "sessions" ? "work_item_id" : "work_item_id";
    const refs = db.prepare(`SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`).pluck().all() as string[];
    if (refs.some((id) => !isTodoId(id) || !byId.has(id))) refusal();
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
    if (recognizedV1(db)) return "v1";
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
  } catch (err) {
    // The file exists and is non-empty but won't open read-only — that is a
    // corrupt/invalid database, not prerelease Todo data. Say so plainly.
    throw new Error(`${CORRUPT_SESSIONS_DATABASE}\n(underlying: ${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return classifyOpenWorkItemsDatabase(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A malformed DB can also surface here (mid-read). Distinguish corruption
    // from a genuine prerelease-Todo refusal so the operator gets the right fix.
    if (isSqliteCorruption(message)) {
      throw new Error(`${CORRUPT_SESSIONS_DATABASE}\n(underlying: ${message})`);
    }
    throw err; // genuine UNSUPPORTED_PRERELEASE_TODO_DATA refusal or other — preserve it
  } finally {
    db.close();
  }
}

export interface WorkItemsMigrationResult { rebuilt: boolean; rows: number }

/** Create the clean v2 model, replace a previously classified empty prerelease
 *  shape, or rebuild a recognized v1 database in place (per-prefix allocator +
 *  tree columns, data preserved). */
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
    if (liveShape === "v1") {
      const legacy = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
        .get() as { prefix: string | null; high_water: number };
      const legacyBurns = db.prepare("SELECT ordinal, claim_digest, burned_at FROM work_item_id_burns ORDER BY ordinal")
        .all() as Array<{ ordinal: number; claim_digest: string; burned_at: string }>;
      const legacyIssuances = db.prepare("SELECT ordinal, issued_at FROM work_item_id_issuances ORDER BY ordinal")
        .all() as Array<{ ordinal: number; issued_at: string }>;

      // Identity tables: tiny — snapshot to JS, drop, recreate canonical, reinsert.
      // Dropping a table drops its triggers; row-level guard triggers do NOT fire on DROP.
      db.exec("DROP TABLE work_item_id_issuances");
      db.exec("DROP TABLE work_item_id_burns");
      db.exec("DROP TABLE work_item_id_allocator");
      db.exec(WORK_ITEM_IDENTITY_TABLES_DDL);
      if (legacy.prefix !== null) {
        db.prepare("INSERT INTO work_item_id_allocator (prefix, high_water) VALUES (?, ?)")
          .run(legacy.prefix, legacy.high_water);
        for (const burn of legacyBurns) {
          db.prepare("INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES (?, ?, ?, ?)")
            .run(legacy.prefix, burn.ordinal, burn.claim_digest, burn.burned_at);
        }
        for (const issuance of legacyIssuances) {
          db.prepare("INSERT INTO work_item_id_issuances (prefix, ordinal, issued_at) VALUES (?, ?, ?)")
            .run(legacy.prefix, issuance.ordinal, issuance.issued_at);
        }
      }

      // work_items: rename-first so the new table's stored SQL is the canonical string.
      // The stale v1 triggers on work_items still reference the dropped singleton
      // allocator shape; ALTER TABLE RENAME re-parses them and would refuse, so drop
      // them first (they die with the legacy table anyway; v2 triggers are installed
      // and verified below).
      db.exec("DROP TRIGGER IF EXISTS work_items_claim_required");
      db.exec("DROP TRIGGER IF EXISTS work_items_mark_issued");
      db.exec("DROP TRIGGER IF EXISTS work_items_id_immutable");
      db.exec("ALTER TABLE work_items RENAME TO work_items_v1_legacy");
      db.exec(WORK_ITEMS_TABLE_DDL);
      db.exec(`INSERT INTO work_items (
          id, title, body, status, department, assignee,
          created_by, parent_id, root_id, depth, due_at,
          priority, rank, version, source, source_ref, acceptance, verify_policy, rounds, budget_usd,
          approval_state, approval_request, approval_ref, approval_target, approval_target_kind,
          approval_escalated_at, approval_decided_by, approval_decided_at,
          created_at, updated_at, closed_at)
        SELECT
          id, title, body, status, department, assignee,
          CASE WHEN source = 'human' THEN 'operator' ELSE 'system' END,
          NULL, id, 0, NULL,
          priority, rank, version, source, source_ref, acceptance, verify_policy, rounds, budget_usd,
          approval_state, approval_request, approval_ref, approval_target, approval_target_kind,
          approval_escalated_at, approval_decided_by, approval_decided_at,
          created_at, updated_at, closed_at
        FROM work_items_v1_legacy`);
      const migratedRows = Number(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get());
      db.exec("DROP TABLE work_items_v1_legacy");
      db.exec(WORK_ITEMS_INDEX_DDL);
      db.exec(WORK_ITEM_IDENTITY_TRIGGERS_DDL);
      verifyCurrentWorkItemSchema(db);
      return { rebuilt: true, rows: migratedRows };
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
