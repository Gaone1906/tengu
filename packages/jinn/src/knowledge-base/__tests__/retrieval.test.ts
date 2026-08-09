import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// retrieval.ts embeds the query through embeddings.ts's real ONNX pipeline —
// swap in a deterministic fake keyed by text content so a "known query" can
// be made to land near a specific stored chunk without downloading the model.
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>()
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map((text) => vectorFor(text))),
  }
})

import { retrieveForTask, DEFAULT_MAX_TOTAL_CHARS, MAX_RETRIEVAL_HITS } from "../retrieval.js"
import { initKbDb, closeKbDb, replaceFileChunks, type ChunkInsert } from "../store.js"
import { EMBEDDING_DIMENSIONS } from "../embeddings.js"

let kbRoot: string
const employeeName = "retrieval-test-employee"

// A tiny deterministic "embedding": near-identical strings land near each
// other, unrelated strings land far apart — enough to make KNN ranking
// meaningful without a real model.
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  const buckets = ["auth", "billing", "widget"]
  return buckets.map((bucket) => (lower.includes(bucket) ? 1 : 0)).concat(Array(EMBEDDING_DIMENSIONS - buckets.length).fill(0))
}

function insert(db: ReturnType<typeof initKbDb>, filePath: string, text: string, source: "code" | "teaching" = "code"): void {
  const insertRow: ChunkInsert = {
    path: filePath,
    startLine: 1,
    endLine: text.split("\n").length,
    text,
    contentHash: `hash-${filePath}`,
    source,
    embedding: vectorFor(text),
  }
  replaceFileChunks(db, filePath, [insertRow], { mtimeMs: 1, contentHash: `file-${filePath}` })
}

beforeEach(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-retrieval-test-"))
})

afterEach(() => {
  closeKbDb(employeeName, kbRoot)
  fs.rmSync(kbRoot, { recursive: true, force: true })
})

describe("retrieveForTask", () => {
  it("ranks chunks by relevance to the query", async () => {
    const db = initKbDb(employeeName, kbRoot)
    insert(db, "src/auth.ts", "export function login(user) { return authenticateUser(user) }")
    insert(db, "src/billing.ts", "export function charge(invoice) { return billingGateway.charge(invoice) }")
    insert(db, "src/widget.ts", "export function renderWidget(props) { return widgetTree(props) }")

    const hits = await retrieveForTask({ name: employeeName }, "how does auth login work?", 8, { kbRoot })

    expect(hits.length).toBe(3)
    expect(hits[0].path).toBe("src/auth.ts")
  })

  it("blends source: code and source: teaching chunks in one ranked result", async () => {
    const db = initKbDb(employeeName, kbRoot)
    insert(db, "src/billing.ts", "billing gateway charges invoices", "code")
    insert(db, "teaching/session-1.md", "Specialist: any billing gotchas? User: billing retries are idempotent by invoice id", "teaching")

    const hits = await retrieveForTask({ name: employeeName }, "billing", 8, { kbRoot })

    expect(hits.map((h) => h.source).sort()).toEqual(["code", "teaching"])
  })

  it("respects the k cap, never exceeding MAX_RETRIEVAL_HITS even if k is larger", async () => {
    const db = initKbDb(employeeName, kbRoot)
    for (let i = 0; i < MAX_RETRIEVAL_HITS + 10; i++) {
      insert(db, `src/widget-${i}.ts`, `widget component number ${i}`)
    }

    const hits = await retrieveForTask({ name: employeeName }, "widget", MAX_RETRIEVAL_HITS + 10, { kbRoot })

    expect(hits.length).toBeLessThanOrEqual(MAX_RETRIEVAL_HITS)
  })

  it("bounds the total returned text to the character budget, truncating the chunk that overflows it", async () => {
    const db = initKbDb(employeeName, kbRoot)
    const big = "a".repeat(50)
    for (let i = 0; i < 5; i++) insert(db, `src/widget-${i}.ts`, `widget ${big}-${i}`)

    const budget = 60
    const hits = await retrieveForTask({ name: employeeName }, "widget", 8, { kbRoot, maxTotalChars: budget })

    const totalChars = hits.reduce((sum, h) => sum + h.text.length, 0)
    expect(totalChars).toBeLessThanOrEqual(budget)
    expect(hits.some((h) => h.truncated)).toBe(true)
  })

  it("uses the default character budget when none is supplied", async () => {
    const db = initKbDb(employeeName, kbRoot)
    insert(db, "src/widget.ts", "widget component")

    const hits = await retrieveForTask({ name: employeeName }, "widget", 8, { kbRoot })

    const totalChars = hits.reduce((sum, h) => sum + h.text.length, 0)
    expect(totalChars).toBeLessThanOrEqual(DEFAULT_MAX_TOTAL_CHARS)
  })

  it("returns an empty array for a blank query without touching the store", async () => {
    initKbDb(employeeName, kbRoot)
    const hits = await retrieveForTask({ name: employeeName }, "   ", 8, { kbRoot })
    expect(hits).toEqual([])
  })
})
