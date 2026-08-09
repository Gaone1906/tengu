import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readManifest, writeManifest, resolveManifestPath, KB_SCHEMA_VERSION, type KbManifest } from "../manifest.js"

let kbRoot: string
const employeeName = "manifest-test-employee"

function sampleManifest(overrides: Partial<KbManifest> = {}): KbManifest {
  return {
    employeeName,
    repo: "/repos/acme",
    lastIndexedAt: "2026-08-01T00:00:00.000Z",
    lastIndexedGitSha: "a".repeat(40),
    fileCount: 3,
    chunkCount: 12,
    embeddingModel: "Xenova/bge-small-en-v1.5",
    schemaVersion: KB_SCHEMA_VERSION,
    ...overrides,
  }
}

beforeEach(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-manifest-test-"))
})

afterEach(() => {
  fs.rmSync(kbRoot, { recursive: true, force: true })
})

describe("manifest read/write", () => {
  it("round-trips a written manifest", () => {
    const manifest = sampleManifest()
    writeManifest(employeeName, manifest, kbRoot)
    expect(readManifest(employeeName, kbRoot)).toEqual(manifest)
    expect(fs.existsSync(resolveManifestPath(employeeName, kbRoot))).toBe(true)
  })

  it("returns undefined when no manifest has ever been written", () => {
    expect(readManifest(employeeName, kbRoot)).toBeUndefined()
  })

  it("returns undefined for malformed JSON instead of throwing", () => {
    const manifestPath = resolveManifestPath(employeeName, kbRoot)
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, "{ not json", "utf8")
    expect(readManifest(employeeName, kbRoot)).toBeUndefined()
  })

  it("returns undefined for a well-formed JSON file missing required fields", () => {
    const manifestPath = resolveManifestPath(employeeName, kbRoot)
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({ employeeName }), "utf8")
    expect(readManifest(employeeName, kbRoot)).toBeUndefined()
  })

  it("still returns a manifest whose schemaVersion is older — the caller decides what to do with it", () => {
    writeManifest(employeeName, sampleManifest({ schemaVersion: 0 }), kbRoot)
    const manifest = readManifest(employeeName, kbRoot)
    expect(manifest?.schemaVersion).toBe(0)
  })
})
