import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// The lower layers (chunking.ts, embeddings.ts) already have their own unit
// tests, including one against the real ONNX model. These tests exercise
// index.ts's orchestration — diffing, what gets re-embedded, store/manifest
// wiring — so `embed` is replaced with a deterministic, near-instant fake that
// still produces `EMBEDDING_DIMENSIONS`-length vectors (store.ts's vec0 table
// is sized to that constant; a mismatched length would break the real code path).
const embedCalls: string[] = []
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>()
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => {
      embedCalls.push(...texts)
      return texts.map((text) => {
        const seed = crypto.createHash("sha1").update(text).digest()
        return Array.from({ length: actual.EMBEDDING_DIMENSIONS }, (_, i) => seed[i % seed.length] / 255)
      })
    }),
  }
})

import { runLearningPhase, runIncrementalUpdate } from "../index.js"
import { initKbDb, closeKbDb, listChunksForPath, listIndexedFiles, countFiles, countChunks } from "../store.js"
import { readManifest } from "../manifest.js"

let repoRoot: string
let kbRoot: string
const employeeName = "acme-engineer"
const CHUNK_OPTIONS = { minChunkTokens: 10, maxChunkTokens: 40, overlapTokens: 5 }

function employee() {
  return { name: employeeName, repo: repoRoot }
}

function write(relPath: string, content: string): void {
  const abs = path.join(repoRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
}

function initGitRepo(): void {
  git(["init", "-q"])
  git(["config", "user.email", "kb-test@example.com"])
  git(["config", "user.name", "KB Test"])
}

function commitAll(message: string): void {
  git(["add", "-A"])
  git(["commit", "-q", "-m", message])
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-index-repo-"))
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-index-kb-"))
  embedCalls.length = 0
})

afterEach(() => {
  closeKbDb(employeeName, kbRoot)
  fs.rmSync(repoRoot, { recursive: true, force: true })
  fs.rmSync(kbRoot, { recursive: true, force: true })
})

describe("runLearningPhase", () => {
  it("walks a synthetic repo, embeds every chunk, and produces the expected chunk/manifest state", async () => {
    initGitRepo()
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    write("src/b.ts", "export function sub(a, b) {\n  return a - b\n}\n")
    write("README.md", "# demo repo\n\nJust a fixture.\n")
    commitAll("initial")

    const result = await runLearningPhase(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(result.fileCount).toBe(3)
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(result.manifest.employeeName).toBe(employeeName)
    expect(result.manifest.repo).toBe(repoRoot)
    expect(result.manifest.lastIndexedGitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.manifest.schemaVersion).toBe(1)
    expect(result.manifest.embeddingModel).toBeTruthy()

    const db = initKbDb(employeeName, kbRoot)
    expect(countFiles(db)).toBe(3)
    expect(countChunks(db)).toBe(result.chunkCount)
    expect(listChunksForPath(db, "src/a.ts").length).toBeGreaterThan(0)
    expect(listChunksForPath(db, "README.md").length).toBeGreaterThan(0)

    const onDisk = readManifest(employeeName, kbRoot)
    expect(onDisk).toEqual(result.manifest)
  })

  it("wipes and rebuilds from scratch on a repeat run rather than accumulating duplicates", async () => {
    initGitRepo()
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    commitAll("initial")

    const first = await runLearningPhase(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })
    const second = await runLearningPhase(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(second.chunkCount).toBe(first.chunkCount)
    const db = initKbDb(employeeName, kbRoot)
    expect(countChunks(db)).toBe(first.chunkCount)
  })
})

describe("runIncrementalUpdate", () => {
  it("diffs against the manifest's git sha and re-embeds only the modified file's chunks", async () => {
    initGitRepo()
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    write("src/b.ts", "export function sub(a, b) {\n  return a - b\n}\n")
    commitAll("initial")
    const initial = await runLearningPhase(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    const db = initKbDb(employeeName, kbRoot)
    const bChunksBefore = listChunksForPath(db, "src/b.ts")
    expect(bChunksBefore.length).toBeGreaterThan(0)

    embedCalls.length = 0
    write("src/a.ts", "export function add(a, b) {\n  return a + b + 1\n}\n")
    commitAll("modify a")

    const result = await runIncrementalUpdate(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(result.usedFallbackWalk).toBe(false)
    expect(result.changedFiles).toEqual(["src/a.ts"])
    expect(result.removedFiles).toEqual([])
    // Only src/a.ts's content should ever have reached embed().
    expect(embedCalls.some((text) => text.includes("a - b"))).toBe(false)
    expect(embedCalls.some((text) => text.includes("+ 1"))).toBe(true)

    // src/b.ts's stored rows are byte-for-byte the same rows — untouched.
    expect(listChunksForPath(db, "src/b.ts")).toEqual(bChunksBefore)

    const aChunksAfter = listChunksForPath(db, "src/a.ts")
    expect(aChunksAfter.some((chunk) => chunk.text.includes("+ 1"))).toBe(true)

    expect(result.manifest.lastIndexedGitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.manifest.lastIndexedGitSha).not.toBe(initial.manifest.lastIndexedGitSha)
    expect(readManifest(employeeName, kbRoot)).toEqual(result.manifest)
  })

  it("deletes a removed file's chunks and drops it from the manifest's file count", async () => {
    initGitRepo()
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    write("src/b.ts", "export function sub(a, b) {\n  return a - b\n}\n")
    commitAll("initial")
    const initial = await runLearningPhase(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    fs.rmSync(path.join(repoRoot, "src/b.ts"))
    commitAll("remove b")

    const result = await runIncrementalUpdate(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(result.removedFiles).toEqual(["src/b.ts"])
    expect(result.changedFiles).toEqual([])

    const db = initKbDb(employeeName, kbRoot)
    expect(listChunksForPath(db, "src/b.ts")).toEqual([])
    expect(listIndexedFiles(db).some((f) => f.path === "src/b.ts")).toBe(false)
    expect(result.manifest.fileCount).toBe(1)
    expect(result.manifest.fileCount).toBeLessThan(initial.fileCount)
  })

  it("falls back to a full mtime+hash walk when there is no manifest yet", async () => {
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    write("src/b.ts", "export function sub(a, b) {\n  return a - b\n}\n")
    // Deliberately not a git repo, and no prior learning-phase run.

    const result = await runIncrementalUpdate(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(result.usedFallbackWalk).toBe(true)
    expect(result.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"])
    expect(result.manifest.fileCount).toBe(2)
    expect(result.manifest.lastIndexedGitSha).toBeNull()
  })

  it("mtime+hash fallback re-embeds only the file whose content actually changed", async () => {
    write("src/a.ts", "export function add(a, b) {\n  return a + b\n}\n")
    write("src/b.ts", "export function sub(a, b) {\n  return a - b\n}\n")
    await runIncrementalUpdate(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    embedCalls.length = 0
    await new Promise((resolve) => setTimeout(resolve, 10))
    write("src/a.ts", "export function add(a, b) {\n  return a + b + 1\n}\n")

    const result = await runIncrementalUpdate(employee(), { kbRoot, chunkOptions: CHUNK_OPTIONS })

    expect(result.usedFallbackWalk).toBe(true)
    expect(result.changedFiles).toEqual(["src/a.ts"])
    expect(embedCalls.some((text) => text.includes("a - b"))).toBe(false)
  })
})
