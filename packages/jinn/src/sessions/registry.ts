import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import { logger } from '../shared/logger.js';
import type { ChatBlock, ChatBlockEnvelope, JsonObject, ReplyContext, Session } from '../shared/types.js';
import { blockFallbackText, mergeBlock, validateBlockEnvelope } from '../shared/blocks.js';

let db: Database.Database;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  model TEXT,
  title TEXT,
  prompt_excerpt TEXT,
  parent_session_id TEXT,
  user_id TEXT,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

const CREATE_MESSAGES_ORDER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages (session_id, timestamp, seq)
`;

const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

// Backs `ORDER BY last_activity DESC` in the session list (was a full scan + sort).
const CREATE_LAST_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity DESC)
`;

// Backs the children lookup (was a full-table deserialization + JS filter).
const CREATE_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
`;

const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
)
`;

// Generic key/value store for one-off migration progress flags (e.g. the FTS
// backfill watermark). Keep entries tiny — this is not a config table.
const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
)
`;

// Full-text search over message bodies. External-content FTS5 table (the index
// lives here; `content` is read back from `messages` via rowid for snippets), so
// it stays in lockstep with `messages` through the AI/AD/AU triggers below. Only
// user/assistant rows are indexed — notification/tool rows are deliberately
// excluded (they're machine chatter, not conversation). Pre-existing rows (rows
// that predate this table) are seeded once by the chunked backfill; the triggers
// own every write from here on.
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages WHEN new.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages WHEN old.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages WHEN new.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function parseJsonObject(value: unknown, label?: string): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Graceful degrade (don't crash the load), but surface it — silent loss of
    // reply_context/transport_meta otherwise shows up as a cryptic "no target".
    logger.warn(`registry: dropped corrupt JSON in ${label ?? 'session field'}`);
    return null;
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context, 'reply_context');
  const transportMeta = parseJsonObject(row.transport_meta, 'transport_meta');
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    promptExcerpt: (row.prompt_excerpt as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    userId: (row.user_id as string) ?? null,
    effortLevel: (row.effort_level as string) ?? null,
    status: row.status as Session['status'],
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    lastContextTokens: (row.last_context_tokens as number) ?? null,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_MESSAGES_TABLE);
  db.exec(CREATE_MESSAGES_INDEX);
  db.exec(CREATE_META_TABLE);
  migrateMessagesSchema(db);
  db.exec(CREATE_MESSAGES_ORDER_INDEX);
  migrateFtsSchema(db);
  // Seed the FTS index for pre-existing rows synchronously at boot — BEFORE the
  // gateway serves any request. The AD/AU sync triggers issue an FTS `'delete'`
  // for every user/assistant row they touch, and on an external-content table a
  // delete of a not-yet-indexed rowid raises "database disk image is malformed"
  // (it rolls back cleanly — no real corruption — but the delete/update fails).
  // So any delete/update of an un-backfilled row would throw until the backfill
  // caught up. Draining here closes that window; it is chunked + idempotent and
  // measured at ~350ms for 120k rows, then a no-op on every later boot.
  // On any exception: degrade gracefully — drop FTS infrastructure, reset progress
  // flags (so the next boot retries), and disable search for this process.
  try {
    backfillFtsSync(db);
  } catch (err) {
    disableFtsForProcess(db, err);
  }
  migrateSessionsSchema(db);
  db.exec(CREATE_SESSION_KEY_INDEX);
  db.exec(CREATE_LAST_ACTIVITY_INDEX);
  db.exec(CREATE_PARENT_INDEX);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_session
      ON queue_items (session_key, status, position);
  `);
  db.exec(CREATE_FILES_TABLE);

  return db;
}

/**
 * Additive, nullable migration: add the `media` column to an existing messages
 * table. Safe to run repeatedly and on legacy DBs created before media support.
 */
export function migrateMessagesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('media')) {
    database.exec('ALTER TABLE messages ADD COLUMN media TEXT');
  }
  // Mid-turn streaming: `partial=1` rows are the live blocks (text segments + tool
  // calls) persisted DURING a turn so a refresh restores in-progress output. They
  // are deleted at turn end and replaced by the single consolidated final message
  // (same end-state as before). `seq` orders blocks within a turn (timestamp ms
  // collides across blocks); `tool_call` carries the tool name so a reloaded tool
  // block renders as a tool card, matching the live stream. All additive/nullable.
  if (!colNames.has('partial')) {
    database.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
  }
  if (!colNames.has('seq')) {
    database.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
  }
  if (!colNames.has('tool_call')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_call TEXT');
  }
  if (!colNames.has('blocks')) {
    database.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
  }
}

function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * Create the FTS5 search index + sync triggers, and record the backfill watermark.
 *
 * The triggers keep the index current for every message written from now on. Rows
 * that already existed before this table did are NOT seen by the triggers, so they
 * are seeded separately by the chunked backfill (`scheduleFtsBackfill`). To stop
 * the backfill from double-indexing rows the triggers also handle, we snapshot the
 * current MAX(rowid) here — synchronously, before any new insert can race in — and
 * the backfill only ever touches `rowid <= fts_backfill_max`. Anything above that
 * watermark is a brand-new row and belongs to the triggers.
 *
 * Idempotent: safe to run on every boot. On a DB where the backfill already
 * completed it is a no-op.
 */
export function migrateFtsSchema(database: Database.Database): void {
  database.exec(CREATE_META_TABLE);
  database.exec(CREATE_FTS);
  // First time we see this DB and the backfill hasn't run: pin the watermark.
  if (getMeta(database, 'fts_backfill_done') !== '1' && getMeta(database, 'fts_backfill_max') === null) {
    const row = database.prepare('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null };
    setMeta(database, 'fts_backfill_max', String(row.m ?? 0));
    setMeta(database, 'fts_backfill_rowid', '0');
  }
}

const FTS_BACKFILL_CHUNK = 1000;

/**
 * Seed one chunk of pre-existing user/assistant rows into the FTS index, in a
 * single transaction. Resumable: progress is persisted in `meta.fts_backfill_rowid`
 * so a mid-backfill restart picks up where it left off. Returns true once there is
 * no more work (and stamps `fts_backfill_done`).
 */
function ftsBackfillStep(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): boolean {
  if (getMeta(database, 'fts_backfill_done') === '1') return true;
  const max = Number(getMeta(database, 'fts_backfill_max') ?? '0');
  const progress = Number(getMeta(database, 'fts_backfill_rowid') ?? '0');
  if (progress >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const rows = database
    .prepare(
      `SELECT rowid, content FROM messages
       WHERE role IN ('user','assistant') AND rowid > ? AND rowid <= ?
       ORDER BY rowid ASC LIMIT ?`,
    )
    .all(progress, max, chunkSize) as Array<{ rowid: number; content: string }>;
  if (rows.length === 0) {
    // No indexable rows left in (progress, max] — we're done.
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const insert = database.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)');
  const txn = database.transaction((items: Array<{ rowid: number; content: string }>) => {
    for (const r of items) insert.run(r.rowid, r.content);
  });
  txn(rows);
  const lastRowid = rows[rows.length - 1].rowid;
  setMeta(database, 'fts_backfill_rowid', String(lastRowid));
  if (lastRowid >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  return false;
}

/**
 * Run the FTS backfill to completion synchronously. Exposed for tests and for
 * callers that genuinely want to block; the request path uses
 * `scheduleFtsBackfill` (which yields between chunks) instead.
 */
export function backfillFtsSync(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): void {
  while (!ftsBackfillStep(database, chunkSize)) {
    /* keep draining chunks */
  }
}

// Set to false when the FTS boot drain fails. `searchMessages` checks this first so it
// returns [] immediately without touching a broken or absent table.
let ftsAvailable = true;

/**
 * Drop all FTS infrastructure from `database` and reset the backfill progress flags so
 * the NEXT boot retries the migration + backfill from scratch. Sets `ftsAvailable =
 * false` for the lifetime of this process so that `searchMessages` returns [] without
 * hitting the (now-absent) table.
 *
 * Called automatically by `initDb()` when the boot drain throws. Also exported as a
 * seam for tests and for callers that want to explicitly disable FTS (e.g. on detecting
 * external corruption).
 */
export function disableFtsForProcess(database: Database.Database, reason?: unknown): void {
  const msg = reason instanceof Error ? reason.message : reason != null ? String(reason) : 'explicit disable';
  console.error(`[fts] Boot drain failed (${msg}). Disabling FTS for this process — next boot will retry.`);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
  } catch (dropErr) {
    console.error(`[fts] Failed to drop FTS infrastructure during disable: ${dropErr instanceof Error ? dropErr.message : dropErr}`);
  }
  try {
    database.prepare("DELETE FROM meta WHERE key IN ('fts_backfill_done','fts_backfill_rowid','fts_backfill_max')").run();
  } catch {
    // meta table may not exist in edge cases — not a fatal error
  }
  ftsAvailable = false;
}

let ftsBackfillScheduled = false;

/**
 * Kick the one-time FTS backfill off the hot path. Normally a no-op because
 * `initDb` already drained it synchronously at boot; this is the resumable
 * fallback for the case where a boot drain was interrupted (process killed
 * mid-migration → `fts_backfill_done` never stamped). Guarded by the persistent
 * `fts_backfill_done` flag (runs at most once across the DB's lifetime) and an
 * in-process latch (concurrent searches don't double-schedule). Each chunk is its
 * own transaction with a `setImmediate` yield in between, so a months-old 100k-row
 * table is seeded without blocking the event loop.
 */
function scheduleFtsBackfill(): void {
  if (!ftsAvailable) return;
  const database = initDb();
  if (getMeta(database, 'fts_backfill_done') === '1') return;
  if (ftsBackfillScheduled) return;
  ftsBackfillScheduled = true;
  const pump = (): void => {
    try {
      if (ftsBackfillStep(database)) {
        ftsBackfillScheduled = false;
        return;
      }
      setImmediate(pump);
    } catch (err) {
      logger.warn(`FTS backfill failed: ${err instanceof Error ? err.message : err}`);
      ftsBackfillScheduled = false;
    }
  };
  setImmediate(pump);
}

export interface MessageSearchResult {
  sessionId: string;
  snippet: string;
  role: string;
  timestamp: number;
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each whitespace
 * token becomes a double-quoted phrase (any embedded `"` stripped first), so FTS5
 * operators (`*`, `(`, `)`, `-`, `NEAR`, `"`) are treated as literal text and can
 * never throw a syntax error. Space-separated phrases AND together implicitly, so
 * a multi-word query requires all words. Returns '' when nothing indexable remains.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, ''))
    .filter(Boolean)
    .map((tok) => `"${tok}"`)
    .join(' ');
}

/**
 * Full-text search over user/assistant message bodies, newest-first. `snippet`
 * wraps matched terms in «»; results are capped by `limit` (default 50). Triggers
 * the one-time backfill on first call so older history becomes searchable.
 */
export function searchMessages(query: string, limit = 50): MessageSearchResult[] {
  const db = initDb();
  if (!ftsAvailable) return [];
  scheduleFtsBackfill();
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(Math.floor(limit) || 50, 200));
  try {
    return db
      .prepare(
        `SELECT m.session_id AS sessionId,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                m.role AS role,
                m.timestamp AS timestamp
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      )
      .all(match, cap) as MessageSearchResult[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such table')) return [];
    throw err;
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    ['user_id', 'TEXT'],
    // No backfill: pre-existing sessions stay NULL (no excerpt); only new sessions populate it.
    ['prompt_excerpt', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string | null;
  model?: string;
  title?: string;
  parentSessionId?: string;
  userId?: string | null;
  effortLevel?: string;
  /**
   * Optional human-facing excerpt override. When the prompt is scaffolded
   * (e.g. talk delegation wraps the operator's ask in a brief + verbatim
   * block), callers pass the original ask here so list UIs don't show
   * scaffold junk. Still flattened/truncated via promptExcerptOf.
   */
  promptExcerpt?: string;
}

function getNextSessionNumber(): number {
  const db = initDb();
  // MAX(rowid) is an O(1) b-tree seek (COUNT(*) walks the whole table) and keeps
  // numbers monotonic even after deletions.
  const row = db.prepare('SELECT MAX(rowid) as maxRowid FROM sessions').get() as { maxRowid: number | null };
  return (row.maxRowid ?? 0) + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

/** Whitespace-flattened, ≤140-char excerpt of a prompt (undefined when empty). */
export function promptExcerptOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 140 ? flat.slice(0, 139).trimEnd() + '…' : flat;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const promptExcerpt = promptExcerptOf(opts.promptExcerpt) ?? promptExcerptOf(opts.prompt) ?? null;
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;

  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, prompt_excerpt, parent_session_id, user_id, effort_level, status, created_at, last_activity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);
  stmt.run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    opts.model ?? null,
    title,
    promptExcerpt,
    opts.parentSessionId ?? null,
    opts.userId ?? null,
    opts.effortLevel ?? null,
    now,
    now,
  );

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    promptExcerpt,
    parentSessionId: opts.parentSessionId ?? null,
    userId: opts.userId ?? null,
    effortLevel: opts.effortLevel ?? null,
    status: 'idle',
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engine?: string;
  engineSessionId?: string | null;
  status?: Session['status'];
  model?: string | null;
  effortLevel?: string | null;
  lastContextTokens?: number | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  userId?: string | null;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engine !== undefined) {
    sets.push('engine = ?');
    values.push(updates.engine);
  }
  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    sets.push('model = ?');
    values.push(updates.model);
  }
  if (updates.effortLevel !== undefined) {
    sets.push('effort_level = ?');
    values.push(updates.effortLevel);
  }
  if (updates.lastContextTokens !== undefined) {
    sets.push('last_context_tokens = ?');
    values.push(updates.lastContextTokens);
  }
  if (updates.replyContext !== undefined) {
    sets.push('reply_context = ?');
    values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null);
  }
  if (updates.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(updates.messageId);
  }
  if (updates.transportMeta !== undefined) {
    sets.push('transport_meta = ?');
    values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.userId !== undefined) {
    sets.push('user_id = ?');
    values.push(updates.userId);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push('engine = ?');
    values.push(filter.engine);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

// Sidebar groups sessions into cron, "direct" (no employee), and per-employee
// buckets. These sentinels mirror that grouping so the server can paginate and
// count per group without the client having to load every row. Keep this SQL in
// sync with isCronSession/isDirectSession in the web chat-sidebar.
export const CRON_GROUP = '__cron__';
export const DIRECT_GROUP = '__direct__';
const IS_CRON_SQL = `(source = 'cron' OR source_ref LIKE 'cron:%')`;

/**
 * A session whose `employee` equals the portal name (case-insensitively) is a
 * direct/COO session that happened to be tagged with the portal slug — there is
 * no org employee by that name. Collapse it to `null` so it buckets into the
 * direct group instead of spawning a phantom pseudo-employee group that renders
 * with the same title as the portal. Real org employees are unaffected.
 */
export function coercePortalEmployee(
  employee: string | null | undefined,
  portalName: string | null | undefined,
): string | null {
  const emp = employee?.trim();
  if (!emp) return null;
  const slug = portalName?.trim().toLowerCase();
  if (slug && emp.toLowerCase() === slug) return null;
  return emp;
}

// Build the CASE that maps a row to its sidebar group. When a portalSlug is
// supplied, portal-slug-tagged rows fold into the direct group (defensive +
// retroactive for any rows that predate coercePortalEmployee). Returns the SQL
// plus the bound params it references so callers can splice them in order.
function groupKeySql(portalSlug?: string | null): { sql: string; params: unknown[] } {
  const slug = portalSlug?.trim().toLowerCase();
  const directExtra = slug ? ` OR LOWER(employee) = ?` : '';
  const sql = `CASE
  WHEN ${IS_CRON_SQL} THEN '${CRON_GROUP}'
  WHEN employee IS NULL OR employee = ''${directExtra} THEN '${DIRECT_GROUP}'
  ELSE employee
END`;
  return { sql, params: slug ? [slug] : [] };
}

function groupFilter(group: string, portalSlug?: string | null): { clause: string; params: unknown[] } {
  const slug = portalSlug?.trim().toLowerCase();
  if (group === CRON_GROUP) return { clause: IS_CRON_SQL, params: [] };
  if (group === DIRECT_GROUP) {
    const directExtra = slug ? ` OR LOWER(employee) = ?` : '';
    return {
      clause: `NOT ${IS_CRON_SQL} AND (employee IS NULL OR employee = ''${directExtra})`,
      params: slug ? [slug] : [],
    };
  }
  // A per-employee page must never leak portal-slug rows (they live in direct).
  // If the requested group *is* the portal slug, this yields nothing.
  const slugExclude = slug ? ` AND LOWER(employee) <> ?` : '';
  return {
    clause: `NOT ${IS_CRON_SQL} AND employee = ?${slugExclude}`,
    params: slug ? [group, slug] : [group],
  };
}

/** Most-recent `perGroup` sessions for each group — the bounded default payload. */
export function listRecentPerGroup(perGroup: number, portalSlug?: string | null): Session[] {
  const db = initDb();
  const { sql: keySql, params } = groupKeySql(portalSlug);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keySql} ORDER BY last_activity DESC) AS __rn
         FROM sessions
       ) WHERE __rn <= ? ORDER BY last_activity DESC`,
    )
    .all(...params, perGroup) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** One group's sessions, newest first — used by the sidebar "load more" button. */
export function listSessionsForGroup(
  group: string,
  limit: number,
  offset: number,
  portalSlug?: string | null,
): Session[] {
  const db = initDb();
  const { clause, params } = groupFilter(group, portalSlug);
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE ${clause} ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Search across ALL sessions by title / employee / id (newest first, bounded). */
export function searchSessions(query: string, limit = 100): Session[] {
  const db = initDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE title LIKE ? ESCAPE '\\' OR employee LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
       ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(like, like, like, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Recent sessions for a given source, newest first (bounded). */
export function listSessionsBySource(source: string, limit: number): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE source = ? ORDER BY last_activity DESC LIMIT ?`)
    .all(source, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Child sessions of a parent — backed by idx_sessions_parent. */
export function listChildSessions(parentSessionId: string): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY last_activity DESC`)
    .all(parentSessionId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Total session count per group, so the UI can show accurate "+N more". */
export function getSessionGroupCounts(portalSlug?: string | null): Record<string, number> {
  const db = initDb();
  const { sql: keySql, params } = groupKeySql(portalSlug);
  const rows = db
    .prepare(`SELECT ${keySql} AS grp, COUNT(*) AS n FROM sessions GROUP BY grp`)
    .all(...params) as Array<{ grp: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.grp] = r.n;
  return out;
}

/**
 * Mark any sessions stuck in "running" status as "interrupted".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 * Sessions with an engine_session_id can be resumed via the Claude --resume flag.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE sessions SET status = 'interrupted', last_activity = ?, last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running'",
  ).run(now);
  return result.changes;
}

/**
 * Get sessions that were interrupted by a gateway restart and can be resumed.
 * A session is resumable if it has an engine_session_id (Claude's internal session ID).
 */
export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Accumulate cost and turns for a session (called after each engine run).
 */
export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare(
    'UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?',
  ).run(cost, turns, id);
}

/**
 * Duplicate a session and all its messages, returning a new session with a fresh ID.
 * Does NOT fork the engine session — the caller handles that separately.
 */
export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;

  // Copy session + messages in a single transaction for consistency
  const messages = db.prepare(
    'SELECT role, content, timestamp, media, blocks FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number; media: string | null; blocks: string | null }>;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, model, title, parent_session_id, effort_level, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      source.transportMeta ? JSON.stringify(source.transportMeta) : null,
      source.employee,
      source.model,
      title,
      source.effortLevel,
      now,
      now,
    );

    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp, msg.media ?? null, msg.blocks ?? null);
    }
  });
  txn();

  const newSession = getSession(newId)!;
  return { session: newSession, messageCount: messages.length };
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM queue_items WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM queue_items WHERE session_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  });
  return txn();
}

/** Attachment descriptor stored alongside a message and rendered by the web UI. */
export interface MessageMedia {
  type: 'image' | 'audio' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  /** Parsed from the `media` JSON column; undefined when the message has no attachments. */
  media?: MessageMedia[];
  /** True for a live mid-turn block. Most engines replace these at turn end. */
  partial?: boolean;
  /** Tool name when this block is a tool call — lets a reloaded block render as a tool card. */
  toolCall?: string;
  /** Structured Chat Mode blocks rendered by the web UI. */
  blocks?: ChatBlock[];
}

interface MessageRow {
  rowid: number;
  id: string;
  role: string;
  content: string;
  timestamp: number;
  media: string | null;
  partial: number | null;
  seq: number | null;
  tool_call: string | null;
  blocks: string | null;
}

export interface MessagePage {
  messages: SessionMessage[];
  hasOlder: boolean;
}

export interface MessagePageOptions {
  /** Fetch messages strictly older than this message id. Omit for the newest tail. */
  before?: string;
  /** Number of messages to return. Clamped to a bounded positive page size. */
  limit?: number;
}

function parseMediaColumn(value: unknown): MessageMedia[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageMedia[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseBlocksColumn(value: unknown): ChatBlock[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const blocks = parsed.flatMap((block) => {
      const result = validateBlockEnvelope({ op: "put", block });
      return result.ok ? [result.envelope.block] : [];
    });
    return blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(r: MessageRow): SessionMessage {
  const msg: SessionMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
  const media = parseMediaColumn(r.media);
  const blocks = parseBlocksColumn(r.blocks);
  if (media) msg.media = media;
  if (blocks) msg.blocks = blocks;
  if (r.partial) msg.partial = true;
  if (r.tool_call) msg.toolCall = r.tool_call;
  return msg;
}

function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return 100;
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function blockFallbackCandidates(block: ChatBlock, fallbackText?: string): string[] {
  return [
    fallbackText,
    blockFallbackText(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isSyntheticBlockContent(content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  const trimmed = content.trim();
  return blockFallbackCandidates(block, fallbackText).some((candidate) => candidate.trim() === trimmed);
}

function isSyntheticBlockRow(rowId: string, content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  if (rowId.startsWith(`block-${block.id}-`)) return true;
  return isSyntheticBlockContent(content, block, fallbackText);
}

export function insertMessage(sessionId: string, role: string, content: string, media?: MessageMedia[], blocks?: ChatBlock[]): string {
  const db = initDb();
  const id = uuidv4();
  const mediaJson = media && media.length > 0 ? JSON.stringify(media) : null;
  const blocksJson = blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, sessionId, role, content, Date.now(), mediaJson, blocksJson,
  );
  return id;
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, blocks FROM messages WHERE session_id = ? ORDER BY timestamp ASC, COALESCE(seq, 0) ASC, rowid ASC')
    .all(sessionId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessagePage(sessionId: string, options: MessagePageOptions = {}): MessagePage {
  const db = initDb();
  const limit = normalizeMessagePageLimit(options.limit);
  const pageLimit = limit + 1;
  let rows: MessageRow[];

  if (options.before) {
    const cursor = db
      .prepare('SELECT rowid, timestamp, COALESCE(seq, 0) AS seq_order FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, options.before) as { rowid: number; timestamp: number; seq_order: number } | undefined;
    if (!cursor) return { messages: [], hasOlder: false };

    rows = db
      .prepare(`
        SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, blocks
        FROM messages
        WHERE session_id = ?
          AND (
            timestamp < ?
            OR (timestamp = ? AND COALESCE(seq, 0) < ?)
            OR (timestamp = ? AND COALESCE(seq, 0) = ? AND rowid < ?)
          )
        ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC
        LIMIT ?
      `)
      .all(
        sessionId,
        cursor.timestamp,
        cursor.timestamp,
        cursor.seq_order,
        cursor.timestamp,
        cursor.seq_order,
        cursor.rowid,
        pageLimit,
      ) as MessageRow[];
  } else {
    rows = db
      .prepare(`
        SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, blocks
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC
        LIMIT ?
      `)
      .all(sessionId, pageLimit) as MessageRow[];
  }

  const hasOlder = rows.length > limit;
  const pageRows = (hasOlder ? rows.slice(0, limit) : rows).reverse();
  return { messages: pageRows.map(rowToMessage), hasOlder };
}

export function applyBlockEnvelope(
  sessionId: string,
  input: ChatBlockEnvelope,
  fallbackText?: string,
  options?: { partial?: boolean; seq?: number },
): string | null {
  const result = validateBlockEnvelope(input);
  if (!result.ok) throw new Error(result.error);
  const envelope = result.envelope;
  const db = initDb();
  const partialOnly = options?.partial === true;
  const rows = db
    .prepare(`SELECT id, content, blocks FROM messages WHERE session_id = ? AND role = ?${partialOnly ? ' AND partial = 1' : ''} ORDER BY timestamp ASC, seq ASC`)
    .all(sessionId, 'assistant') as Array<{ id: string; content: string; blocks: string | null }>;
  const existing = rows
    .map((row) => ({ row, blocks: parseBlocksColumn(row.blocks) ?? [] }))
    .find((entry) => entry.blocks.some((block) => block.id === envelope.block.id));

  if (envelope.op === 'remove') {
    if (!existing) return null;
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const remainingBlocks = existing.blocks.filter((block) => block.id !== envelope.block.id);
    if (remainingBlocks.length > 0) {
      db.prepare('UPDATE messages SET blocks = ? WHERE id = ?').run(JSON.stringify(remainingBlocks), existing.row.id);
    } else if (isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(existing.row.id);
    } else {
      db.prepare('UPDATE messages SET blocks = NULL WHERE id = ?').run(existing.row.id);
    }
    return existing.row.id;
  }

  if (existing) {
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const nextBlocks = existing.blocks.map((block) =>
      block.id === envelope.block.id
        ? envelope.op === "patch" ? mergeBlock(block, envelope.block) : envelope.block
        : block,
    );
    const target = nextBlocks.find((block) => block.id === envelope.block.id) ?? envelope.block;
    const nextContent = isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)
      ? fallbackText?.trim() || blockFallbackText(target)
      : existing.row.content;
    db.prepare('UPDATE messages SET content = ?, blocks = ? WHERE id = ?').run(
      nextContent,
      JSON.stringify(nextBlocks),
      existing.row.id,
    );
    return existing.row.id;
  }

  if (envelope.op === 'patch') return null;

  const id = `block-${envelope.block.id}-${uuidv4()}`;
  if (partialOnly) {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, blocks) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      options?.seq ?? 0,
      JSON.stringify([envelope.block]),
    );
  } else {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      JSON.stringify([envelope.block]),
    );
  }
  return id;
}

/**
 * Insert a live mid-turn block (`partial=1`). `seq` orders blocks within the turn;
 * `toolCall` is set when the block is a tool call (renders as a tool card on reload).
 * These rows are usually wiped by `deletePartialMessages` at turn end.
 */
export function insertPartialMessage(sessionId: string, role: string, content: string, seq: number, toolCall?: string): string {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, tool_call) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
    id, sessionId, role, content, Date.now(), seq, toolCall ?? null,
  );
  return id;
}

/** Grow the current partial text block in place (debounced text streaming). */
export function updatePartialMessage(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ? AND partial = 1').run(content, id);
}

/** Replace a stored (non-partial) message's text in place. Used by external-turn
 *  sync to upgrade a truncated early-Stop assistant row to the complete transcript
 *  text instead of inserting a duplicate row. */
export function updateMessageContent(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

/** Delete all live partial blocks for a session (called at turn end before the final insert). */
export function deletePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

/** Keep streamed blocks as canonical history. Used by engines whose final
 * answer is already represented as interleaved text + tool rows. */
export function finalizePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('UPDATE messages SET partial = NULL WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

/** Boot sweep: drop any partial blocks stranded by a mid-turn gateway restart. */
export function clearAllPartialMessages(): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE partial = 1').run().changes;
}

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE id = ?"
  ).get(itemId) as QueueItem | undefined;
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC"
  ).all(sessionKey) as QueueItem[];
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all() as QueueItem[];
}

// ── File management ──────────────────────────────────────────────────

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: { id: string; filename: string; size: number; mimetype: string | null; path: string | null }): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, now,
  );
  return { ...meta, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Update the recorded on-disk path for a file (used when re-homing into the uploads dir). */
export function setFilePath(id: string, filePath: string): void {
  const db = initDb();
  db.prepare('UPDATE files SET path = ? WHERE id = ?').run(filePath, id);
}
