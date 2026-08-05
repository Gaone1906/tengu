import fs from "node:fs"
import path from "node:path"
import { parseDocument, Scalar, YAMLMap, isScalar } from "yaml"
import { reconcileServiceOwnedRemovals, type PendingInstanceMigration } from "./service.js"
import { verifyMigrationSnapshot } from "./snapshot.js"

export type StampResult = { ok: true; text: string } | { ok: false; reason: string }

const firstLine = (message: string) => message.split("\n")[0].trim()

export function stampVersionInYaml(raw: string, version: string): StampResult {
  const doc = parseDocument(raw)
  if (doc.errors.length) return { ok: false, reason: `config.yaml isn't valid YAML (${firstLine(doc.errors[0].message)})` }
  const node = new Scalar(version)
  node.type = Scalar.QUOTE_DOUBLE
  const oldVersion = doc.getIn(["jinn", "version"], true)
  if (isScalar(oldVersion)) {
    if (oldVersion.comment != null) node.comment = oldVersion.comment
    if (oldVersion.commentBefore != null) node.commentBefore = oldVersion.commentBefore
  }
  const jinnNode = doc.get("jinn", true)
  if (isScalar(jinnNode) && jinnNode.value == null) {
    const map = new YAMLMap()
    if (jinnNode.comment != null) map.comment = jinnNode.comment
    if (jinnNode.commentBefore != null) map.commentBefore = jinnNode.commentBefore
    doc.set("jinn", map)
  }
  try { doc.setIn(["jinn", "version"], node) } catch (error) {
    return { ok: false, reason: `config.yaml's "jinn" isn't a mapping (${firstLine((error as Error).message)})` }
  }
  let text: string
  try { text = doc.toString() } catch (error) {
    return { ok: false, reason: `couldn't serialize the version update safely (${firstLine((error as Error).message)})` }
  }
  const check = parseDocument(text)
  if (check.errors.length || check.getIn(["jinn", "version"]) !== version) return { ok: false, reason: "version marker didn't round-trip" }
  return { ok: true, text }
}

function validateInstancePath(home: string, relative: string): void {
  if (!relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`unsafe reviewed path: ${relative}`)
  const resolved = path.resolve(home, relative)
  if (!resolved.startsWith(`${home}${path.sep}`)) throw new Error(`reviewed path is outside the instance: ${relative}`)
}

export function completeInstanceMigration(options: {
  instanceHome: string
  installedPackageVersion: string
  targetVersion: string
  expectedMigrationKey: string
  pending: PendingInstanceMigration
}): void {
  const home = fs.realpathSync(options.instanceHome)
  if (options.targetVersion !== options.installedPackageVersion) throw new Error(`target must equal installed package ${options.installedPackageVersion}`)
  if (!options.pending.required || !options.pending.migrationKey) throw new Error("no instance migration is pending")
  if (options.pending.toVersion !== options.targetVersion) throw new Error("pending migration target does not match installed package")
  if (options.expectedMigrationKey !== options.pending.migrationKey) throw new Error("migration key does not match the pending migration")
  for (const file of options.pending.changedFiles) validateInstancePath(home, file.path)
  const snapshotOptions = {
    instanceHome: home,
    migrationKey: options.pending.migrationKey,
    fromVersion: options.pending.fromVersion,
    toVersion: options.pending.toVersion,
    changedFiles: options.pending.changedFiles,
    materialization: options.pending.materialization,
  }
  if (!verifyMigrationSnapshot(snapshotOptions)) throw new Error("verified migration snapshot is required")
  const serviceRemovalReceipt = reconcileServiceOwnedRemovals({ instanceHome: home, pending: options.pending })
  const snapshotDir = path.join(home, ".migration-snapshots", options.pending.migrationKey)
  const receiptPath = path.join(snapshotDir, "completion-receipt.json")
  let receipt: {
    schemaVersion?: unknown
    migrationKey?: unknown
    reviewedFiles?: unknown
    skippedItems?: unknown
    verifiedAt?: unknown
  }
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) } catch { throw new Error("completion receipt is required") }
  if (receipt.schemaVersion !== 1 || receipt.migrationKey !== options.pending.migrationKey || !Array.isArray(receipt.reviewedFiles) || !Array.isArray(receipt.skippedItems)) {
    throw new Error("completion receipt has an invalid contract")
  }
  const reviewed = new Set(receipt.reviewedFiles.filter((value): value is string => typeof value === "string"))
  const skipped = new Set(receipt.skippedItems.map((value) => typeof value === "string" ? value : value && typeof value === "object" && "path" in value ? String((value as { path: unknown }).path) : ""))
  const removalPaths = new Set(options.pending.changedFiles.filter((file) => file.operation === "remove").map((file) => file.path))
  const serviceRemovalPaths = new Set(serviceRemovalReceipt.outcomes.map((outcome) => outcome.path))
  for (const file of options.pending.changedFiles) {
    if (removalPaths.has(file.path)) {
      if (!serviceRemovalPaths.has(file.path)) throw new Error(`service-owned removal outcome is required for ${file.path}`)
      if (reviewed.has(file.path) || skipped.has(file.path)) {
        throw new Error(`generic completion receipt cannot cover service-owned removal path ${file.path}`)
      }
      continue
    }
    if (!reviewed.has(file.path) && !skipped.has(file.path)) throw new Error(`completion receipt has not reviewed or skipped ${file.path}`)
  }
  const configPath = path.join(home, "config.yaml")
  const result = stampVersionInYaml(fs.readFileSync(configPath, "utf8"), options.targetVersion)
  if (!result.ok) throw new Error(result.reason)
  const temp = `${configPath}.migration-${process.pid}.tmp`
  fs.writeFileSync(temp, result.text, { mode: fs.statSync(configPath).mode & 0o777 })
  fs.renameSync(temp, configPath)
}
