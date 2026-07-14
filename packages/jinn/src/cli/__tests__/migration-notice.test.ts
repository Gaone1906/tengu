import { describe, expect, it } from "vitest"
import { migrationNoticeOptionsForProcess, renderMigrationNotice, shouldUseMigrationNoticeColor } from "../migration-notice.js"
import type { PendingInstanceMigration } from "../../migrations/service.js"

const pending: PendingInstanceMigration = {
  required: true,
  fromVersion: "0.25.0",
  toVersion: "0.27.0",
  versions: ["0.26.0", "0.27.0"],
  changedFiles: [{ path: "CLAUDE.md", operation: "modify" }],
  prompt: "# canonical prompt\nexact bytes\n",
  migrationKey: "abc",
  materialization: null,
}

describe("renderMigrationNotice", () => {
  it("shares one TTY and NO_COLOR-aware color decision", () => {
    expect(shouldUseMigrationNoticeColor({ isTTY: true, color: true })).toBe(true)
    expect(shouldUseMigrationNoticeColor({ isTTY: false, color: true })).toBe(false)
    expect(shouldUseMigrationNoticeColor({ isTTY: true, color: false })).toBe(false)
  })
  it("treats any NO_COLOR presence, including an empty value, as disabling ANSI", () => {
    const options = migrationNoticeOptionsForProcess({
      isTTY: true,
      columns: 80,
      env: { NO_COLOR: "", TERM: "xterm-256color" },
      daemon: false,
    })
    const result = renderMigrationNotice(pending, options)
    expect(result.notice).not.toMatch(/\u001b\[/)
    expect(result.prompt).toBe(pending.prompt)
  })

  it("uses violet, amber, and cyan but never red on an interactive TTY", () => {
    const result = renderMigrationNotice(pending, { isTTY: true, color: true, unicode: true, columns: 80 })
    expect(result.notice).toContain("\u001b[35m")
    expect(result.notice).toContain("\u001b[33m")
    expect(result.notice).toContain("\u001b[36m")
    expect(result.notice).not.toContain("\u001b[31m")
    expect(result.prompt).toBe(pending.prompt)
  })

  it.each([
    { isTTY: false, color: true },
    { isTTY: true, color: false },
  ])("has no ANSI and omits the full prompt for $isTTY/$color", (options) => {
    const result = renderMigrationNotice(pending, { ...options, unicode: true, columns: 80 })
    expect(result.notice).not.toMatch(/\u001b\[/)
    expect(result.prompt).toBe(options.isTTY ? pending.prompt : null)
  })

  it("wraps for narrow ASCII terminals", () => {
    const result = renderMigrationNotice(pending, { isTTY: true, color: false, unicode: false, columns: 36 })
    expect(result.notice).not.toBeNull()
    expect(result.notice).toContain("+-")
    expect(result.notice).not.toContain("╭")
    expect(result.notice).not.toContain("→")
    expect(result.notice).toContain("v0.25.0 -> v0.27.0")
    expect(result.notice!.split("\n").every((line) => line.length <= 36)).toBe(true)
  })

  it("returns nothing when migration is current", () => {
    const result = renderMigrationNotice({ ...pending, required: false, prompt: null, migrationKey: null }, { isTTY: true })
    expect(result).toEqual({ notice: null, prompt: null })
  })
})
