import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import type { ServerResponse } from "node:http"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Connector, IncomingMessage } from "../../shared/types.js"

const registryHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migration-api-registry-"))
process.env.JINN_HOME = registryHome
const dbModule = await import("../../shared/db.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migration-api-home-"))
const migrationsDir = path.join(home, "package-migrations")
const dispatched: Array<{ sessionId: string; prompt: string }> = []
let engineAvailable = true
let api: typeof import("../api.js")
let registry: typeof import("../../sessions/registry.js")

function seedBundle() {
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, "org"), { recursive: true })
  fs.writeFileSync(path.join(home, "config.yaml"), "jinn:\n  version: \"0.25.0\"\n")
  fs.writeFileSync(path.join(home, "CLAUDE.md"), "custom doctrine\n")
  const dir = path.join(migrationsDir, "0.26.0")
  fs.mkdirSync(path.join(dir, "files/base"), { recursive: true })
  fs.mkdirSync(path.join(dir, "files/target"), { recursive: true })
  fs.writeFileSync(path.join(dir, "files/base/CLAUDE.md"), "old doctrine\n")
  fs.writeFileSync(path.join(dir, "files/target/CLAUDE.md"), "new doctrine\n")
  const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.26.0",
    baseVersion: "0.25.0",
    generatedFrom: { baseRef: "v0.25.0", headRef: "WORKTREE" },
    files: [{
      path: "CLAUDE.md",
      operation: "modify",
      baseSha256: sha(path.join(dir, "files/base/CLAUDE.md")),
      targetSha256: sha(path.join(dir, "files/target/CLAUDE.md")),
      basePayload: "files/base/CLAUDE.md",
      targetPayload: "files/target/CLAUDE.md",
    }],
  }, null, 2) + "\n")
  fs.writeFileSync(path.join(dir, "MIGRATION.md"), "# migration\n")
}

/** The shape every patch release actually ships: a required chain bridge that
 *  changes no files. `AGENTS.md` is a symlink here because that is what
 *  `jinn setup` creates, and it used to drag the snapshot through
 *  fs.symlinkSync. */
function seedEmptyBundle() {
  seedBundle()
  fs.symlinkSync("CLAUDE.md", path.join(home, "AGENTS.md"))
  const dir = path.join(migrationsDir, "0.26.0")
  fs.rmSync(path.join(dir, "files"), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.26.0",
    baseVersion: "0.25.0",
    generatedFrom: { baseRef: "v0.25.0", headRef: "WORKTREE" },
    files: [],
  }, null, 2) + "\n")
}

function seedRemovalBundle() {
  seedBundle()
  const target = path.join(home, "retired.md")
  fs.writeFileSync(target, "stock retirement file\n")
  const dir = path.join(migrationsDir, "0.26.0")
  fs.rmSync(path.join(dir, "files"), { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "files/base"), { recursive: true })
  const base = path.join(dir, "files/base/retired.md")
  fs.writeFileSync(base, "stock retirement file\n")
  const sha = crypto.createHash("sha256").update(fs.readFileSync(base)).digest("hex")
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.26.0",
    baseVersion: "0.25.0",
    generatedFrom: { baseRef: "v0.25.0", headRef: "WORKTREE" },
    files: [{
      path: "retired.md",
      operation: "remove",
      baseSha256: sha,
      targetSha256: null,
      basePayload: "files/base/retired.md",
      targetPayload: null,
    }],
  }, null, 2) + "\n")
  return target
}

function responseCapture() {
  let status = 200
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number) { status = code; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)) },
  } as unknown as ServerResponse
  return { res, status: () => status, text: () => Buffer.concat(chunks).toString("utf8") }
}

const context = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex", codex: {} }, portal: { portalName: "Portal" } }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token-with-at-least-thirty-two-characters",
  jinnHome: home,
  migrationMigrationsDir: migrationsDir,
  migrationPackageVersion: "0.26.0",
  dispatchInstanceMigration: (session: { id: string }, prompt: string) => dispatched.push({ sessionId: session.id, prompt }),
  emit: vi.fn(),
  sessionManager: {
    getEngine: () => engineAvailable ? ({ name: "codex", run: vi.fn() }) : undefined,
    getEngines: () => new Map(),
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, state: string) => state }),
  },
} as unknown as import("../api.js").ApiContext

async function request(method: string, url: string, body?: unknown, authorized = true) {
  const encoded = body === undefined ? "" : JSON.stringify(body)
  const req = Object.assign(Readable.from(encoded ? [Buffer.from(encoded)] : []), {
    method,
    url,
    headers: {
      host: "gateway.test",
      ...(authorized ? { authorization: `Bearer ${context.gatewayAuthToken}` } : {}),
      ...(encoded ? { "content-type": "application/json" } : {}),
    },
  })
  const capture = responseCapture()
  await api.handleApiRequest(req as never, capture.res, context)
  return { status: capture.status(), body: JSON.parse(capture.text()) as Record<string, any> }
}

beforeAll(async () => {
  api = await import("../api.js")
  registry = await import("../../sessions/registry.js")
  dbModule.initDb()
})

beforeEach(() => {
  seedBundle()
  dispatched.length = 0
  engineAvailable = true
  context.connectors.clear()
  for (const session of registry.listSessions()) registry.deleteSession(session.id)
})

function connectorStub(id: string, name: string): Connector {
  const capabilities = { threading: false, messageEdits: false, reactions: false, attachments: false }
  return {
    id,
    name,
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => capabilities,
    getHealth: () => ({ status: "running", capabilities }),
    reconstructTarget: () => ({ channel: "test" }),
    sendMessage: async () => undefined,
    replyMessage: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    editMessage: async () => {},
    onMessage: () => {},
  }
}

describe("instance migration API", () => {
  it("keeps operator-chosen connector labels out of public status", async () => {
    context.connectors.set("private-support-label", connectorStub("private-support-label", "slack"))
    context.connectors.set("private-ops-label", connectorStub("private-ops-label", "telegram"))

    const status = await request("GET", "/api/status", undefined, false)

    expect(status.status).toBe(200)
    expect(Object.keys(status.body.connectors).sort()).toEqual(["slack", "telegram"])
    expect(JSON.stringify(status.body)).not.toContain("private-support-label")
    expect(JSON.stringify(status.body)).not.toContain("private-ops-label")
  })

  it("addresses the selected named WhatsApp instance when reading a QR code", async () => {
    const legacyQr = vi.fn(() => "legacy-qr")
    const supportQr = vi.fn(() => "support-qr")
    context.connectors.set("whatsapp", Object.assign(connectorStub("whatsapp", "whatsapp"), { getQrCode: legacyQr }))
    context.connectors.set("whatsapp-support", Object.assign(connectorStub("whatsapp-support", "whatsapp"), { getQrCode: supportQr }))

    const named = await request("GET", "/api/connectors/whatsapp-support/qr")

    expect(named.status).toBe(200)
    expect(named.body.qr).toMatch(/^data:image\/png;base64,/)
    expect(supportQr).toHaveBeenCalledOnce()
    expect(legacyQr).not.toHaveBeenCalled()
  })

  it("rejects HTTP connector ids outside the normalized lowercase contract", async () => {
    const invalid = await request("POST", "/api/connectors/Slack-Support/send", { channel: "C1", text: "hello" })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toMatch(/connector id/i)
  })

  it("keeps legacy Remote Discord inbound identity and rejects named route widening", async () => {
    const legacyDelivery = vi.fn<(message: IncomingMessage) => void>()
    context.connectors.set("discord", Object.assign(connectorStub("discord", "discord"), { deliverMessage: legacyDelivery }))
    const body = {
      sessionKey: "discord:C1",
      channel: "C1",
      user: "tester",
      userId: "U1",
      text: "hello",
      messageId: "M1",
      replyContext: { channel: "C1" },
    }

    const legacy = await request("POST", "/api/connectors/discord/incoming", body)
    expect(legacy.status).toBe(200)
    expect(legacyDelivery).toHaveBeenCalledWith(expect.objectContaining({
      connector: "discord",
      sessionKey: "discord:C1",
    }))

    const namedDelivery = vi.fn<(message: IncomingMessage) => void>()
    context.connectors.set("discord-ops", Object.assign(connectorStub("discord-ops", "discord"), { deliverMessage: namedDelivery }))
    const named = await request("POST", "/api/connectors/discord-ops/incoming", body)
    expect(named.status).toBe(404)
    expect(namedDelivery).not.toHaveBeenCalled()
  })

  it("adds version and a compact migration summary to status and exposes the canonical contract", async () => {
    const status = await request("GET", "/api/status")
    const migration = await request("GET", "/api/instance-migration")
    expect(status.body).toMatchObject({ version: "0.26.0", migration: { required: true, fromVersion: "0.25.0", toVersion: "0.26.0" } })
    expect(status.body.migration).not.toHaveProperty("prompt")
    expect(migration.body).toMatchObject({ required: true, versions: ["0.26.0"] })
    expect(migration.body.prompt).toContain("customized instance file")
  })

  it("requires browser mutation authority, snapshots first, and reuses one durable COO session", async () => {
    const pending = await request("GET", "/api/instance-migration")
    expect((await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey }, false)).status).toBe(403)
    const [first, duplicate] = await Promise.all([
      request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey }),
      request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey }),
    ])
    expect(first.status).toBe(201)
    expect(duplicate.status).toBe(200)
    expect(first.body.sessionId).toBe(duplicate.body.sessionId)
    expect([first.body.reused, duplicate.body.reused].sort()).toEqual([false, true])
    expect(dispatched).toHaveLength(1)
    const queue = registry.getQueueItems(`instance-migration:${pending.body.migrationKey}`)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ sessionId: first.body.sessionId, status: "pending" })
    expect(fs.existsSync(path.join(home, ".migration-snapshots", pending.body.migrationKey, "snapshot.json"))).toBe(true)
    expect(registry.getSessionBySessionKey(`instance-migration:${pending.body.migrationKey}`)?.id).toBe(first.body.sessionId)
  })

  it("runs service-owned exact-byte removals before dispatching the migration session", async () => {
    const target = seedRemovalBundle()
    const pending = await request("GET", "/api/instance-migration")

    const opened = await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey })

    expect(opened.status).toBe(201)
    expect(fs.existsSync(target)).toBe(false)
    const serviceReceipt = JSON.parse(fs.readFileSync(path.join(
      home,
      ".migration-snapshots",
      pending.body.migrationKey,
      "service-removal-receipt.json",
    ), "utf8"))
    expect(serviceReceipt.outcomes).toEqual([
      expect.objectContaining({ path: "retired.md", status: "removed" }),
    ])
    expect(dispatched).toHaveLength(1)
  })

  it("persists nothing when the selected engine is unavailable, then accepts one retry durably across restart", async () => {
    const pending = await request("GET", "/api/instance-migration")
    engineAvailable = false

    const unavailable = await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey })

    expect(unavailable.status).toBe(500)
    expect(registry.listSessions()).toHaveLength(0)
    expect(registry.getQueueItems(`instance-migration:${pending.body.migrationKey}`)).toHaveLength(0)
    expect(fs.existsSync(path.join(home, ".migration-snapshots", pending.body.migrationKey))).toBe(false)

    engineAvailable = true
    const [first, concurrent] = await Promise.all([
      request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey }),
      request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey }),
    ])
    expect([first.status, concurrent.status].sort()).toEqual([200, 201])
    expect(first.body.sessionId).toBe(concurrent.body.sessionId)
    expect(dispatched).toHaveLength(1)
    expect(registry.getQueueItems(`instance-migration:${pending.body.migrationKey}`)).toHaveLength(1)

    dbModule.__closeDbForTest()
    dbModule.initDb()
    expect(registry.getQueueItems(`instance-migration:${pending.body.migrationKey}`)).toHaveLength(1)
    const afterRestart = await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey })
    expect(afterRestart).toMatchObject({
      status: 200,
      body: { sessionId: first.body.sessionId, reused: true, migrationKey: pending.body.migrationKey },
    })
    expect(dispatched).toHaveLength(1)
  })

  it.each([
    { label: "idle incomplete", status: "idle", attemptOutcome: null },
    { label: "failed", status: "error", attemptOutcome: "failed" },
  ] as const)("retires a $label row without accepted queue evidence before retrying", async ({ status, attemptOutcome }) => {
    const pending = await request("GET", "/api/instance-migration")
    const sessionKey = `instance-migration:${pending.body.migrationKey}`
    const stale = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: sessionKey,
      connector: "web",
      sessionKey,
      prompt: pending.body.prompt,
    })
    registry.insertMessage(stale.id, "user", pending.body.prompt)
    registry.updateSession(stale.id, { status, attemptOutcome })

    const retry = await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey })

    expect(retry.status).toBe(201)
    expect(retry.body.reused).toBe(false)
    expect(retry.body.sessionId).not.toBe(stale.id)
    expect(registry.getSession(stale.id)?.sessionKey).toMatch(/^retired:instance-migration:/)
    expect(registry.getQueueItems(sessionKey)).toHaveLength(1)
    expect(dispatched).toHaveLength(1)
  })

  it("returns 409 after completion and creates nothing when bundle validation fails", async () => {
    fs.writeFileSync(path.join(home, "config.yaml"), "jinn:\n  version: \"0.26.0\"\n")
    expect((await request("GET", "/api/instance-migration")).body.required).toBe(false)
    expect((await request("POST", "/api/instance-migration/open", { migrationKey: "x" })).status).toBe(409)

    seedBundle()
    fs.writeFileSync(path.join(migrationsDir, "0.26.0/files/target/CLAUDE.md"), "tampered")
    expect((await request("GET", "/api/instance-migration")).status).toBe(500)
    expect(registry.listSessions()).toHaveLength(0)
  })

  it("opens an empty required bundle end to end, over a symlinked AGENTS.md", async () => {
    // The case that was dead on Windows: 0.27.0 and every 0.28.x ship
    // "files": [], and the snapshot dragged AGENTS.md through fs.symlinkSync
    // regardless, so the open route 500'd as "temporarily unavailable" and the
    // instance could never leave the migration gate.
    seedEmptyBundle()
    const pending = await request("GET", "/api/instance-migration")
    expect(pending.body).toMatchObject({ required: true, fromVersion: "0.25.0", toVersion: "0.26.0" })
    expect(pending.body.changedFiles ?? []).toEqual([])

    const opened = await request("POST", "/api/instance-migration/open", { migrationKey: pending.body.migrationKey })

    expect(opened.status).toBe(201)
    expect(opened.body).toMatchObject({ reused: false, migrationKey: pending.body.migrationKey })
    expect(opened.body).not.toHaveProperty("remedy")
    expect(dispatched).toHaveLength(1)

    // The snapshot still exists and holds the receipt the completion gate reads,
    // and nothing was materialized under it.
    const snapshotDir = path.join(home, ".migration-snapshots", pending.body.migrationKey)
    expect(JSON.parse(fs.readFileSync(path.join(snapshotDir, "snapshot.json"), "utf8")).files).toEqual([])
    expect(fs.existsSync(path.join(snapshotDir, "AGENTS.md"))).toBe(false)
    // The instance's own symlink is untouched.
    expect(fs.lstatSync(path.join(home, "AGENTS.md")).isSymbolicLink()).toBe(true)
  })

  it("classifies a refused symlink so the operator is told which knob to turn", () => {
    // Windows without SeCreateSymbolicLinkPrivilege reports EPERM from
    // fs.symlinkSync. Collapsing that into a bare "service unavailable" hid a
    // fixable local condition behind a message that reads as a transient outage.
    const denied = Object.assign(new Error("EPERM: operation not permitted, symlink 'CLAUDE.md' -> '/snap/AGENTS.md'"), {
      code: "EPERM",
      syscall: "symlink",
    })
    expect(api.isSymlinkPrivilegeError(denied)).toBe(true)
    expect(api.isSymlinkPrivilegeError(Object.assign(new Error("nope"), { code: "EACCES", syscall: "symlink" }))).toBe(true)
    // Message-only fallback, for errors that lost their syscall metadata.
    expect(api.isSymlinkPrivilegeError(new Error("EPERM: operation not permitted, symlink 'a' -> 'b'"))).toBe(true)

    // Unrelated failures must NOT claim a symlink remedy.
    expect(api.isSymlinkPrivilegeError(Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC", syscall: "write" }))).toBe(false)
    expect(api.isSymlinkPrivilegeError(new Error("existing migration snapshot failed verification"))).toBe(false)
    expect(api.isSymlinkPrivilegeError("EPERM symlink")).toBe(false)
    expect(api.isSymlinkPrivilegeError(undefined)).toBe(false)
  })
})
