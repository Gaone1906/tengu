import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const policy = await import("./harness-policy.mjs").catch(() => null)

function withTempDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-layout-policy-"))
  try { return fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test("disk preflight requires both byte and inode headroom", () => {
  assert.ok(policy, "harness policy module must exist")
  assert.doesNotThrow(() => policy.assertDiskPreflight({ availableBytes: 200, availableInodes: 20, minimumBytes: 100, minimumInodes: 10 }))
  assert.throws(() => policy.assertDiskPreflight({ availableBytes: 99, availableInodes: 20, minimumBytes: 100, minimumInodes: 10 }), /ENOSPC.*bytes/i)
  assert.throws(() => policy.assertDiskPreflight({ availableBytes: 200, availableInodes: 9, minimumBytes: 100, minimumInodes: 10 }), /ENOSPC.*inodes/i)
})

test("sandbox target rejects port 7777 and homes outside the current verification root", () => withTempDir((root) => {
  assert.ok(policy, "harness policy module must exist")
  const home = path.join(root, "host", ".jinn-workflow-layout-verification")
  assert.doesNotThrow(() => policy.assertSandboxTarget({ root, home, baseUrl: "http://127.0.0.1:8060" }))
  assert.throws(() => policy.assertSandboxTarget({ root, home, baseUrl: "http://127.0.0.1:7777" }), /8060|candidate|port/i)
  assert.throws(() => policy.assertSandboxTarget({ root, home: path.join(os.tmpdir(), ".jinn-workflow-layout-verification"), baseUrl: "http://127.0.0.1:8060" }), /sandbox|verification root/i)
}))

test("retention keeps every metric while bounding screenshots, files, and total bytes", () => withTempDir((root) => {
  assert.ok(policy, "harness policy module must exist")
  for (let i = 0; i < 5; i += 1) {
    const metric = path.join(root, "metrics", `${i}.json`)
    fs.mkdirSync(path.dirname(metric), { recursive: true })
    fs.writeFileSync(metric, JSON.stringify({ index: i }))
  }
  for (let i = 0; i < 5; i += 1) {
    const screenshot = path.join(root, "screenshots", `${i}.png`)
    fs.mkdirSync(path.dirname(screenshot), { recursive: true })
    fs.writeFileSync(screenshot, Buffer.alloc(6, i))
  }
  const result = policy.finalizeArtifactBundle(root, {
    maxScreenshots: 2,
    maxScreenshotBytes: 10,
    maxFiles: 20,
    maxTotalBytes: 1_024,
  })
  assert.equal(result.metrics, 5)
  assert.ok(result.screenshots <= 2)
  assert.ok(result.screenshotBytes <= 10)
  assert.ok(result.files <= 20)
  assert.ok(result.totalBytes <= 1_024)
  assert.equal(fs.readdirSync(path.join(root, "metrics")).length, 5)
}))

test("retention never deletes metrics to force an oversized bundle under budget", () => withTempDir((root) => {
  assert.ok(policy, "harness policy module must exist")
  const metric = path.join(root, "metrics", "oversized.json")
  fs.mkdirSync(path.dirname(metric), { recursive: true })
  fs.writeFileSync(metric, "x".repeat(64))
  assert.throws(() => policy.finalizeArtifactBundle(root, {
    maxScreenshots: 64,
    maxScreenshotBytes: 16 * 1024 * 1024,
    maxFiles: 20,
    maxTotalBytes: 32,
  }), /incomplete.*artifact bundle/i)
  assert.equal(fs.existsSync(metric), true)
}))

test("cleanup removes only enumerated current-run caches beneath its root", () => withTempDir((root) => {
  assert.ok(policy, "harness policy module must exist")
  const cache = path.join(root, "host", "sandbox", "cache")
  const codex = path.join(root, "host", ".codex")
  const siblingScratch = path.join(path.dirname(root), `${path.basename(root)}-pre-existing`)
  fs.mkdirSync(cache, { recursive: true })
  fs.mkdirSync(codex, { recursive: true })
  fs.mkdirSync(siblingScratch, { recursive: true })
  try {
    policy.cleanupRunPaths(root, [cache, codex])
    assert.equal(fs.existsSync(cache), false)
    assert.equal(fs.existsSync(codex), false)
    assert.equal(fs.existsSync(siblingScratch), true)
    assert.throws(() => policy.cleanupRunPaths(root, [siblingScratch]), /outside.*current run/i)
  } finally {
    fs.rmSync(siblingScratch, { recursive: true, force: true })
  }
}))

test("author artifacts are sanitized before the exact session overlay is removed", () => withTempDir((root) => {
  assert.ok(policy, "harness policy module must exist")
  const sessionId = "session-author-1"
  const overlay = path.join(root, "tmp", "codex-homes", sessionId)
  fs.mkdirSync(overlay, { recursive: true })
  fs.writeFileSync(path.join(overlay, "auth.json"), "secret")
  assert.deepEqual(policy.sanitizeArtifactValue({ token: "secret", nested: { authorization: "Bearer x", id: sessionId } }), {
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]", id: sessionId },
  })
  policy.removeAuthorCodexHome(root, sessionId)
  assert.equal(fs.existsSync(overlay), false)
  assert.throws(() => policy.removeAuthorCodexHome(root, "../escape"), /session id/i)
}))

test("completion accounts for every deterministic and authored matrix cell", () => {
  assert.ok(policy, "harness policy module must exist")
  assert.equal(policy.expectedBrowserChecks(false), 111)
  assert.equal(policy.expectedBrowserChecks(true), 151)
  const deterministic = policy.expectedCompletionPlan(false)
  const authored = policy.expectedCompletionPlan(true)
  assert.equal(deterministic.global, 7)
  assert.equal(authored.global, 7)
  assert.ok(Object.values(deterministic.cells).every((count) => count === 13))
  assert.ok(Object.values(authored.cells).every((count) => count === 18))
  assert.equal(Object.values(deterministic.cells).reduce((sum, count) => sum + count, deterministic.global), 111)
  assert.equal(Object.values(authored.cells).reduce((sum, count) => sum + count, authored.global), 151)
})

test("missing, timed out, blank, listener-leak, and ENOSPC results are hard incomplete", () => {
  assert.ok(policy, "harness policy module must exist")
  for (const sample of [
    { expected: 2, discovered: 1, results: [] },
    { expected: 1, discovered: 1, results: [{ title: "cell", status: "timedOut", error: "timeout" }] },
    { expected: 1, discovered: 1, results: [{ title: "cell", status: "failed", error: "blank page" }] },
    { expected: 1, discovered: 1, results: [{ title: "cell", status: "failed", error: "listener leak" }] },
    { expected: 1, discovered: 1, results: [{ title: "cell", status: "failed", error: "ENOSPC" }] },
  ]) assert.equal(policy.completionStatus(sample).status, "incomplete")
})

test("screenshot curation retains the exact 64-path deterministic evidence set", () => {
  assert.ok(policy, "harness policy module must exist")
  assert.equal(policy.DEFAULT_LIMITS.maxScreenshots, 64)
  assert.equal(policy.DEFAULT_LIMITS.maxScreenshotBytes, 16 * 1024 * 1024)
  assert.equal(policy.DEFAULT_LIMITS.maxTotalBytes, 128 * 1024 * 1024)

  const cells = ["dark", "light"].flatMap((theme) => ["normal", "reduced"].flatMap((motion) => ["desktop", "mobile"].map((viewport) => `${theme}/${motion}/${viewport}`)))
  const canonical = ["linear", "branch", "merge", "approval", "error", "loop"]
  const expected = new Set(cells.flatMap((cell) => canonical.map((shape) => `${cell}/verify-${shape}-initial.png`)))
  for (const viewport of ["desktop", "mobile"]) {
    const cell = `dark/normal/${viewport}`
    for (const name of ["verify-run-success-completed.png", "verify-run-failure-failed.png", "verify-run-approval-parked.png"]) expected.add(`${cell}/${name}`)
    for (const name of ["verify-manual-before.png", "verify-manual-reloaded.png", "verify-manual-invalid-overlap.png"]) expected.add(`${cell}/${name}`)
  }
  for (const evidence of [
    "gestures/02-dragged-connected.png",
    "gestures/04-reloaded.png",
    "approval/unauthorized-waiting.png",
    "approval/authorized-completed.png",
  ]) expected.add(evidence)

  assert.equal(expected.size, 64)
  for (const screenshot of expected) assert.equal(policy.shouldCaptureScreenshot(screenshot), true, screenshot)
  for (const excluded of [
    "dark/normal/desktop/verify-new-initial.png",
    "dark/normal/desktop/verify-authored-linear-initial.png",
    "light/reduced/mobile/verify-linear-tidy-preview.png",
    "dark/normal/desktop/verify-manual-preview.png",
    "light/normal/desktop/verify-run-success-completed.png",
    "gestures/01-added.png",
    "gestures/03-removed-reconnected.png",
  ]) assert.equal(policy.shouldCaptureScreenshot(excluded), false, excluded)
})
