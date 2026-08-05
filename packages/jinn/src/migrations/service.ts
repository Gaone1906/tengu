import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import { compareSemver, isStrictSemver } from "../shared/version.js"
import {
  deriveTemplateMaterializationInputs,
  materializeTemplateBytes,
  type TemplateMaterializationInputs,
} from "../shared/template-materialization.js"

export type InstanceMigrationOperation = "add" | "modify" | "remove"

export interface PendingInstanceMigration {
  required: boolean
  fromVersion: string
  toVersion: string
  versions: string[]
  changedFiles: Array<{ path: string; operation: InstanceMigrationOperation }>
  prompt: string | null
  migrationKey: string | null
  materialization: MigrationMaterializationPlan | null
}

export interface MigrationMaterializationPayload {
  sourcePath: string
  destinationPath: string
  sourceSha256: string
}

export interface MigrationMaterializationFile {
  version: string
  path: string
  operation: InstanceMigrationOperation
  base: MigrationMaterializationPayload | null
  target: MigrationMaterializationPayload | null
}

export interface MigrationMaterializationManifest {
  version: string
  sha256: string
}

export interface MigrationMaterializationLegacy {
  version: string
  sourcePath: string
  destinationPath: string
  sourceSha256: string
}

export interface MigrationMaterializationLegacyHash {
  version: string
  sha256: string
}

export interface MigrationMaterializationPlan {
  schemaVersion: 1
  inputs: TemplateMaterializationInputs
  inputsSha256: string
  manifests: MigrationMaterializationManifest[]
  legacy: MigrationMaterializationLegacy[]
  files: MigrationMaterializationFile[]
}

export type ServiceRemovalStatus = "removed" | "preserved" | "already-missing"

export interface ServiceRemovalOutcome {
  version: string
  path: string
  status: ServiceRemovalStatus
  baseSha256: string
  observedState: "missing" | "file" | "symlink" | "other"
  observedSha256?: string
  linkTarget?: string
  reason?: string
}

export interface ServiceRemovalReceipt {
  schemaVersion: 1
  migrationKey: string
  reconciledAt: string
  outcomes: ServiceRemovalOutcome[]
}

export const SERVICE_REMOVAL_RECEIPT = "service-removal-receipt.json"

interface ManifestRecord {
  path: string
  operation: InstanceMigrationOperation
  baseSha256: string | null
  targetSha256: string | null
  basePayload: string | null
  targetPayload: string | null
}

interface InstanceMigrationManifest {
  schemaVersion: 1
  version: string
  baseVersion: string
  generatedFrom: { baseRef: string; headRef: string }
  files: ManifestRecord[]
}

interface ValidatedBundle {
  dir: string
  manifestPath: string
  manifest: InstanceMigrationManifest
  manifestHash: string
}

interface ValidatedLegacyMigration {
  dir: string
  version: string
  sourcePath: string
  sourceHash: string
  bytes: Buffer
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(`unsafe ${label}: ${String(value)}`)
  }
  return value
}

function readMarker(instanceHome: string): { version: string; present: boolean; config: { portal?: { portalName?: string } } } {
  const config = path.join(instanceHome, "config.yaml")
  if (!fs.existsSync(config)) return { version: "0.0.0", present: false, config: {} }
  let parsed: unknown
  try { parsed = yaml.load(fs.readFileSync(config, "utf8")) } catch (error) {
    throw new Error(`config.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = (parsed as { jinn?: { version?: unknown } } | null)?.jinn?.version
  const selectedConfig = parsed && typeof parsed === "object" ? parsed as { portal?: { portalName?: string } } : {}
  if (value === undefined || value === null || value === "") return { version: "0.0.0", present: false, config: selectedConfig }
  if (typeof value !== "string" || !isStrictSemver(value)) throw new Error(`instance marker is not a plain X.Y.Z version: ${String(value)}`)
  return { version: value, present: true, config: selectedConfig }
}

export function migrationMaterializationInputsSha256(
  inputs: TemplateMaterializationInputs,
  manifests: MigrationMaterializationManifest[],
  legacy: MigrationMaterializationLegacyHash[] = [],
): string {
  return sha256(JSON.stringify({ schemaVersion: 1, inputs, manifests, legacy }))
}

function buildMaterializationPlan(
  inputs: TemplateMaterializationInputs,
  bundles: ValidatedBundle[],
  legacyMigrations: ValidatedLegacyMigration[],
): MigrationMaterializationPlan {
  const manifests = bundles.map((bundle) => ({ version: bundle.manifest.version, sha256: bundle.manifestHash }))
  const legacyHashes = legacyMigrations.map((legacy) => ({ version: legacy.version, sha256: legacy.sourceHash }))
  const payload = (
    bundle: ValidatedBundle,
    record: ManifestRecord,
    side: "base" | "target",
  ): MigrationMaterializationPayload | null => {
    const relative = side === "base" ? record.basePayload : record.targetPayload
    const sourceSha256 = side === "base" ? record.baseSha256 : record.targetSha256
    if (relative === null || sourceSha256 === null) return null
    return {
      sourcePath: path.join(bundle.dir, relative),
      destinationPath: path.posix.join("materialized", bundle.manifest.version, relative),
      sourceSha256,
    }
  }
  return {
    schemaVersion: 1,
    inputs,
    inputsSha256: migrationMaterializationInputsSha256(inputs, manifests, legacyHashes),
    manifests,
    legacy: legacyMigrations.map((legacy) => ({
      version: legacy.version,
      sourcePath: legacy.sourcePath,
      destinationPath: path.posix.join("materialized", "legacy", legacy.version, "MIGRATION.md"),
      sourceSha256: legacy.sourceHash,
    })),
    files: bundles.flatMap((bundle) => bundle.manifest.files.map((record) => ({
      version: bundle.manifest.version,
      path: record.path,
      operation: record.operation,
      base: payload(bundle, record, "base"),
      target: payload(bundle, record, "target"),
    }))),
  }
}

function validateLegacyMigration(dir: string, version: string): ValidatedLegacyMigration {
  const sourcePath = path.join(dir, "MIGRATION.md")
  let canonical: string
  try { canonical = fs.realpathSync(sourcePath) } catch { throw new Error(`legacy migration ${version} is missing MIGRATION.md`) }
  const root = `${fs.realpathSync(dir)}${path.sep}`
  if (!canonical.startsWith(root) || !fs.lstatSync(sourcePath).isFile()) {
    throw new Error(`legacy migration ${version} MIGRATION.md is not a regular file inside its directory`)
  }
  const bytes = fs.readFileSync(sourcePath)
  return { dir, version, sourcePath, sourceHash: sha256(bytes), bytes }
}

function validatePayload(bundleDir: string, payload: string | null, expectedHash: string | null, expected: string | null): void {
  if (payload === null || expectedHash === null) {
    if (payload !== null || expectedHash !== null || expected !== null) throw new Error("manifest payload/hash nullability mismatch")
    return
  }
  if (expected === null || payload !== expected) throw new Error(`manifest payload path mismatch: ${payload}`)
  const relative = safeRelative(payload, "payload path")
  const file = path.resolve(bundleDir, relative)
  const root = `${fs.realpathSync(bundleDir)}${path.sep}`
  let canonical: string
  try { canonical = fs.realpathSync(file) } catch { throw new Error(`migration payload is missing: ${payload}`) }
  if (!canonical.startsWith(root)) throw new Error(`migration payload escapes its bundle: ${payload}`)
  if (!fs.lstatSync(file).isFile()) throw new Error(`migration payload is not a regular file: ${payload}`)
  const actual = sha256(fs.readFileSync(file))
  if (actual !== expectedHash) throw new Error(`migration payload hash mismatch: ${payload}`)
}

function validateBundle(dir: string, version: string): ValidatedBundle {
  const manifestPath = path.join(dir, "manifest.json")
  if (!fs.existsSync(manifestPath)) throw new Error(`migration ${version} is missing manifest.json`)
  const bytes = fs.readFileSync(manifestPath)
  let manifest: InstanceMigrationManifest
  try { manifest = JSON.parse(bytes.toString("utf8")) as InstanceMigrationManifest } catch {
    throw new Error(`migration ${version} manifest is malformed JSON`)
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.version !== version
    || !isStrictSemver(manifest.baseVersion)
    || compareSemver(manifest.baseVersion, manifest.version) >= 0
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`migration ${version} manifest has an invalid contract`)
  }
  const seen = new Set<string>()
  for (const record of manifest.files) {
    const recordPath = safeRelative(record.path, "instance path")
    if (seen.has(recordPath)) throw new Error(`migration ${version} repeats path ${recordPath}`)
    seen.add(recordPath)
    if (!(["add", "modify", "remove"] as unknown[]).includes(record.operation)) throw new Error(`migration ${version} has invalid operation`)
    const baseExpected = record.operation === "add" ? null : `files/base/${recordPath}`
    const targetExpected = record.operation === "remove" ? null : `files/target/${recordPath}`
    validatePayload(dir, record.basePayload, record.baseSha256, baseExpected)
    validatePayload(dir, record.targetPayload, record.targetSha256, targetExpected)
  }
  return { dir, manifestPath, manifest, manifestHash: sha256(bytes) }
}

function discoverMigrations(migrationsDir: string, packageVersion: string): {
  legacy: ValidatedLegacyMigration[]
  structured: ValidatedBundle[]
} {
  if (!fs.existsSync(migrationsDir)) return { legacy: [], structured: [] }
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const malformed = entries.map((entry) => entry.name).filter((name) => /\d/.test(name) && name.includes(".") && !isStrictSemver(name))
  if (malformed.length) throw new Error(`malformed migration directories: ${malformed.sort().join(", ")}`)
  const versions = entries
    .map((entry) => entry.name)
    .filter(isStrictSemver)
    .filter((version) => compareSemver(version, packageVersion) <= 0)
    .sort(compareSemver)
  const legacy: ValidatedLegacyMigration[] = []
  const structured: ValidatedBundle[] = []
  let sawStructured = false
  for (const version of versions) {
    const dir = path.join(migrationsDir, version)
    if (fs.existsSync(path.join(dir, "manifest.json"))) {
      sawStructured = true
      structured.push(validateBundle(dir, version))
      continue
    }
    if (!fs.existsSync(path.join(dir, "MIGRATION.md"))) {
      throw new Error(`migration ${version} is missing manifest.json or MIGRATION.md`)
    }
    if (sawStructured) throw new Error(`migration ${version} uses legacy Markdown after the structured migration chain began`)
    legacy.push(validateLegacyMigration(dir, version))
  }
  if (versions.length > 0 && structured.length === 0) {
    throw new Error(`migration chain through ${packageVersion} has no structured bundle`)
  }
  return { legacy, structured }
}

function composePrompt(options: {
  instanceHome: string
  fromVersion: string
  toVersion: string
  bundles: ValidatedBundle[]
  legacyMigrations: ValidatedLegacyMigration[]
  migrationKey: string
  materialization: MigrationMaterializationPlan
}): string {
  const snapshotRoot = path.join(options.instanceHome, ".migration-snapshots", options.migrationKey)
  const receiptPath = path.join(snapshotRoot, "completion-receipt.json")
  const lines = [
    `# Jinn instance migration: ${options.fromVersion} → ${options.toVersion}`,
    "",
    `Migration key: \`${options.migrationKey}\``,
    `Instance (user-owned): \`${options.instanceHome}\``,
    "",
    "Create and verify the idempotent migration snapshot before editing. Its read-only materialized base and target payloads apply the exact portalName/portalSlug replacements selected by this instance. Compare those materialized payloads byte-for-byte with the current user file; never reverse user text into placeholders or write raw template placeholders into the instance.",
    "For every non-remove record below, perform a three-way comparison: materialized base payload + current customized instance file + materialized target payload. User customizations win over stock defaults. An unresolved placeholder newly introduced by the target, or present in a customized user file, is a conflict that must be preserved/reported and never guessed. A placeholder already present in both base and target may be carried only when the user file equals the materialized base byte-for-byte.",
    "Removal is owned by the Jinn migration service. It synchronously removes only a live regular file whose bytes exactly match the audited materialized base and records a structured service outcome. Do not delete or edit any remove path. If the service preserved a path, leave it untouched and report the conflict; a freeform completion receipt cannot authorize its deletion.",
    "",
  ]
  for (const legacy of options.legacyMigrations) {
    const planned = options.materialization.legacy.find((entry) => entry.version === legacy.version)!
    const materialized = materializeTemplateBytes("MIGRATION.md", legacy.bytes, options.materialization.inputs).toString("utf8").trimEnd()
    lines.push(
      `## Legacy migration ${legacy.version}`,
      "",
      `Audited materialized instructions: \`${path.join(snapshotRoot, planned.destinationPath)}\``,
      "",
      materialized,
      "",
    )
  }
  for (const bundle of options.bundles) {
    lines.push(`## Migration ${bundle.manifest.version}`, "")
    for (const record of bundle.manifest.files) {
      const planned = options.materialization.files.find((file) => file.version === bundle.manifest.version && file.path === record.path)!
      const reviewInstruction = record.operation === "remove"
        ? "- Service removal: do not delete or edit this path. Report the service-owned removed, preserved, or already-missing outcome."
        : "- Review: merge conservatively, preserve customized content, and record the path as reviewed or explicitly skipped/conflicted."
      lines.push(
        `### \`${record.path}\` (${record.operation})`,
        `- Materialized base payload: ${planned.base ? `\`${path.join(snapshotRoot, planned.base.destinationPath)}\`` : "none"}`,
        `- User file: \`${path.join(options.instanceHome, record.path)}\``,
        `- Materialized target payload: ${planned.target ? `\`${path.join(snapshotRoot, planned.target.destinationPath)}\`` : "none"}`,
        reviewInstruction,
        "",
      )
    }
  }
  lines.push(
    `After verification, write the completion receipt exactly to \`${receiptPath}\` using this contract:`,
    "",
    "```json",
    JSON.stringify({
      schemaVersion: 1,
      migrationKey: options.migrationKey,
      reviewedFiles: ["<every reviewed manifest path>"],
      skippedItems: [{ path: "<skipped/conflicted path>", reason: "<why>" }],
      verifiedAt: "<ISO-8601 timestamp>",
    }, null, 2),
    "```",
    "",
    "Replace the example entries with the real reviewed and skipped/conflicted non-remove paths. Keep either array empty when it has no entries; every non-remove manifest path must appear in one of them. Remove paths must not appear in reviewedFiles or skippedItems because only the structured service removal receipt can cover them.",
    `Only then run \`jinn migrate --mark-done ${options.toVersion} --migration-key ${options.migrationKey}\`. Completion is receipt- and snapshot-gated; an engine exit or interrupted session never advances the marker.`,
    "Report changed, preserved, skipped, and conflicted paths.",
  )
  return `${lines.join("\n").trimEnd()}\n`
}

export function getPendingInstanceMigration(options: {
  instanceHome: string
  packageVersion: string
  migrationsDir: string
}): PendingInstanceMigration {
  if (!isStrictSemver(options.packageVersion)) throw new Error(`package version is not a plain X.Y.Z release: ${options.packageVersion}`)
  const instanceHome = fs.realpathSync(options.instanceHome)
  const marker = readMarker(instanceHome)
  if (marker.present && compareSemver(marker.version, options.packageVersion) >= 0) {
    return { required: false, fromVersion: marker.version, toVersion: options.packageVersion, versions: [], changedFiles: [], prompt: null, migrationKey: null, materialization: null }
  }
  const discovered = discoverMigrations(options.migrationsDir, options.packageVersion)
  const selected = discovered.structured.filter((bundle) => compareSemver(bundle.manifest.version, marker.version) > 0)
  if (selected.length === 0) {
    return { required: false, fromVersion: marker.version, toVersion: options.packageVersion, versions: [], changedFiles: [], prompt: null, migrationKey: null, materialization: null }
  }
  const firstStructuredVersion = selected[0].manifest.version
  const selectedLegacy = discovered.legacy.filter((legacy) => (
    compareSemver(legacy.version, marker.version) > 0
      && compareSemver(legacy.version, firstStructuredVersion) < 0
  ))
  let previousVersion: string | null = null
  for (const bundle of selected) {
    if (previousVersion && compareSemver(bundle.manifest.baseVersion, previousVersion) < 0) {
      throw new Error(`migration chain is broken at ${bundle.manifest.version}: expected base ${previousVersion} or newer, got ${bundle.manifest.baseVersion}`)
    }
    previousVersion = bundle.manifest.version
  }
  const materialization = buildMaterializationPlan(deriveTemplateMaterializationInputs(marker.config), selected, selectedLegacy)
  const migrationKey = sha256(JSON.stringify({
    instanceHome,
    fromVersion: marker.version,
    toVersion: options.packageVersion,
    legacyHashes: selectedLegacy.map((legacy) => legacy.sourceHash),
    manifestHashes: selected.map((bundle) => bundle.manifestHash),
    materializationInputsSha256: materialization.inputsSha256,
  }))
  const changedFiles = selected.flatMap((bundle) => bundle.manifest.files.map(({ path: filePath, operation }) => ({ path: filePath, operation })))
  return {
    required: true,
    fromVersion: marker.version,
    toVersion: options.packageVersion,
    versions: [...selectedLegacy.map((legacy) => legacy.version), ...selected.map((bundle) => bundle.manifest.version)],
    changedFiles,
    prompt: composePrompt({ instanceHome, fromVersion: marker.version, toVersion: options.packageVersion, bundles: selected, legacyMigrations: selectedLegacy, migrationKey, materialization }),
    migrationKey,
    materialization,
  }
}

interface SnapshotRemovalEntry {
  path: string
  state: "missing" | "file" | "symlink"
}

function serviceRemovalTarget(instanceHome: string, relative: string): string {
  const safe = safeRelative(relative, "service removal path")
  const resolved = path.resolve(instanceHome, safe)
  if (!resolved.startsWith(`${instanceHome}${path.sep}`)) throw new Error(`service removal path escapes the instance: ${relative}`)
  return resolved
}

function serviceMaterializedBase(snapshotRoot: string, relative: string): string {
  const safe = safeRelative(relative, "materialized removal base")
  const resolved = path.resolve(snapshotRoot, safe)
  if (!resolved.startsWith(`${snapshotRoot}${path.sep}`)) throw new Error(`materialized removal base escapes the snapshot: ${relative}`)
  return resolved
}

function readPreviousServiceRemovalReceipt(receiptPath: string, migrationKey: string): ServiceRemovalReceipt | null {
  if (!fs.existsSync(receiptPath)) return null
  let receipt: ServiceRemovalReceipt
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as ServiceRemovalReceipt } catch {
    throw new Error("service-owned removal outcome has an invalid contract")
  }
  if (receipt.schemaVersion !== 1 || receipt.migrationKey !== migrationKey || !Array.isArray(receipt.outcomes)) {
    throw new Error("service-owned removal outcome has an invalid contract")
  }
  const seen = new Set<string>()
  for (const outcome of receipt.outcomes) {
    const key = `${outcome.version}\0${outcome.path}`
    if (
      typeof outcome.version !== "string"
      || typeof outcome.path !== "string"
      || !(["removed", "preserved", "already-missing"] as unknown[]).includes(outcome.status)
      || typeof outcome.baseSha256 !== "string"
      || seen.has(key)
    ) throw new Error("service-owned removal outcome has an invalid contract")
    seen.add(key)
  }
  return receipt
}

function writeServiceRemovalReceipt(receiptPath: string, receipt: ServiceRemovalReceipt): void {
  const temp = `${receiptPath}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    fs.renameSync(temp, receiptPath)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/**
 * Own structured removals in trusted synchronous code. There are deliberately
 * no callbacks or promises in the live compare/unlink sequence: the service
 * opens and reads the current regular file, re-checks the same directory entry,
 * and unlinks it only when those live bytes equal the audited materialized base.
 */
export function reconcileServiceOwnedRemovals(options: {
  instanceHome: string
  pending: PendingInstanceMigration
}): ServiceRemovalReceipt {
  const home = fs.realpathSync(options.instanceHome)
  const migrationKey = options.pending.migrationKey
  if (!options.pending.required || !migrationKey || !/^[a-f0-9]{64}$/.test(migrationKey)) {
    throw new Error("service-owned removal requires a pending migration key")
  }
  const removals = options.pending.materialization?.files.filter((file) => file.operation === "remove") ?? []
  const changedRemovalPaths = new Set(options.pending.changedFiles.filter((file) => file.operation === "remove").map((file) => file.path))
  if (changedRemovalPaths.size > 0 && removals.length === 0) {
    throw new Error("service-owned removal requires structured materialization")
  }
  const snapshotRoot = path.join(home, ".migration-snapshots", migrationKey)
  const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotRoot, "snapshot.json"), "utf8")) as { files?: SnapshotRemovalEntry[] }
  const snapshotEntries = new Map((snapshot.files ?? []).map((entry) => [entry.path, entry]))
  const receiptPath = path.join(snapshotRoot, SERVICE_REMOVAL_RECEIPT)
  const previous = readPreviousServiceRemovalReceipt(receiptPath, migrationKey)
  const previousByOperation = new Map((previous?.outcomes ?? []).map((outcome) => [`${outcome.version}\0${outcome.path}`, outcome]))
  const outcomes: ServiceRemovalOutcome[] = []

  for (const operation of removals) {
    if (!operation.base) throw new Error(`service-owned removal is missing a materialized base: ${operation.path}`)
    const targetPath = serviceRemovalTarget(home, operation.path)
    const basePath = serviceMaterializedBase(snapshotRoot, operation.base.destinationPath)
    const baseStat = fs.lstatSync(basePath)
    if (!baseStat.isFile()) throw new Error(`service-owned removal base is not a regular file: ${operation.path}`)
    const baseBytes = fs.readFileSync(basePath)
    const baseSha256 = sha256(baseBytes)
    const operationKey = `${operation.version}\0${operation.path}`
    const prior = previousByOperation.get(operationKey)
    if (prior && prior.baseSha256 !== baseSha256) {
      throw new Error(`service-owned removal base changed after reconciliation: ${operation.path}`)
    }
    const current = fs.lstatSync(targetPath, { throwIfNoEntry: false })

    if (!current) {
      if (prior?.status === "preserved") {
        throw new Error(`service-preserved removal target disappeared before completion: ${operation.path}`)
      }
      if (prior?.status === "removed" || prior?.status === "already-missing") {
        outcomes.push(prior)
        continue
      }
      if (snapshotEntries.get(operation.path)?.state !== "missing") {
        throw new Error(`service-owned removal outcome is required before accepting deletion of ${operation.path}`)
      }
      outcomes.push({
        version: operation.version,
        path: operation.path,
        status: "already-missing",
        baseSha256,
        observedState: "missing",
        reason: "target was absent in both the audited snapshot and service reconciliation",
      })
      continue
    }

    // Preservation is terminal for this migration. A later retry may verify
    // that the same conflict is still present, but it must never reinterpret
    // newly changed bytes as stock and turn an earlier preserve into a delete.
    if (prior?.status === "preserved") {
      let unchanged = false
      if (current.isFile() && prior.observedState === "file" && prior.observedSha256) {
        const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          unchanged = sha256(fs.readFileSync(fd)) === prior.observedSha256
        } finally {
          fs.closeSync(fd)
        }
      } else if (current.isSymbolicLink() && prior.observedState === "symlink") {
        unchanged = fs.readlinkSync(targetPath) === prior.linkTarget
      } else if (!current.isFile() && !current.isSymbolicLink() && prior.observedState === "other") {
        unchanged = true
      }
      if (!unchanged) throw new Error(`service-preserved removal target changed before completion: ${operation.path}`)
      outcomes.push(prior)
      continue
    }

    if (!current.isFile()) {
      outcomes.push({
        version: operation.version,
        path: operation.path,
        status: "preserved",
        baseSha256,
        observedState: current.isSymbolicLink() ? "symlink" : "other",
        ...(current.isSymbolicLink() ? { linkTarget: fs.readlinkSync(targetPath) } : {}),
        reason: "live target is not a regular file",
      })
      continue
    }

    const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let liveBytes: Buffer
    let opened: fs.Stats
    try {
      opened = fs.fstatSync(fd)
      if (!opened.isFile()) throw new Error(`service-owned removal target changed type during comparison: ${operation.path}`)
      liveBytes = fs.readFileSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const liveSha256 = sha256(liveBytes)
    if (!liveBytes.equals(baseBytes)) {
      outcomes.push({
        version: operation.version,
        path: operation.path,
        status: "preserved",
        baseSha256,
        observedState: "file",
        observedSha256: liveSha256,
        reason: "live bytes differ from the audited materialized base",
      })
      continue
    }

    const immediatelyBeforeUnlink = fs.lstatSync(targetPath, { throwIfNoEntry: false })
    if (
      !immediatelyBeforeUnlink?.isFile()
      || immediatelyBeforeUnlink.dev !== opened.dev
      || immediatelyBeforeUnlink.ino !== opened.ino
      || immediatelyBeforeUnlink.size !== opened.size
      || immediatelyBeforeUnlink.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`service-owned removal target changed during comparison: ${operation.path}`)
    }
    fs.unlinkSync(targetPath)
    outcomes.push({
      version: operation.version,
      path: operation.path,
      status: "removed",
      baseSha256,
      observedState: "file",
      observedSha256: liveSha256,
      reason: "live bytes exactly matched the audited materialized base",
    })
  }

  const receipt: ServiceRemovalReceipt = {
    schemaVersion: 1,
    migrationKey,
    reconciledAt: new Date().toISOString(),
    outcomes,
  }
  if (removals.length > 0) writeServiceRemovalReceipt(receiptPath, receipt)
  return receipt
}
