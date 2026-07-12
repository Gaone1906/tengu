#!/usr/bin/env node
import { artifactWriter, gatewayToken, pollUntil, sandboxClient, verificationEnv } from "./api-client.mjs"
import { authorRequests } from "./fixtures.mjs"
import { removeAuthorCodexHome, sanitizeArtifactValue } from "./harness-policy.mjs"

if (process.env.JINN_VERIFY_RUN_AUTHORS !== "1") {
  throw new Error("authoring is opt-in; set JINN_VERIFY_RUN_AUTHORS=1 only after implementation is green")
}
const env = verificationEnv()
const write = artifactWriter(env.artifacts)
const request = sandboxClient({ baseUrl: env.baseUrl, token: gatewayToken(env.home) })

function assertNoForeignGatewayContext(value, label) {
  const text = JSON.stringify(value)
  const urls = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[^\s"']*)?/gi) ?? []
  for (const raw of urls) {
    let url
    try { url = new URL(raw.replace(/[),.;]+$/, "")) } catch { throw new Error(`${label} contains an unreadable loopback URL`) }
    if (url.origin !== env.baseUrl) throw new Error(`${label} contains foreign gateway origin ${url.origin}`)
  }
}

const created = []
for (const author of authorRequests()) {
  const body = {
    ...author.body,
    prompt: `${author.body.prompt} The only allowed MCP gateway is ${env.baseUrl}; the disposable JINN_HOME is ${env.home}.`,
  }
  write(`authoring/requests/${author.expectedWorkflowId}.json`, body)
  const result = await request("POST", "/api/sessions", body)
  write(`authoring/sessions/${author.expectedWorkflowId}-created.json`, result)
  if (!result.ok || typeof result.body?.id !== "string") throw new Error(`author session failed to start: ${author.expectedWorkflowId}`)
  assertNoForeignGatewayContext(result.body, `created session ${author.expectedWorkflowId}`)
  const createdAuthor = { ...author, body, sessionId: result.body.id }
  created.push(createdAuthor)
  const final = await pollUntil(
    async () => request("GET", `/api/sessions/${encodeURIComponent(createdAuthor.sessionId)}?last=20`),
    (result) => result.ok && ["idle", "error"].includes(result.body?.status),
    { label: `author ${createdAuthor.expectedWorkflowId}` },
  )
  write(`authoring/sessions/${createdAuthor.expectedWorkflowId}-final.json`, sanitizeArtifactValue(final))
  assertNoForeignGatewayContext(final.body, `final session ${createdAuthor.expectedWorkflowId}`)
  if (final.body.status !== "idle" || final.body.engine !== "codex" || final.body.model !== "gpt-5.5" || final.body.effortLevel !== "low") {
    throw new Error(`author ${createdAuthor.expectedWorkflowId} did not settle with the pinned model contract`)
  }
  const definition = await request("GET", `/api/workflow-definitions/${encodeURIComponent(createdAuthor.expectedWorkflowId)}`)
  write(`authoring/definitions/${createdAuthor.expectedWorkflowId}.json`, sanitizeArtifactValue(definition))
  if (!definition.ok || definition.body?.id !== createdAuthor.expectedWorkflowId) throw new Error(`author did not create ${createdAuthor.expectedWorkflowId}`)
  removeAuthorCodexHome(env.home, createdAuthor.sessionId)
}

write("authoring/session-ids.json", created.map(({ expectedWorkflowId, sessionId }) => ({ expectedWorkflowId, sessionId })))
