import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chunkRepo, chunkText, listRepoFiles } from "../chunking.js"

let repoRoot: string

function write(relPath: string, content: string) {
  const abs = path.join(repoRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-chunking-test-"))
})

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true })
})

describe("listRepoFiles", () => {
  it("excludes node_modules, dist, .git, and binary files", () => {
    write("src/index.ts", "export const a = 1\n")
    write("node_modules/pkg/index.js", "module.exports = {}\n")
    write("dist/index.js", "console.log(1)\n")
    write(".git/HEAD", "ref: refs/heads/main\n")
    write("assets/logo.png", "\x89PNG\r\n\x1a\nsome binary junk\x00more")

    const files = listRepoFiles(repoRoot).map((f) => f.relPath).sort()
    expect(files).toEqual(["src/index.ts"])
  })

  it("respects a root .gitignore", () => {
    write(".gitignore", "secrets/\n*.log\nbuild\n")
    write("src/index.ts", "export const a = 1\n")
    write("secrets/keys.txt", "shh\n")
    write("debug.log", "log line\n")
    write("build/out.js", "console.log(1)\n")
    write("README.md", "# hello\n")

    const files = listRepoFiles(repoRoot).map((f) => f.relPath).sort()
    expect(files).toEqual(["README.md", "src/index.ts"])
  })

  it("respects nested .gitignore files scoped to their own directory", () => {
    write(".gitignore", "*.log\n")
    write("packages/a/.gitignore", "tmp/\n")
    write("packages/a/tmp/scratch.txt", "scratch\n")
    write("packages/a/src/index.ts", "export const a = 1\n")
    write("packages/b/tmp/keep.txt", "kept because rule is scoped to package a\n")
    write("top.log", "ignored by root rule\n")

    const files = listRepoFiles(repoRoot).map((f) => f.relPath).sort()
    expect(files).toEqual(["packages/a/src/index.ts", "packages/b/tmp/keep.txt"])
  })

  it("supports gitignore negation", () => {
    write(".gitignore", "*.log\n!important.log\n")
    write("a.log", "drop me\n")
    write("important.log", "keep me\n")

    const files = listRepoFiles(repoRoot).map((f) => f.relPath).sort()
    expect(files).toEqual(["important.log"])
  })
})

describe("chunkText", () => {
  it("produces a single chunk for short files", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")
    const chunks = chunkText("small.ts", content)
    expect(chunks.length).toBe(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(10)
    expect(chunks[0].path).toBe("small.ts")
    expect(chunks[0].contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("splits long files into multiple chunks within the target token range, with overlap", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `const line_${i} = "padding value to add some bulk to this line";`)
    const content = lines.join("\n")

    const chunks = chunkText("big.ts", content, { minChunkTokens: 800, maxChunkTokens: 1200, overlapTokens: 80 })

    expect(chunks.length).toBeGreaterThan(1)

    for (const chunk of chunks.slice(0, -1)) {
      const approxTokens = Math.ceil(chunk.text.length / 4)
      expect(approxTokens).toBeLessThanOrEqual(1300)
    }

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].endLine).toBeGreaterThanOrEqual(chunks[i].startLine)
      expect(chunks[i].text.split("\n").length).toBe(chunks[i].endLine - chunks[i].startLine + 1)
    }

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine)
      expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].startLine)
    }

    const lastChunk = chunks[chunks.length - 1]
    expect(lastChunk.endLine).toBe(2000)
  })

  it("captures a nearby symbol name heuristically", () => {
    const content = [
      "import { x } from './x.js'",
      "",
      "export function computeTotal(items) {",
      "  return items.reduce((a, b) => a + b, 0)",
      "}",
    ].join("\n")
    const chunks = chunkText("math.ts", content)
    expect(chunks[0].symbolName).toBe("computeTotal")
  })

  it("returns no chunks for empty content", () => {
    expect(chunkText("empty.ts", "")).toEqual([])
    expect(chunkText("whitespace.ts", "   \n\n  \n")).toEqual([])
  })
})

describe("chunkRepo", () => {
  it("walks a synthetic repo, skips ignored files, and chunks the rest", () => {
    write(".gitignore", "node_modules/\ndist/\n")
    write("src/a.ts", "export function a() {\n  return 1\n}\n")
    write("src/b.ts", "export function b() {\n  return 2\n}\n")
    write("node_modules/dep/index.js", "module.exports = {}\n")
    write("dist/bundle.js", "console.log('built')\n")

    const chunks = chunkRepo(repoRoot)
    const paths = new Set(chunks.map((c) => c.path))
    expect(paths.has("src/a.ts")).toBe(true)
    expect(paths.has("src/b.ts")).toBe(true)
    expect(paths.has("node_modules/dep/index.js")).toBe(false)
    expect(paths.has("dist/bundle.js")).toBe(false)
    expect(chunks.every((c) => c.contentHash.length === 64)).toBe(true)
  })
})
