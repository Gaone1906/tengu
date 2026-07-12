import test from "node:test"
import assert from "node:assert/strict"

import BoundedWorkflowLayoutReporter from "./bounded-reporter.mjs"

test("Playwright list-only discovery does not require completion results or artifacts", async () => {
  const reporter = new BoundedWorkflowLayoutReporter({ _mode: "list" })
  reporter.onBegin({}, { allTests: () => Array.from({ length: 111 }, () => ({})) })
  assert.equal(await reporter.onEnd(), undefined)
})
