import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMigrationSnapshot, verifyMigrationSnapshot } from "../snapshot.js"
import { migrationMaterializationInputsSha256, type MigrationMaterializationPlan } from "../service.js"

const roots: string[] = []
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex")
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-snapshot-"))
  roots.push(home)
  fs.mkdirSync(path.join(home, "skills/stock"), { recursive: true })
  fs.mkdirSync(path.join(home, "secrets"), { recursive: true })
  fs.writeFileSync(path.join(home, "config.yaml"), "jinn:\n  version: 0.25.0\n")
  fs.writeFileSync(path.join(home, "CLAUDE.md"), "custom doctrine\n", { mode: 0o640 })
  fs.symlinkSync("CLAUDE.md", path.join(home, "AGENTS.md"))
  fs.writeFileSync(path.join(home, "skills/stock/SKILL.md"), "custom skill\n")
  fs.writeFileSync(path.join(home, "secrets/token"), "must-not-copy")
  return home
}

describe("migration snapshots", () => {
  it("creates audited read-only materialized payloads without changing generic sources or user edits", () => {
    const home = fixture()
    fs.writeFileSync(path.join(home, "config.yaml"), 'jinn:\n  version: "0.25.0"\nportal:\n  portalName: "My Mixed CASE Portal"\n')
    fs.mkdirSync(path.join(home, "docs"), { recursive: true })
    fs.writeFileSync(path.join(home, "docs/overview.md"), "# My Mixed CASE Portal\nGenuine user edit.\n")

    const sources = path.join(home, "generic-sources")
    fs.mkdirSync(path.join(sources, "base/docs"), { recursive: true })
    fs.mkdirSync(path.join(sources, "target/docs"), { recursive: true })
    fs.mkdirSync(path.join(sources, "base/state"), { recursive: true })
    fs.mkdirSync(path.join(sources, "target/state"), { recursive: true })
    const genericBase = "# {{portalName}}\nRun {{portalSlug}}.\nUnknown {{futureValue}}.\n"
    const genericTarget = "# {{portalName}}\nRun {{portalSlug}} now.\nUnknown {{futureValue}}.\n"
    const genericJson = '{"portal":"{{portalName}}"}\n'
    fs.writeFileSync(path.join(sources, "base/docs/overview.md"), genericBase)
    fs.writeFileSync(path.join(sources, "target/docs/overview.md"), genericTarget)
    fs.writeFileSync(path.join(sources, "base/state/template.json"), genericJson)
    fs.writeFileSync(path.join(sources, "target/state/template.json"), genericJson)

    const inputs = { portalName: "My Mixed CASE Portal", portalSlug: "my-mixed-case-portal" }
    const manifests = [{ version: "0.26.0", sha256: "2".repeat(64) }]
    const materialization: MigrationMaterializationPlan = {
      schemaVersion: 1,
      inputs,
      inputsSha256: migrationMaterializationInputsSha256(inputs, manifests, [{ version: "0.9.0", sha256: hash("# Legacy {{portalName}}\n") }]),
      manifests,
      legacy: [{
        version: "0.9.0",
        sourcePath: path.join(sources, "legacy/MIGRATION.md"),
        destinationPath: "materialized/legacy/0.9.0/MIGRATION.md",
        sourceSha256: hash("# Legacy {{portalName}}\n"),
      }],
      files: [
        {
          version: "0.26.0",
          path: "docs/overview.md",
          operation: "modify",
          base: { sourcePath: path.join(sources, "base/docs/overview.md"), destinationPath: "materialized/0.26.0/files/base/docs/overview.md", sourceSha256: hash(genericBase) },
          target: { sourcePath: path.join(sources, "target/docs/overview.md"), destinationPath: "materialized/0.26.0/files/target/docs/overview.md", sourceSha256: hash(genericTarget) },
        },
        {
          version: "0.26.0",
          path: "state/template.json",
          operation: "modify",
          base: { sourcePath: path.join(sources, "base/state/template.json"), destinationPath: "materialized/0.26.0/files/base/state/template.json", sourceSha256: hash(genericJson) },
          target: { sourcePath: path.join(sources, "target/state/template.json"), destinationPath: "materialized/0.26.0/files/target/state/template.json", sourceSha256: hash(genericJson) },
        },
      ],
    }
    fs.mkdirSync(path.join(sources, "legacy"), { recursive: true })
    fs.writeFileSync(path.join(sources, "legacy/MIGRATION.md"), "# Legacy {{portalName}}\n")
    const options = {
      instanceHome: home,
      migrationKey: "f".repeat(64),
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      changedFiles: [
        { path: "docs/overview.md", operation: "modify" as const },
        { path: "state/template.json", operation: "modify" as const },
      ],
      materialization,
    }

    const snapshot = createMigrationSnapshot(options)
    const base = path.join(snapshot.path, "materialized/0.26.0/files/base/docs/overview.md")
    const target = path.join(snapshot.path, "materialized/0.26.0/files/target/docs/overview.md")
    const json = path.join(snapshot.path, "materialized/0.26.0/files/base/state/template.json")
    expect(fs.readFileSync(base, "utf8")).toBe("# My Mixed CASE Portal\nRun my-mixed-case-portal.\nUnknown {{futureValue}}.\n")
    expect(fs.readFileSync(target, "utf8")).toBe("# My Mixed CASE Portal\nRun my-mixed-case-portal now.\nUnknown {{futureValue}}.\n")
    expect(fs.readFileSync(json, "utf8")).toBe(genericJson)
    expect(fs.readFileSync(path.join(snapshot.path, "materialized/legacy/0.9.0/MIGRATION.md"), "utf8")).toBe("# Legacy My Mixed CASE Portal\n")
    expect(fs.statSync(base).mode & 0o777).toBe(0o444)
    expect(fs.readFileSync(path.join(snapshot.path, "docs/overview.md"), "utf8")).toBe("# My Mixed CASE Portal\nGenuine user edit.\n")
    expect(fs.readFileSync(path.join(sources, "base/docs/overview.md"), "utf8")).toBe(genericBase)
    const audit = JSON.parse(fs.readFileSync(path.join(snapshot.path, "materialization.json"), "utf8"))
    expect(audit).toMatchObject({
      schemaVersion: 1,
      inputs: materialization.inputs,
      inputsSha256: materialization.inputsSha256,
    })
    expect(audit.legacy).toEqual([
      expect.objectContaining({ version: "0.9.0", payload: expect.objectContaining({ unresolvedPlaceholders: [] }) }),
    ])
    expect(audit.files[0].base.unresolvedPlaceholders).toEqual(["{{futureValue}}"])
    expect(audit.files[1].base.unresolvedPlaceholders).toEqual([])
    expect(verifyMigrationSnapshot(options)).toBe(true)
    expect(createMigrationSnapshot(options)).toEqual({ path: snapshot.path, reused: true })
  })

  it("atomically snapshots only reviewed paths and is idempotent", () => {
    const home = fixture()
    const options = {
      instanceHome: home,
      migrationKey: "a".repeat(64),
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      changedFiles: [
        { path: "skills/stock/SKILL.md", operation: "modify" as const },
        { path: "skills/new/SKILL.md", operation: "add" as const },
      ],
    }
    const first = createMigrationSnapshot(options)
    const second = createMigrationSnapshot(options)
    expect(second).toEqual({ path: first.path, reused: true })
    expect(verifyMigrationSnapshot(options)).toBe(true)
    expect(fs.readFileSync(path.join(first.path, "skills/stock/SKILL.md"), "utf8")).toBe("custom skill\n")
    expect(fs.lstatSync(path.join(first.path, "AGENTS.md")).isSymbolicLink()).toBe(true)
    expect(fs.statSync(path.join(first.path, "CLAUDE.md")).mode & 0o777).toBe(0o640)
    expect(fs.existsSync(path.join(first.path, "secrets"))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(first.path, "snapshot.json"), "utf8"))).toMatchObject({
      migrationKey: options.migrationKey,
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
    })
  })

  it("materializes nothing for an empty bundle, so a no-op migration needs no symlink privilege", () => {
    // Patch upgrades routinely ship empty bridges (0.28.3 and 0.28.4 both have
    // "files": []). The snapshot used to copy config.yaml/CLAUDE.md/AGENTS.md
    // regardless, and AGENTS.md is a symlink in the layout `jinn setup` creates —
    // so on Windows without SeCreateSymbolicLinkPrivilege the snapshot threw
    // EPERM and the migration could never complete.
    const home = fixture()
    const options = {
      instanceHome: home,
      migrationKey: "c".repeat(64),
      fromVersion: "0.28.2",
      toVersion: "0.28.4",
      changedFiles: [],
    }
    const snapshot = createMigrationSnapshot(options)

    // No entries copied at all — in particular no symlink was created.
    expect(fs.existsSync(path.join(snapshot.path, "AGENTS.md"))).toBe(false)
    expect(fs.existsSync(path.join(snapshot.path, "CLAUDE.md"))).toBe(false)
    expect(fs.existsSync(path.join(snapshot.path, "config.yaml"))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(snapshot.path, "snapshot.json"), "utf8")).files).toEqual([])

    // The directory and receipt still exist and verify, which is what the
    // completion gate requires before it will advance the version marker.
    expect(verifyMigrationSnapshot(options)).toBe(true)
    expect(createMigrationSnapshot(options)).toEqual({ path: snapshot.path, reused: true })

    // The instance itself is untouched.
    expect(fs.lstatSync(path.join(home, "AGENTS.md")).isSymbolicLink()).toBe(true)
  })

  it("still snapshots the context files when the bundle has records to compare", () => {
    // Guard the narrow scope of the fix above: a real migration must keep its
    // three-way comparison material.
    const home = fixture()
    const options = {
      instanceHome: home,
      migrationKey: "d".repeat(64),
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      changedFiles: [{ path: "skills/stock/SKILL.md", operation: "modify" as const }],
    }
    const snapshot = createMigrationSnapshot(options)
    expect(fs.lstatSync(path.join(snapshot.path, "AGENTS.md")).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(snapshot.path, "CLAUDE.md"))).toBe(true)
    expect(fs.existsSync(path.join(snapshot.path, "config.yaml"))).toBe(true)
    expect(verifyMigrationSnapshot(options)).toBe(true)
  })

  it("refuses unsafe, excluded, and escaping paths", () => {
    const home = fixture()
    for (const changedPath of ["../outside", "secrets/token", "sessions/registry.db", "/tmp/outside"]) {
      expect(() => createMigrationSnapshot({
        instanceHome: home,
        migrationKey: "b".repeat(64),
        fromVersion: "0.25.0",
        toVersion: "0.26.0",
        changedFiles: [{ path: changedPath, operation: "modify" }],
      })).toThrow(/unsafe|excluded|inside/i)
    }
  })

  it("detects corruption instead of reusing an unverified snapshot", () => {
    const home = fixture()
    const options = {
      instanceHome: home,
      migrationKey: "c".repeat(64),
      fromVersion: "0.25.0",
      toVersion: "0.26.0",
      changedFiles: [{ path: "skills/stock/SKILL.md", operation: "modify" as const }],
    }
    const snapshot = createMigrationSnapshot(options)
    fs.writeFileSync(path.join(snapshot.path, "skills/stock/SKILL.md"), "corrupt")
    expect(verifyMigrationSnapshot(options)).toBe(false)
    expect(() => createMigrationSnapshot(options)).toThrow(/verification/i)
  })
})
