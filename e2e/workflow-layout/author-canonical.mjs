#!/usr/bin/env node
import { artifactWriter, gatewayToken, pollUntil, sandboxClient, verificationEnv } from "./api-client.mjs"
import { authorRequests } from "./fixtures.mjs"

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

const created = await Promise.all(authorRequests().map(async (author) => {
  const body = {
    ...author.body,
    prompt: `${author.body.prompt} The only allowed MCP gateway is ${env.baseUrl}; the disposable JINN_HOME is ${env.home}.`,
  }
  write(`authoring/requests/${author.expectedWorkflowId}.json`, body)
  const result = await request("POST", "/api/sessions", body)
  write(`authoring/sessions/${author.expectedWorkflowId}-created.json`, result)
  if (!result.ok || typeof result.body?.id !== "string") throw new Error(`author session failed to start: ${author.expectedWorkflowId}`)
  assertNoForeignGatewayContext(result.body, `created session ${author.expectedWorkflowId}`)
  return { ...author, body, sessionId: result.body.id }
}))

for (const author of created) {
  const final = await pollUntil(
    async () => request("GET", `/api/sessions/${encodeURIComponent(author.sessionId)}?last=20`),
    (result) => result.ok && ["idle", "error"].includes(result.body?.status),
    { label: `author ${author.expectedWorkflowId}` },
  )
  write(`authoring/sessions/${author.expectedWorkflowId}-final.json`, final)
  assertNoForeignGatewayContext(final.body, `final session ${author.expectedWorkflowId}`)
  if (final.body.status !== "idle" || final.body.engine !== "codex" || final.body.model !== "gpt-5.5" || final.body.effortLevel !== "low") {
    throw new Error(`author ${author.expectedWorkflowId} did not settle with the pinned model contract`)
  }
  const definition = await request("GET", `/api/workflow-definitions/${encodeURIComponent(author.expectedWorkflowId)}`)
  write(`authoring/definitions/${author.expectedWorkflowId}.json`, definition)
  if (!definition.ok || definition.body?.id !== author.expectedWorkflowId) throw new Error(`author did not create ${author.expectedWorkflowId}`)
}

write("authoring/session-ids.json", created.map(({ expectedWorkflowId, sessionId }) => ({ expectedWorkflowId, sessionId })))
