#!/usr/bin/env node
import { artifactWriter, gatewayToken, sandboxClient, verificationEnv } from "./api-client.mjs"
import { canonicalFixtures, scenarioFixtures } from "./fixtures.mjs"

const env = verificationEnv()
const write = artifactWriter(env.artifacts)
const request = sandboxClient({ baseUrl: env.baseUrl, token: gatewayToken(env.home) })

async function create(definition, label) {
  const payload = definition.layout?.source === "manual"
    ? { ...definition, layoutIntent: "manual" }
    : definition
  const result = await request("POST", "/api/workflow-definitions", payload)
  write(`fixtures/responses/${label}.json`, result)
  if (!result.ok && result.status !== 409) throw new Error(`fixture ${label} create failed: ${JSON.stringify(result.body)}`)
  const read = await request("GET", `/api/workflow-definitions/${encodeURIComponent(definition.id)}`)
  if (!read.ok) throw new Error(`fixture ${label} was not readable after create`)
  write(`fixtures/definitions/${label}.json`, read.body)
}

for (const definition of canonicalFixtures()) await create(definition, definition.id)
for (const fixture of scenarioFixtures()) {
  write(`fixtures/requests/${fixture.scenario}.json`, fixture.definition)
  if (fixture.mode === "create") await create(fixture.definition, fixture.scenario)
  else {
    const plan = await request("POST", "/api/workflow-definitions/plan", { definition: fixture.definition, layoutIntent: "normalize" })
    write(`fixtures/responses/${fixture.scenario}-plan.json`, plan)
    if (!plan.ok || plan.body?.layout?.normalizedPreview?.layout?.source !== "normalized") {
      throw new Error(`invalid fixture plan preview failed unexpectedly: ${fixture.scenario}`)
    }
    const rejected = await request("POST", "/api/workflow-definitions", { ...fixture.definition, layoutIntent: "manual" })
    write(`fixtures/responses/${fixture.scenario}-manual-rejection.json`, rejected)
    const rejectionText = JSON.stringify(rejected.body)
    if (rejected.status !== 400 || !/tidy/i.test(rejectionText)) {
      throw new Error(`invalid manual fixture was not rejected with Tidy guidance: ${fixture.scenario}`)
    }
  }
}
