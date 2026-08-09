import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"

// teaching.ts pulls its transcript from sessions/registry.ts, whose DB path
// (SESSIONS_DB) is resolved from JINN_HOME at module load — point it at a
// throwaway dir BEFORE anything imports that module graph, same pattern as
// sessions/__tests__/registry-pagination.test.ts.
const sessionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-teaching-sessions-"))
process.env.JINN_HOME = sessionsHome

// A tiny deterministic "embedding": near-identical strings land near each
// other via shared keyword buckets — enough to make KNN ranking meaningful
// without downloading the real ONNX model.
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  const buckets = ["billing", "widget"]
  return buckets.map((bucket) => (lower.includes(bucket) ? 1 : 0)).concat(Array(EMBEDDING_DIMENSIONS - buckets.length).fill(0))
}

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>()
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map((text) => vectorFor(text))),
  }
})

import { retrieveForTask } from "../retrieval.js"
import { initKbDb, closeKbDb, replaceFileChunks, listChunksForPath, type ChunkInsert } from "../store.js"
import { EMBEDDING_DIMENSIONS } from "../embeddings.js"

type Registry = typeof import("../../sessions/registry.js")
type Teaching = typeof import("../teaching.js")

let registry: Registry
let teaching: Teaching

let kbRoot: string
const employeeName = "teaching-test-employee"

beforeAll(async () => {
  registry = await import("../../sessions/registry.js")
  teaching = await import("../teaching.js")
})

afterAll(() => {
  fs.rmSync(sessionsHome, { recursive: true, force: true })
})

beforeEach(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-teaching-test-"))
})

afterEach(() => {
  closeKbDb(employeeName, kbRoot)
  fs.rmSync(kbRoot, { recursive: true, force: true })
})

function seedSession(messages: Array<{ role: string; content: string }>): string {
  const session = registry.createSession({
    engine: "claude",
    source: "web",
    sourceRef: `web:teaching-${Date.now()}-${Math.random()}`,
    employee: employeeName,
  })
  for (const message of messages) {
    registry.insertMessage(session.id, message.role, message.content)
  }
  return session.id
}

describe("formatTeachingTranscript", () => {
  it("keeps only user/assistant content, dropping partial and empty messages", () => {
    const formatted = teaching.formatTeachingTranscript([
      { id: "1", role: "assistant", content: "What's the deploy process?", timestamp: 1 },
      { id: "2", role: "user", content: "We ship via the release-jinn-cli skill.", timestamp: 2 },
      { id: "3", role: "tool", content: "irrelevant tool output", timestamp: 3 },
      { id: "4", role: "user", content: "   ", timestamp: 4 },
      { id: "5", role: "assistant", content: "still streaming", timestamp: 5, partial: true },
    ])

    expect(formatted).toBe(
      "Specialist: What's the deploy process?\n\nUser: We ship via the release-jinn-cli skill.",
    )
  })
})

describe("runTeachingPhase", () => {
  it("is a no-op when the session has no usable transcript content", async () => {
    const sessionId = seedSession([])

    const result = await teaching.runTeachingPhase({ name: employeeName }, sessionId, { kbRoot })

    expect(result.chunkCount).toBe(0)
    const db = initKbDb(employeeName, kbRoot)
    expect(listChunksForPath(db, `teaching/${sessionId}.md`)).toEqual([])
  })

  it("stores the Q&A transcript as source: teaching chunks in the specialist's KB", async () => {
    const sessionId = seedSession([
      { role: "assistant", content: "Any billing gotchas I should know about?" },
      { role: "user", content: "Billing retries are idempotent by invoice id — never retry blind." },
    ])

    const result = await teaching.runTeachingPhase({ name: employeeName }, sessionId, { kbRoot })

    expect(result.chunkCount).toBeGreaterThan(0)
    expect(result.sessionId).toBe(sessionId)

    const db = initKbDb(employeeName, kbRoot)
    const stored = listChunksForPath(db, `teaching/${sessionId}.md`)
    expect(stored.length).toBe(result.chunkCount)
    for (const chunk of stored) {
      expect(chunk.source).toBe("teaching")
      expect(chunk.text).toContain("Billing retries are idempotent")
    }
  })

  it("makes stored teaching chunks retrievable alongside code chunks via retrieveForTask", async () => {
    const db = initKbDb(employeeName, kbRoot)
    const codeInsert: ChunkInsert = {
      path: "src/billing.ts",
      startLine: 1,
      endLine: 1,
      text: "export function chargeInvoice(invoice) { return billingGateway.charge(invoice) }",
      contentHash: "code-hash",
      source: "code",
      embedding: vectorFor("billing gateway charge invoice"),
    }
    replaceFileChunks(db, "src/billing.ts", [codeInsert], { mtimeMs: 1, contentHash: "file-hash" })

    const sessionId = seedSession([
      { role: "assistant", content: "Any billing gotchas I should know about?" },
      { role: "user", content: "Billing retries are idempotent by invoice id — never retry blind." },
    ])
    await teaching.runTeachingPhase({ name: employeeName }, sessionId, { kbRoot })

    const hits = await retrieveForTask({ name: employeeName }, "billing", 8, { kbRoot })

    const sources = new Set(hits.map((h) => h.source))
    expect(sources.has("code")).toBe(true)
    expect(sources.has("teaching")).toBe(true)
    expect(hits.some((h) => h.path === "src/billing.ts")).toBe(true)
    expect(hits.some((h) => h.path === `teaching/${sessionId}.md`)).toBe(true)
  })
})

describe("buildTeachingKickoffPrompt", () => {
  it("mentions the repo and asks one question at a time", () => {
    const prompt = teaching.buildTeachingKickoffPrompt({ name: employeeName, repo: "~/code/acme" })
    expect(prompt).toContain("~/code/acme")
    expect(prompt.toLowerCase()).toContain("one question at a time")
  })
})
