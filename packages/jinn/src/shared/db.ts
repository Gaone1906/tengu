// The process-wide SQLite connection. Owns opening, upgrade safety and the one
// initialize transaction; each core module owns its own DDL in its migrate.ts and
// this composition root sequences them in a fixed order.
import path from 'node:path';
import { mkdirSync, existsSync, statSync, statfsSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SESSIONS_DB } from './paths.js';
import { getPackageVersion } from './version.js';
import { logger } from './logger.js';
import { migrateWorkItemsSchema, preflightWorkItemsDatabase, UNSUPPORTED_PRERELEASE_TODO_DATA, WORK_ITEMS_BACKUP_SUFFIX } from '../work-items/migrate.js';
import type { WorkItemSchemaPreflight } from '../work-items/migrate.js';
import { CREATE_TABLE, CREATE_MESSAGES_TABLE, CREATE_MESSAGES_INDEX, CREATE_META_TABLE, CREATE_MESSAGES_ORDER_INDEX, CREATE_MESSAGES_PARTIAL_INDEX, CREATE_SESSION_KEY_INDEX, CREATE_DELEGATION_IDEMPOTENCY_INDEX, CREATE_LAST_ACTIVITY_INDEX, CREATE_PARENT_INDEX, CREATE_WORKFLOW_RUN_INDEX, CREATE_STATUS_INDEX, CREATE_WORK_ITEM_SESSION_INDEX, CREATE_QUEUE_ITEMS_TABLE, CREATE_FILES_TABLE, CREATE_CHAT_PINS_TABLE, migrateMessagesSchema, migrateFtsSchema, migrateSessionsSchema, migrateQueueItemsSchema, migrateCallbackDeliveriesSchema, runImmediateMigrationWithRetry, runSqliteBusyRetry } from '../sessions/migrate.js';

let db: Database.Database | undefined;

// --- Upgrade safety around the session database -----------------------------
// Migrations are transactional (atomic rollback on failure), but two failure
// modes still deserve belt-and-suspenders: (1) running out of disk mid-migration
// — the classic corruption trigger — and (2) an operator wanting to undo an
// upgrade. So before an upgrade migration we refuse to proceed on a near-full
// disk and snapshot the existing DB, logging where it went.
const MIN_FREE_BYTES_FOR_DB = 200 * 1024 * 1024; // 200 MB headroom for a migration
const DB_VERSION_SIDECAR = `${SESSIONS_DB}.version`;
const DB_BACKUP_DIR = path.join(path.dirname(SESSIONS_DB), 'backups');
const KEEP_PREMIGRATION_BACKUPS = 3;

function preflightSessionDiskSpace(): void {
  let free: number;
  try {
    const dir = existsSync(path.dirname(SESSIONS_DB))
      ? path.dirname(SESSIONS_DB)
      : path.dirname(path.dirname(SESSIONS_DB));
    const fs = statfsSync(dir);
    free = fs.bavail * fs.bsize;
  } catch {
    return; // can't stat the filesystem — don't block boot on that alone
  }
  if (free < MIN_FREE_BYTES_FOR_DB) {
    const mb = Math.round(free / (1024 * 1024));
    throw new Error(
      `Refusing to open the session database: only ${mb} MB free on the disk holding ${SESSIONS_DB}. ` +
        `Free up space before starting — running out of disk during a schema migration can corrupt the database.`,
    );
  }
}

function prunePremigrationBackups(): void {
  try {
    const bases = readdirSync(DB_BACKUP_DIR)
      .filter((n) => n.startsWith('registry.db.pre-') && !n.endsWith('-wal') && !n.endsWith('-shm'))
      .sort(); // ISO-timestamped names sort chronologically
    for (const name of bases.slice(0, Math.max(0, bases.length - KEEP_PREMIGRATION_BACKUPS))) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(path.join(DB_BACKUP_DIR, name + suffix), { force: true });
    }
  } catch {
    /* best-effort pruning */
  }
}

function maybeBackupBeforeMigration(): void {
  if (!existsSync(SESSIONS_DB) || statSync(SESSIONS_DB).size === 0) return; // fresh install — nothing to snapshot
  const current = getPackageVersion();
  let last = '';
  try {
    last = readFileSync(DB_VERSION_SIDECAR, 'utf8').trim();
  } catch {
    last = '';
  }
  if (last === current) return; // same version already booted — no upgrade migration expected
  try {
    mkdirSync(DB_BACKUP_DIR, { recursive: true });
    // Idempotent per version: if a backup for this target version already exists
    // (a prior boot, or a racing concurrent first-boot process just made one),
    // don't snapshot again.
    if (readdirSync(DB_BACKUP_DIR).some((n) => n.startsWith(`registry.db.pre-${current}-`))) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const from = last || 'preversioned';
    const dest = path.join(DB_BACKUP_DIR, `registry.db.pre-${current}-from-${from}-${stamp}`);
    // Copy the whole consistent set so a checkpoint-pending WAL rides with its base file.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(SESSIONS_DB + suffix)) copyFileSync(SESSIONS_DB + suffix, dest + suffix);
    }
    logger.info(`Pre-migration session DB backup created: ${dest} (upgrade ${from} → ${current})`);
    prunePremigrationBackups();
  } catch (err) {
    // A backup failure must not block boot, but it must be loud.
    logger.warn(`Could not create pre-migration session DB backup: ${err instanceof Error ? err.message : err}`);
  }
}

function recordDbVersion(): void {
  try {
    writeFileSync(DB_VERSION_SIDECAR, getPackageVersion(), 'utf8');
  } catch {
    /* best-effort — sidecar only gates the backup, never correctness */
  }
}

/**
 * Read-only Todo preflight that tolerates a peer's concurrent first-boot migration.
 *
 * The preflight is deliberately read-only and runs before any lock, so several
 * gateway processes discovering the same fresh/upgraded home at once can have one
 * of them mid-migration while another probes. During that window the probe can
 * momentarily observe an inconsistent schema shape (e.g. an uncheckpointed WAL a
 * read-only connection can't fully resolve) and classify it as an unsupported
 * prerelease refusal even though the database is perfectly valid.
 *
 * That early refusal is NOT authoritative: {@link migrateWorkItemsSchema} re-runs
 * the SAME classification under `BEGIN IMMEDIATE` on the write connection — which
 * has full, consistent visibility — and refuses genuinely-unsupported data there,
 * rolling back without persisting any write. So on that specific refusal we retry
 * the read-only probe within a bounded budget: genuinely-unsupported data is stable
 * and keeps refusing (so we still refuse fast, before any write), while a racing
 * migration commits a valid schema within the window and a retry then succeeds.
 * Corruption/disk-space errors are not this refusal and propagate immediately.
 */
function preflightWorkItemsToleratingConcurrentInit(
  filename: string,
): WorkItemSchemaPreflight {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return preflightWorkItemsDatabase(filename);
    } catch (error) {
      const isPrereleaseRefusal =
        error instanceof Error && error.message === UNSUPPORTED_PRERELEASE_TODO_DATA;
      if (!isPrereleaseRefusal || Date.now() >= deadline) throw error;
      // Synchronous sleep (initDb is sync) before re-reading a fresh snapshot.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Tables of the removed Activity ledger, dropped in dependency-free order. */
const ACTIVITY_LEDGER_TABLES = [
  'activity_event_search',
  'activity_story_versions',
  'activity_stories',
  'activity_events',
  'activity_ledger_meta',
] as const;

/**
 * Drop the Activity ledger left behind on homes that booted a version which
 * created it. No shipped code path ever appended to it, so those tables are
 * empty, and fresh homes never create them — this is a no-op there. SQLite
 * removes a table's indexes and triggers along with the table, so naming the
 * tables is enough. Idempotent; runs inside the boot migration transaction.
 *
 * If a home somehow does hold events, keep everything and say so loudly:
 * silently deleting operator data is never the right answer to a surprise.
 */
function dropActivityLedgerSchema(database: Database.Database): void {
  const lookup = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").pluck();
  const present = ACTIVITY_LEDGER_TABLES.filter((table) => lookup.get(table) !== undefined);
  if (present.length === 0) return;
  if (present.includes('activity_events')) {
    const rows = database.prepare('SELECT COUNT(*) FROM activity_events').pluck().get() as number;
    if (rows > 0) {
      logger.warn(
        `Refusing to drop the removed Activity ledger: activity_events holds ${rows} row(s). ` +
        `Leaving ${present.join(', ')} in place — drop them by hand once those rows are exported.`,
      );
      return;
    }
  }
  for (const table of present) database.exec(`DROP TABLE ${table}`);
}

export function initDb(): Database.Database {
  if (db) return db;
  // Fail fast on a near-full disk before any write — running out of space during
  // a migration is the classic corruption trigger.
  preflightSessionDiskSpace();
  // Todo classification is deliberately the first database operation. It opens
  // an existing file read-only and refuses unsupported prerelease data before
  // WAL mode, migrations, or any other schema write can occur.
  const todoPreflight = preflightWorkItemsToleratingConcurrentInit(SESSIONS_DB);
  // A v1 ledger is about to be rebuilt in place — keep a one-time pristine file
  // copy (plus WAL/SHM sidecars) beside it so the operator can always roll back.
  if (todoPreflight === 'v1') {
    const backup = `${SESSIONS_DB}${WORK_ITEMS_BACKUP_SUFFIX}`;
    if (!existsSync(backup)) {
      copyFileSync(SESSIONS_DB, backup);
      for (const suffix of ['-wal', '-shm'] as const) {
        if (existsSync(`${SESSIONS_DB}${suffix}`)) copyFileSync(`${SESSIONS_DB}${suffix}`, `${backup}${suffix}`);
      }
    }
  }
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  // Snapshot the existing DB before an upgrade migration mutates it (version-gated,
  // so this runs once per upgrade, never on a steady-state boot).
  maybeBackupBeforeMigration();
  const database = new Database(SESSIONS_DB);
  db = database;
  // Register the busy handler before WAL/DDL. Several gateway processes may
  // discover the same fresh or upgraded home concurrently; initialization is
  // serialized by SQLite instead of surfacing a transient SQLITE_BUSY.
  database.pragma('busy_timeout = 10000');
  runSqliteBusyRetry(() => database.pragma('journal_mode = WAL'));
  const initialize = database.transaction(() => {
    database.exec(CREATE_TABLE);
    database.exec(CREATE_MESSAGES_TABLE);
    database.exec(CREATE_MESSAGES_INDEX);
    database.exec(CREATE_META_TABLE);
    migrateMessagesSchema(database);
    database.exec(CREATE_MESSAGES_ORDER_INDEX);
    // Partial-message index needs the `partial` column, added by migrateMessagesSchema above.
    database.exec(CREATE_MESSAGES_PARTIAL_INDEX);
    migrateFtsSchema(database);
    // Pre-existing rows are intentionally NOT drained here. startGateway schedules
    // the chunked backfill after server.listen(), and searchMessages also schedules
    // it as a lazy fallback for non-gateway callers. The guarded AD/AU triggers above
    // keep writes safe while that one-time backfill is incomplete.
    migrateSessionsSchema(database);
    database.exec(CREATE_SESSION_KEY_INDEX);
    database.exec(CREATE_DELEGATION_IDEMPOTENCY_INDEX);
    database.exec(CREATE_LAST_ACTIVITY_INDEX);
    database.exec(CREATE_PARENT_INDEX);
    database.exec(CREATE_WORKFLOW_RUN_INDEX);
    database.exec(CREATE_STATUS_INDEX);
    // The next public release is the first Todo release: create the clean model
    // directly, or replace only a read-only-preflighted empty prerelease shape.
    migrateWorkItemsSchema(database, todoPreflight);
    database.exec(CREATE_WORK_ITEM_SESSION_INDEX);
    dropActivityLedgerSchema(database);
    database.exec(CREATE_QUEUE_ITEMS_TABLE);
    migrateQueueItemsSchema(database);
    migrateCallbackDeliveriesSchema(database);
    database.exec(CREATE_FILES_TABLE);
    database.exec(CREATE_CHAT_PINS_TABLE);
  });
  try {
    runImmediateMigrationWithRetry(initialize);
    // Migration succeeded — stamp the version so the next boot at the same version
    // skips the pre-migration backup.
    recordDbVersion();
    return database;
  } catch (error) {
    database.close();
    db = undefined;
    throw error;
  }
}

/** Test-only restart seam: close the process singleton so the next initDb()
 * reopens the same sanitized home and reruns migrations. */
export function __closeDbForTest(): void {
  db?.close();
  db = undefined;
}
