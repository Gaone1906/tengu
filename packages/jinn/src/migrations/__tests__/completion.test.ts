import fs from "node:fs"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { completeInstanceMigration } from "../completion.js"
import { createMigrationSnapshot } from "../snapshot.js"
import { migrationMaterializationInputsSha256, type MigrationMaterializationPlan } from "../service.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("completeInstanceMigration", () => {
  it("does not let a generic reviewed receipt authorize deletion after stock snapshot bytes were customized", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-complete-live-modified-remove-"))
    roots.push(home)
    fs.mkdirSync(path.join(home, "talk"), { recursive: true })
    const configPath = path.join(home, "config.yaml")
    const targetPath = path.join(home, "talk/orchestrator-persona.md")
    fs.writeFileSync(configPath, 'jinn:\n  version: "0.29.0"\n')
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "company doctrine\n")

    const sourceRoot = path.join(home, "migration-sources")
    const baseSource = path.join(sourceRoot, "files/base/talk/orchestrator-persona.md")
    fs.mkdirSync(path.dirname(baseSource), { recursive: true })
    const stockBytes = "stock voice persona\n"
    fs.writeFileSync(baseSource, stockBytes)
    fs.writeFileSync(targetPath, stockBytes)
    const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
    const manifests = [{ version: "0.29.1", sha256: "b".repeat(64) }]
    const materialization: MigrationMaterializationPlan = {
      schemaVersion: 1,
      inputs: { portalName: "Jinn", portalSlug: "jinn" },
      inputsSha256: migrationMaterializationInputsSha256(
        { portalName: "Jinn", portalSlug: "jinn" },
        manifests,
      ),
      manifests,
      legacy: [],
      files: [{
        version: "0.29.1",
        path: "talk/orchestrator-persona.md",
        operation: "remove",
        base: {
          sourcePath: baseSource,
          destinationPath: "materialized/0.29.1/files/base/talk/orchestrator-persona.md",
          sourceSha256: sha256(stockBytes),
        },
        target: null,
      }],
    }
    const pending = {
      required: true as const,
      fromVersion: "0.29.0",
      toVersion: "0.29.1",
      versions: ["0.29.1"],
      changedFiles: [{ path: "talk/orchestrator-persona.md", operation: "remove" as const }],
      prompt: "prompt",
      migrationKey: "e".repeat(64),
      materialization,
    }
    const snapshot = createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization,
    })

    fs.writeFileSync(targetPath, "customized after snapshot\n")
    // Reproduce the unsafe freeform sequence: snapshot stock bytes, customize
    // them, delete the customized path, then claim the path was reviewed.
    fs.rmSync(targetPath)
    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: ["talk/orchestrator-persona.md"],
      skippedItems: [],
      verifiedAt: "2026-08-05T00:00:00.000Z",
    }))

    expect(() => completeInstanceMigration({
      instanceHome: home,
      installedPackageVersion: "0.29.1",
      targetVersion: "0.29.1",
      expectedMigrationKey: pending.migrationKey,
      pending,
    })).toThrow(/service-owned removal (?:outcome|path)/i)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readFileSync(configPath, "utf8")).toContain('version: "0.29.0"')
  })

  it("preserves a custom removal target that appears after a missing snapshot and rejects generic review", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-complete-live-added-remove-"))
    roots.push(home)
    fs.mkdirSync(path.join(home, "talk"), { recursive: true })
    const configPath = path.join(home, "config.yaml")
    const targetPath = path.join(home, "talk/orchestrator-persona.md")
    fs.writeFileSync(configPath, 'jinn:\n  version: "0.29.0"\n')
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "company doctrine\n")

    const sourceRoot = path.join(home, "migration-sources")
    const baseSource = path.join(sourceRoot, "files/base/talk/orchestrator-persona.md")
    fs.mkdirSync(path.dirname(baseSource), { recursive: true })
    const stockBytes = "stock voice persona\n"
    fs.writeFileSync(baseSource, stockBytes)
    const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
    const manifests = [{ version: "0.29.1", sha256: "c".repeat(64) }]
    const materialization: MigrationMaterializationPlan = {
      schemaVersion: 1,
      inputs: { portalName: "Jinn", portalSlug: "jinn" },
      inputsSha256: migrationMaterializationInputsSha256(
        { portalName: "Jinn", portalSlug: "jinn" },
        manifests,
      ),
      manifests,
      legacy: [],
      files: [{
        version: "0.29.1",
        path: "talk/orchestrator-persona.md",
        operation: "remove",
        base: {
          sourcePath: baseSource,
          destinationPath: "materialized/0.29.1/files/base/talk/orchestrator-persona.md",
          sourceSha256: sha256(stockBytes),
        },
        target: null,
      }],
    }
    const pending = {
      required: true as const,
      fromVersion: "0.29.0",
      toVersion: "0.29.1",
      versions: ["0.29.1"],
      changedFiles: [{ path: "talk/orchestrator-persona.md", operation: "remove" as const }],
      prompt: "prompt",
      migrationKey: "c".repeat(64),
      materialization,
    }
    const snapshot = createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization,
    })

    // A new user file appears after the audited snapshot. A generic reviewed
    // claim must neither remove it nor authorize completion.
    fs.writeFileSync(targetPath, "new custom voice persona\n")
    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: ["talk/orchestrator-persona.md"],
      skippedItems: [],
      verifiedAt: "2026-08-05T00:00:00.000Z",
    }))

    expect(() => completeInstanceMigration({
      instanceHome: home,
      installedPackageVersion: "0.29.1",
      targetVersion: "0.29.1",
      expectedMigrationKey: pending.migrationKey,
      pending,
    })).toThrow(/service-owned removal (?:outcome|path)/i)
    expect(fs.readFileSync(targetPath, "utf8")).toBe("new custom voice persona\n")
    expect(fs.readFileSync(configPath, "utf8")).toContain('version: "0.29.0"')
  })

  it("preserves a user-modified remove target through a service-owned outcome", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-complete-modified-remove-"))
    roots.push(home)
    fs.mkdirSync(path.join(home, "talk"), { recursive: true })
    fs.writeFileSync(path.join(home, "config.yaml"), 'jinn:\n  version: "0.29.0"\n')
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "company doctrine\n")
    fs.writeFileSync(path.join(home, "talk/orchestrator-persona.md"), "customized voice persona\n")

    const sourceRoot = path.join(home, "migration-sources")
    const baseSource = path.join(sourceRoot, "files/base/talk/orchestrator-persona.md")
    fs.mkdirSync(path.dirname(baseSource), { recursive: true })
    const stockBytes = "stock voice persona\n"
    fs.writeFileSync(baseSource, stockBytes)
    const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
    const manifests = [{ version: "0.29.1", sha256: "a".repeat(64) }]
    const materialization: MigrationMaterializationPlan = {
      schemaVersion: 1,
      inputs: { portalName: "Jinn", portalSlug: "jinn" },
      inputsSha256: migrationMaterializationInputsSha256(
        { portalName: "Jinn", portalSlug: "jinn" },
        manifests,
      ),
      manifests,
      legacy: [],
      files: [{
        version: "0.29.1",
        path: "talk/orchestrator-persona.md",
        operation: "remove",
        base: {
          sourcePath: baseSource,
          destinationPath: "materialized/0.29.1/files/base/talk/orchestrator-persona.md",
          sourceSha256: sha256(stockBytes),
        },
        target: null,
      }],
    }
    const pending = {
      required: true as const,
      fromVersion: "0.29.0",
      toVersion: "0.29.1",
      versions: ["0.29.1"],
      changedFiles: [{ path: "talk/orchestrator-persona.md", operation: "remove" as const }],
      prompt: "prompt",
      migrationKey: "f".repeat(64),
      materialization,
    }
    const snapshot = createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization,
    })

    // A careless migration worker deleted a customized file and claimed review.
    fs.rmSync(path.join(home, "talk/orchestrator-persona.md"))
    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: ["talk/orchestrator-persona.md"],
      skippedItems: [],
      verifiedAt: "2026-08-05T00:00:00.000Z",
    }))

    expect(() => completeInstanceMigration({
      instanceHome: home,
      installedPackageVersion: "0.29.1",
      targetVersion: "0.29.1",
      expectedMigrationKey: pending.migrationKey,
      pending,
    })).toThrow(/service-owned removal outcome/i)

    // Restoring the user bytes lets the migration service record the preserved
    // conflict. The generic agent receipt must not claim the remove path at all.
    fs.writeFileSync(path.join(home, "talk/orchestrator-persona.md"), "customized voice persona\n")
    fs.writeFileSync(path.join(snapshot.path, "completion-receipt.json"), JSON.stringify({
      schemaVersion: 1,
      migrationKey: pending.migrationKey,
      reviewedFiles: [],
      skippedItems: [],
      verifiedAt: "2026-08-05T00:00:00.000Z",
    }))

    expect(() => completeInstanceMigration({
      instanceHome: home,
      installedPackageVersion: "0.29.1",
      targetVersion: "0.29.1",
      expectedMigrationKey: pending.migrationKey,
      pending,
    })).not.toThrow()
    expect(fs.readFileSync(path.join(home, "talk/orchestrator-persona.md"), "utf8")).toBe("customized voice persona\n")
  })

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
