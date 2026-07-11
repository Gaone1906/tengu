import test from "node:test"
import assert from "node:assert/strict"

import { canonicalFixtures, scenarioFixtures, authorRequests } from "./fixtures.mjs"

test("canonical fixtures cover six deterministic graph shapes", () => {
  const fixtures = canonicalFixtures()
  assert.deepEqual(fixtures.map((x) => x.id), [
    "verify-linear", "verify-branch", "verify-merge", "verify-approval", "verify-error", "verify-loop",
  ])
  assert.ok(fixtures.every((x) => x.layout?.source === "generated"))
  assert.ok(fixtures.find((x) => x.id === "verify-error")?.edges.some((x) => x.lane === "error"))
  assert.ok(fixtures.find((x) => x.id === "verify-loop")?.edges.some((x) => x.kind === "loop"))
})

test("scenario fixtures cover new, valid manual, invalid manual, and run states", () => {
  const fixtures = scenarioFixtures()
  assert.deepEqual(new Set(fixtures.map((x) => x.scenario)), new Set([
    "new", "manual", "invalid-manual-overlap",
    "run-success", "run-failure", "run-approval",
  ]))
  const manual = fixtures.find((x) => x.scenario === "manual")?.definition
  assert.equal(manual?.layout.source, "manual")
  assert.deepEqual(manual?.nodes.map((node) => node.position.x), [40, 340, 740])
  assert.equal(fixtures.find((x) => x.scenario === "run-failure")?.definition.nodes.at(-1)?.type, "fail")
  assert.equal(fixtures.find((x) => x.scenario === "run-approval")?.definition.nodes.at(-1)?.type, "gate")
})

test("five opt-in author requests pin sandbox employees to GPT-5.5 low", () => {
  const requests = authorRequests()
  assert.equal(requests.length, 5)
  assert.equal(new Set(requests.map((x) => x.expectedWorkflowId)).size, 5)
  for (const request of requests) {
    assert.equal(request.body.engine, "codex")
    assert.equal(request.body.model, "gpt-5.5")
    assert.equal(request.body.effortLevel, "low")
    assert.match(request.body.employee, /^layout-author-[1-5]$/)
    assert.doesNotMatch(request.body.prompt, /7777/)
    assert.match(request.body.prompt, /current sandbox gateway/i)
  }
})
