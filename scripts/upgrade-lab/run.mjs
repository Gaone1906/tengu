#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const NONCE = ".jinn-upgrade-lab-nonce"
const SCENARIOS = new Set(["stock", "customized", "heavily-customized", "interrupted", "no-instance-change"])
const PROTECTED_GATEWAY_PORTS = new Set([7777, 7801])
const LAB_PORT_MIN = 20_000
const LAB_PORT_SPAN = 20_000
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")
const STRICT_VERSION = /^\d+\.\d+\.\d+$/
const inside = (root, value) => value === root || value.startsWith(`${root}${path.sep}`)
const resolvedIdentity = (value) => {
  const absolute = path.resolve(value)
  try { return fs.realpathSync(absolute) } catch { return absolute }
}

export const MIGRATION_SCREENSHOT_CASES = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "mobile-light", width: 390, height: 844, theme: "light" },
]

export function readInstalledPackageVersion(packageRoot) {
  const value = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version
  if (typeof value !== "string" || !STRICT_VERSION.test(value)) {
    throw new Error(`Installed package has an invalid release version: ${String(value)}`)
  }
  return value
}

export function candidateNeedsMigrationHandoff({ scenario, packageRoot, version }) {
  if (scenario === "no-instance-change") return false
  return fs.existsSync(path.join(packageRoot, "template", "migrations", version, "manifest.json"))
}

export function createLabRoot(explicitRoot) {
  let root
  if (explicitRoot) {
    root = path.resolve(explicitRoot)
    if (fs.existsSync(root)) throw new Error(`Disposable lab root must not already exist: ${root}`)
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  } else {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-upgrade-lab-"))
  }
  fs.writeFileSync(path.join(root, NONCE), `${crypto.randomUUID()}\n`, { mode: 0o600 })
  return fs.realpathSync(root)
}

export function assertIsolatedLayout(rootInput) {
  const livePath = path.resolve(os.homedir(), ".jinn")
  const live = fs.existsSync(livePath) ? fs.realpathSync(livePath) : livePath
  const requested = path.resolve(rootInput)
  if (inside(live, requested)) throw new Error("Lab root is the live instance or nested inside the live instance")
  const root = fs.realpathSync(rootInput)
  if (inside(live, root)) throw new Error("Lab root is the live instance or nested inside the live instance")
  if (!root.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`) && !fs.existsSync(path.join(root, NONCE))) {
    throw new Error("Explicit lab root is not a newly created nonce-owned disposable directory")
  }
  const entries = {
    root,
    home: path.join(root, "home", ".jinn-lab"),
    osHome: path.join(root, "home"),
    cache: path.join(root, "cache"),
    prefix: path.join(root, "prefix"),
    xdgConfig: path.join(root, "xdg", "config"),
    xdgCache: path.join(root, "xdg", "cache"),
    xdgData: path.join(root, "xdg", "data"),
    registry: path.join(root, "state", "instances.json"),
    logs: path.join(root, "artifacts", "logs"),
    attachments: path.join(root, "artifacts", "attachments"),
    artifacts: path.join(root, "artifacts"),
  }
  for (const value of Object.values(entries)) {
    if (!inside(root, path.resolve(value))) throw new Error(`Lab path escapes disposable root: ${value}`)
  }
  if (inside(live, entries.home)) throw new Error("Lab home overlaps the live instance")
  for (const value of Object.values(entries)) fs.mkdirSync(value, { recursive: true })
  return entries
}

export function buildMinimalEnvironment(layout, base = {}) {
  const env = {
    PATH: base.PATH ?? "/usr/bin:/bin",
    HOME: layout.osHome,
    JINN_HOME: layout.home,
    JINN_INSTANCE: "upgrade-lab",
    JINN_INSTANCES_REGISTRY: layout.registry,
    JINN_REGISTRY_PATH: layout.registry,
    JINN_LOG_DIR: layout.logs,
    JINN_ATTACHMENTS_DIR: layout.attachments,
    XDG_CONFIG_HOME: layout.xdgConfig,
    XDG_CACHE_HOME: layout.xdgCache,
    XDG_DATA_HOME: layout.xdgData,
    npm_config_prefix: layout.prefix,
    npm_config_cache: layout.cache,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    NO_COLOR: "1",
    CI: "1",
    TERM: "dumb",
    JINN_NO_OPEN: "1",
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  return env
}

export function mergeFileThreeWay({ base, user, target }) {
  const result = spawnSync("git", ["merge-file", "-p", user, base, target], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status === 0) return { ok: true, contents: result.stdout }
  if (result.status === 1) return { ok: false, contents: result.stdout, reason: "text merge conflict" }
  return { ok: false, contents: null, reason: result.stderr?.toString("utf8").trim() || "file is not mergeable text" }
}

export function buildDockerInvocation({ repo, root, scenario, candidateTarball, baselineTarball, image, dryRun = false }) {
  const candidateName = path.basename(candidateTarball)
  const baselineName = path.basename(baselineTarball)
  return {
    command: "docker",
    args: [
      "run", "--rm", "--network", "none",
      "--mount", `type=bind,src=${repo},dst=/workspace,readonly`,
      "--mount", `type=bind,src=${root},dst=/lab`,
      image,
      "--scenario", scenario,
      "--candidate-tarball", `/lab/${candidateName}`,
      "--baseline-tarball", `/lab/${baselineName}`,
      "--root", "/lab/run",
      "--keep",
      ...(dryRun ? ["--dry-run"] : []),
    ],
  }
}

export async function executeDockerLab(options, dependencies = {}) {
  const dockerAvailable = dependencies.dockerAvailable ?? (() => spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0)
  if (!dockerAvailable()) throw new Error("Docker was explicitly requested but is unavailable")
  const runCommand = dependencies.runCommand ?? ((command, args) => spawnSync(command, args, { stdio: "inherit" }))
  const copyIntoRoot = (source) => {
    const destination = path.join(options.root, path.basename(source))
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination)
    return destination
  }
  const candidateTarball = copyIntoRoot(options.candidateTarball)
  const baselineTarball = copyIntoRoot(options.baselineTarball)
  const image = `jinn-upgrade-lab:${sha256(fs.readFileSync(path.join(options.root, NONCE))).slice(0, 12)}`
  const dockerfile = path.join(options.repo, "scripts", "upgrade-lab", "Dockerfile")
  const context = path.dirname(dockerfile)
  const build = runCommand("docker", ["build", "--file", dockerfile, "--tag", image, context])
  if (build?.error || build?.status !== 0) throw build?.error ?? new Error(`Docker image build failed with status ${build?.status}`)
  const invocation = buildDockerInvocation({
    repo: options.repo,
    root: options.root,
    scenario: options.scenario,
    candidateTarball,
    baselineTarball,
    image,
    dryRun: Boolean(options.dryRun),
  })
  const executed = runCommand(invocation.command, invocation.args)
  if (executed?.error || executed?.status !== 0) throw executed?.error ?? new Error(`Docker upgrade lab failed with status ${executed?.status}`)
}

export function assertSafeLabPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid lab port: ${port}`)
  if (PROTECTED_GATEWAY_PORTS.has(port)) throw new Error(`Refusing protected gateway port ${port}`)
  return port
}

export function deriveLabPort(rootInput) {
  const root = fs.realpathSync(rootInput)
  const noncePath = path.join(root, NONCE)
  if (!fs.existsSync(noncePath)) throw new Error("Cannot derive a lab port without the lab-owned nonce file")
  const seed = crypto.createHash("sha256").update(root).update("\0").update(fs.readFileSync(noncePath)).digest()
  return assertSafeLabPort(LAB_PORT_MIN + (seed.readUInt32BE(0) % LAB_PORT_SPAN))
}

export async function allocateLabPort(rootInput) {
  const port = deriveLabPort(rootInput)
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`Deterministic lab port ${port} is already in use or unavailable: ${error.message}`)))
    server.listen(port, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string" || address.port !== port) {
    server.close()
    throw new Error(`Failed to reserve deterministic lab port ${port}`)
  }
  return { port: address.port, release: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

export async function allocateSafeEphemeralServer(createServer, dependencies = {}) {
  const listen = dependencies.listen ?? ((server) => new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  }))
  const address = dependencies.address ?? ((server) => server.address())
  const close = dependencies.close ?? ((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  for (let attempt = 0; attempt < 16; attempt++) {
    const server = createServer()
    await listen(server)
    const bound = address(server)
    if (!bound || typeof bound === "string" || !Number.isInteger(bound.port)) {
      await close(server)
      throw new Error("Could not allocate a numeric loopback fixture port")
    }
    if (PROTECTED_GATEWAY_PORTS.has(bound.port)) {
      await close(server)
      continue
    }
    return { server, port: bound.port }
  }
  throw new Error("Could not allocate a safe fixture port after rejecting protected ports")
}

function gatewayConfigLines(home) {
  const configPath = path.join(home, "config.yaml")
  if (!fs.existsSync(configPath)) throw new Error(`Lab setup did not create ${configPath}`)
  return { configPath, source: fs.readFileSync(configPath, "utf8") }
}

function gatewayPortLine(source) {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? []
  const gatewayIndex = lines.findIndex((line) => /^gateway:\s*(?:#.*)?(?:\r?\n)?$/.test(line))
  if (gatewayIndex === -1) throw new Error("Lab config has no top-level gateway mapping")
  for (let index = gatewayIndex + 1; index < lines.length; index++) {
    const line = lines[index]
    if (/^[^\s#][^:]*:/.test(line)) break
    const match = line.match(/^(\s+port:\s*)(?:["']?)(\d+)(?:["']?)([ \t]*(?:#.*)?(?:\r?\n)?)$/)
    if (match) return { lines, index, match }
  }
  throw new Error("Lab config gateway mapping has no numeric port")
}

export function readConfiguredGatewayPort(home) {
  const { source } = gatewayConfigLines(home)
  const { match } = gatewayPortLine(source)
  return Number(match[2])
}

export function persistLabGatewayPort(home, port) {
  assertSafeLabPort(port)
  const { configPath, source } = gatewayConfigLines(home)
  const { lines, index, match } = gatewayPortLine(source)
  lines[index] = `${match[1]}${port}${match[3]}`
  const temporary = `${configPath}.upgrade-lab-${process.pid}-${crypto.randomUUID()}.tmp`
  const mode = fs.statSync(configPath).mode & 0o777
  try {
    fs.writeFileSync(temporary, lines.join(""), { mode })
    fs.renameSync(temporary, configPath)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  const persisted = readConfiguredGatewayPort(home)
  if (persisted !== port) throw new Error(`Lab config port persistence failed: expected ${port}, read ${persisted}`)
}

export function lookupListeningPid(port) {
  assertSafeLabPort(port)
  const commands = process.platform === "darwin" ? ["/usr/sbin/lsof", "lsof"] : ["lsof"]
  for (const command of commands) {
    const result = spawnSync(command, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    if (result.error?.code === "ENOENT") continue
    if (result.error) throw result.error
    if (result.status === 1 && !result.stdout.trim()) return null
    if (result.status !== 0) throw new Error(`Unable to inspect owner of lab port ${port}: ${result.stderr.trim() || `lsof exited ${result.status}`}`)
    const pids = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))]
    if (pids.length === 0) return null
    if (pids.length !== 1) throw new Error(`Lab port ${port} has multiple listening PIDs: ${pids.join(", ")}`)
    return pids[0]
  }
  throw new Error(`Cannot verify ownership of lab port ${port}: lsof is unavailable`)
}

export function readProcessJinnHome(pid) {
  if (process.platform === "linux") {
    try {
      const entries = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      const entry = entries.find((value) => value.startsWith("JINN_HOME="))
      return entry ? entry.slice("JINN_HOME=".length) : null
    } catch {}
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" })
  if (result.status !== 0) return null
  const match = result.stdout.match(/(?:^|\s)JINN_HOME=([^\s]+)/)
  return match?.[1] ?? null
}

export function assertLabProcessTarget({ pid, port, labHome }, dependencies = {}) {
  assertSafeLabPort(port)
  const lookup = dependencies.lookupListeningPid ?? lookupListeningPid
  const readHome = dependencies.readProcessJinnHome ?? readProcessJinnHome
  const ownerPid = lookup(port)
  if (ownerPid !== pid) throw new Error(`Refusing to signal PID ${pid}: lab port ${port} is owned by PID ${ownerPid ?? "none"}, not ${pid}`)
  const ownerHome = readHome(pid)
  if (!ownerHome || resolvedIdentity(ownerHome) !== resolvedIdentity(labHome)) {
    throw new Error(`Refusing to signal foreign process ${pid}: JINN_HOME=${ownerHome ?? "unknown"}, expected ${resolvedIdentity(labHome)}`)
  }
}

export function signalVerifiedLabProcess({ pid, port, labHome, signal }, dependencies = {}) {
  assertLabProcessTarget({ pid, port, labHome }, dependencies)
  const signalProcess = dependencies.signalProcess ?? process.kill
  signalProcess(pid, signal)
}

async function probePortAvailable(port) {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

export async function assertLabStartPreflight({ labHome, port }, dependencies = {}) {
  assertSafeLabPort(port)
  const configuredPort = readConfiguredGatewayPort(labHome)
  if (configuredPort !== port) throw new Error(`Lab config port ${configuredPort} does not match launch port ${port}`)
  try {
    await (dependencies.probePortAvailable ?? probePortAvailable)(port)
  } catch (error) {
    const lookup = dependencies.lookupListeningPid ?? lookupListeningPid
    const readHome = dependencies.readProcessJinnHome ?? readProcessJinnHome
    const ownerPid = lookup(port)
    const ownerHome = ownerPid === null ? null : readHome(ownerPid)
    const ownership = ownerPid === null ? "unknown owner" : `PID ${ownerPid}, JINN_HOME=${ownerHome ?? "unknown"}`
    const foreign = !ownerHome || resolvedIdentity(ownerHome) !== resolvedIdentity(labHome)
    throw new Error(`${foreign ? "Foreign process" : "Lab process"} already occupies lab port ${port} (${ownership}); refusing to start or restart: ${error.message}`)
  }
}

export function assertLabRestartPreflight({ pid, labHome, port }, dependencies = {}) {
  assertSafeLabPort(port)
  const configuredPort = readConfiguredGatewayPort(labHome)
  if (configuredPort !== port) throw new Error(`Lab config port ${configuredPort} does not match restart port ${port}`)
  assertLabProcessTarget({ pid, port, labHome }, dependencies)
}

export function runVerifiedLabRestart({ pid, labHome, port, restart }, dependencies = {}) {
  if (typeof restart !== "function") throw new TypeError("Verified lab restart requires a restart callback")
  assertLabRestartPreflight({ pid, labHome, port }, dependencies)
  return restart()
}

export function removeLabRoot(rootInput) {
  const root = fs.realpathSync(rootInput)
  if (!fs.existsSync(path.join(root, NONCE))) throw new Error("Refusing cleanup without the lab-owned nonce file")
  fs.rmSync(root, { recursive: true })
}

export function assertRepresentativeStateSurvived(before, after) {
  for (const kind of ["session", "todo", "cron", "org"]) {
    if (JSON.stringify(before?.[kind]) !== JSON.stringify(after?.[kind])) {
      throw new Error(`Representative ${kind} state changed across the package swap`)
    }
  }
  const oldWorkflow = before?.workflow
  const newWorkflow = after?.workflow
  if (oldWorkflow?.storage === "v2") {
    if (JSON.stringify(oldWorkflow) !== JSON.stringify(newWorkflow)) {
      throw new Error("Representative workflow state changed across the package swap")
    }
    return
  }
  if (
    oldWorkflow?.count !== 1
    || newWorkflow?.count !== 1
    || oldWorkflow.id !== newWorkflow.id
    || oldWorkflow.title !== newWorkflow.title
    || oldWorkflow.sourceSha256 !== newWorkflow.sourceSha256
    || newWorkflow.enabled !== false
    || newWorkflow.legacySourcePreserved !== true
    || newWorkflow.importOutcome !== "imported"
  ) {
    throw new Error("Representative workflow state changed across the package swap")
  }
}

export function buildLabProcessScanPipeline(labHome) {
  const expected = resolvedIdentity(labHome)
  return {
    source: {
      command: "ps",
      args: ["eww", "-axo", "pid=,command="],
    },
    filter: {
      command: "awk",
      args: [
        "-v",
        `needle=JINN_HOME=${expected}`,
        '{ for (i = 2; i <= NF; i++) if ($i == needle) { print $1; break } }',
      ],
    },
  }
}

async function runLabProcessScanPipeline(pipeline, spawnProcess = spawn) {
  const source = spawnProcess(pipeline.source.command, pipeline.source.args, { stdio: ["ignore", "pipe", "pipe"] })
  const filter = spawnProcess(pipeline.filter.command, pipeline.filter.args, { stdio: ["pipe", "pipe", "pipe"] })
  source.stdout.pipe(filter.stdin)

  const settle = (child) => {
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    return new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal, stderr }))
    })
  }
  let stdout = ""
  filter.stdout.setEncoding("utf8")
  filter.stdout.on("data", (chunk) => { stdout += chunk })
  const [sourceResult, filterResult] = await Promise.all([settle(source), settle(filter)])
  if (sourceResult.code !== 0) {
    throw new Error(`Unable to inspect lab processes: ${sourceResult.stderr.trim() || sourceResult.signal || sourceResult.code}`)
  }
  if (filterResult.code !== 0) {
    throw new Error(`Unable to filter lab processes: ${filterResult.stderr.trim() || filterResult.signal || filterResult.code}`)
  }
  return {
    stdout,
    scannerPids: [source.pid, filter.pid].filter(Number.isInteger),
  }
}

export async function listLabHomeProcessIds(labHome, dependencies = {}) {
  const pipeline = buildLabProcessScanPipeline(labHome)
  const run = dependencies.runLabProcessScanPipeline ?? runLabProcessScanPipeline
  const result = await run(pipeline)
  const output = typeof result === "string" ? result : result.stdout
  const scannerPids = new Set(typeof result === "string" ? [] : result.scannerPids)
  const pids = output
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((pid) => pid !== process.pid && !scannerPids.has(pid))
  return [...new Set(pids)]
}

async function waitForNoLabHomeProcesses(labHome, timeoutMs, dependencies = {}) {
  const list = dependencies.listLabHomeProcessIds ?? listLabHomeProcessIds
  const deadline = Date.now() + timeoutMs
  let remaining = await list(labHome)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    remaining = await list(labHome)
  }
  return remaining
}

export async function quiesceLabProcesses(rootInput, dependencies = {}) {
  const layout = assertIsolatedLayout(rootInput)
  const list = dependencies.listLabHomeProcessIds ?? listLabHomeProcessIds
  const signal = dependencies.signalProcess ?? process.kill
  const send = (pid, kind) => {
    try { signal(pid, kind) } catch (error) { if (error?.code !== "ESRCH") throw error }
  }
  for (const pid of await list(layout.home)) send(pid, "SIGTERM")
  let remaining = await waitForNoLabHomeProcesses(layout.home, 2_000, dependencies)
  for (const pid of remaining) send(pid, "SIGKILL")
  remaining = await waitForNoLabHomeProcesses(layout.home, 3_000, dependencies)
  if (remaining.length > 0) throw new Error(`Lab-home processes survived cleanup: ${remaining.join(", ")}`)
}

export async function quiesceAndRemoveLabRoot(rootInput, options = {}, dependencies = {}) {
  const root = fs.realpathSync(rootInput)
  await quiesceLabProcesses(root, dependencies)
  if (options.keep) return
  let lastError
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      removeLabRoot(root)
      if (!fs.existsSync(root)) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
  }
  throw lastError ?? new Error(`Disposable lab root still exists after cleanup: ${root}`)
}

export async function runWithLabCleanup(work, cleanup) {
  let value
  let primaryError
  try { value = await work() } catch (error) { primaryError = error }
  let cleanupError
  try { await cleanup() } catch (error) { cleanupError = error }
  if (primaryError) {
    if (cleanupError && primaryError && typeof primaryError === "object") {
      Object.defineProperty(primaryError, "cleanupError", { configurable: true, enumerable: false, value: cleanupError })
    }
    throw primaryError
  }
  if (cleanupError) throw cleanupError
  return value
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "spawn"})\n${detail}`)
  }
  return result.stdout.trim()
}

function parseArgs(argv) {
  const options = { scenario: "stock", keep: false, dryRun: false, docker: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === "--") continue
    if (value === "--scenario") options.scenario = argv[++i]
    else if (value === "--candidate-tarball") options.candidateTarball = path.resolve(argv[++i])
    else if (value === "--baseline-tarball") options.baselineTarball = path.resolve(argv[++i])
    else if (value === "--root") options.root = path.resolve(argv[++i])
    else if (value === "--keep") options.keep = true
    else if (value === "--dry-run") options.dryRun = true
    else if (value === "--docker") options.docker = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!SCENARIOS.has(options.scenario)) throw new Error(`Unknown scenario: ${options.scenario}`)
  if (options.candidateTarball && !fs.statSync(options.candidateTarball).isFile()) throw new Error("Candidate tarball does not exist")
  if (options.baselineTarball && !fs.statSync(options.baselineTarball).isFile()) throw new Error("Baseline tarball does not exist")
  return options
}

function packCandidate(repo, cache, env) {
  const before = new Set(fs.readdirSync(cache))
  run("pnpm", ["pack", "--pack-destination", cache], { cwd: path.join(repo, "packages", "jinn"), env })
  const created = fs.readdirSync(cache).filter((name) => !before.has(name) && name.endsWith(".tgz"))
  if (created.length !== 1) throw new Error(`Candidate pack produced ${created.length} tarballs`)
  return path.join(cache, created[0])
}

function previousReleaseVersion(repo, env) {
  const tag = run("git", ["describe", "--tags", "--abbrev=0", "HEAD^"], { cwd: repo, env })
  const version = tag.replace(/^v/, "")
  if (!STRICT_VERSION.test(version)) throw new Error(`Previous release tag is not a plain version: ${tag}`)
  return version
}

function packPublicBaseline(repo, cache, env) {
  const version = previousReleaseVersion(repo, env)
  run("npm", ["pack", `jinn-cli@${version}`, "--pack-destination", cache], { env })
  const name = fs.readdirSync(cache).find((entry) => entry === `jinn-cli-${version}.tgz`)
  if (!name) throw new Error(`npm did not produce the v${version} baseline tarball`)
  return path.join(cache, name)
}

function installTarball(tarball, prefix, env) {
  fs.mkdirSync(prefix, { recursive: true })
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { env: { ...env, npm_config_prefix: prefix } })
  const cli = path.join(prefix, "lib", "node_modules", "jinn-cli", "dist", "bin", "jinn.js")
  if (!fs.existsSync(cli)) throw new Error(`Installed package has no CLI: ${cli}`)
  const packageRoot = path.join(prefix, "lib", "node_modules", "jinn-cli")
  const rebuild = buildNativeDependencyRebuild(packageRoot)
  run(rebuild.command, rebuild.args, { env: { ...env, npm_config_prefix: prefix, npm_config_ignore_scripts: "false" } })
  return { cli, packageRoot }
}

export function buildNativeDependencyRebuild(packageRoot) {
  return {
    command: "npm",
    args: [
      "rebuild",
      "better-sqlite3",
      "--prefix",
      packageRoot,
      "--ignore-scripts=false",
      "--foreground-scripts",
    ],
  }
}

async function startGateway(cli, port, env, logPath, contactedPorts) {
  assertSafeLabPort(port)
  await assertLabStartPreflight({ labHome: env.JINN_HOME, port })
  contactedPorts.push(port)
  const log = fs.openSync(logPath, "a")
  const child = spawn(process.execPath, [cli, "start", "--port", String(port)], {
    cwd: env.HOME,
    env,
    stdio: ["ignore", log, log],
  })
  let exited = null
  child.once("exit", (code, signal) => { exited = { code, signal } })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (exited) {
      fs.closeSync(log)
      throw new Error(`Lab gateway exited before readiness: ${JSON.stringify(exited)}\n${fs.readFileSync(logPath, "utf8")}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`)
      if (response.ok) {
        const status = await response.json()
        assertLabProcessTarget({ pid: child.pid, port, labHome: env.JINN_HOME })
        return { child, log, status, port, labHome: env.JINN_HOME }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signalVerifiedLabProcess({ pid: child.pid, port, labHome: env.JINN_HOME, signal: "SIGTERM" })
  fs.closeSync(log)
  throw new Error(`Lab gateway did not become ready on deterministic port ${port}\n${fs.readFileSync(logPath, "utf8")}`)
}

async function stopGateway(handle) {
  const waitForExit = (timeoutMs) => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      handle.child.once("exit", () => { clearTimeout(timer); resolve(true) })
    })
  }
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    signalVerifiedLabProcess({ pid: handle.child.pid, port: handle.port, labHome: handle.labHome, signal: "SIGTERM" })
    await waitForExit(5_000)
  }
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    const ownerHome = readProcessJinnHome(handle.child.pid)
    if (!ownerHome || resolvedIdentity(ownerHome) !== resolvedIdentity(handle.labHome)) {
      throw new Error(`Refusing to kill foreign surviving process ${handle.child.pid}: JINN_HOME=${ownerHome ?? "unknown"}`)
    }
    process.kill(handle.child.pid, "SIGKILL")
    if (!await waitForExit(5_000)) throw new Error(`Lab gateway PID ${handle.child.pid} did not exit after SIGKILL`)
  }
  fs.closeSync(handle.log)
}

function gatewayToken(home) {
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf8"))
  if (typeof parsed.token !== "string" || parsed.token.length < 32) throw new Error("Lab gateway token is missing")
  return parsed.token
}

export function buildLabRequestOptions(token, options = {}) {
  return {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  }
}

async function labRequest(port, route, contactedPorts, token, options = {}) {
  assertSafeLabPort(port)
  contactedPorts.push(port)
  const response = await fetch(`http://127.0.0.1:${port}${route}`, buildLabRequestOptions(token, options))
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: response.ok, status: response.status, body }
}

function installStubCodex(layout, delayed) {
  const binDir = path.join(layout.root, "stub-bin")
  const record = path.join(layout.artifacts, "stub-engine-invocations.jsonl")
  fs.mkdirSync(binDir, { recursive: true })
  const file = path.join(binDir, "codex")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), at: new Date().toISOString() }) + "\\n")
const finish = () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "upgrade-lab-thread" }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Upgrade lab stub recorded the migration prompt." } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n")
}
${delayed ? "setTimeout(finish, 60000)" : "finish()"}
`
  fs.writeFileSync(file, source, { mode: 0o755 })
  return { file, record }
}

function configureStubEngine(home, stubPath) {
  const config = path.join(home, "config.yaml")
  let source = fs.readFileSync(config, "utf8")
  source = source.replace(/default:\s*claude/, "default: codex")
  source = source.replace(/(codex:\s*\n\s*bin:)\s*[^\n]+/, `$1 ${JSON.stringify(stubPath)}`)
  fs.writeFileSync(config, source)
}

export async function waitForJsonlRecord(file, predicate, timeoutMs = 10_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const source = fs.readFileSync(file, "utf8")
      const lines = source.split("\n")
      if (!source.endsWith("\n")) lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const record = JSON.parse(line)
        if (predicate(record)) return record
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out waiting for a matching lab JSONL record: ${file}`)
}

export async function loadPlaywrightChromium() {
  const { chromium } = await import("@playwright/test")
  return chromium
}

export function resolvePlaywrightChromiumExecutable(env = process.env) {
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

export function migrationSurfaceLocator(page) {
  const dialogHeading = page.getByRole("dialog").getByRole("heading", { name: /^v.* is installed\./ })
  const reminder = page.getByRole("button", { name: /Finish v.* setup/ })
  return dialogHeading.or(reminder).first()
}

async function captureMigrationScreenshots({ port, token, artifacts, required }) {
  const chromium = await loadPlaywrightChromium()
  const executablePath = resolvePlaywrightChromiumExecutable()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const files = []
  try {
    for (const screenshot of MIGRATION_SCREENSHOT_CASES) {
      const context = await browser.newContext({
        viewport: { width: screenshot.width, height: screenshot.height },
        extraHTTPHeaders: { Authorization: `Bearer ${token}` },
        colorScheme: screenshot.theme,
      })
      const page = await context.newPage()
      await page.addInitScript((theme) => localStorage.setItem("jinn-theme", theme), screenshot.theme)
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" })
      const migrationSurface = migrationSurfaceLocator(page)
      if (required) await migrationSurface.waitFor({ state: "visible", timeout: 15_000 })
      else if (await migrationSurface.count()) throw new Error("No-change scenario rendered a migration reminder")
      const destination = path.join(artifacts, `${screenshot.name}-migration.png`)
      await page.screenshot({ path: destination, fullPage: true })
      files.push(destination)
      await context.close()
    }
  } finally {
    await browser.close()
  }
  return files
}

export function liveSentinelMetadata(homeInput = path.resolve(os.homedir(), ".jinn")) {
  const home = path.resolve(homeInput)
  // The live gateway legitimately writes sessions/registry.db while the lab is
  // running (including for the chat supervising this test). Keep this sentinel
  // limited to stable operator-owned instance files; process ownership is
  // enforced separately before every lab start/restart/signal.
  const names = [".", "config.yaml", "CLAUDE.md", "AGENTS.md", "cron/jobs.json"]
  const values = {}
  for (const name of names) {
    const file = name === "." ? home : path.join(home, name)
    try {
      const stat = fs.lstatSync(file, { bigint: true })
      values[name] = { mode: stat.mode.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ino: stat.ino.toString() }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      values[name] = null
    }
  }
  return { values, digest: sha256(JSON.stringify(values)) }
}

function hashTree(root, excluded = new Set()) {
  const result = {}
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (excluded.has(relative.split("/")[0])) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(absolute)}`
      else result[relative] = sha256(fs.readFileSync(absolute))
    }
  }
  visit(root)
  return result
}

async function loadFixture(name) {
  const fixture = name === "stock" || name === "no-instance-change" ? "stock" : name === "interrupted" ? "customized" : name
  return import(`./fixtures/${fixture}.mjs`)
}

function seedRepresentativeState(home) {
  fs.mkdirSync(path.join(home, "org", "lab"), { recursive: true })
  fs.writeFileSync(path.join(home, "org", "lab", "operator.yaml"), "name: lab-operator\ndisplayName: Lab Operator\ndepartment: lab\nrank: employee\nengine: codex\npersona: Disposable fixture.\n")
  fs.mkdirSync(path.join(home, "docs"), { recursive: true })
  fs.writeFileSync(path.join(home, "docs", "lab-state.md"), "LAB-DOC-STATE-SURVIVES\n")
}

function runStateProbe(mode, packageRoot, layout, env) {
  const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "state-probe.mjs")
  const evidenceRoot = path.join(layout.home, "workflow-evidence")
  const output = run(process.execPath, [probe, mode, packageRoot, evidenceRoot], { env })
  try { return JSON.parse(output) } catch { throw new Error(`State probe returned invalid JSON: ${output}`) }
}

export function mergeBundle(home, materializedBundleDir, manifest, materializationAudit, version) {
  const reviewedFiles = []
  const skippedItems = []
  for (const record of manifest.files) {
    const user = path.join(home, record.path)
    const base = record.basePayload ? path.join(materializedBundleDir, record.basePayload) : null
    const target = record.targetPayload ? path.join(materializedBundleDir, record.targetPayload) : null
    const audited = materializationAudit.files?.find((file) => file.version === version && file.path === record.path)
    if (!audited) throw new Error(`materialization audit is missing ${version}:${record.path}`)
    const userBytes = fs.existsSync(user) && fs.lstatSync(user).isFile() ? fs.readFileSync(user) : null
    const baseBytes = base ? fs.readFileSync(base) : null
    const unchanged = userBytes !== null && baseBytes !== null && userBytes.equals(baseBytes)
    const baseUnresolved = audited.base?.unresolvedPlaceholders ?? []
    const targetUnresolved = audited.target?.unresolvedPlaceholders ?? []
    const introducedUnresolved = targetUnresolved.filter((placeholder) => !baseUnresolved.includes(placeholder))
    const safelyCarriedUnresolved = record.operation === "modify" && unchanged && introducedUnresolved.length === 0
    if (targetUnresolved.length > 0 && !safelyCarriedUnresolved) {
      skippedItems.push({ path: record.path, reason: `unresolved materialized placeholders: ${targetUnresolved.join(", ")}` })
      continue
    }
    if (record.operation === "add" && userBytes === null) {
      fs.mkdirSync(path.dirname(user), { recursive: true }); fs.copyFileSync(target, user); reviewedFiles.push(record.path)
    } else if (record.operation === "modify" && unchanged) {
      fs.mkdirSync(path.dirname(user), { recursive: true }); fs.copyFileSync(target, user); reviewedFiles.push(record.path)
    } else if (record.operation === "modify" && userBytes !== null && base && target) {
      const merged = mergeFileThreeWay({ base, user, target })
      if (merged.ok) {
        fs.writeFileSync(user, merged.contents)
        reviewedFiles.push(record.path)
      } else {
        skippedItems.push({ path: record.path, reason: merged.reason || "user customization preserved after merge conflict" })
      }
    } else if (record.operation === "remove" && unchanged) {
      fs.rmSync(user); reviewedFiles.push(record.path)
    } else if (record.operation === "add" && userBytes !== null) {
      skippedItems.push({ path: record.path, reason: "custom file occupies added stock path" })
    } else {
      skippedItems.push({ path: record.path, reason: "user customization preserved for conservative merge" })
    }
  }
  return { reviewedFiles, skippedItems }
}

export function mergeMigrationChain({
  home,
  snapshotPath,
  migrationsDir,
  manifests,
  materializationAudit,
  verifyStock = false,
}) {
  const reviewedFiles = new Set()
  const skippedItems = new Map()
  const appliedVersions = []
  for (const { version } of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(migrationsDir, version, "manifest.json"), "utf8"))
    const materializedBundleDir = path.join(snapshotPath, "materialized", version)
    const preMergeTree = hashTree(home, new Set([".migration-snapshots", "logs", "tmp"]))
    const bundleReceipt = mergeBundle(home, materializedBundleDir, manifest, materializationAudit, version)
    for (const reviewed of bundleReceipt.reviewedFiles) reviewedFiles.add(reviewed)
    for (const skipped of bundleReceipt.skippedItems) {
      skippedItems.set(`${version}:${skipped.path}:${skipped.reason}`, skipped)
    }
    if (verifyStock) {
      assertStockBundleApplied({ home, materializedBundleDir, manifest, receipt: bundleReceipt, preMergeTree })
    }
    appliedVersions.push(version)
  }
  return {
    appliedVersions,
    receipt: {
      reviewedFiles: [...reviewedFiles],
      skippedItems: [...skippedItems.values()],
    },
  }
}

export function assertStockBundleApplied({ home, materializedBundleDir, manifest, receipt, preMergeTree }) {
  if (receipt.skippedItems.length > 0) throw new Error(`stock migration skipped manifest paths: ${JSON.stringify(receipt.skippedItems)}`)
  const reviewed = new Set(receipt.reviewedFiles)
  for (const record of manifest.files) {
    if (!reviewed.has(record.path)) throw new Error(`stock migration did not review manifest path: ${record.path}`)
    const user = path.join(home, record.path)
    if (record.operation === "remove") {
      if (fs.existsSync(user)) throw new Error(`removed stock path survived: ${record.path}`)
      continue
    }
    if (!fs.existsSync(user)) throw new Error(`stock path is missing after migration: ${record.path}`)
    const actualSha256 = sha256(fs.readFileSync(user))
    const baseSha256 = record.basePayload ? sha256(fs.readFileSync(path.join(materializedBundleDir, record.basePayload))) : null
    const targetSha256 = record.targetPayload ? sha256(fs.readFileSync(path.join(materializedBundleDir, record.targetPayload))) : null
    const wasUnmodifiedStock = record.operation === "add" || preMergeTree[record.path] === baseSha256
    if (wasUnmodifiedStock && actualSha256 !== targetSha256) {
      throw new Error(`stock path did not reach target: ${record.path}`)
    }
    if (!wasUnmodifiedStock && baseSha256 !== targetSha256 && actualSha256 === preMergeTree[record.path]) {
      throw new Error(`personalized stock path did not incorporate target changes: ${record.path}`)
    }
  }
}

async function executeScenario({ scenario, candidateTarball, baselineTarball, root, keep, dryRun }) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
  const layout = assertIsolatedLayout(root)
  const allocation = await allocateLabPort(layout.root)
  let allocationReleased = false
  const env = buildMinimalEnvironment(layout, { PATH: process.env.PATH ?? "" })
  const liveBefore = liveSentinelMetadata()
  const summary = { schemaVersion: 1, scenario, port: allocation.port, contactedPorts: [], candidateSha256: null, baselineSha256: null, checks: {}, screenshots: [], artifacts: layout.artifacts }
  let primaryError
  try {
    if (dryRun) {
      summary.checks = { isolation: "PASS", deterministicSafePort: PROTECTED_GATEWAY_PORTS.has(allocation.port) ? "FAIL" : "PASS", secretsMounted: false, wouldRun: true }
      fs.writeFileSync(path.join(layout.artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify(summary, null, 2))
      return summary
    }
    const cache = path.join(root, "tarballs")
    fs.mkdirSync(cache)
    const candidate = candidateTarball ?? packCandidate(repo, cache, env)
    const exactCandidate = path.join(cache, path.basename(candidate))
    if (candidate !== exactCandidate) fs.copyFileSync(candidate, exactCandidate)
    summary.candidateSha256 = sha256(fs.readFileSync(exactCandidate))
    let oldTarball
    if (baselineTarball) {
      oldTarball = path.join(cache, path.basename(baselineTarball))
      if (path.resolve(baselineTarball) !== path.resolve(oldTarball)) fs.copyFileSync(baselineTarball, oldTarball)
    } else {
      oldTarball = packPublicBaseline(repo, cache, env)
    }
    summary.baselineSha256 = sha256(fs.readFileSync(oldTarball))
    const old = installTarball(oldTarball, path.join(root, "prefix-baseline"), env)
    const candidateInstall = installTarball(exactCandidate, path.join(root, "prefix-candidate"), env)
    const baselineVersion = readInstalledPackageVersion(old.packageRoot)
    const candidateVersion = readInstalledPackageVersion(candidateInstall.packageRoot)
    if (baselineVersion === candidateVersion) throw new Error("Baseline and candidate package versions must differ")
    summary.baselineVersion = baselineVersion
    summary.candidateVersion = candidateVersion
    run(process.execPath, [old.cli, "setup"], { env })
    persistLabGatewayPort(layout.home, allocation.port)
    summary.checks.configuredPortPersisted = "PASS"
    const fixture = await loadFixture(scenario)
    fixture.seed(layout.home)
    seedRepresentativeState(layout.home)
    runStateProbe("seed-old", old.packageRoot, layout, env)
    const stub = installStubCodex(layout, scenario === "interrupted")
    configureStubEngine(layout.home, stub.file)
    const baseline = hashTree(layout.home, new Set([".migration-snapshots", "logs", "tmp"]))

    await allocation.release()
    allocationReleased = true
    const oldGateway = await startGateway(old.cli, allocation.port, env, path.join(layout.logs, `v${baselineVersion}-gateway.log`), summary.contactedPorts)
    summary.checks.baselineGatewayReady = "PASS"
    const oldPid = oldGateway.child.pid
    await stopGateway(oldGateway)
    if (oldGateway.child.exitCode === null && oldGateway.child.signalCode === null) throw new Error(`v${baselineVersion} lab PID survived shutdown`)
    summary.checks.baselineStoppedBeforeCandidate = "PASS"
    const representativeBefore = runStateProbe("query-old", old.packageRoot, layout, env)
    summary.representativeState = { before: representativeBefore }

    if (scenario === "no-instance-change") {
      const config = path.join(layout.home, "config.yaml")
      const raw = fs.readFileSync(config, "utf8")
      const updated = raw.replace(/^(\s*version:\s*)["']?[^"'\s]+["']?\s*$/m, `$1"${candidateVersion}"`)
      if (updated === raw) throw new Error("no-instance-change could not advance the disposable marker")
      fs.writeFileSync(config, updated)
    }

    const expectedPending = candidateNeedsMigrationHandoff({
      scenario,
      packageRoot: candidateInstall.packageRoot,
      version: candidateVersion,
    })
    summary.candidateMigrationBundlePresent = fs.existsSync(
      path.join(candidateInstall.packageRoot, "template", "migrations", candidateVersion, "manifest.json"),
    )
    let candidateGateway = await startGateway(candidateInstall.cli, allocation.port, env, path.join(layout.logs, "candidate-gateway.log"), summary.contactedPorts)
    let openedSessionId = null
    try {
      if (candidateGateway.child.pid === oldPid) throw new Error("candidate unexpectedly reused the old process identity")
      const token = gatewayToken(layout.home)
      const migrationResponse = await labRequest(allocation.port, "/api/instance-migration", summary.contactedPorts, token)
      if (!migrationResponse.ok) throw new Error(`candidate migration API failed: ${migrationResponse.status}`)
      if (Boolean(migrationResponse.body?.required) !== expectedPending) throw new Error(`candidate pending state was ${migrationResponse.body?.required}, expected ${expectedPending}`)
      summary.checks.candidateGatewayReady = "PASS"
      summary.checks.migrationApiReachable = "PASS"
      summary.screenshots = await captureMigrationScreenshots({ port: allocation.port, token, artifacts: layout.artifacts, required: expectedPending })
      summary.checks.playwrightScreenshots = "PASS"

      if (expectedPending) {
        const body = JSON.stringify({ migrationKey: migrationResponse.body.migrationKey })
        const [first, duplicate] = await Promise.all([
          labRequest(allocation.port, "/api/instance-migration/open", summary.contactedPorts, token, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
          labRequest(allocation.port, "/api/instance-migration/open", summary.contactedPorts, token, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
        ])
        if (!first.ok || !duplicate.ok || first.body.sessionId !== duplicate.body.sessionId) throw new Error("gateway did not reuse one concurrent migration handoff")
        openedSessionId = first.body.sessionId
        summary.checks.idempotentGatewayHandoff = "PASS"
        const snapshotDir = path.join(layout.home, ".migration-snapshots", migrationResponse.body.migrationKey)
        if (!fs.existsSync(path.join(snapshotDir, "snapshot.json"))) throw new Error("gateway created a session before its snapshot")
        if (!fs.existsSync(path.join(snapshotDir, "materialization.json"))) throw new Error("gateway created a session before audited payload materialization")
        if (!migrationResponse.body.prompt.includes(path.join(snapshotDir, "materialized"))) throw new Error("canonical prompt did not reference materialized snapshot payloads")
        summary.checks.snapshotBeforeSession = "PASS"
        summary.checks.auditedMaterializedPayloads = "PASS"
        fs.writeFileSync(path.join(layout.artifacts, "migration-prompt.md"), migrationResponse.body.prompt)
        if (scenario !== "interrupted") {
          await waitForJsonlRecord(
            stub.record,
            (call) => call.argv?.some((arg) => typeof arg === "string" && arg.includes(migrationResponse.body.prompt)),
          )
          summary.checks.stubRecordedCanonicalPrompt = "PASS"
        }
      } else {
        if (fs.existsSync(path.join(layout.home, ".migration-snapshots"))) throw new Error("no-handoff candidate created a snapshot")
        if (fs.readFileSync(path.join(layout.logs, "candidate-gateway.log"), "utf8").includes("Jinn update installed")) throw new Error("no-handoff candidate printed a migration banner")
        summary.checks.noPromptBannerSnapshotOrSession = "PASS"
      }
    } finally {
      await stopGateway(candidateGateway)
    }

    if (scenario === "interrupted" && expectedPending) {
      const markerBeforeRetry = fs.readFileSync(path.join(layout.home, "config.yaml"), "utf8")
      candidateGateway = await startGateway(candidateInstall.cli, allocation.port, env, path.join(layout.logs, "candidate-retry-gateway.log"), summary.contactedPorts)
      try {
        const token = gatewayToken(layout.home)
        const pendingRetry = await labRequest(allocation.port, "/api/instance-migration", summary.contactedPorts, token)
        const retry = await labRequest(allocation.port, "/api/instance-migration/open", summary.contactedPorts, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ migrationKey: pendingRetry.body.migrationKey }),
        })
        if (!retry.ok || retry.body.sessionId !== openedSessionId || retry.body.reused !== true) throw new Error("interrupted retry did not reuse the durable migration session")
      } finally {
        await stopGateway(candidateGateway)
      }
      const markerAfterRetry = fs.readFileSync(path.join(layout.home, "config.yaml"), "utf8")
      if (markerBeforeRetry !== markerAfterRetry) throw new Error("interrupted handoff advanced the version marker")
      summary.checks.interruptionPreservedMarker = "PASS"
      summary.checks.retryReusedSession = "PASS"
    } else if (scenario === "interrupted") {
      summary.checks.noMigrationHandoffRequired = "PASS"
    }

    const service = await import(pathToFileURL(path.join(candidateInstall.packageRoot, "dist", "src", "migrations", "service.js")))
    const snapshot = await import(pathToFileURL(path.join(candidateInstall.packageRoot, "dist", "src", "migrations", "snapshot.js")))
    const completion = await import(pathToFileURL(path.join(candidateInstall.packageRoot, "dist", "src", "migrations", "completion.js")))
    const migrationsDir = path.join(candidateInstall.packageRoot, "template", "migrations")
    let pending = service.getPendingInstanceMigration({ instanceHome: layout.home, packageVersion: candidateVersion, migrationsDir })
    if (!expectedPending) {
      if (pending.required) throw new Error("no-handoff candidate unexpectedly produced a migration")
      summary.checks.noPromptOrSnapshot = "PASS"
    } else if (scenario === "interrupted") {
      if (!pending.required) throw new Error("interrupted flow suppressed the pending migration")
    } else {
      const snap = snapshot.createMigrationSnapshot({ instanceHome: layout.home, migrationKey: pending.migrationKey, fromVersion: pending.fromVersion, toVersion: pending.toVersion, changedFiles: pending.changedFiles, materialization: pending.materialization })
      if (!snap.reused) throw new Error("direct migration phase did not reuse the gateway-created snapshot")
      const materializationAudit = JSON.parse(fs.readFileSync(path.join(snap.path, "materialization.json"), "utf8"))
      const chain = mergeMigrationChain({
        home: layout.home,
        snapshotPath: snap.path,
        migrationsDir,
        manifests: pending.materialization.manifests,
        materializationAudit,
        verifyStock: scenario === "stock",
      })
      const { receipt } = chain
      summary.structuredBundlesApplied = chain.appliedVersions
      if (scenario === "customized") {
        summary.checks.customizedConservativeMerge = receipt.skippedItems.length > 0
          ? "PASS_WITH_REVIEWED_SKIPS"
          : "PASS"
      }
      if (scenario === "heavily-customized") {
        let refused = false
        try { completion.completeInstanceMigration({ instanceHome: layout.home, installedPackageVersion: candidateVersion, targetVersion: candidateVersion, expectedMigrationKey: pending.migrationKey, pending }) } catch { refused = true }
        if (!refused) throw new Error("completion advanced without a receipt")
        if (receipt.skippedItems.length === 0) throw new Error("heavily-customized fixture did not report conservative skips")
        summary.checks.reminderUntilReceipt = "PASS"
      }
      fs.writeFileSync(path.join(snap.path, "completion-receipt.json"), `${JSON.stringify({ schemaVersion: 1, migrationKey: pending.migrationKey, reviewedFiles: receipt.reviewedFiles, skippedItems: receipt.skippedItems, verifiedAt: new Date().toISOString() }, null, 2)}\n`)
      completion.completeInstanceMigration({ instanceHome: layout.home, installedPackageVersion: candidateVersion, targetVersion: candidateVersion, expectedMigrationKey: pending.migrationKey, pending })
      pending = service.getPendingInstanceMigration({ instanceHome: layout.home, packageVersion: candidateVersion, migrationsDir })
      if (pending.required) throw new Error("completion left the migration pending")
      summary.checks.markerAdvanced = "PASS"

      if (scenario === "stock") {
        summary.checks.allStockTargetsApplied = "PASS"
      }
    }
    const finalTree = hashTree(layout.home, new Set([".migration-snapshots", "logs", "tmp"]))
    for (const key of ["org/lab/operator.yaml", "docs/lab-state.md"]) if (baseline[key] !== finalTree[key]) throw new Error(`state did not survive package swap: ${key}`)
    const representativeAfter = runStateProbe("query-candidate", candidateInstall.packageRoot, layout, env)
    assertRepresentativeStateSurvived(representativeBefore, representativeAfter)
    summary.representativeState.after = representativeAfter
    summary.checks.registryBackedStateSurvived = "PASS"
    if (["customized", "heavily-customized", "interrupted"].includes(scenario)) {
      const contents = Object.keys(finalTree).filter((key) => /CLAUDE\.md|local-helper\/SKILL\.md|local-runbook|local-operator/.test(key)).map((key) => fs.lstatSync(path.join(layout.home, key)).isFile() ? fs.readFileSync(path.join(layout.home, key), "utf8") : "").join("\n")
      if (!contents.includes("CUSTOM-CLAUDE-SURVIVES") || !contents.includes("CUSTOM-SKILL-SURVIVES")) throw new Error("custom sentinels did not survive")
      summary.checks.customSentinelsSurvived = "PASS"
    }
    if (scenario === "customized") {
      for (const required of ["docs/company-doctrine.md", "skills/delegation/SKILL.md", "skills/todo-handling/SKILL.md", "skills/workflow/SKILL.md"]) {
        if (!fs.existsSync(path.join(layout.home, required))) throw new Error(`target instance surface is missing: ${required}`)
      }
      if (!fs.readFileSync(path.join(layout.home, "config.yaml"), "utf8").includes("CUSTOM-CONFIG-SURVIVES")) throw new Error("custom config sentinel did not survive")
      summary.checks.targetDoctrineAndSkillsPresent = "PASS"
    }
    summary.checks.stateSurvived = "PASS"
    summary.checks.protectedPortsNeverContacted = summary.contactedPorts.some((port) => PROTECTED_GATEWAY_PORTS.has(port)) ? "FAIL" : "PASS"
    const livePath = path.resolve(os.homedir(), ".jinn")
    const liveResolved = fs.existsSync(livePath) ? fs.realpathSync(livePath) : livePath
    summary.checks.liveInstanceUnaddressable = inside(liveResolved, layout.home) ? "FAIL" : "PASS"
    const liveAfter = liveSentinelMetadata()
    if (liveBefore.digest !== liveAfter.digest) throw new Error("live instance sentinel metadata changed during the lab")
    summary.liveSentinels = { before: liveBefore.digest, after: liveAfter.digest, unchanged: true }
    summary.checks.liveInstanceSentinelsUnchanged = "PASS"
    const candidateManifest = path.join(candidateInstall.packageRoot, "template", "migrations", candidateVersion, "manifest.json")
    if (fs.existsSync(candidateManifest)) fs.copyFileSync(candidateManifest, path.join(layout.artifacts, "manifest.json"))
    fs.writeFileSync(path.join(layout.artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary, null, 2))
    return summary
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError
    try { if (!allocationReleased) await allocation.release() } catch (error) { cleanupError = error }
    try { await quiesceAndRemoveLabRoot(root, { keep }) } catch (error) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error], "Upgrade lab cleanup failed") : error
    }
    if (cleanupError) {
      if (primaryError && typeof primaryError === "object") {
        Object.defineProperty(primaryError, "cleanupError", { configurable: true, enumerable: false, value: cleanupError })
      } else {
        throw cleanupError
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.docker) {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
    const root = createLabRoot(options.root)
    const layout = assertIsolatedLayout(root)
    const env = buildMinimalEnvironment(layout, { PATH: process.env.PATH ?? "" })
    await runWithLabCleanup(async () => {
      const cache = path.join(root, "docker-tarballs")
      fs.mkdirSync(cache)
      const candidateTarball = options.candidateTarball ?? packCandidate(repo, cache, env)
      let baselineTarball = options.baselineTarball
      if (!baselineTarball) {
        baselineTarball = packPublicBaseline(repo, cache, env)
      }
      await executeDockerLab({ ...options, repo, root, candidateTarball, baselineTarball })
    }, () => quiesceAndRemoveLabRoot(root, { keep: options.keep }))
    return
  }
  const root = createLabRoot(options.root)
  await executeScenario({ ...options, root })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1 })
}
