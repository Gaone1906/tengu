import fs from "node:fs"
import path from "node:path"
import { assertCandidateBaseUrl } from "./metrics.mjs"

export function verificationEnv() {
  const home = process.env.JINN_VERIFY_HOME
  const artifacts = process.env.JINN_VERIFY_ARTIFACTS
  if (!home || !artifacts) throw new Error("JINN_VERIFY_HOME and JINN_VERIFY_ARTIFACTS are required")
  const baseUrl = assertCandidateBaseUrl(process.env.JINN_VERIFY_BASE_URL ?? "")
  const resolvedHome = path.resolve(home)
  const resolvedArtifacts = path.resolve(artifacts)
  if (path.basename(resolvedHome) !== ".jinn-workflow-layout-verification") {
    throw new Error("JINN_VERIFY_HOME must be the dedicated workflow-layout verification home")
  }
  if (!resolvedArtifacts.startsWith(`${resolvedHome}${path.sep}`)) {
    throw new Error("JINN_VERIFY_ARTIFACTS must remain inside JINN_VERIFY_HOME")
  }
  return { home: resolvedHome, artifacts: resolvedArtifacts, baseUrl }
}

export function gatewayToken(home) {
  const info = JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf8"))
  if (typeof info.token !== "string" || !info.token) throw new Error("sandbox gateway token is missing")
  return info.token
}

export function artifactWriter(root) {
  return (relative, value) => {
    const target = path.resolve(root, relative)
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("artifact path escaped root")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
    return target
  }
}

export function sandboxClient({ baseUrl, token }) {
  const origin = assertCandidateBaseUrl(baseUrl)
  return async (method, route, body) => {
    const url = new URL(route, `${origin}/`)
    if (url.origin !== origin) throw new Error(`refusing non-candidate request origin: ${url.origin}`)
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { ok: response.ok, status: response.status, body: parsed }
  }
}

export async function pollUntil(read, predicate, { timeoutMs = 480_000, intervalMs = 1_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 800)}`)
}
