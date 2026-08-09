import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export interface Chunk {
  path: string
  startLine: number
  endLine: number
  symbolName?: string
  text: string
  contentHash: string
}

export interface ChunkOptions {
  minChunkTokens?: number
  maxChunkTokens?: number
  overlapTokens?: number
}

const DEFAULT_MIN_CHUNK_TOKENS = 800
const DEFAULT_MAX_CHUNK_TOKENS = 1200
const DEFAULT_OVERLAP_TOKENS = 80

const ALWAYS_IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", ".next", ".turbo", ".pnpm"])

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg", ".flac",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".node", ".wasm",
  ".onnx", ".pyc", ".class", ".jar", ".db", ".sqlite", ".sqlite3",
  ".lock",
])

const MAX_FILE_BYTES = 2_000_000

interface GitignoreRule {
  regex: RegExp
  negate: boolean
  dirOnly: boolean
}

function globToRegExp(pattern: string): RegExp {
  let anchored = pattern.startsWith("/")
  let body = anchored ? pattern.slice(1) : pattern
  const dirOnly = body.endsWith("/")
  if (dirOnly) body = body.slice(0, -1)
  if (!anchored && body.includes("/")) anchored = true

  let out = ""
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "*" && body[i + 1] === "*") {
      const nextNext = body[i + 2]
      if (nextNext === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
    } else if (c === "*") {
      out += "[^/]*"
    } else if (c === "?") {
      out += "[^/]"
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?"
  const suffix = dirOnly ? "(?:/.*)?$" : "(?:/.*)?$"
  return new RegExp(prefix + out + suffix)
}

function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const negate = line.startsWith("!")
    const pattern = negate ? line.slice(1) : line
    if (!pattern) continue
    const dirOnly = pattern.endsWith("/")
    rules.push({ regex: globToRegExp(pattern), negate, dirOnly })
  }
  return rules
}

interface IgnoreLayer {
  baseDir: string
  rules: GitignoreRule[]
}

function isIgnored(relFromBase: string, isDir: boolean, rules: GitignoreRule[]): boolean | undefined {
  let result: boolean | undefined
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.regex.test(relFromBase)) result = !rule.negate
  }
  return result
}

function isPathIgnored(relPath: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  let ignored = false
  for (const layer of layers) {
    const relFromBase = path.relative(layer.baseDir, relPath).split(path.sep).join("/")
    if (!relFromBase || relFromBase.startsWith("..")) continue
    const verdict = isIgnored(relFromBase, isDir, layer.rules)
    if (verdict !== undefined) ignored = verdict
  }
  return ignored
}

function looksBinary(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return true
  let fd: number
  try {
    fd = fs.openSync(absPath, "r")
  } catch {
    return true
  }
  try {
    const buf = Buffer.alloc(8000)
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } finally {
    fs.closeSync(fd)
  }
}

export interface RepoFile {
  relPath: string
  absPath: string
}

export function listRepoFiles(repoRoot: string): RepoFile[] {
  const files: RepoFile[] = []
  const rootIgnoreLayer: IgnoreLayer[] = []

  const walk = (dirAbs: string, layers: IgnoreLayer[]) => {
    let gitignorePath = path.join(dirAbs, ".gitignore")
    let localLayers = layers
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf8")
      localLayers = [...layers, { baseDir: dirAbs, rules: parseGitignore(content) }]
    }

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryAbs = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue
        if (isPathIgnored(entryAbs, true, localLayers)) continue
        walk(entryAbs, localLayers)
      } else if (entry.isFile()) {
        if (entry.name === ".gitignore") continue
        if (isPathIgnored(entryAbs, false, localLayers)) continue
        if (looksBinary(entryAbs)) continue
        let size = 0
        try {
          size = fs.statSync(entryAbs).size
        } catch {
          continue
        }
        if (size > MAX_FILE_BYTES) continue
        const relPath = path.relative(repoRoot, entryAbs).split(path.sep).join("/")
        files.push({ relPath, absPath: entryAbs })
      }
    }
  }

  walk(repoRoot, rootIgnoreLayer)
  return files
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const SYMBOL_LINE_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def)\s+([A-Za-z_$][A-Za-z0-9_$]*)/

function findSymbolName(lines: string[], startLineIdx: number, endLineIdx: number): string | undefined {
  for (let i = startLineIdx; i <= endLineIdx && i < lines.length; i++) {
    const match = SYMBOL_LINE_RE.exec(lines[i])
    if (match) return match[1]
  }
  for (let i = startLineIdx - 1; i >= 0; i--) {
    const match = SYMBOL_LINE_RE.exec(lines[i])
    if (match) return match[1]
  }
  return undefined
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

export function chunkText(relPath: string, content: string, options: ChunkOptions = {}): Chunk[] {
  const minTokens = options.minChunkTokens ?? DEFAULT_MIN_CHUNK_TOKENS
  const maxTokens = options.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS

  const lines = content.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.length > 0) lines.pop()
  if (lines.length === 0) return []

  const chunks: Chunk[] = []
  let start = 0

  while (start < lines.length) {
    let end = start
    let tokens = 0
    while (end < lines.length && tokens < maxTokens) {
      tokens += estimateTokens(lines[end]) + 1
      end += 1
      if (tokens >= minTokens && end < lines.length) {
        const lookaheadTokens = tokens + estimateTokens(lines[end]) + 1
        if (lookaheadTokens > maxTokens) break
      }
    }
    if (end === start) end = start + 1
    end = Math.min(end, lines.length)

    const chunkLines = lines.slice(start, end)
    const text = chunkLines.join("\n")
    if (text.trim().length > 0) {
      chunks.push({
        path: relPath,
        startLine: start + 1,
        endLine: end,
        symbolName: findSymbolName(lines, start, end - 1),
        text,
        contentHash: hashText(text),
      })
    }

    if (end >= lines.length) break

    let overlapLines = 0
    let overlapTokenCount = 0
    let idx = end - 1
    while (idx > start && overlapTokenCount < overlapTokens) {
      overlapTokenCount += estimateTokens(lines[idx]) + 1
      overlapLines += 1
      idx -= 1
    }
    start = Math.max(end - overlapLines, start + 1)
  }

  return chunks
}

export function chunkRepo(repoRoot: string, options: ChunkOptions = {}): Chunk[] {
  const absRoot = path.resolve(repoRoot)
  const files = listRepoFiles(absRoot)
  const chunks: Chunk[] = []
  for (const file of files) {
    let content: string
    try {
      content = fs.readFileSync(file.absPath, "utf8")
    } catch {
      continue
    }
    chunks.push(...chunkText(file.relPath, content, options))
  }
  return chunks
}
