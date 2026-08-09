import fs from "node:fs"
import path from "node:path"
import { KB_DIR } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import { resolveKbDir } from "./store.js"

/**
 * Per-specialist KB manifest (docs/tengu/18-council-specialists.md): filesystem-
 * resident bookkeeping at `~/.{instance}/kb/<employeeName>/manifest.json`,
 * deliberately outside the SQL ledger — it describes the state of the KB
 * itself (what was indexed, when, against which git sha), not a Todo.
 */

export const KB_SCHEMA_VERSION = 1

export interface KbManifest {
  employeeName: string
  repo: string
  lastIndexedAt: string | null
  lastIndexedGitSha: string | null
  fileCount: number
  chunkCount: number
  embeddingModel: string
  schemaVersion: number
}

export function resolveManifestPath(employeeName: string, kbRoot: string = KB_DIR): string {
  return path.join(resolveKbDir(employeeName, kbRoot), "manifest.json")
}

function isKbManifestShape(value: unknown): value is KbManifest {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.employeeName === "string" &&
    typeof v.repo === "string" &&
    (v.lastIndexedAt === null || typeof v.lastIndexedAt === "string") &&
    (v.lastIndexedGitSha === null || typeof v.lastIndexedGitSha === "string") &&
    typeof v.fileCount === "number" &&
    typeof v.chunkCount === "number" &&
    typeof v.embeddingModel === "string" &&
    typeof v.schemaVersion === "number"
  )
}

/** Read a specialist's manifest. Returns undefined for a missing file, an
 *  unparseable one, or one whose shape doesn't match `KbManifest` — every case
 *  `runIncrementalUpdate` treats identically as "no manifest, fall back to a
 *  full mtime+hash walk." A schema-version mismatch is NOT filtered here: the
 *  caller decides whether an older manifest is close enough to diff against. */
export function readManifest(employeeName: string, kbRoot: string = KB_DIR): KbManifest | undefined {
  const manifestPath = resolveManifestPath(employeeName, kbRoot)
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isKbManifestShape(parsed)) {
      logger.warn(`knowledge-base/manifest: malformed manifest at ${manifestPath}, treating as absent`)
      return undefined
    }
    return parsed
  } catch (err) {
    logger.warn(`knowledge-base/manifest: could not parse ${manifestPath}: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

/** Write a specialist's manifest, creating its KB directory if needed. Writes
 *  to a sibling temp file and renames into place so a crash mid-write never
 *  leaves a truncated manifest for the next read to trip over. */
export function writeManifest(employeeName: string, manifest: KbManifest, kbRoot: string = KB_DIR): void {
  const manifestPath = resolveManifestPath(employeeName, kbRoot)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const tmpPath = `${manifestPath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf8")
  fs.renameSync(tmpPath, manifestPath)
}
