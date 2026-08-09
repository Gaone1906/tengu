import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { KB_DIR } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import { EMBEDDING_DIMENSIONS } from "./embeddings.js"

/**
 * Per-specialist vector store (docs/tengu/18-council-specialists.md): one
 * SQLite file per employee at `~/.{instance}/kb/<employeeName>/index.sqlite3`,
 * `sqlite-vec`'s `vec0` virtual table loaded as a `better-sqlite3` extension
 * for chunk vectors, plus a plain table for chunk metadata/text. A third,
 * `kb_files` table tracks one row per indexed source file (mtime + whole-file
 * hash) so `runIncrementalUpdate`'s mtime+hash fallback (`index.ts`) never
 * needs to reload every chunk to know what changed.
 *
 * `vec0` requires its `rowid` bound as a JS BigInt — a plain JS number binds
 * as SQLITE_FLOAT for this virtual table's stricter type check and is
 * rejected ("Only integers are allowed for primary key values"), unlike an
 * ordinary rowid table where better-sqlite3's integer binding is accepted as-is.
 */

export type KbChunkSource = "code" | "teaching"

export interface StoredChunk {
  id: number
  path: string
  startLine: number
  endLine: number
  symbolName: string | null
  text: string
  contentHash: string
  source: KbChunkSource
  createdAt: string
}

export interface ChunkInsert {
  path: string
  startLine: number
  endLine: number
  symbolName?: string | null
  text: string
  contentHash: string
  source: KbChunkSource
  embedding: number[]
}

export interface KbFileRecord {
  path: string
  mtimeMs: number
  contentHash: string
  chunkCount: number
  updatedAt: string
}

export interface ChunkSearchHit extends StoredChunk {
  distance: number
}

const CREATE_KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  symbol_name TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('code', 'teaching')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_path ON kb_chunks(path);
`

function createVectorTableSql(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_vectors USING vec0(embedding float[${EMBEDDING_DIMENSIONS}]);`
}

const dbCache = new Map<string, Database.Database>()

export function resolveKbDir(employeeName: string, kbRoot: string = KB_DIR): string {
  return path.join(kbRoot, employeeName)
}

export function resolveKbDbPath(employeeName: string, kbRoot: string = KB_DIR): string {
  return path.join(resolveKbDir(employeeName, kbRoot), "index.sqlite3")
}

/** Open (or reuse) the per-specialist KB database, running its DDL and loading
 *  the `vec0` extension. Cached by resolved db path — repeated calls for the
 *  same specialist (and the same `kbRoot` override) return the same connection. */
export function initKbDb(employeeName: string, kbRoot: string = KB_DIR): Database.Database {
  const dbPath = resolveKbDbPath(employeeName, kbRoot)
  const cached = dbCache.get(dbPath)
  if (cached) return cached

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const database = new Database(dbPath)
  database.pragma("busy_timeout = 10000")
  database.pragma("journal_mode = WAL")
  sqliteVec.load(database)
  database.exec(CREATE_KB_SCHEMA)
  database.exec(createVectorTableSql())
  dbCache.set(dbPath, database)
  logger.info(`knowledge-base/store: opened KB for ${employeeName} at ${dbPath}`)
  return database
}

/** Test-only restart seam, mirroring `shared/db.ts`'s `__closeDbForTest`. */
export function closeKbDb(employeeName: string, kbRoot: string = KB_DIR): void {
  const dbPath = resolveKbDbPath(employeeName, kbRoot)
  const cached = dbCache.get(dbPath)
  if (!cached) return
  cached.close()
  dbCache.delete(dbPath)
}

function serializeVector(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer)
}

function rowToChunk(row: Record<string, unknown>): StoredChunk {
  return {
    id: row.id as number,
    path: row.path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    symbolName: (row.symbol_name as string) ?? null,
    text: row.text as string,
    contentHash: row.content_hash as string,
    source: row.source as KbChunkSource,
    createdAt: row.created_at as string,
  }
}

function rowToFileRecord(row: Record<string, unknown>): KbFileRecord {
  return {
    path: row.path as string,
    mtimeMs: row.mtime_ms as number,
    contentHash: row.content_hash as string,
    chunkCount: row.chunk_count as number,
    updatedAt: row.updated_at as string,
  }
}

function deleteChunksForPathTxn(db: Database.Database, filePath: string): void {
  const ids = db.prepare("SELECT id FROM kb_chunks WHERE path = ?").pluck().all(filePath) as number[]
  if (ids.length > 0) {
    const deleteVector = db.prepare("DELETE FROM kb_chunk_vectors WHERE rowid = ?")
    for (const id of ids) deleteVector.run(BigInt(id))
    db.prepare("DELETE FROM kb_chunks WHERE path = ?").run(filePath)
  }
  db.prepare("DELETE FROM kb_files WHERE path = ?").run(filePath)
}

/** Delete every chunk (metadata + vector) indexed for one source file, and its
 *  `kb_files` bookkeeping row. Used for files a diff reports as removed, and as
 *  the first half of `replaceFileChunks`'s reindex-in-place. A no-op (beyond
 *  the `kb_files` delete, itself a no-op if absent) when the file was never
 *  indexed — callers don't need to check first. */
export function deleteFileChunks(db: Database.Database, filePath: string): void {
  const txn = db.transaction(() => deleteChunksForPathTxn(db, filePath))
  txn()
}

/** Replace everything indexed for one source file: deletes its existing chunks
 *  (if any) and inserts the given ones, updating `kb_files`. One transaction,
 *  so a reader never observes the file half-reindexed. `chunks` may be empty
 *  (a file that chunked to nothing still gets its `kb_files` row updated). */
export function replaceFileChunks(
  db: Database.Database,
  filePath: string,
  chunks: readonly ChunkInsert[],
  fileMeta: { mtimeMs: number; contentHash: string },
): void {
  const now = new Date().toISOString()
  const insertChunk = db.prepare(
    `INSERT INTO kb_chunks (path, start_line, end_line, symbol_name, text, content_hash, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertVector = db.prepare("INSERT INTO kb_chunk_vectors (rowid, embedding) VALUES (?, ?)")
  const upsertFile = db.prepare(
    `INSERT INTO kb_files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash,
       chunk_count = excluded.chunk_count, updated_at = excluded.updated_at`,
  )

  const txn = db.transaction(() => {
    deleteChunksForPathTxn(db, filePath)
    for (const chunk of chunks) {
      const info = insertChunk.run(
        chunk.path,
        chunk.startLine,
        chunk.endLine,
        chunk.symbolName ?? null,
        chunk.text,
        chunk.contentHash,
        chunk.source,
        now,
      )
      insertVector.run(BigInt(info.lastInsertRowid as number), serializeVector(chunk.embedding))
    }
    upsertFile.run(filePath, fileMeta.mtimeMs, fileMeta.contentHash, chunks.length, now)
  })
  txn()
}

/** Clear every table — the full learning phase re-indexes from a blank slate
 *  rather than reconciling against whatever a prior (possibly stale) run left. */
export function resetKb(db: Database.Database): void {
  const txn = db.transaction(() => {
    db.exec("DELETE FROM kb_chunk_vectors")
    db.exec("DELETE FROM kb_chunks")
    db.exec("DELETE FROM kb_files")
  })
  txn()
}

/** Refresh a `kb_files` row's mtime/hash bookkeeping without touching its
 *  chunks — for the mtime+hash fallback walk's "only the mtime moved, content
 *  is unchanged" case, where re-chunking and re-embedding would be wasted work. */
export function touchIndexedFile(db: Database.Database, filePath: string, mtimeMs: number, contentHash: string, chunkCount: number): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO kb_files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
  ).run(filePath, mtimeMs, contentHash, chunkCount, now)
}

export function getIndexedFile(db: Database.Database, filePath: string): KbFileRecord | undefined {
  const row = db.prepare("SELECT * FROM kb_files WHERE path = ?").get(filePath) as Record<string, unknown> | undefined
  return row ? rowToFileRecord(row) : undefined
}

export function listIndexedFiles(db: Database.Database): KbFileRecord[] {
  return (db.prepare("SELECT * FROM kb_files ORDER BY path").all() as Record<string, unknown>[]).map(rowToFileRecord)
}

export function listChunksForPath(db: Database.Database, filePath: string): StoredChunk[] {
  return (db.prepare("SELECT * FROM kb_chunks WHERE path = ? ORDER BY start_line").all(filePath) as Record<string, unknown>[]).map(rowToChunk)
}

/** Fetch one chunk by its `kb_chunks.id` — the read half of `read_repo_chunk`,
 *  given the id a prior `search_repo_knowledge` hit returned. */
export function getChunkById(db: Database.Database, id: number): StoredChunk | undefined {
  const row = db.prepare("SELECT * FROM kb_chunks WHERE id = ?").get(id) as Record<string, unknown> | undefined
  return row ? rowToChunk(row) : undefined
}

export function countChunks(db: Database.Database): number {
  return db.prepare("SELECT COUNT(*) FROM kb_chunks").pluck().get() as number
}

export function countFiles(db: Database.Database): number {
  return db.prepare("SELECT COUNT(*) FROM kb_files").pluck().get() as number
}

/** Nearest-neighbor search over the specialist's chunk vectors — the read path
 *  `knowledge-base/retrieval.ts` sits on top of. Kept here rather than there
 *  since it is the one query that touches `kb_chunk_vectors` directly. */
export function searchChunks(db: Database.Database, queryEmbedding: number[], limit: number): ChunkSearchHit[] {
  if (limit <= 0) return []
  const matches = db
    .prepare("SELECT rowid, distance FROM kb_chunk_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance")
    .all(serializeVector(queryEmbedding), limit) as Array<{ rowid: number; distance: number }>
  if (matches.length === 0) return []
  const distanceById = new Map(matches.map((match) => [match.rowid, match.distance]))
  const placeholders = matches.map(() => "?").join(", ")
  const rows = db
    .prepare(`SELECT * FROM kb_chunks WHERE id IN (${placeholders})`)
    .all(...matches.map((match) => match.rowid)) as Record<string, unknown>[]
  return rows
    .map((row) => ({ ...rowToChunk(row), distance: distanceById.get(row.id as number) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.distance - b.distance)
}
