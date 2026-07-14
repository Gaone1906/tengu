import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { completeInstanceMigration } from "../completion.js"
import { createMigrationSnapshot } from "../snapshot.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("completeInstanceMigration", () => {
  it("requires the expected key, verified snapshot, and complete receipt before preserving config formatting", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-complete-"))
    roots.push(home)
    fs.writeFileSync(path.join(home, "config.yaml"), "# keep\njinn: { version: \"0.25.0\" } # inline\ncustom: yes\n")
    const pending = {
      required: true as const,
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      versions: ["0.26.0"],
      changedFiles: [{ path: "CLAUDE.md", operation: "modify" as const }],
      prompt: "prompt",
      migrationKey: "d".repeat(64),
      materialization: null,
    }
    expect(() => completeInstanceMigration({ instanceHome: home, installedPackageVersion: "0.26.0", targetVersion: "0.26.0", expectedMigrationKey: "bad", pending })).toThrow(/key/i)
    expect(() => completeInstanceMigration({ instanceHome: home, installedPackageVersion: "0.26.0", targetVersion: "0.26.0", expectedMigrationKey: pending.migrationKey, pending })).toThrow(/snapshot/i)

    const snapshot = createMigrationSnapshot({ instanceHome: home, migrationKey: pending.migrationKey, fromVersion: pending.fromVersion, toVersion: pending.toVersion, changedFiles: pending.changedFiles })
    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: [],
      skippedItems: [],
    }))
    expect(() => completeInstanceMigration({ instanceHome: home, installedPackageVersion: "0.26.0", targetVersion: "0.26.0", expectedMigrationKey: pending.migrationKey, pending })).toThrow(/reviewed/i)

    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: ["CLAUDE.md"],
      skippedItems: [],
      verifiedAt: "2026-07-14T00:00:00.000Z",
    }))
    completeInstanceMigration({ instanceHome: home, installedPackageVersion: "0.26.0", targetVersion: "0.26.0", expectedMigrationKey: pending.migrationKey, pending })
    const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8")
    expect(config).toContain("# keep")
    expect(config).toContain("# inline")
    expect(config).toContain("custom: yes")
    expect(config).toContain('version: "0.26.0"')
  })

  it("refuses a target other than the installed package", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-complete-version-"))
    roots.push(home)
    fs.writeFileSync(path.join(home, "config.yaml"), "jinn:\n  version: 0.25.0\n")
    expect(() => completeInstanceMigration({
      instanceHome: home,
      installedPackageVersion: "0.26.0",
      targetVersion: "0.27.0",
      expectedMigrationKey: "e".repeat(64),
      pending: { required: false, fromVersion: "0.25.0", toVersion: "0.26.0", versions: [], changedFiles: [], prompt: null, migrationKey: null, materialization: null },
    })).toThrow(/installed package/i)
  })
})
