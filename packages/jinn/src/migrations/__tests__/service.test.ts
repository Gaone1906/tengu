import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getPendingInstanceMigration, reconcileServiceOwnedRemovals } from "../service.js"
import { createMigrationSnapshot } from "../snapshot.js"

const roots: string[] = []
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex")

function fixture(marker: string | null = "0.25.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migration-service-"))
  roots.push(root)
  const home = path.join(root, "home")
  const migrationsDir = path.join(root, "migrations")
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "config.yaml"), marker ? `jinn:\n  version: "${marker}"\ncustom: keep\n` : "custom: keep\n")
  return { root, home, migrationsDir }
}

function bundle(
  migrationsDir: string,
  version: string,
  baseVersion: string,
  files: Array<{ path: string; operation: "add" | "modify" | "remove"; base?: string; target?: string }>,
) {
  const dir = path.join(migrationsDir, version)
  fs.mkdirSync(dir, { recursive: true })
  const records = files.map((file) => {
    const basePayload = file.base === undefined ? null : `files/base/${file.path}`
    const targetPayload = file.target === undefined ? null : `files/target/${file.path}`
    if (basePayload) {
      fs.mkdirSync(path.dirname(path.join(dir, basePayload)), { recursive: true })
      fs.writeFileSync(path.join(dir, basePayload), file.base!)
    }
    if (targetPayload) {
      fs.mkdirSync(path.dirname(path.join(dir, targetPayload)), { recursive: true })
      fs.writeFileSync(path.join(dir, targetPayload), file.target!)
    }
    return {
      path: file.path,
      operation: file.operation,
      baseSha256: file.base === undefined ? null : hash(file.base),
      targetSha256: file.target === undefined ? null : hash(file.target),
      basePayload,
      targetPayload,
    }
  })
  const manifest = {
    schemaVersion: 1,
    version,
    baseVersion,
    generatedFrom: { baseRef: `v${baseVersion}`, headRef: "WORKTREE" },
    files: records,
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, "MIGRATION.md"), `# ${version}\n`)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("getPendingInstanceMigration", () => {
  it("returns the canonical non-pending contract for equal or ahead markers", () => {
    for (const marker of ["0.26.0", "0.27.0"]) {
      const { home, migrationsDir } = fixture(marker)
      const result = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
      expect(result).toEqual({
        required: false,
        fromVersion: marker,
        toVersion: "0.26.0",
        versions: [],
        changedFiles: [],
        prompt: null,
        migrationKey: null,
        materialization: null,
      })
    }
  })

  it("composes and validates one or more bundles with a stable key", () => {
    const { home, migrationsDir } = fixture("0.24.0")
    fs.writeFileSync(path.join(home, "config.yaml"), 'jinn:\n  version: "0.24.0"\nportal:\n  portalName: "My Mixed CASE Portal"\n')
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "customized doctrine\n")
    bundle(migrationsDir, "0.25.0", "0.24.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old\n", target: "new\n" },
    ])
    bundle(migrationsDir, "0.26.0", "0.25.0", [
      { path: "skills/delegation/SKILL.md", operation: "add", target: "skill\n" },
    ])
    const first = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    const second = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    expect(first).toEqual(second)
    expect(first.required).toBe(true)
    expect(first.versions).toEqual(["0.25.0", "0.26.0"])
    expect(first.changedFiles).toEqual([
      { path: "CLAUDE.md", operation: "modify" },
      { path: "skills/delegation/SKILL.md", operation: "add" },
    ])
    expect(first.migrationKey).toMatch(/^[a-f0-9]{64}$/)
    expect(first.materialization).toMatchObject({
      schemaVersion: 1,
      inputs: { portalName: "My Mixed CASE Portal", portalSlug: "my-mixed-case-portal" },
      manifests: [
        { version: "0.25.0", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { version: "0.26.0", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    })
    expect(first.materialization?.inputsSha256).toMatch(/^[a-f0-9]{64}$/)
    const snapshotRoot = path.join(home, ".migration-snapshots", first.migrationKey!)
    expect(first.prompt).toContain(path.join(snapshotRoot, "materialized/0.25.0/files/base/CLAUDE.md"))
    expect(first.prompt).toContain(path.join(home, "CLAUDE.md"))
    expect(first.prompt).toContain(path.join(snapshotRoot, "materialized/0.25.0/files/target/CLAUDE.md"))
    expect(first.prompt).not.toContain(path.join(migrationsDir, "0.25.0", "files/base/CLAUDE.md"))
    expect(first.prompt).toMatch(/materialized base.*materialized target/is)
    expect(first.prompt).toMatch(/unresolved placeholders?.*conflict/i)
    expect(first.prompt).toContain("snapshot")
    expect(first.prompt).toContain("completion receipt")
    expect(first.prompt).toContain(path.join(snapshotRoot, "completion-receipt.json"))
    expect(first.prompt).toContain('"schemaVersion": 1')
    expect(first.prompt).toContain(`"migrationKey": "${first.migrationKey}"`)
    expect(first.prompt).toContain('"reviewedFiles"')
    expect(first.prompt).toContain('"skippedItems"')
    expect(first.prompt).toContain('"verifiedAt"')
    expect(first.prompt).toMatch(/engine exit or interrupted session never advances/i)
  })

  it("allows intentional releases without bundles before and after changed releases", () => {
    const trailingGap = fixture("0.25.0")
    bundle(trailingGap.migrationsDir, "0.26.0", "0.25.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old", target: "new" },
    ])

    const throughNoOpRelease = getPendingInstanceMigration({
      instanceHome: trailingGap.home,
      packageVersion: "0.27.0",
      migrationsDir: trailingGap.migrationsDir,
    })

    expect(throughNoOpRelease.required).toBe(true)
    expect(throughNoOpRelease.toVersion).toBe("0.27.0")
    expect(throughNoOpRelease.versions).toEqual(["0.26.0"])

    const internalGap = fixture("0.25.0")
    bundle(internalGap.migrationsDir, "0.26.0", "0.25.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old", target: "new" },
    ])
    bundle(internalGap.migrationsDir, "0.28.0", "0.27.0", [
      { path: "skills/new/SKILL.md", operation: "add", target: "new skill" },
    ])

    const afterNoOpRelease = getPendingInstanceMigration({
      instanceHome: internalGap.home,
      packageVersion: "0.28.0",
      migrationsDir: internalGap.migrationsDir,
    })

    expect(afterNoOpRelease.required).toBe(true)
    expect(afterNoOpRelease.versions).toEqual(["0.26.0", "0.28.0"])
  })

  it("infers a missing marker from the earliest structured bundle base", () => {
    const { home, migrationsDir } = fixture(null)
    bundle(migrationsDir, "0.26.0", "0.25.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old", target: "new" },
    ])
    const result = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    expect(result.required).toBe(true)
    expect(result.fromVersion).toBe("0.0.0")
  })

  it("composes the shipped chain through releases with no instance-surface changes when the marker is missing", () => {
    const { home } = fixture(null)
    const migrationsDir = path.resolve("template/migrations")

    const result = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.28.0", migrationsDir })

    expect(result.required).toBe(true)
    expect(result.fromVersion).toBe("0.0.0")
    expect(result.versions).toEqual([
      "0.1.0",
      "0.2.0",
      "0.3.0",
      "0.7.3",
      "0.7.5",
      "0.8.0",
      "0.9.0",
      "0.26.0",
      "0.27.0",
      "0.28.0",
    ])
  })

  it("keeps the shipped migration chain aligned with the installed package version", () => {
    const { home } = fixture("0.27.0")
    const migrationsDir = path.resolve("template/migrations")
    const packageVersion = (
      JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
        version: string
      }
    ).version

    const result = getPendingInstanceMigration({
      instanceHome: home,
      packageVersion,
      migrationsDir,
    })

    expect(result.toVersion).toBe(packageVersion)
  })

  it("bridges real shipped Markdown-only migrations into the first structured bundle with instance materialization", () => {
    const { home } = fixture("0.8.0")
    fs.writeFileSync(path.join(home, "config.yaml"), 'jinn:\n  version: "0.8.0"\nportal:\n  portalName: "My Mixed CASE Portal"\n')
    const migrationsDir = path.resolve("template/migrations")

    const result = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })

    expect(result.versions).toEqual(["0.9.0", "0.26.0"])
    expect(result.fromVersion).toBe("0.8.0")
    expect(result.materialization?.legacy).toEqual([
      expect.objectContaining({
        version: "0.9.0",
        destinationPath: "materialized/legacy/0.9.0/MIGRATION.md",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(result.prompt).toContain("Hierarchical Org")
    expect(result.prompt).toContain("reportsTo: my-mixed-case-portal")
    expect(result.prompt).not.toContain("{{portalSlug}}")
    expect(result.prompt).toContain(path.join(home, ".migration-snapshots", result.migrationKey!, "materialized/legacy/0.9.0/MIGRATION.md"))
  })

  it("preserves every applicable legacy instruction for a missing marker and excludes them at the structured floor", () => {
    const missing = fixture(null)
    const migrationsDir = path.resolve("template/migrations")
    const fromMissing = getPendingInstanceMigration({ instanceHome: missing.home, packageVersion: "0.26.0", migrationsDir })
    expect(fromMissing.fromVersion).toBe("0.0.0")
    expect(fromMissing.versions).toEqual(["0.1.0", "0.2.0", "0.3.0", "0.7.3", "0.7.5", "0.8.0", "0.9.0", "0.26.0"])
    expect(fromMissing.materialization?.legacy.map(({ version }) => version)).toEqual(fromMissing.versions.slice(0, -1))

    const current = fixture("0.25.0")
    const fromFloor = getPendingInstanceMigration({ instanceHome: current.home, packageVersion: "0.26.0", migrationsDir })
    expect(fromFloor.versions).toEqual(["0.26.0"])
    expect(fromFloor.materialization?.legacy).toEqual([])
  })

  it("hashes legacy instructions into the key and rejects a broken structured chain", () => {
    const drift = fixture("0.8.0")
    const legacy = path.join(drift.migrationsDir, "0.9.0")
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, "MIGRATION.md"), "# Legacy\nKeep this.\n")
    bundle(drift.migrationsDir, "0.26.0", "0.25.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old", target: "new" },
    ])
    const first = getPendingInstanceMigration({ instanceHome: drift.home, packageVersion: "0.26.0", migrationsDir: drift.migrationsDir })
    fs.writeFileSync(path.join(legacy, "MIGRATION.md"), "# Legacy\nKeep this changed instruction.\n")
    const second = getPendingInstanceMigration({ instanceHome: drift.home, packageVersion: "0.26.0", migrationsDir: drift.migrationsDir })
    expect(second.migrationKey).not.toBe(first.migrationKey)

    const broken = fixture("0.23.0")
    bundle(broken.migrationsDir, "0.25.0", "0.23.0", [{ path: "a.md", operation: "add", target: "a" }])
    bundle(broken.migrationsDir, "0.26.0", "0.24.0", [{ path: "b.md", operation: "add", target: "b" }])
    expect(() => getPendingInstanceMigration({ instanceHome: broken.home, packageVersion: "0.26.0", migrationsDir: broken.migrationsDir })).toThrow(/chain is broken/i)
  })

  it("rejects malformed directories, missing manifests, broken chains, and hash drift", () => {
    const malformed = fixture()
    fs.mkdirSync(path.join(malformed.migrationsDir, "0.26.0-beta.1"), { recursive: true })
    expect(() => getPendingInstanceMigration({ instanceHome: malformed.home, packageVersion: "0.26.0", migrationsDir: malformed.migrationsDir })).toThrow(/malformed/i)

    const missing = fixture()
    fs.mkdirSync(path.join(missing.migrationsDir, "0.26.0"), { recursive: true })
    expect(() => getPendingInstanceMigration({ instanceHome: missing.home, packageVersion: "0.26.0", migrationsDir: missing.migrationsDir })).toThrow(/manifest/i)
    fs.writeFileSync(path.join(missing.migrationsDir, "0.26.0/MIGRATION.md"), "legacy")
    expect(() => getPendingInstanceMigration({ instanceHome: missing.home, packageVersion: "0.26.0", migrationsDir: missing.migrationsDir })).toThrow(/structured|chain|package/i)

    const drift = fixture()
    const dir = bundle(drift.migrationsDir, "0.26.0", "0.25.0", [
      { path: "CLAUDE.md", operation: "modify", base: "old", target: "new" },
    ])
    fs.writeFileSync(path.join(dir, "files/target/CLAUDE.md"), "tampered")
    expect(() => getPendingInstanceMigration({ instanceHome: drift.home, packageVersion: "0.26.0", migrationsDir: drift.migrationsDir })).toThrow(/hash/i)
  })
})

describe("service-owned structured removals", () => {
  it("unlinks only current bytes that exactly match the materialized base", () => {
    const { home, migrationsDir } = fixture("0.25.0")
    const stockPath = path.join(home, "stock.md")
    const customPath = path.join(home, "custom.md")
    fs.writeFileSync(stockPath, "stock\n")
    fs.writeFileSync(customPath, "user customization\n")
    bundle(migrationsDir, "0.26.0", "0.25.0", [
      { path: "stock.md", operation: "remove", base: "stock\n" },
      { path: "custom.md", operation: "remove", base: "stock\n" },
    ])
    const pending = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    expect(pending.prompt).toMatch(/removal is owned by the Jinn migration service.*do not delete/is)
    expect(pending.prompt).toMatch(/remove paths must not appear in reviewedFiles or skippedItems/i)
    createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey!,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization: pending.materialization,
    })

    const receipt = reconcileServiceOwnedRemovals({ instanceHome: home, pending })

    expect(fs.existsSync(stockPath)).toBe(false)
    expect(fs.readFileSync(customPath, "utf8")).toBe("user customization\n")
    expect(receipt.outcomes).toEqual([
      expect.objectContaining({ path: "stock.md", status: "removed" }),
      expect.objectContaining({ path: "custom.md", status: "preserved" }),
    ])
  })

  it("preserves and records a custom file that appears after a missing snapshot", () => {
    const { home, migrationsDir } = fixture("0.25.0")
    const targetPath = path.join(home, "new-custom.md")
    bundle(migrationsDir, "0.26.0", "0.25.0", [
      { path: "new-custom.md", operation: "remove", base: "stock\n" },
    ])
    const pending = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey!,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization: pending.materialization,
    })
    fs.writeFileSync(targetPath, "new user content\n")

    const receipt = reconcileServiceOwnedRemovals({ instanceHome: home, pending })

    expect(fs.readFileSync(targetPath, "utf8")).toBe("new user content\n")
    expect(receipt.outcomes).toEqual([
      expect.objectContaining({ path: "new-custom.md", status: "preserved" }),
    ])
  })

  it("never converts an already-preserved conflict into a later removal", () => {
    const { home, migrationsDir } = fixture("0.25.0")
    const targetPath = path.join(home, "custom.md")
    fs.writeFileSync(targetPath, "user customization\n")
    bundle(migrationsDir, "0.26.0", "0.25.0", [
      { path: "custom.md", operation: "remove", base: "stock\n" },
    ])
    const pending = getPendingInstanceMigration({ instanceHome: home, packageVersion: "0.26.0", migrationsDir })
    createMigrationSnapshot({
      instanceHome: home,
      migrationKey: pending.migrationKey!,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization: pending.materialization,
    })
    reconcileServiceOwnedRemovals({ instanceHome: home, pending })

    fs.writeFileSync(targetPath, "stock\n")

    expect(() => reconcileServiceOwnedRemovals({ instanceHome: home, pending })).toThrow(
      /service-preserved removal target changed before completion/i,
    )
    expect(fs.readFileSync(targetPath, "utf8")).toBe("stock\n")
  })
})
