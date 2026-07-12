#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { assertCandidateBaseUrl, matrixCells } from "./metrics.mjs"

export const DEFAULT_LIMITS = Object.freeze({
  maxScreenshots: 64,
  maxScreenshotBytes: 16 * 1024 * 1024,
  maxFiles: 2_048,
  maxTotalBytes: 128 * 1024 * 1024,
})

function asBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(Math.floor(value))
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function assertDiskPreflight({ availableBytes, availableInodes, minimumBytes, minimumInodes }) {
  if (asBigInt(availableBytes) < asBigInt(minimumBytes)) {
    throw new Error(`ENOSPC preflight: available bytes ${availableBytes} are below required bytes ${minimumBytes}`)
  }
  if (asBigInt(availableInodes) < asBigInt(minimumInodes)) {
    throw new Error(`ENOSPC preflight: available inodes ${availableInodes} are below required inodes ${minimumInodes}`)
  }
}

export function preflightPath(target, { minimumBytes, minimumInodes }) {
  const stats = fs.statfsSync(target, { bigint: true })
  const availableBytes = stats.bavail * stats.bsize
  const availableInodes = stats.ffree
  assertDiskPreflight({ availableBytes, availableInodes, minimumBytes, minimumInodes })
  return { availableBytes: String(availableBytes), availableInodes: String(availableInodes) }
}

export function assertSandboxTarget({ root, home, baseUrl }) {
  const origin = assertCandidateBaseUrl(baseUrl)
  if (path.basename(path.resolve(home)) !== ".jinn-workflow-layout-verification" || !inside(root, home)) {
    throw new Error("refusing non-sandbox target: verification home must remain inside the current verification root")
  }
  return { root: path.resolve(root), home: path.resolve(home), baseUrl: origin }
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return []
  const files = []
  const pending = [path.resolve(root)]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile()) files.push({ path: target, relative: path.relative(root, target), bytes: fs.statSync(target).size })
    }
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative))
}

export function shouldCaptureScreenshot(relative) {
  const normalized = relative.split(path.sep).join("/")
  if ([
    "gestures/02-dragged-connected.png",
    "gestures/04-reloaded.png",
    "approval/unauthorized-waiting.png",
    "approval/authorized-completed.png",
  ].includes(normalized)) return true
  const cell = normalized.match(/^(dark|light)\/(normal|reduced)\/(desktop|mobile)\/(.+)$/)
  if (!cell) return false
  const [, theme, motion, , name] = cell
  if (/^verify-(?:linear|branch|merge|approval|error|loop)-initial\.png$/.test(name)) return true
  if (theme !== "dark" || motion !== "normal") return false
  return /^verify-run-(?:success-completed|failure-failed|approval-parked)\.png$/.test(name)
    || /^verify-manual-(?:before|reloaded|invalid-overlap)\.png$/.test(name)
}

export function finalizeArtifactBundle(root, limits = DEFAULT_LIMITS) {
  const resolved = path.resolve(root)
  const configured = { ...DEFAULT_LIMITS, ...limits }
  const screenshots = filesBelow(resolved).filter((file) => file.relative.split(path.sep).includes("screenshots") && file.relative.endsWith(".png"))
  let keptScreenshots = 0
  let keptScreenshotBytes = 0
  for (const screenshot of screenshots) {
    if (keptScreenshots < configured.maxScreenshots && keptScreenshotBytes + screenshot.bytes <= configured.maxScreenshotBytes) {
      keptScreenshots += 1
      keptScreenshotBytes += screenshot.bytes
    } else {
      fs.rmSync(screenshot.path, { force: true })
    }
  }
  const retained = filesBelow(resolved)
  const totalBytes = retained.reduce((sum, file) => sum + file.bytes, 0)
  const metricCount = retained.filter((file) => file.relative.split(path.sep)[0] === "metrics").length
  if (retained.length > configured.maxFiles || totalBytes > configured.maxTotalBytes) {
    throw new Error(`incomplete: artifact bundle exceeds retained limits (${retained.length}/${configured.maxFiles} files, ${totalBytes}/${configured.maxTotalBytes} bytes)`)
  }
  return {
    files: retained.length,
    totalBytes,
    metrics: metricCount,
    screenshots: keptScreenshots,
    screenshotBytes: keptScreenshotBytes,
  }
}

export function cleanupRunPaths(root, targets) {
  const resolvedRoot = path.resolve(root)
  for (const target of targets) {
    if (!inside(resolvedRoot, target)) throw new Error(`refusing cleanup outside the current run: ${target}`)
  }
  for (const target of targets) fs.rmSync(path.resolve(target), { recursive: true, force: true })
}

export function sanitizeArtifactValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeArtifactValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
    const sensitive = normalized.split(/[^a-z0-9]+/).some((part) => ["token", "authorization", "capability", "secret", "auth"].includes(part))
    return [key, sensitive ? "[REDACTED]" : sanitizeArtifactValue(nested)]
  }))
}

export function removeAuthorCodexHome(home, sessionId) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId) || sessionId.includes("..")) {
    throw new Error("invalid author session id for Codex-home cleanup")
  }
  const base = path.join(path.resolve(home), "tmp", "codex-homes")
  const target = path.join(base, sessionId)
  if (!inside(base, target)) throw new Error("author session id escaped Codex-home root")
  fs.rmSync(target, { recursive: true, force: true })
}

export function expectedCompletionPlan(withAuthors) {
  const perCell = withAuthors ? 18 : 13
  return {
    global: 7,
    cells: Object.fromEntries(matrixCells().map((cell) => [`${cell.theme}/${cell.motion}/${cell.viewport.key}`, perCell])),
  }
}

export function expectedBrowserChecks(withAuthors) {
  const plan = expectedCompletionPlan(withAuthors)
  return plan.global + Object.values(plan.cells).reduce((sum, count) => sum + count, 0)
}

function incompleteFailure(result) {
  return result.status === "timedOut"
    || result.status === "interrupted"
    || result.status === "skipped"
    || /ENOSPC|timed?\s*out|timeout|blank(?: page)?|listener leak|missing/i.test(result.error ?? "")
}

export function completionStatus({ expected, discovered, results }) {
  const reasons = []
  if (discovered !== expected) reasons.push(`missing checks: discovered ${discovered} of ${expected}`)
  if (results.length !== discovered) reasons.push(`missing results: completed ${results.length} of ${discovered}`)
  const incomplete = results.filter(incompleteFailure)
  if (incomplete.length) reasons.push(...incomplete.map((result) => `${result.title}: ${result.error || result.status}`))
  const failed = results.filter((result) => result.status !== "passed")
  return {
    status: reasons.length ? "incomplete" : failed.length ? "failed" : "complete",
    expected,
    discovered,
    completed: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: failed.length,
    reasons,
  }
}

export function assertCompleteArtifact(root, expected) {
  const target = path.join(path.resolve(root), "completion.json")
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error("incomplete: missing or blank completion.json")
  let summary
  try { summary = JSON.parse(fs.readFileSync(target, "utf8")) } catch { throw new Error("incomplete: unreadable completion.json") }
  if (summary.status !== "complete" || summary.expected !== expected || summary.completed !== expected) {
    throw new Error(`incomplete: browser accounting did not complete ${expected} checks`)
  }
  return summary
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2)
  if (command === "preflight") {
    const [target, minimumBytes, minimumInodes] = args
    console.log(JSON.stringify(preflightPath(target, { minimumBytes: BigInt(minimumBytes), minimumInodes: BigInt(minimumInodes) })))
    return
  }
  if (command === "assert-target") {
    console.log(JSON.stringify(assertSandboxTarget({ root: args[0], home: args[1], baseUrl: args[2] })))
    return
  }
  if (command === "cleanup-run") {
    cleanupRunPaths(args[0], args.slice(1))
    return
  }
  if (command === "finalize") {
    console.log(JSON.stringify(finalizeArtifactBundle(args[0])))
    return
  }
  if (command === "require-complete") {
    console.log(JSON.stringify(assertCompleteArtifact(args[0], Number(args[1]))))
    return
  }
  throw new Error("usage: harness-policy.mjs preflight|assert-target|cleanup-run|finalize|require-complete ...")
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => { console.error(error.message); process.exitCode = 2 })
}
