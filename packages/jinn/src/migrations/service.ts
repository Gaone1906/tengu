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
  if (manifest.schemaVersion !== 1 || manifest.version !== version || !isStrictSemver(manifest.baseVersion) || !Array.isArray(manifest.files)) {
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
    "For every record below, perform a three-way comparison: materialized base payload + current customized instance file + materialized target payload. User customizations win over stock defaults. An unresolved placeholder newly introduced by the target, or present in a customized user file, is a conflict that must be preserved/reported and never guessed. A placeholder already present in both base and target may be carried only when the user file equals the materialized base byte-for-byte. Do not delete user content without explicit instruction and backup.",
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
      lines.push(
        `### \`${record.path}\` (${record.operation})`,
        `- Materialized base payload: ${planned.base ? `\`${path.join(snapshotRoot, planned.base.destinationPath)}\`` : "none"}`,
        `- User file: \`${path.join(options.instanceHome, record.path)}\``,
        `- Materialized target payload: ${planned.target ? `\`${path.join(snapshotRoot, planned.target.destinationPath)}\`` : "none"}`,
        "- Review: merge conservatively, preserve customized content, and record the path as reviewed or explicitly skipped/conflicted.",
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
    "Replace the example entries with the real reviewed and skipped/conflicted paths. Keep either array empty when it has no entries; every manifest path must appear in one of them.",
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
  let expectedBase = selected[0].manifest.baseVersion
  for (const [index, bundle] of selected.entries()) {
    if (index === 0) {
      expectedBase = bundle.manifest.version
      continue
    }
    if (bundle.manifest.baseVersion !== expectedBase) {
      throw new Error(`migration chain is broken at ${bundle.manifest.version}: expected base ${expectedBase}, got ${bundle.manifest.baseVersion}`)
    }
    expectedBase = bundle.manifest.version
  }
  if (expectedBase !== options.packageVersion) {
    throw new Error(`migration chain ends at ${expectedBase}, not installed package ${options.packageVersion}`)
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
