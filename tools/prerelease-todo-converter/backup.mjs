import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../packages/jinn/package.json", import.meta.url));
const Database = require("better-sqlite3");

function digestFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function regularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} must be an existing regular non-symlink file`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return stat;
}

function assertQuiescent(databasePath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (fs.existsSync(`${databasePath}${suffix}`)) {
      throw new Error("SQLite WAL/journal evidence exists; the source is not offline and quiescent");
    }
  }
}

function integrity(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return String(db.pragma("integrity_check", { simple: true }));
  } finally {
    db.close();
  }
}

export function verifyExternalBackup({ sourcePath, backupPath }) {
  assertQuiescent(sourcePath);
  assertQuiescent(backupPath);
  const sourceStat = regularFile(sourcePath, "source database");
  const backupStat = regularFile(backupPath, "backup database");
  const sameFile = sourceStat.dev === backupStat.dev && sourceStat.ino === backupStat.ino;
  if (sameFile) throw new Error("backup must be a separate file from the source database");
  const sourceDigest = digestFile(sourcePath);
  const backupDigest = digestFile(backupPath);
  if (sourceDigest !== backupDigest) throw new Error("backup digest does not match the offline source database");
  const result = integrity(backupPath);
  if (result !== "ok") throw new Error("backup SQLite integrity check failed");
  return {
    sourceDigest,
    backupDigest,
    integrity: result,
    sameFile: false,
    size: sourceStat.size,
  };
}

export function rehearseRestore({ backupPath, restorePath }) {
  assertQuiescent(backupPath);
  regularFile(backupPath, "backup database");
  if (fs.existsSync(restorePath)) throw new Error("restore rehearsal target already exists");
  fs.mkdirSync(path.dirname(restorePath), { recursive: true });
  fs.copyFileSync(backupPath, restorePath, fs.constants.COPYFILE_EXCL);
  try {
    const backupDigest = digestFile(backupPath);
    const restoredDigest = digestFile(restorePath);
    if (restoredDigest !== backupDigest) throw new Error("restored backup digest mismatch");
    const result = integrity(restorePath);
    if (result !== "ok") throw new Error("restored SQLite integrity check failed");
    return { backupDigest, restoredDigest, integrity: result };
  } catch (error) {
    fs.rmSync(restorePath, { force: true });
    throw error;
  }
}
