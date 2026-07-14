#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { inventoryDatabaseForDryRun } from "./inventory.mjs";
import { rehearseRestore, verifyExternalBackup } from "./backup.mjs";
import { inventoryArtifactRoots, rehearseArtifactRestore, verifyArtifactBackups } from "./artifacts.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readArtifactManifest(manifestPath) {
  let stat;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch {
    throw new Error("artifact manifest must be an existing bounded regular non-symlink file");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("artifact manifest must be a bounded regular non-symlink file");
  }
  const bytes = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("artifact manifest is malformed");
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.roots)) {
    throw new Error("artifact manifest must contain a roots array");
  }
  const sourceRoots = [];
  const backupRoots = [];
  const restoreRoots = [];
  for (const root of manifest.roots) {
    if (!root || typeof root !== "object" || typeof root.sourcePath !== "string"
      || typeof root.backupPath !== "string" || typeof root.restorePath !== "string") {
      throw new Error("artifact manifest root is incomplete");
    }
    const common = { kind: root.kind, files: root.files };
    sourceRoots.push({ ...common, path: root.sourcePath });
    backupRoots.push({ ...common, path: root.backupPath });
    restoreRoots.push({ ...common, path: root.restorePath });
  }
  return { sourceRoots, backupRoots, restoreRoots, manifestDigest: sha256(bytes) };
}

function parseArgs(argv) {
  const allowed = new Set(["--database", "--backup", "--restore-rehearsal", "--artifacts", "--prefix"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error("usage: dry-run.mjs --database <offline.db> --backup <external.db> --restore-rehearsal <new-path> --artifacts <manifest.json> --prefix <AAA>");
    }
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  if (values.size !== allowed.size) {
    throw new Error("all dry-run paths are required; there are no instance defaults");
  }
  return {
    databasePath: values.get("--database"),
    backupPath: values.get("--backup"),
    restorePath: values.get("--restore-rehearsal"),
    artifactManifestPath: values.get("--artifacts"),
    prefix: values.get("--prefix"),
  };
}

export function runDryRun(argv) {
  const paths = parseArgs(argv);
  const manifest = readArtifactManifest(paths.artifactManifestPath);
  const backup = verifyExternalBackup({ sourcePath: paths.databasePath, backupPath: paths.backupPath });
  const artifactBackup = verifyArtifactBackups({
    sourceRoots: manifest.sourceRoots,
    backupRoots: manifest.backupRoots,
  });
  const databaseInventory = inventoryDatabaseForDryRun({ databasePath: paths.databasePath, prefix: paths.prefix });
  const inventory = databaseInventory.report;
  const artifacts = inventoryArtifactRoots(manifest.sourceRoots, databaseInventory.mapping);
  const restore = rehearseRestore({ backupPath: paths.backupPath, restorePath: paths.restorePath });
  const artifactRestore = rehearseArtifactRestore({
    backupRoots: manifest.backupRoots,
    restoreRoots: manifest.restoreRoots,
  });
  const finalBackup = verifyExternalBackup({ sourcePath: paths.databasePath, backupPath: paths.backupPath });
  const finalArtifactBackup = verifyArtifactBackups({
    sourceRoots: manifest.sourceRoots,
    backupRoots: manifest.backupRoots,
  });
  if (backup.sourceDigest !== finalBackup.sourceDigest
    || backup.backupDigest !== finalBackup.backupDigest
    || artifactBackup.reportDigest !== finalArtifactBackup.reportDigest) {
    throw new Error("offline source evidence changed during the dry run");
  }
  return {
    mode: "dry-run",
    ok: inventory.ok && artifacts.ok,
    inventory,
    artifacts,
    backup: {
      sourceDigest: backup.sourceDigest,
      backupDigest: backup.backupDigest,
      integrity: backup.integrity,
      size: backup.size,
    },
    restore,
    artifactBackup,
    artifactRestore,
    manifestDigest: manifest.manifestDigest,
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const report = runDryRun(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
