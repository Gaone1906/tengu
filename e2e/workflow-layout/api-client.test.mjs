import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { artifactWriter, gatewayToken, sandboxClient, verificationEnv } from "./api-client.mjs"

test("sandbox client rejects every origin other than its exact candidate", async () => {
  const request = sandboxClient({ baseUrl: "http://127.0.0.1:8060", token: "throwaway" })
  await assert.rejects(
    request("GET", "http://127.0.0.1:8061/api/status"),
    /refusing non-candidate request origin/i,
  )
  await assert.rejects(
    request("GET", "http://localhost:8060/api/status"),
    /refusing non-candidate request origin/i,
  )
})

test("artifact writer and token reader stay inside a throwaway home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-layout-unit-"))
  try {
    fs.writeFileSync(path.join(root, "gateway.json"), JSON.stringify({ token: "sandbox-token" }))
    assert.equal(gatewayToken(root), "sandbox-token")
    const write = artifactWriter(path.join(root, "artifacts"))
    const target = write("metrics/result.json", { ok: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true })
    assert.throws(() => write("../escape.json", {}), /escaped root/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("verification environment refuses a production-shaped home or external artifacts", () => {
  const previous = {
    home: process.env.JINN_VERIFY_HOME,
    artifacts: process.env.JINN_VERIFY_ARTIFACTS,
    base: process.env.JINN_VERIFY_BASE_URL,
  }
  try {
    process.env.JINN_VERIFY_BASE_URL = "http://127.0.0.1:8060"
    process.env.JINN_VERIFY_HOME = "/tmp/.jinn"
    process.env.JINN_VERIFY_ARTIFACTS = "/tmp/.jinn/artifacts"
    assert.throws(() => verificationEnv(), /dedicated workflow-layout verification home/i)
    process.env.JINN_VERIFY_HOME = "/tmp/.jinn-workflow-layout-verification"
    process.env.JINN_VERIFY_ARTIFACTS = "/tmp/outside"
    assert.throws(() => verificationEnv(), /must remain inside/i)
  } finally {
    if (previous.home === undefined) delete process.env.JINN_VERIFY_HOME
    else process.env.JINN_VERIFY_HOME = previous.home
    if (previous.artifacts === undefined) delete process.env.JINN_VERIFY_ARTIFACTS
    else process.env.JINN_VERIFY_ARTIFACTS = previous.artifacts
    if (previous.base === undefined) delete process.env.JINN_VERIFY_BASE_URL
    else process.env.JINN_VERIFY_BASE_URL = previous.base
  }
})
