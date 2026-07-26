import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  migrationMaterializationInputsSha256,
  type InstanceMigrationOperation,
  type MigrationMaterializationPayload,
  type MigrationMaterializationPlan,
} from "./service.js"
import {
  findUnresolvedTemplatePlaceholders,
  isTemplateMaterializationPath,
  materializeTemplateBytes,
} from "../shared/template-materialization.js"

export interface MigrationSnapshotOptions {
  instanceHome: string
  migrationKey: string
  fromVersion: string
  toVersion: string
  changedFiles: Array<{ path: string; operation: InstanceMigrationOperation }>
  materialization?: MigrationMaterializationPlan | null
}

interface SnapshotEntry {
  path: string
  state: "missing" | "file" | "symlink"
  mode?: number
  sha256?: string
  linkTarget?: string
}

interface SnapshotReceipt {
  schemaVersion: 1
  migrationKey: string
  fromVersion: string
  toVersion: string
  createdAt: string
  files: SnapshotEntry[]
}

interface MaterializedPayloadReceipt {
  destinationPath: string
  sourceSha256: string
  materializedSha256: string
  unresolvedPlaceholders: string[]
}

interface MaterializationReceipt {
  schemaVersion: 1
  inputs: MigrationMaterializationPlan["inputs"]
  inputsSha256: string
  manifests: MigrationMaterializationPlan["manifests"]
  legacy: Array<{
    version: string
    payload: MaterializedPayloadReceipt
  }>
  files: Array<{
    version: string
    path: string
    operation: InstanceMigrationOperation
    base: MaterializedPayloadReceipt | null
    target: MaterializedPayloadReceipt | null
  }>
}

const EXCLUDED = new Set(["secrets", "sessions", "logs", "uploads", "attachments", "cache", "caches", "tmp", ".migration-snapshots"])
const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex")

function safePath(instanceHome: string, relative: string): string {
  if (!relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`unsafe snapshot path: ${relative}`)
  if (EXCLUDED.has(relative.split("/")[0])) throw new Error(`excluded snapshot path: ${relative}`)
  const destination = path.resolve(instanceHome, relative)
  const prefix = `${instanceHome}${path.sep}`
  if (!destination.startsWith(prefix)) throw new Error(`snapshot path is not inside the instance: ${relative}`)
  return destination
}

function selectedPaths(options: MigrationSnapshotOptions): string[] {
  // No changed records means no three-way comparison to perform, so the context
  // files below have nothing to support. Materializing them anyway is not merely
  // wasted work: an instance whose AGENTS.md is a symlink (the layout `jinn setup`
  // creates) forces fs.symlinkSync, which Windows refuses without
  // SeCreateSymbolicLinkPrivilege — so a no-op patch migration became impossible
  // to complete there, surfacing only as "the migration service is temporarily
  // unavailable". Empty bundles are the common case for patch upgrades.
  //
  // Both createMigrationSnapshot and verifyMigrationSnapshot derive their file
  // set from here, so the snapshot and its verification stay consistent; the
  // snapshot directory and snapshot.json are still written, which is what the
  // completion receipt needs.
  if (options.changedFiles.length === 0) return []
  const paths = new Set(options.changedFiles.map((file) => file.path))
  paths.add("config.yaml")
  paths.add("CLAUDE.md")
  paths.add("AGENTS.md")
  return [...paths].sort()
}

function inspectSource(instanceHome: string, relative: string): SnapshotEntry {
  const source = safePath(instanceHome, relative)
  let stat: fs.Stats
  try { stat = fs.lstatSync(source) } catch { return { path: relative, state: "missing" } }
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(source)
    return { path: relative, state: "symlink", mode: stat.mode & 0o777, linkTarget, sha256: sha(linkTarget) }
  }
  if (!stat.isFile()) throw new Error(`snapshot source is not a file: ${relative}`)
  return { path: relative, state: "file", mode: stat.mode & 0o777, sha256: sha(fs.readFileSync(source)) }
}

function copyEntry(instanceHome: string, snapshotRoot: string, entry: SnapshotEntry): void {
  if (entry.state === "missing") return
  // A symlink's entire content is its target, and the receipt already records the
  // target and its sha256, so a link on disk preserves nothing the receipt does
  // not. Recreating one costs SeCreateSymbolicLinkPrivilege, which Windows
  // withholds unless Developer Mode is on or the process is elevated: an instance
  // whose AGENTS.md is a symlink (the layout `jinn setup` creates when the
  // privilege IS available) could not snapshot at all afterwards, and the failure
  // surfaced only as "the migration service is temporarily unavailable".
  if (entry.state === "symlink") return
  const source = safePath(instanceHome, entry.path)
  const destination = path.join(snapshotRoot, entry.path)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  if (entry.mode !== undefined) fs.chmodSync(destination, entry.mode)
}

function snapshotPath(options: MigrationSnapshotOptions): string {
  if (!/^[a-f0-9]{64}$/.test(options.migrationKey)) throw new Error("unsafe migration key")
  return path.join(fs.realpathSync(options.instanceHome), ".migration-snapshots", options.migrationKey)
}

function safeMaterializedPath(snapshotRoot: string, relative: string): string {
  if (!relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error(`unsafe materialized payload path: ${relative}`)
  }
  const destination = path.resolve(snapshotRoot, relative)
  if (!destination.startsWith(`${snapshotRoot}${path.sep}`)) throw new Error(`materialized payload escapes snapshot: ${relative}`)
  return destination
}

function validateMaterializationPlan(plan: MigrationMaterializationPlan): void {
  if (plan.schemaVersion !== 1) throw new Error("unsupported materialization plan")
  const expected = migrationMaterializationInputsSha256(
    plan.inputs,
    plan.manifests,
    plan.legacy.map((legacy) => ({ version: legacy.version, sha256: legacy.sourceSha256 })),
  )
  if (plan.inputsSha256 !== expected) throw new Error("materialization inputs hash mismatch")
  const destinations = new Set<string>()
  for (const legacy of plan.legacy) {
    if (destinations.has(legacy.destinationPath)) throw new Error(`duplicate materialized payload: ${legacy.destinationPath}`)
    destinations.add(legacy.destinationPath)
    if (!/^[a-f0-9]{64}$/.test(legacy.sourceSha256)) throw new Error(`invalid materialized source hash: ${legacy.destinationPath}`)
  }
  for (const file of plan.files) {
    for (const payload of [file.base, file.target]) {
      if (!payload) continue
      if (destinations.has(payload.destinationPath)) throw new Error(`duplicate materialized payload: ${payload.destinationPath}`)
      destinations.add(payload.destinationPath)
      if (!/^[a-f0-9]{64}$/.test(payload.sourceSha256)) throw new Error(`invalid materialized source hash: ${payload.destinationPath}`)
    }
  }
}

function materializePayload(
  snapshotRoot: string,
  filePath: string,
  payload: MigrationMaterializationPayload,
  plan: MigrationMaterializationPlan,
): MaterializedPayloadReceipt {
  let source: Buffer
  try {
    const stat = fs.lstatSync(payload.sourcePath)
    if (!stat.isFile()) throw new Error("not a regular file")
    source = fs.readFileSync(payload.sourcePath)
  } catch (error) {
    throw new Error(`materialization source is unavailable: ${payload.sourcePath} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (sha(source) !== payload.sourceSha256) throw new Error(`materialization source hash mismatch: ${payload.sourcePath}`)
  const supported = isTemplateMaterializationPath(filePath)
  const materialized = materializeTemplateBytes(filePath, source, plan.inputs)
  const destination = safeMaterializedPath(snapshotRoot, payload.destinationPath)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.writeFileSync(destination, materialized, { flag: "wx", mode: 0o444 })
  fs.chmodSync(destination, 0o444)
  return {
    destinationPath: payload.destinationPath,
    sourceSha256: payload.sourceSha256,
    materializedSha256: sha(materialized),
    unresolvedPlaceholders: supported ? findUnresolvedTemplatePlaceholders(materialized.toString("utf8")) : [],
  }
}

function createMaterializedPayloads(snapshotRoot: string, plan: MigrationMaterializationPlan): MaterializationReceipt {
  validateMaterializationPlan(plan)
  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    inputs: plan.inputs,
    inputsSha256: plan.inputsSha256,
    manifests: plan.manifests,
    legacy: plan.legacy.map((legacy) => ({
      version: legacy.version,
      payload: materializePayload(snapshotRoot, "MIGRATION.md", legacy, plan),
    })),
    files: plan.files.map((file) => ({
      version: file.version,
      path: file.path,
      operation: file.operation,
      base: file.base ? materializePayload(snapshotRoot, file.path, file.base, plan) : null,
      target: file.target ? materializePayload(snapshotRoot, file.path, file.target, plan) : null,
    })),
  }
  fs.writeFileSync(path.join(snapshotRoot, "materialization.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o400 })
  return receipt
}

function verifyMaterializedPayload(
  root: string,
  filePath: string,
  planned: MigrationMaterializationPayload | null,
  receipt: MaterializedPayloadReceipt | null,
): boolean {
  if (!planned || !receipt) return planned === null && receipt === null
  if (receipt.destinationPath !== planned.destinationPath || receipt.sourceSha256 !== planned.sourceSha256) return false
  const saved = safeMaterializedPath(root, receipt.destinationPath)
  const stat = fs.lstatSync(saved)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o444) return false
  const bytes = fs.readFileSync(saved)
  if (sha(bytes) !== receipt.materializedSha256) return false
  const unresolved = isTemplateMaterializationPath(filePath)
    ? findUnresolvedTemplatePlaceholders(bytes.toString("utf8"))
    : []
  return JSON.stringify(unresolved) === JSON.stringify(receipt.unresolvedPlaceholders)
}

function verifyMaterializedPayloads(root: string, plan: MigrationMaterializationPlan): boolean {
  validateMaterializationPlan(plan)
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "materialization.json"), "utf8")) as MaterializationReceipt
  if (receipt.schemaVersion !== 1 || receipt.inputsSha256 !== plan.inputsSha256) return false
  if (JSON.stringify(receipt.inputs) !== JSON.stringify(plan.inputs) || JSON.stringify(receipt.manifests) !== JSON.stringify(plan.manifests)) return false
  if (!Array.isArray(receipt.legacy) || receipt.legacy.length !== plan.legacy.length) return false
  if (!plan.legacy.every((legacy, index) => (
    receipt.legacy[index]?.version === legacy.version
      && verifyMaterializedPayload(root, "MIGRATION.md", legacy, receipt.legacy[index].payload)
  ))) return false
  if (!Array.isArray(receipt.files) || receipt.files.length !== plan.files.length) return false
  return plan.files.every((file, index) => {
    const recorded = receipt.files[index]
    return recorded?.version === file.version
      && recorded.path === file.path
      && recorded.operation === file.operation
      && verifyMaterializedPayload(root, file.path, file.base, recorded.base)
      && verifyMaterializedPayload(root, file.path, file.target, recorded.target)
  })
}

export function verifyMigrationSnapshot(options: MigrationSnapshotOptions): boolean {
  try {
    const root = snapshotPath(options)
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "snapshot.json"), "utf8")) as SnapshotReceipt
    if (receipt.schemaVersion !== 1 || receipt.migrationKey !== options.migrationKey || receipt.fromVersion !== options.fromVersion || receipt.toVersion !== options.toVersion || !Array.isArray(receipt.files)) return false
    const expected = selectedPaths(options)
    if (JSON.stringify(receipt.files.map((entry) => entry.path)) !== JSON.stringify(expected)) return false
    for (const entry of receipt.files) {
      safePath(fs.realpathSync(options.instanceHome), entry.path)
      const saved = path.join(root, entry.path)
      if (entry.state === "missing") {
        try {
          fs.lstatSync(saved)
          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
        }
        continue
      }
      if (entry.state === "symlink") {
        // Verified from the receipt, which holds the whole of a symlink's content.
        // The link is no longer materialized (see copyEntry), so accept its absence
        // — and equally accept a snapshot written before that change, which still
        // has one on disk, rather than failing an otherwise sound snapshot.
        if (typeof entry.linkTarget !== "string" || sha(entry.linkTarget) !== entry.sha256) return false
        const existing = fs.lstatSync(saved, { throwIfNoEntry: false })
        if (existing && (!existing.isSymbolicLink() || fs.readlinkSync(saved) !== entry.linkTarget)) return false
        continue
      }
      const stat = fs.lstatSync(saved)
      if (!stat.isFile() || sha(fs.readFileSync(saved)) !== entry.sha256 || (stat.mode & 0o777) !== entry.mode) return false
    }
    if (options.materialization && !verifyMaterializedPayloads(root, options.materialization)) return false
    return true
  } catch { return false }
}

export function createMigrationSnapshot(options: MigrationSnapshotOptions): { path: string; reused: boolean } {
  const instanceHome = fs.realpathSync(options.instanceHome)
  for (const file of options.changedFiles) safePath(instanceHome, file.path)
  if (options.materialization) validateMaterializationPlan(options.materialization)
  const finalPath = snapshotPath({ ...options, instanceHome })
  if (fs.existsSync(finalPath)) {
    if (!verifyMigrationSnapshot({ ...options, instanceHome })) throw new Error("existing migration snapshot failed verification")
    return { path: finalPath, reused: true }
  }
  fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 })
  const tempPath = path.join(path.dirname(finalPath), `.${options.migrationKey}.tmp-${process.pid}-${crypto.randomUUID()}`)
  fs.mkdirSync(tempPath, { mode: 0o700 })
  try {
    const files = selectedPaths(options).map((relative) => inspectSource(instanceHome, relative))
    for (const entry of files) copyEntry(instanceHome, tempPath, entry)
    if (options.materialization) createMaterializedPayloads(tempPath, options.materialization)
    const receipt: SnapshotReceipt = {
      schemaVersion: 1,
      migrationKey: options.migrationKey,
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      createdAt: new Date().toISOString(),
      files,
    }
    fs.writeFileSync(path.join(tempPath, "snapshot.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    try { fs.renameSync(tempPath, finalPath) } catch (error) {
      if (!fs.existsSync(finalPath)) throw error
      fs.rmSync(tempPath, { recursive: true, force: true })
    }
    if (!verifyMigrationSnapshot({ ...options, instanceHome })) throw new Error("migration snapshot failed verification")
    return { path: finalPath, reused: false }
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true })
    throw error
  }
}
