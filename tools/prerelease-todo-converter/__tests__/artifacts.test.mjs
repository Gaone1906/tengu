import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inventoryArtifactRoots,
  rehearseArtifactRestore,
  verifyArtifactBackups,
} from "../artifacts.mjs";

function rootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifacts-"));
  fs.mkdirSync(path.join(root, "runs", "wf"), { recursive: true });
  fs.mkdirSync(path.join(root, "poll"), { recursive: true });
  return root;
}

test("opens the closed artifact allowlist without following paths and returns deterministic digest evidence", () => {
  const root = rootFixture();
  try {
    fs.writeFileSync(path.join(root, "runs", "wf", "done.json"), JSON.stringify({
      schemaVersion: 3,
      status: "completed",
      trigger: { payload: { todoId: "wi_000000000001" } },
      prompt: "free-form wi_000000000001 remains prose",
    }));
    fs.writeFileSync(path.join(root, "poll", "safe.json"), JSON.stringify({ note: "free-form wi_000000000001" }));
    const input = [{
      path: path.join(root, "runs"),
      kind: "workflow",
      files: ["wf/done.json"],
    }, {
      path: path.join(root, "poll"),
      kind: "poll",
      files: ["safe.json"],
    }];
    const first = inventoryArtifactRoots(input, new Map([["wi_000000000001", "JIN-1"]]));
    const second = inventoryArtifactRoots(input, new Map([["wi_000000000001", "JIN-1"]]));
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    assert.equal(first.files.length, 2);
    assert.doesNotMatch(JSON.stringify(first), /wi_[0-9a-f]{12}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses symlinks, unexpected files, nonterminal Workflow references, and executable poll references", () => {
  const root = rootFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifacts-outside-"));
  try {
    fs.writeFileSync(path.join(root, "runs", "wf", "running.json"), JSON.stringify({
      schemaVersion: 3,
      status: "running",
      trigger: { payload: { todoId: "wi_000000000001" } },
    }));
    fs.writeFileSync(path.join(root, "poll", "armed.json"), JSON.stringify({
      activation: "active",
      filter: { todoId: "wi_000000000001" },
    }));
    fs.writeFileSync(path.join(root, "poll", "unexpected.json"), "{}");
    fs.writeFileSync(path.join(outside, "target.json"), "{}");
    fs.symlinkSync(path.join(outside, "target.json"), path.join(root, "poll", "link.json"));

    const report = inventoryArtifactRoots([{
      path: path.join(root, "runs"),
      kind: "workflow",
      files: ["wf/running.json"],
    }, {
      path: path.join(root, "poll"),
      kind: "poll",
      files: ["armed.json", "link.json"],
    }], new Map([["wi_000000000001", "JIN-1"]]));
    assert.equal(report.ok, false);
    for (const code of ["unsafe-artifact", "unexpected-artifact", "nonterminal-workflow-todo-reference", "executable-poll-todo-reference"]) {
      assert.equal(report.blockers.some((entry) => entry.code === code), true, code);
    }
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("verifies byte-exact external artifact backups and rehearses a descriptor-safe restore", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifact-source-"));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifact-backup-"));
  const restore = path.join(os.tmpdir(), `jinn-prerelease-artifact-restore-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(path.join(source, "runs", "wf"), { recursive: true });
    fs.mkdirSync(path.join(backup, "runs", "wf"), { recursive: true });
    const content = JSON.stringify({ schemaVersion: 3, status: "completed", prompt: "generic" });
    fs.writeFileSync(path.join(source, "runs", "wf", "done.json"), content);
    fs.writeFileSync(path.join(backup, "runs", "wf", "done.json"), content);
    const sourceRoots = [{ path: source, kind: "workflow", files: ["runs/wf/done.json"] }];
    const backupRoots = [{ path: backup, kind: "workflow", files: ["runs/wf/done.json"] }];
    const restoreRoots = [{ path: restore, kind: "workflow", files: ["runs/wf/done.json"] }];

    const verified = verifyArtifactBackups({ sourceRoots, backupRoots });
    assert.equal(verified.ok, true);
    const rehearsal = rehearseArtifactRestore({ backupRoots, restoreRoots });
    assert.equal(rehearsal.ok, true);
    assert.equal(fs.readFileSync(path.join(restore, "runs", "wf", "done.json"), "utf8"), content);
    assert.equal(JSON.stringify({ verified, rehearsal }).includes(source), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(restore, { recursive: true, force: true });
  }
});

test("refuses artifact backup mismatches and occupied restore targets", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifact-source-"));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifact-backup-"));
  const restore = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-artifact-restore-"));
  try {
    fs.mkdirSync(path.join(source, "runs", "wf"), { recursive: true });
    fs.mkdirSync(path.join(backup, "runs", "wf"), { recursive: true });
    fs.writeFileSync(path.join(source, "runs", "wf", "done.json"), '{"status":"completed"}');
    fs.writeFileSync(path.join(backup, "runs", "wf", "done.json"), '{"status":"failed"}');
    const roots = (root) => [{ path: root, kind: "workflow", files: ["runs/wf/done.json"] }];
    assert.throws(
      () => verifyArtifactBackups({ sourceRoots: roots(source), backupRoots: roots(backup) }),
      /digest|match/i,
    );
    assert.throws(
      () => rehearseArtifactRestore({ backupRoots: roots(backup), restoreRoots: roots(restore) }),
      /already exists/i,
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(restore, { recursive: true, force: true });
  }
});
