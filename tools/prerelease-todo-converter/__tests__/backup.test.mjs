import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { rehearseRestore, verifyExternalBackup } from "../backup.mjs";

const require = createRequire(new URL("../../../packages/jinn/package.json", import.meta.url));
const Database = require("better-sqlite3");

function databaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-backup-"));
  const source = path.join(root, "source.db");
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-external-"));
  const backup = path.join(external, "backup.db");
  const db = new Database(source);
  db.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO evidence VALUES (1, 'generic')");
  db.close();
  fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
  return { root, external, source, backup };
}

test("verifies a byte-exact external SQLite backup and rehearses restoration elsewhere", () => {
  const fixture = databaseFixture();
  try {
    const evidence = verifyExternalBackup({ sourcePath: fixture.source, backupPath: fixture.backup });
    assert.equal(evidence.sourceDigest, evidence.backupDigest);
    assert.equal(evidence.integrity, "ok");
    assert.equal(evidence.sameFile, false);

    const restored = path.join(fixture.root, "restore-rehearsal", "sessions.db");
    const rehearsal = rehearseRestore({ backupPath: fixture.backup, restorePath: restored });
    assert.equal(rehearsal.restoredDigest, evidence.backupDigest);
    assert.equal(rehearsal.integrity, "ok");
    assert.ok(fs.readFileSync(restored).equals(fs.readFileSync(fixture.source)));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.external, { recursive: true, force: true });
  }
});

test("refuses same-file, changed, WAL-bearing, and pre-existing restore targets", () => {
  const fixture = databaseFixture();
  try {
    assert.throws(() => verifyExternalBackup({ sourcePath: fixture.source, backupPath: fixture.source }), /separate file/i);

    fs.appendFileSync(fixture.backup, "changed");
    assert.throws(() => verifyExternalBackup({ sourcePath: fixture.source, backupPath: fixture.backup }), /digest/i);
    fs.copyFileSync(fixture.source, fixture.backup);

    fs.writeFileSync(`${fixture.source}-wal`, "live");
    assert.throws(() => verifyExternalBackup({ sourcePath: fixture.source, backupPath: fixture.backup }), /WAL/i);
    fs.rmSync(`${fixture.source}-wal`);

    const occupied = path.join(fixture.root, "occupied.db");
    fs.writeFileSync(occupied, "do not overwrite");
    assert.throws(() => rehearseRestore({ backupPath: fixture.backup, restorePath: occupied }), /already exists/i);
    assert.equal(fs.readFileSync(occupied, "utf8"), "do not overwrite");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.external, { recursive: true, force: true });
  }
});

test("the executable is dry-run-only, has no instance defaults, and emits deterministic digest evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-cli-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-cli-external-"));
  try {
    const source = path.join(root, "source.db");
    const backup = path.join(external, "backup.db");
    const db = new Database(source);
    db.exec(`
      CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO work_items VALUES ('wi_000000000001', 'generic', '2026-07-14T00:00:00.000Z');
    `);
    db.close();
    fs.copyFileSync(source, backup);
    const artifactSource = path.join(root, "artifacts");
    const artifactBackup = path.join(external, "artifacts");
    fs.mkdirSync(path.join(artifactSource, "runs"), { recursive: true });
    fs.mkdirSync(path.join(artifactBackup, "runs"), { recursive: true });
    const terminalRun = JSON.stringify({
      schemaVersion: 3,
      status: "completed",
      trigger: { payload: { todoId: "wi_000000000001" } },
    });
    fs.writeFileSync(path.join(artifactSource, "runs", "terminal.json"), terminalRun);
    fs.writeFileSync(path.join(artifactBackup, "runs", "terminal.json"), terminalRun);
    const manifest = path.join(root, "artifact-manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ roots: [{
      kind: "workflow",
      sourcePath: artifactSource,
      backupPath: artifactBackup,
      restorePath: path.join(root, "artifact-restore"),
      files: ["runs/terminal.json"],
    }] }));
    const cli = fileURLToPath(new URL("../dry-run.mjs", import.meta.url));
    const run = (restore) => spawnSync(process.execPath, [
      cli, "--database", source, "--backup", backup, "--restore-rehearsal", restore,
      "--artifacts", manifest, "--prefix", "ICI",
    ], { encoding: "utf8" });

    const first = run(path.join(root, "restore-1.db"));
    fs.rmSync(path.join(root, "artifact-restore"), { recursive: true, force: true });
    const second = run(path.join(root, "restore-2.db"));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstReport = JSON.parse(first.stdout);
    const secondReport = JSON.parse(second.stdout);
    assert.equal(firstReport.mode, "dry-run");
    assert.equal(firstReport.inventory.reportDigest, secondReport.inventory.reportDigest);
    assert.equal(firstReport.artifacts.reportDigest, secondReport.artifacts.reportDigest);
    assert.equal(firstReport.backup.backupDigest, secondReport.backup.backupDigest);
    assert.equal(firstReport.artifactBackup.reportDigest, secondReport.artifactBackup.reportDigest);
    assert.equal(firstReport.artifactRestore.reportDigest, secondReport.artifactRestore.reportDigest);
    assert.doesNotMatch(first.stdout, /wi_[0-9a-f]{12}/);
    assert.equal(fs.readFileSync(path.join(artifactSource, "runs", "terminal.json"), "utf8"), terminalRun);
    assert.equal(fs.readFileSync(path.join(artifactBackup, "runs", "terminal.json"), "utf8"), terminalRun);

    const apply = spawnSync(process.execPath, [cli, "--apply", source], { encoding: "utf8" });
    assert.notEqual(apply.status, 0);
    assert.match(apply.stderr, /usage|dry-run/i);
    assert.ok(fs.readFileSync(source).equals(fs.readFileSync(backup)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
