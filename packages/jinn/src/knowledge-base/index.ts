import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { logger } from "../shared/logger.js"
import { KB_DIR } from "../shared/paths.js"
import { chunkText, listRepoFiles, type Chunk, type ChunkOptions } from "./chunking.js"
import { embed, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js"
import { initKbDb, replaceFileChunks, deleteFileChunks, resetKb, countChunks, countFiles, getIndexedFile, listIndexedFiles, touchIndexedFile, type ChunkInsert } from "./store.js"
import { readManifest, writeManifest, KB_SCHEMA_VERSION, type KbManifest } from "./manifest.js"

/**
 * The learning phase (full index) and incremental update entry points
 * (docs/tengu/18-council-specialists.md): the orchestration layer that walks
 * `chunking.ts`, embeds via `embeddings.ts`, and writes through `store.ts`,
 * keeping `manifest.ts` in sync at every run.
 */

export interface KbEmployee {
  name: string
  /** Absolute or `~`-relative repo path, same shape as `Employee.repo`. */
  repo: string
}

export interface RunKbOptions {
  /** Overrides `~/.{instance}/kb` — tests only. */
  kbRoot?: string
  embeddingModel?: string
  chunkOptions?: ChunkOptions
}

export interface RunLearningPhaseResult {
  manifest: KbManifest
  fileCount: number
  chunkCount: number
}

export interface RunIncrementalUpdateResult {
  manifest: KbManifest
  changedFiles: string[]
  removedFiles: string[]
  /** True when the diff-against-git-sha path was unavailable (no manifest, a
   *  schema mismatch, a non-git repo, or a stale/unreachable sha) and the
   *  mtime+hash walk ran instead. */
  usedFallbackWalk: boolean
}

const EMBED_BATCH_SIZE = 64

/**
 * `Employee.repo` is stored `~`-relative or absolute (`shared/session-cwd.ts`
 * deliberately leaves `~` unexpanded — resolution is "the engine's job" when
 * the value becomes a child-process cwd the shell can interpret). Node's `fs`
 * and `execFileSync` do not get that shell interpretation, so this subsystem
 * — which walks the filesystem and shells out to git directly — expands it
 * itself before ever touching the path.
 */
function resolveRepoRoot(repo: string): string {
  if (repo === "~") return os.homedir()
  if (repo.startsWith("~/")) return path.join(os.homedir(), repo.slice(2))
  return path.resolve(repo)
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim()
}

function isGitRepo(cwd: string): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true"
  } catch {
    return false
  }
}

function currentGitSha(cwd: string): string | undefined {
  try {
    return git(["rev-parse", "HEAD"], cwd)
  } catch {
    return undefined
  }
}

interface GitDiff {
  changed: string[]
  removed: string[]
}

/** Parse `git diff --name-status` output. A rename/copy contributes its old
 *  path to `removed` and its new path to `changed` — exactly the same net
 *  effect as an independent delete-then-add, which is how the store treats it. */
function parseGitDiffNameStatus(output: string): GitDiff {
  const changed: string[] = []
  const removed: string[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const fields = line.split("\t")
    const status = fields[0]
    if (status.startsWith("R") || status.startsWith("C")) {
      const [, from, to] = fields
      if (from) removed.push(from)
      if (to) changed.push(to)
    } else if (status === "D") {
      if (fields[1]) removed.push(fields[1])
    } else {
      // A (added), M (modified), T (type change), and anything else with a
      // single path all land in the store the same way: re-chunk and replace.
      if (fields[1]) changed.push(fields[1])
    }
  }
  return { changed, removed }
}

function diffAgainstSha(repoRoot: string, fromSha: string): GitDiff | undefined {
  try {
    const output = git(["diff", "--name-status", fromSha, "HEAD"], repoRoot)
    return parseGitDiffNameStatus(output)
  } catch (err) {
    logger.warn(`knowledge-base/index: git diff --name-status ${fromSha}..HEAD failed in ${repoRoot}: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

function hashFile(absPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex")
}

async function embedTexts(texts: string[], model: string): Promise<number[][]> {
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE)
    vectors.push(...(await embed(batch, { model })))
  }
  return vectors
}

async function chunkAndEmbedFile(
  repoRoot: string,
  relPath: string,
  model: string,
  chunkOptions: ChunkOptions | undefined,
): Promise<{ chunks: Chunk[]; inserts: ChunkInsert[] }> {
  const absPath = path.join(repoRoot, relPath)
  const content = fs.readFileSync(absPath, "utf8")
  const chunks = chunkText(relPath, content, chunkOptions)
  const vectors = await embedTexts(chunks.map((chunk) => chunk.text), model)
  const inserts: ChunkInsert[] = chunks.map((chunk, i) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName ?? null,
    text: chunk.text,
    contentHash: chunk.contentHash,
    source: "code",
    embedding: vectors[i],
  }))
  return { chunks, inserts }
}

function buildManifest(employee: KbEmployee, repoRoot: string, model: string, db: ReturnType<typeof initKbDb>): KbManifest {
  return {
    employeeName: employee.name,
    repo: repoRoot,
    lastIndexedAt: new Date().toISOString(),
    lastIndexedGitSha: currentGitSha(repoRoot) ?? null,
    fileCount: countFiles(db),
    chunkCount: countChunks(db),
    embeddingModel: model,
    schemaVersion: KB_SCHEMA_VERSION,
  }
}

/**
 * Full walk + embed + write for one specialist. Wipes and rebuilds the store
 * from scratch — the safe, simple starting state for the first learning pass
 * and for any later forced re-learn (a stale/corrupt manifest is not this
 * function's problem to reconcile; `runIncrementalUpdate` owns that).
 */
export async function runLearningPhase(employee: KbEmployee, options: RunKbOptions = {}): Promise<RunLearningPhaseResult> {
  const repoRoot = resolveRepoRoot(employee.repo)
  const model = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  const db = initKbDb(employee.name, options.kbRoot)
  resetKb(db)

  const files = listRepoFiles(repoRoot)
  logger.info(`knowledge-base/index: learning phase starting for ${employee.name} (${repoRoot}, ${files.length} file(s))`)
  for (const file of files) {
    const { inserts } = await chunkAndEmbedFile(repoRoot, file.relPath, model, options.chunkOptions)
    const stat = fs.statSync(file.absPath)
    replaceFileChunks(db, file.relPath, inserts, { mtimeMs: stat.mtimeMs, contentHash: hashFile(file.absPath) })
  }

  const manifest = buildManifest(employee, repoRoot, model, db)
  writeManifest(employee.name, manifest, options.kbRoot)
  logger.info(`knowledge-base/index: learning phase done for ${employee.name} — ${manifest.fileCount} file(s), ${manifest.chunkCount} chunk(s)`)
  return { manifest, fileCount: manifest.fileCount, chunkCount: manifest.chunkCount }
}

async function reindexFiles(
  db: ReturnType<typeof initKbDb>,
  repoRoot: string,
  relPaths: readonly string[],
  eligible: ReadonlyMap<string, { relPath: string; absPath: string }>,
  model: string,
  chunkOptions: ChunkOptions | undefined,
): Promise<string[]> {
  const applied: string[] = []
  for (const relPath of relPaths) {
    const file = eligible.get(relPath)
    if (!file) {
      // No longer an eligible source file (deleted, now ignored, now binary, …) —
      // drop anything previously indexed for it rather than leaving it stale.
      deleteFileChunks(db, relPath)
      continue
    }
    const { inserts } = await chunkAndEmbedFile(repoRoot, relPath, model, chunkOptions)
    const stat = fs.statSync(file.absPath)
    replaceFileChunks(db, relPath, inserts, { mtimeMs: stat.mtimeMs, contentHash: hashFile(file.absPath) })
    applied.push(relPath)
  }
  return applied
}

/** mtime+hash fallback: full walk, per-file change detection against `kb_files`. */
async function runMtimeHashWalk(
  db: ReturnType<typeof initKbDb>,
  repoRoot: string,
  eligible: ReadonlyMap<string, { relPath: string; absPath: string }>,
  model: string,
  chunkOptions: ChunkOptions | undefined,
): Promise<{ changed: string[]; removed: string[] }> {
  const changed: string[] = []
  const removed: string[] = []
  const previouslyIndexed = new Set(listIndexedFiles(db).map((f) => f.path))

  for (const file of eligible.values()) {
    const stat = fs.statSync(file.absPath)
    const existing = getIndexedFile(db, file.relPath)
    if (existing && existing.mtimeMs === stat.mtimeMs) continue
    const contentHash = hashFile(file.absPath)
    if (existing && existing.contentHash === contentHash) {
      // Only the mtime moved (e.g. a checkout touched it) — nothing to redo,
      // but refresh the bookkeeping so the NEXT walk short-circuits again.
      touchIndexedFile(db, file.relPath, stat.mtimeMs, contentHash, existing.chunkCount)
      continue
    }
    const { inserts } = await chunkAndEmbedFile(repoRoot, file.relPath, model, chunkOptions)
    replaceFileChunks(db, file.relPath, inserts, { mtimeMs: stat.mtimeMs, contentHash })
    changed.push(file.relPath)
  }

  for (const indexedPath of previouslyIndexed) {
    if (!eligible.has(indexedPath)) {
      deleteFileChunks(db, indexedPath)
      removed.push(indexedPath)
    }
  }

  return { changed, removed }
}

/**
 * Incremental update for one specialist: diffs against `manifest.lastIndexedGitSha`
 * via `git diff --name-status` when possible, re-chunking/re-embedding only the
 * files that changed and deleting rows for files that were removed. Falls back
 * to a full mtime+hash walk (still incremental in effect — only files whose
 * mtime or content hash moved are re-chunked) when the repo isn't git, or the
 * manifest is missing, schema-mismatched, or its recorded sha is no longer
 * reachable (e.g. history was rewritten).
 */
export async function runIncrementalUpdate(employee: KbEmployee, options: RunKbOptions = {}): Promise<RunIncrementalUpdateResult> {
  const repoRoot = resolveRepoRoot(employee.repo)
  const model = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  const db = initKbDb(employee.name, options.kbRoot)
  const eligible = new Map(listRepoFiles(repoRoot).map((f) => [f.relPath, f]))

  const manifest = readManifest(employee.name, options.kbRoot)
  const canDiff = !!manifest && manifest.schemaVersion === KB_SCHEMA_VERSION && isGitRepo(repoRoot) && !!manifest.lastIndexedGitSha
  const diff = canDiff ? diffAgainstSha(repoRoot, manifest!.lastIndexedGitSha!) : undefined

  let changedFiles: string[]
  let removedFiles: string[]
  let usedFallbackWalk: boolean

  if (diff) {
    changedFiles = await reindexFiles(db, repoRoot, diff.changed, eligible, model, options.chunkOptions)
    for (const relPath of diff.removed) deleteFileChunks(db, relPath)
    removedFiles = diff.removed
    usedFallbackWalk = false
    logger.info(`knowledge-base/index: incremental update for ${employee.name} via git diff — ${changedFiles.length} changed, ${removedFiles.length} removed`)
  } else {
    const walk = await runMtimeHashWalk(db, repoRoot, eligible, model, options.chunkOptions)
    changedFiles = walk.changed
    removedFiles = walk.removed
    usedFallbackWalk = true
    logger.info(`knowledge-base/index: incremental update for ${employee.name} via mtime+hash fallback — ${changedFiles.length} changed, ${removedFiles.length} removed`)
  }

  const nextManifest = buildManifest(employee, repoRoot, model, db)
  writeManifest(employee.name, nextManifest, options.kbRoot)
  return { manifest: nextManifest, changedFiles, removedFiles, usedFallbackWalk }
}
