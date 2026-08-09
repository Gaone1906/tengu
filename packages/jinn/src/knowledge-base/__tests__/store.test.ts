import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  initKbDb,
  closeKbDb,
  replaceFileChunks,
  deleteFileChunks,
  resetKb,
  searchChunks,
  listChunksForPath,
  listIndexedFiles,
  getIndexedFile,
  countChunks,
  countFiles,
} from "../store.js"
import { EMBEDDING_DIMENSIONS } from "../embeddings.js"

let kbRoot: string
const employeeName = "store-test-employee"

function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed + i))
}

beforeEach(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-store-test-"))
})

afterEach(() => {
  closeKbDb(employeeName, kbRoot)
  fs.rmSync(kbRoot, { recursive: true, force: true })
})

describe("initKbDb", () => {
  it("creates one sqlite3 file per employee under kbRoot/<employeeName>/", () => {
    initKbDb(employeeName, kbRoot)
    expect(fs.existsSync(path.join(kbRoot, employeeName, "index.sqlite3"))).toBe(true)
  })

  it("returns the same cached connection for repeat calls with the same path", () => {
    const first = initKbDb(employeeName, kbRoot)
    const second = initKbDb(employeeName, kbRoot)
    expect(first).toBe(second)
  })
})

describe("replaceFileChunks / searchChunks", () => {
  it("writes chunk metadata + vectors and finds nearest neighbors via vec0", () => {
    const db = initKbDb(employeeName, kbRoot)
    replaceFileChunks(
      db,
      "src/a.ts",
      [{ path: "src/a.ts", startLine: 1, endLine: 3, text: "chunk a", contentHash: "hash-a", source: "code", embedding: vec(1) }],
      { mtimeMs: 1, contentHash: "file-hash-a" },
    )
    replaceFileChunks(
      db,
      "src/b.ts",
      [{ path: "src/b.ts", startLine: 1, endLine: 3, text: "chunk b", contentHash: "hash-b", source: "code", embedding: vec(50) }],
      { mtimeMs: 1, contentHash: "file-hash-b" },
    )

    expect(countFiles(db)).toBe(2)
    expect(countChunks(db)).toBe(2)

    const hits = searchChunks(db, vec(1), 1)
    expect(hits.length).toBe(1)
    expect(hits[0].path).toBe("src/a.ts")
    expect(hits[0].distance).toBeCloseTo(0, 5)
  })

  it("deletes the file's prior chunks+vectors before inserting the new set", () => {
    const db = initKbDb(employeeName, kbRoot)
    replaceFileChunks(
      db,
      "src/a.ts",
      [
        { path: "src/a.ts", startLine: 1, endLine: 1, text: "v1", contentHash: "h1", source: "code", embedding: vec(1) },
        { path: "src/a.ts", startLine: 2, endLine: 2, text: "v1b", contentHash: "h1b", source: "code", embedding: vec(2) },
      ],
      { mtimeMs: 1, contentHash: "fh1" },
    )
    expect(listChunksForPath(db, "src/a.ts").length).toBe(2)

    replaceFileChunks(
      db,
      "src/a.ts",
      [{ path: "src/a.ts", startLine: 1, endLine: 1, text: "v2", contentHash: "h2", source: "code", embedding: vec(3) }],
      { mtimeMs: 2, contentHash: "fh2" },
    )

    const chunks = listChunksForPath(db, "src/a.ts")
    expect(chunks.length).toBe(1)
    expect(chunks[0].text).toBe("v2")
    expect(countChunks(db)).toBe(1)
    expect(getIndexedFile(db, "src/a.ts")?.contentHash).toBe("fh2")
  })
})

describe("deleteFileChunks", () => {
  it("removes both the metadata rows and their vectors", () => {
    const db = initKbDb(employeeName, kbRoot)
    replaceFileChunks(
      db,
      "src/a.ts",
      [{ path: "src/a.ts", startLine: 1, endLine: 1, text: "chunk a", contentHash: "h1", source: "code", embedding: vec(1) }],
      { mtimeMs: 1, contentHash: "fh1" },
    )

    deleteFileChunks(db, "src/a.ts")

    expect(listChunksForPath(db, "src/a.ts")).toEqual([])
    expect(getIndexedFile(db, "src/a.ts")).toBeUndefined()
    expect(searchChunks(db, vec(1), 5)).toEqual([])
  })

  it("is a no-op for a file that was never indexed", () => {
    const db = initKbDb(employeeName, kbRoot)
    expect(() => deleteFileChunks(db, "never/indexed.ts")).not.toThrow()
  })
})

describe("resetKb", () => {
  it("clears every table", () => {
    const db = initKbDb(employeeName, kbRoot)
    replaceFileChunks(
      db,
      "src/a.ts",
      [{ path: "src/a.ts", startLine: 1, endLine: 1, text: "chunk a", contentHash: "h1", source: "code", embedding: vec(1) }],
      { mtimeMs: 1, contentHash: "fh1" },
    )

    resetKb(db)

    expect(countChunks(db)).toBe(0)
    expect(countFiles(db)).toBe(0)
    expect(listIndexedFiles(db)).toEqual([])
  })
})
