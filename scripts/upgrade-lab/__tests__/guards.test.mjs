import assert from "node:assert/strict"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import * as upgradeLab from "../run.mjs"
import {
  allocateLabPort,
  allocateSafeEphemeralServer,
  assertLabProcessTarget,
  assertLabStartPreflight,
  assertIsolatedLayout,
  assertSafeLabPort,
  buildNativeDependencyRebuild,
  buildDockerInvocation,
  buildMinimalEnvironment,
  createLabRoot,
  MIGRATION_SCREENSHOT_CASES,
  loadPlaywrightChromium,
  liveSentinelMetadata,
  migrationSurfaceLocator,
  mergeFileThreeWay,
  persistLabGatewayPort,
  readConfiguredGatewayPort,
  removeLabRoot,
  resolvePlaywrightChromiumExecutable,
  assertRepresentativeStateSurvived,
  executeDockerLab,
  runWithLabCleanup,
  quiesceAndRemoveLabRoot,
  signalVerifiedLabProcess,
} from "../run.mjs"

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")

test("captures desktop light, desktop dark, and a true 390px mobile viewport", () => {
  assert.deepEqual(
    MIGRATION_SCREENSHOT_CASES.map(({ name, width, height, theme }) => ({ name, width, height, theme })),
    [
      { name: "desktop-light", width: 1440, height: 900, theme: "light" },
      { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
      { name: "mobile-light", width: 390, height: 844, theme: "light" },
    ],
  )
})

test("loads Chromium from the repository's installed Playwright package", async () => {
  const chromium = await loadPlaywrightChromium()
  assert.equal(typeof chromium.launch, "function")
})

test("finds the visible migration dialog when Radix aria-hides the background reminder", async () => {
  const chromium = await loadPlaywrightChromium()
  const executablePath = resolvePlaywrightChromiumExecutable()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <main aria-hidden="true"><button aria-label="Finish v0.26.0 setup">Finish setup</button></main>
      <section role="dialog"><h2>v0.26.0 is installed. Your custom setup is safe.</h2></section>
    `)
    const surface = migrationSurfaceLocator(page)
    await surface.waitFor({ state: "visible", timeout: 1_000 })
    assert.match(await surface.textContent(), /v0\.26\.0 is installed/)
  } finally {
    await browser.close()
  }
})

test("creates a nonce-owned disposable layout outside the live instance", () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    assert.ok(fs.existsSync(path.join(root, ".jinn-upgrade-lab-nonce")))
    assert.ok(layout.home.startsWith(`${root}${path.sep}`))
    assert.ok(Object.values(layout).every((value) => value.startsWith(root)))
  } finally {
    removeLabRoot(root)
  }
  assert.equal(fs.existsSync(root), false)
})

test("live sentinels ignore volatile session writes but detect stable instance changes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-live-sentinel-"))
  try {
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true })
    fs.mkdirSync(path.join(home, "cron"), { recursive: true })
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7777\n")
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "stable\n")
    fs.symlinkSync("CLAUDE.md", path.join(home, "AGENTS.md"))
    fs.writeFileSync(path.join(home, "cron", "jobs.json"), "[]\n")
    fs.writeFileSync(path.join(home, "sessions", "registry.db"), "before")

    const before = liveSentinelMetadata(home)
    fs.writeFileSync(path.join(home, "sessions", "registry.db"), "after")
    assert.equal(liveSentinelMetadata(home).digest, before.digest)

    fs.appendFileSync(path.join(home, "config.yaml"), "# changed\n")
    assert.notEqual(liveSentinelMetadata(home).digest, before.digest)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("rejects the real instance, nested paths, unsafe cleanup, and protected gateway ports", async () => {
  const live = path.resolve(os.homedir(), ".jinn")
  assert.throws(() => assertIsolatedLayout(live), /live instance/i)
  assert.throws(() => assertIsolatedLayout(path.join(live, "lab")), /live instance/i)
  const ordinary = fs.mkdtempSync(path.join(os.tmpdir(), "not-owned-"))
  assert.throws(() => removeLabRoot(ordinary), /nonce/i)
  fs.rmSync(ordinary, { recursive: true })
  assert.throws(() => assertSafeLabPort(7777), /protected/i)
  assert.throws(() => assertSafeLabPort(7801), /protected/i)
  const root = createLabRoot()
  const allocation = await allocateLabPort(root)
  assert.notEqual(allocation.port, 7777)
  assert.notEqual(allocation.port, 7801)
  await allocation.release()
  const repeated = await allocateLabPort(root)
  assert.equal(repeated.port, allocation.port)
  await repeated.release()
  removeLabRoot(root)
})

test("ephemeral fixture allocation closes and retries both protected ports before use", async () => {
  const ports = [7777, 7801, 21877]
  const closed = []
  const servers = ports.map((port) => ({ port }))
  const allocated = await allocateSafeEphemeralServer(
    () => servers.shift(),
    {
      listen: async () => {},
      address: (server) => ({ address: "127.0.0.1", family: "IPv4", port: server.port }),
      close: async (server) => { closed.push(server.port) },
    },
  )
  assert.equal(allocated.port, 21877)
  assert.deepEqual(closed, [7777, 7801])
})

test("persists the chosen lab port into setup's config before gateway startup", () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    const configPath = path.join(layout.home, "config.yaml")
    fs.writeFileSync(configPath, "jinn:\n  version: 0.25.0\ngateway:\n  port: 7777 # setup default\n  host: 127.0.0.1\n")

    persistLabGatewayPort(layout.home, 21877)

    assert.equal(readConfiguredGatewayPort(layout.home), 21877)
    assert.match(fs.readFileSync(configPath, "utf8"), /port: 21877 # setup default/)
  } finally {
    removeLabRoot(root)
  }
})

test("start preflight requires config and launch ports to agree", async () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    fs.writeFileSync(path.join(layout.home, "config.yaml"), "gateway:\n  port: 21877\n")
    await assert.rejects(
      assertLabStartPreflight({ labHome: layout.home, port: 21878 }),
      /config.*21877.*launch.*21878/i,
    )
  } finally {
    removeLabRoot(root)
  }
})

test("start preflight refuses an occupied port owned by a foreign home", async () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    fs.writeFileSync(path.join(layout.home, "config.yaml"), "gateway:\n  port: 21877\n")
    await assert.rejects(
      assertLabStartPreflight(
        { labHome: layout.home, port: 21877 },
        {
          probePortAvailable: async () => { throw new Error("EADDRINUSE") },
          lookupListeningPid: () => 4242,
          readProcessJinnHome: () => path.join(root, "foreign-home"),
        },
      ),
      /foreign process.*4242.*refusing to start or restart/i,
    )
  } finally {
    removeLabRoot(root)
  }
})

test("self-restart preflight never invokes a restart against a PID outside the lab home", () => {
  assert.equal(typeof upgradeLab.runVerifiedLabRestart, "function", "runVerifiedLabRestart must guard the installed CLI restart handoff")
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    fs.writeFileSync(path.join(layout.home, "config.yaml"), "gateway:\n  port: 21877\n")
    const foreignHome = path.join(root, "foreign-home")
    const restarts = []

    assert.throws(
      () => upgradeLab.runVerifiedLabRestart(
        {
          pid: 4242,
          port: 21877,
          labHome: layout.home,
          restart: () => restarts.push({ pid: 4242, signal: "SIGTERM" }),
        },
        {
          lookupListeningPid: () => 4242,
          readProcessJinnHome: () => foreignHome,
        },
      ),
      /foreign.*JINN_HOME/i,
    )
    assert.deepEqual(restarts, [])
  } finally {
    removeLabRoot(root)
  }
})

test("simulated self-restart leaves a foreign listener alive", async () => {
  const root = createLabRoot()
  let listener = null
  try {
    const layout = assertIsolatedLayout(root)
    const allocation = await allocateLabPort(root)
    const port = allocation.port
    await allocation.release()
    fs.writeFileSync(path.join(layout.home, "config.yaml"), `gateway:\n  port: ${port}\n`)
    const foreignHome = path.join(root, "foreign-home")
    fs.mkdirSync(foreignHome)
    const source = `
const net = require("node:net")
const server = net.createServer((socket) => socket.end("alive"))
server.listen(Number(process.env.LAB_TEST_PORT), "127.0.0.1", () => process.send("ready"))
process.on("SIGTERM", () => server.close(() => process.exit(0)))
`
    listener = spawn(process.execPath, ["-e", source], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        JINN_HOME: foreignHome,
        LAB_TEST_PORT: String(port),
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    await new Promise((resolve, reject) => {
      listener.once("message", resolve)
      listener.once("error", reject)
      listener.once("exit", (code, signal) => reject(new Error(`Foreign listener exited before readiness: ${code ?? signal}`)))
    })
    let restartInvoked = false

    assert.throws(
      () => upgradeLab.runVerifiedLabRestart(
        {
          pid: listener.pid,
          port,
          labHome: layout.home,
          restart: () => {
            restartInvoked = true
            listener.kill("SIGTERM")
          },
        },
      ),
      /foreign.*JINN_HOME/i,
    )
    assert.equal(restartInvoked, false)
    process.kill(listener.pid, 0)
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => { body += chunk })
      socket.on("end", () => resolve(body))
      socket.on("error", reject)
    })
    assert.equal(response, "alive")
  } finally {
    if (listener && listener.exitCode === null && listener.signalCode === null) {
      const exited = new Promise((resolve) => listener.once("exit", resolve))
      listener.kill("SIGTERM")
      await exited
    }
    removeLabRoot(root)
  }
})

test("signal guard requires both disposable port ownership and disposable JINN_HOME", () => {
  const labHome = path.resolve(os.tmpdir(), "owned-upgrade-lab-home")
  const dependencies = {
    lookupListeningPid: () => 4242,
    readProcessJinnHome: () => labHome,
  }

  assert.doesNotThrow(() => assertLabProcessTarget({ pid: 4242, port: 21877, labHome }, dependencies))
  assert.throws(
    () => assertLabProcessTarget({ pid: 4343, port: 21877, labHome }, dependencies),
    /owned by PID 4242.*not 4343/i,
  )
})

test("verified self-restart invokes the handoff only for the configured lab-owned PID", () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    fs.writeFileSync(path.join(layout.home, "config.yaml"), "gateway:\n  port: 21877\n")
    const restarts = []
    const result = upgradeLab.runVerifiedLabRestart(
      {
        pid: 4242,
        port: 21877,
        labHome: layout.home,
        restart: () => { restarts.push(4242); return "started" },
      },
      {
        lookupListeningPid: () => 4242,
        readProcessJinnHome: () => layout.home,
      },
    )

    assert.equal(result, "started")
    assert.deepEqual(restarts, [4242])
  } finally {
    removeLabRoot(root)
  }
})

test("builds a minimal child environment rooted entirely in the lab", () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    const env = buildMinimalEnvironment(layout, { PATH: process.env.PATH ?? "" })
    for (const key of ["HOME", "JINN_HOME", "npm_config_prefix", "npm_config_cache", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "JINN_REGISTRY_PATH", "JINN_LOG_DIR", "JINN_ATTACHMENTS_DIR"]) {
      assert.ok(path.resolve(env[key]).startsWith(root), key)
    }
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.deepEqual(Object.keys(env).sort(), Object.keys(env).filter((key) => !/(TOKEN|SECRET|PASSWORD|API_KEY)/.test(key)).sort())
  } finally {
    removeLabRoot(root)
  }
})

test("waits past model discovery until the stub records the migration prompt", async () => {
  assert.equal(typeof upgradeLab.waitForJsonlRecord, "function")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-upgrade-lab-jsonl-"))
  const record = path.join(root, "stub-engine-invocations.jsonl")
  try {
    fs.writeFileSync(record, `${JSON.stringify({ argv: ["debug", "models"] })}\n`)
    setTimeout(() => {
      fs.appendFileSync(record, `${JSON.stringify({ argv: ["exec", "canonical migration prompt"] })}\n`)
    }, 20)

    const match = await upgradeLab.waitForJsonlRecord(
      record,
      (entry) => entry.argv?.includes("canonical migration prompt"),
      1_000,
      5,
    )

    assert.deepEqual(match.argv, ["exec", "canonical migration prompt"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("native dependency rebuild enables scripts only for better-sqlite3 inside the installed package", () => {
  const packageRoot = path.join(os.tmpdir(), "disposable-jinn-package")
  assert.deepEqual(buildNativeDependencyRebuild(packageRoot), {
    command: "npm",
    args: [
      "rebuild",
      "better-sqlite3",
      "--prefix",
      packageRoot,
      "--ignore-scripts=false",
      "--foreground-scripts",
    ],
  })
})

test("accepts pnpm's argument separator for the documented dry-run command", () => {
  const runner = path.resolve("scripts/upgrade-lab/run.mjs")
  const result = spawnSync(process.execPath, [runner, "--", "--scenario", "stock", "--dry-run"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"isolation": "PASS"/)
})

test("derives baseline and candidate versions instead of hard-coding an obsolete release pair", () => {
  assert.equal(typeof upgradeLab.readInstalledPackageVersion, "function")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-upgrade-version-"))
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jinn-cli", version: "0.28.0" }))
    assert.equal(upgradeLab.readInstalledPackageVersion(root), "0.28.0")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  const runner = fs.readFileSync(path.resolve("scripts/upgrade-lab/run.mjs"), "utf8")
  assert.doesNotMatch(runner, /jinn-cli@0\.25\.0/)
  assert.doesNotMatch(runner, /packageVersion:\s*"0\.26\.0"/)
  assert.doesNotMatch(runner, /migrations",\s*"0\.26\.0"/)
})

test("candidate state probing uses the v2 Workflow repository and import report", () => {
  const probe = fs.readFileSync(path.resolve("scripts/upgrade-lab/state-probe.mjs"), "utf8")
  assert.match(probe, /query-candidate/)
  assert.match(probe, /workflows\/repository-migrations\.js/)
  assert.match(probe, /legacy-v1-import-report\.json/)
})

test("three-way merge preserves a non-conflicting user append and target changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-merge-file-"))
  try {
    const base = path.join(root, "base.md")
    const user = path.join(root, "user.md")
    const target = path.join(root, "target.md")
    fs.writeFileSync(base, "heading\nstock line\nstable one\nstable two\nstable three\n")
    fs.writeFileSync(user, "heading\nstock line\nstable one\nstable two\nstable three\nCUSTOM-SURVIVES\n")
    fs.writeFileSync(target, "heading\nupdated stock line\nstable one\nstable two\nstable three\n")
    const merged = mergeFileThreeWay({ base, user, target })
    assert.equal(merged.ok, true)
    assert.match(merged.contents.toString("utf8"), /updated stock line/)
    assert.match(merged.contents.toString("utf8"), /CUSTOM-SURVIVES/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("stock verification uses materialized base and target hashes", () => {
  assert.equal(typeof upgradeLab.assertStockBundleApplied, "function")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-stock-verification-"))
  try {
    const bundle = path.join(root, "materialized", "0.26.0")
    fs.mkdirSync(path.join(bundle, "files/base"), { recursive: true })
    fs.mkdirSync(path.join(bundle, "files/target"), { recursive: true })
    const base = "# Custom Portal\nv0.25 doctrine\n"
    const target = "# Custom Portal\nv0.26 doctrine\n"
    fs.writeFileSync(path.join(bundle, "files/base/CLAUDE.md"), base)
    fs.writeFileSync(path.join(bundle, "files/target/CLAUDE.md"), target)
    fs.writeFileSync(path.join(root, "CLAUDE.md"), target)
    assert.doesNotThrow(() => upgradeLab.assertStockBundleApplied({
      home: root,
      materializedBundleDir: bundle,
      manifest: {
        files: [{
          path: "CLAUDE.md",
          operation: "modify",
          basePayload: "files/base/CLAUDE.md",
          targetPayload: "files/target/CLAUDE.md",
        }],
      },
      receipt: { reviewedFiles: ["CLAUDE.md"], skippedItems: [] },
      preMergeTree: { "CLAUDE.md": sha256(base) },
    }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("materialized three-way merge preserves a genuine edit on top of personalization", () => {
  assert.equal(typeof upgradeLab.mergeBundle, "function")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-materialized-merge-"))
  try {
    const bundle = path.join(root, "materialized", "0.26.0")
    fs.mkdirSync(path.join(bundle, "files/base"), { recursive: true })
    fs.mkdirSync(path.join(bundle, "files/target"), { recursive: true })
    fs.writeFileSync(path.join(bundle, "files/base/CLAUDE.md"), "# Custom Portal\nstock line\nstable one\nstable two\nstable three\n")
    fs.writeFileSync(path.join(bundle, "files/target/CLAUDE.md"), "# Custom Portal\nupdated stock line\nstable one\nstable two\nstable three\n")
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Custom Portal\nstock line\nstable one\nstable two\nstable three\nGENUINE-EDIT-SURVIVES\n")
    const manifest = { files: [{ path: "CLAUDE.md", operation: "modify", basePayload: "files/base/CLAUDE.md", targetPayload: "files/target/CLAUDE.md" }] }
    const audit = { files: [{ version: "0.26.0", path: "CLAUDE.md", base: { unresolvedPlaceholders: [] }, target: { unresolvedPlaceholders: [] } }] }

    const receipt = upgradeLab.mergeBundle(root, bundle, manifest, audit, "0.26.0")

    assert.deepEqual(receipt.skippedItems, [])
    assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /updated stock line/)
    assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /GENUINE-EDIT-SURVIVES/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("materialized migration chains apply every structured bundle in version order", () => {
  assert.equal(typeof upgradeLab.mergeMigrationChain, "function")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-materialized-chain-"))
  try {
    const migrations = path.join(root, "migrations")
    const snapshot = path.join(root, "snapshot")
    const versions = [
      { version: "0.26.0", base: "old\n", target: "middle\n" },
      { version: "0.28.0", base: "middle\n", target: "new\n" },
    ]
    const audit = { files: [] }
    for (const entry of versions) {
      const manifestDir = path.join(migrations, entry.version)
      const materializedDir = path.join(snapshot, "materialized", entry.version, "files")
      fs.mkdirSync(manifestDir, { recursive: true })
      fs.mkdirSync(path.join(materializedDir, "base"), { recursive: true })
      fs.mkdirSync(path.join(materializedDir, "target"), { recursive: true })
      fs.writeFileSync(path.join(materializedDir, "base/CLAUDE.md"), entry.base)
      fs.writeFileSync(path.join(materializedDir, "target/CLAUDE.md"), entry.target)
      fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({
        files: [{
          path: "CLAUDE.md",
          operation: "modify",
          basePayload: "files/base/CLAUDE.md",
          targetPayload: "files/target/CLAUDE.md",
        }],
      }))
      audit.files.push({
        version: entry.version,
        path: "CLAUDE.md",
        base: { unresolvedPlaceholders: [] },
        target: { unresolvedPlaceholders: [] },
      })
    }
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "old\n")

    const result = upgradeLab.mergeMigrationChain({
      home: root,
      snapshotPath: snapshot,
      migrationsDir: migrations,
      manifests: versions.map(({ version }) => ({ version })),
      materializationAudit: audit,
    })

    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "new\n")
    assert.deepEqual(result.appliedVersions, ["0.26.0", "0.28.0"])
    assert.deepEqual(result.receipt, { reviewedFiles: ["CLAUDE.md"], skippedItems: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("materialized merge refuses unresolved placeholders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-unresolved-merge-"))
  try {
    const bundle = path.join(root, "materialized", "0.26.0")
    fs.mkdirSync(path.join(bundle, "files/base"), { recursive: true })
    fs.mkdirSync(path.join(bundle, "files/target"), { recursive: true })
    fs.writeFileSync(path.join(bundle, "files/base/CLAUDE.md"), "{{futureValue}}\n")
    fs.writeFileSync(path.join(bundle, "files/target/CLAUDE.md"), "{{futureValue}} changed\n")
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "user content\n")
    const manifest = { files: [{ path: "CLAUDE.md", operation: "modify", basePayload: "files/base/CLAUDE.md", targetPayload: "files/target/CLAUDE.md" }] }
    const audit = { files: [{ version: "0.26.0", path: "CLAUDE.md", base: { unresolvedPlaceholders: ["{{futureValue}}"] }, target: { unresolvedPlaceholders: ["{{futureValue}}"] } }] }

    const receipt = upgradeLab.mergeBundle(root, bundle, manifest, audit, "0.26.0")

    assert.equal(receipt.skippedItems.length, 1)
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "user content\n")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("materialized merge carries an existing unresolved placeholder only for an untouched file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-carried-placeholder-"))
  try {
    const bundle = path.join(root, "materialized", "0.26.0")
    fs.mkdirSync(path.join(bundle, "files/base"), { recursive: true })
    fs.mkdirSync(path.join(bundle, "files/target"), { recursive: true })
    const base = "runtime: {{runtimeValue}}\nstock: old\n"
    const target = "runtime: {{runtimeValue}}\nstock: new\n"
    fs.writeFileSync(path.join(bundle, "files/base/config.yaml"), base)
    fs.writeFileSync(path.join(bundle, "files/target/config.yaml"), target)
    fs.writeFileSync(path.join(root, "config.yaml"), base)
    const manifest = { files: [{ path: "config.yaml", operation: "modify", basePayload: "files/base/config.yaml", targetPayload: "files/target/config.yaml" }] }
    const audit = { files: [{ version: "0.26.0", path: "config.yaml", base: { unresolvedPlaceholders: ["{{runtimeValue}}"] }, target: { unresolvedPlaceholders: ["{{runtimeValue}}"] } }] }

    const receipt = upgradeLab.mergeBundle(root, bundle, manifest, audit, "0.26.0")

    assert.deepEqual(receipt.skippedItems, [])
    assert.equal(fs.readFileSync(path.join(root, "config.yaml"), "utf8"), target)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Docker invocation is network-isolated and mounts no host home", () => {
  const root = createLabRoot()
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-repo-fixture-"))
    const candidate = path.join(root, "candidate.tgz")
    const baseline = path.join(root, "v025.tgz")
    fs.writeFileSync(candidate, "candidate")
    fs.writeFileSync(baseline, "baseline")
    const invocation = buildDockerInvocation({ repo, root, scenario: "stock", candidateTarball: candidate, baselineTarball: baseline, image: "jinn-upgrade-lab:test" })
    assert.equal(invocation.command, "docker")
    assert.ok(invocation.args.includes("none"))
    assert.ok(invocation.args.some((value) => value.includes(`src=${repo},dst=/workspace,readonly`)))
    assert.ok(invocation.args.every((value) => !value.includes(os.homedir())))
    fs.rmSync(repo, { recursive: true, force: true })
  } finally {
    removeLabRoot(root)
  }
})

test("representative state comparison requires real semantic identities and content", () => {
  const before = {
    session: { count: 1, id: "session-id", sessionKey: "upgrade-lab:state", title: "Lab state" },
    todo: { count: 1, id: "todo-id", sourceRef: "upgrade-lab:todo", title: "Lab Todo", status: "backlog" },
    workflow: {
      count: 1,
      id: "workflow-id",
      title: "Upgrade lab Workflow",
      status: "active",
      sourceSha256: "abc123",
    },
    cron: { count: 1, id: "upgrade-lab-cron", prompt: "fixture" },
    org: { count: 1, name: "lab-operator", persona: "Disposable fixture." },
  }
  const after = structuredClone(before)
  after.workflow = {
    count: 1,
    id: "workflow-id",
    title: "Upgrade lab Workflow",
    enabled: false,
    sourceSha256: "abc123",
    legacySourcePreserved: true,
    importOutcome: "imported",
  }
  assert.doesNotThrow(() => assertRepresentativeStateSurvived(before, after))
  const changed = structuredClone(before)
  changed.todo.status = "done"
  assert.throws(() => assertRepresentativeStateSurvived(before, changed), /todo.*changed/i)
  const unsafeWorkflow = structuredClone(after)
  unsafeWorkflow.workflow.legacySourcePreserved = false
  assert.throws(() => assertRepresentativeStateSurvived(before, unsafeWorkflow), /workflow.*changed/i)
})

test("cleanup waits for a lab-home descendant that recreates .hermes before removing the nonce root", async () => {
  const root = createLabRoot()
  const layout = assertIsolatedLayout(root)
  const source = `
const fs = require("node:fs")
const path = require("node:path")
if (process.send) process.send("ready")
process.on("SIGTERM", () => setTimeout(() => {
  fs.mkdirSync(path.join(process.env.HOME, ".hermes"), { recursive: true })
  process.exit(0)
}, 40))
setInterval(() => {}, 1000)
`
  const child = spawn(process.execPath, ["-e", source], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: layout.osHome, JINN_HOME: layout.home },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  await new Promise((resolve, reject) => {
    child.once("message", resolve)
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(`fixture exited early: ${code ?? signal}`)))
  })

  await quiesceAndRemoveLabRoot(root)

  assert.equal(child.exitCode, 0)
  assert.equal(fs.existsSync(root), false)
})

test("primary scenario failure wins when cleanup also fails", async () => {
  const primary = new Error("scenario failed")
  const cleanup = new Error("cleanup failed")
  await assert.rejects(
    runWithLabCleanup(async () => { throw primary }, async () => { throw cleanup }),
    (error) => error === primary && error.cleanupError === cleanup,
  )
})

test("explicit Docker mode dispatches build and run without invoking the local scenario", async () => {
  const root = createLabRoot()
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-docker-repo-"))
  try {
    const candidate = path.join(root, "candidate.tgz")
    const baseline = path.join(root, "baseline.tgz")
    fs.writeFileSync(candidate, "candidate")
    fs.writeFileSync(baseline, "baseline")
    const commands = []
    let localCalls = 0
    await executeDockerLab(
      { repo, root, scenario: "stock", candidateTarball: candidate, baselineTarball: baseline, keep: true },
      {
        dockerAvailable: () => true,
        runCommand: (command, args) => { commands.push({ command, args }); return { status: 0 } },
        executeLocal: async () => { localCalls++ },
      },
    )
    assert.equal(localCalls, 0)
    assert.equal(commands[0].command, "docker")
    assert.ok(commands[0].args.includes("build"))
    assert.equal(commands[1].command, "docker")
    assert.ok(commands[1].args.includes("run"))
    assert.ok(commands[1].args.every((arg) => !arg.includes(os.homedir())))
    assert.equal(commands[1].args.includes("-p"), false)
  } finally {
    if (fs.existsSync(root)) removeLabRoot(root)
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("explicit Docker mode fails clearly when Docker is unavailable", async () => {
  const root = createLabRoot()
  try {
    await assert.rejects(
      executeDockerLab({ repo: path.resolve("."), root, scenario: "stock", candidateTarball: "candidate", baselineTarball: "baseline", keep: false }, { dockerAvailable: () => false }),
      /Docker.*unavailable/i,
    )
  } finally {
    removeLabRoot(root)
  }
})
