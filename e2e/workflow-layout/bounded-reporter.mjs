import fs from "node:fs"
import path from "node:path"
import {
  completionStatus,
  expectedBrowserChecks,
  expectedCompletionPlan,
  finalizeArtifactBundle,
} from "./harness-policy.mjs"

export default class BoundedWorkflowLayoutReporter {
  constructor(options = {}) {
    this.results = []
    this.discovered = 0
    this.listOnly = options._mode === "list"
  }

  onBegin(_config, suite) {
    this.discovered = suite.allTests().length
  }

  onTestEnd(test, result) {
    this.results.push({
      title: test.titlePath().join(" › "),
      status: result.status,
      error: result.error?.message ?? "",
    })
  }

  async onEnd() {
    if (this.listOnly) return
    const artifacts = process.env.JINN_VERIFY_ARTIFACTS
    if (!artifacts) return { status: "failed" }
    const withAuthors = process.env.JINN_VERIFY_RUN_AUTHORS === "1"
    const expected = expectedBrowserChecks(withAuthors)
    const summary = completionStatus({ expected, discovered: this.discovered, results: this.results })
    const plan = expectedCompletionPlan(withAuthors)
    const completedByCell = Object.fromEntries(Object.keys(plan.cells).map((cell) => [cell, 0]))
    let completedGlobal = 0
    for (const result of this.results) {
      const cell = Object.keys(plan.cells).find((key) => result.title.includes(key))
      if (cell) completedByCell[cell] += 1
      else completedGlobal += 1
    }
    for (const [cell, expectedCell] of Object.entries(plan.cells)) {
      if (completedByCell[cell] !== expectedCell) summary.reasons.push(`missing cell checks: ${cell} completed ${completedByCell[cell]} of ${expectedCell}`)
    }
    if (completedGlobal !== plan.global) summary.reasons.push(`missing global checks: completed ${completedGlobal} of ${plan.global}`)
    if (summary.reasons.length) summary.status = "incomplete"
    summary.cells = completedByCell
    summary.global = completedGlobal

    fs.mkdirSync(artifacts, { recursive: true })
    const summaryPath = path.join(artifacts, "completion.json")
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
    try {
      finalizeArtifactBundle(artifacts)
    } catch (error) {
      summary.status = "incomplete"
      summary.reasons.push(error instanceof Error ? error.message : String(error))
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
    }
    return summary.status === "complete" ? undefined : { status: "failed" }
  }
}
