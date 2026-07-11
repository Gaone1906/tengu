const pos = (x, y) => ({ x, y })
const trigger = (id = "trigger", x = 0, y = 0) => ({ id, type: "trigger", label: "Manual", position: pos(x, y), trigger: { kind: "manual" } })
const step = (id, label, x, y, actor = "run-worker-a", extra = {}) => ({
  id, type: "step", label, position: pos(x, y), actor: { kind: "employee", ref: actor },
  instructions: `Return concise generic evidence for ${label}. Do not use external systems.`, ...extra,
})
const edge = (id, from, to, extra = {}) => ({ id, from, to, kind: "sequence", ...extra })
const base = (id, title, nodes, edges, extra = {}) => ({
  schemaVersion: 1, id, name: id, title, status: "active", layout: { source: "generated", version: 1 }, nodes, edges, ...extra,
})

export function canonicalFixtures() {
  return [
    base("verify-linear", "Verify Linear", [
      trigger(), step("intake", "Intake", 0, 140), step("draft", "Draft", 0, 280),
      step("check", "Check", 0, 420, "run-worker-b"), step("finish", "Finish", 0, 560),
    ], [edge("e1", "trigger", "intake"), edge("e2", "intake", "draft"), edge("e3", "draft", "check"), edge("e4", "check", "finish")]),
    base("verify-branch", "Verify Branch", [
      trigger(), step("classify", "Classify", 0, 140),
      { id: "route", type: "switch", label: "Route", position: pos(0, 280), switchMode: "firstMatch" },
      step("path-a", "Path A", -140, 420), step("path-b", "Path B", 300, 420, "run-worker-b"), step("complete", "Complete", 80, 600),
    ], [edge("e1", "trigger", "classify"), edge("e2", "classify", "route"), edge("e3", "route", "path-a", { when: [{ path: "trigger.payload.route", op: "eq", value: "A" }] }), edge("e4", "route", "path-b"), edge("e5", "path-a", "complete"), edge("e6", "path-b", "complete")]),
    base("verify-merge", "Verify Merge", [
      trigger(), step("prepare-a", "Prepare A", 0, 160), step("prepare-b", "Prepare B", 280, 160, "run-worker-b"), step("merge", "Merge", 140, 340),
    ], [edge("e1", "trigger", "prepare-a"), edge("e2", "trigger", "prepare-b"), edge("e3", "prepare-a", "merge"), edge("e4", "prepare-b", "merge")]),
    base("verify-approval", "Verify Approval", [
      trigger(), step("prepare", "Prepare", 0, 140),
      { id: "approval", type: "gate", label: "Approval", position: pos(0, 280), gate: { kind: "approval", approvalRef: "verify-approval", description: "Approve generic sandbox evidence." } },
      step("finish", "Finish", 0, 420),
    ], [edge("e1", "trigger", "prepare"), edge("e2", "prepare", "approval"), edge("e3", "approval", "finish")]),
    base("verify-error", "Verify Error Lane", [
      trigger(), step("attempt", "Attempt", 0, 160, "run-worker-a", { options: { onError: "error-edge" } }),
      step("success", "Success", 0, 320), step("recover", "Recover", 320, 320, "run-worker-b"),
    ], [edge("e1", "trigger", "attempt"), edge("e2", "attempt", "success"), edge("error-edge", "attempt", "recover", { lane: "error" })]),
    base("verify-loop", "Verify Bounded Loop", [
      trigger(), step("build", "Build", 0, 160), step("verify", "Verify", 0, 320, "run-worker-b"), step("complete", "Complete", 0, 480),
    ], [edge("e1", "trigger", "build"), edge("e2", "build", "verify"), edge("retry", "verify", "build", { kind: "loop" }), edge("e3", "verify", "complete")], { loop: { maxRoundsPerRun: 2 } }),
  ]
}

export function scenarioFixtures() {
  const manualNodes = [trigger("trigger", 40, 80), step("one", "One", 340, 80), step("two", "Two", 740, 80)]
  return [
    { scenario: "new", mode: "create", definition: base("verify-new", "Verify New", [trigger()], []) },
    { scenario: "manual", mode: "create", definition: { ...base("verify-manual", "Verify Manual", manualNodes, [edge("e1", "trigger", "one"), edge("e2", "one", "two")]), layout: { source: "manual", version: 1 } } },
    { scenario: "invalid-manual-overlap", mode: "plan-reject", definition: { ...base("verify-invalid-overlap", "Invalid Manual Overlap", [trigger(), step("bad", "Bad", 20, 20)], [edge("e1", "trigger", "bad")]), layout: { source: "manual", version: 1 } } },
    { scenario: "run-success", mode: "create", definition: base("verify-run-success", "Run Success", [trigger()], []) },
    { scenario: "run-failure", mode: "create", definition: base("verify-run-failure", "Run Failure", [trigger(), { id: "stop", type: "fail", label: "Intentional failure", position: pos(0, 160), failMessage: "Intentional sandbox failure" }], [edge("e1", "trigger", "stop")]) },
    { scenario: "run-approval", mode: "create", definition: base("verify-run-approval", "Run Approval", [trigger(), { id: "approve", type: "gate", label: "Operator approval", position: pos(0, 160), gate: { kind: "approval", approvalRef: "verify-run-approval", description: "Approve the deterministic sandbox run." } }], [edge("e1", "trigger", "approve")]) },
  ]
}

const authorShapes = [
  ["child-linear", "Create a linear workflow with four ordered actor steps."],
  ["child-branch-merge", "Create a workflow with a switch, two branches, and a shared merge successor."],
  ["child-approval-wait", "Create a workflow containing preparation, an approval gate, a short wait, and completion."],
  ["child-error-lane", "Create a supported error-lane workflow using options.onError and an edge with lane error."],
  ["child-bounded-loop", "Create a bounded-loop workflow with a loop edge and maxRoundsPerRun 2."],
]

export function authorRequests() {
  return authorShapes.map(([expectedWorkflowId, shape], index) => ({
    expectedWorkflowId,
    body: {
      engine: "codex", model: "gpt-5.5", effortLevel: "low", employee: `layout-author-${index + 1}`,
      prompt: `You are a disposable workflow author on the current sandbox gateway. Use only its workflow MCP tools. Create exactly one generic workflow named ${expectedWorkflowId}; validate it, create it, do not run it, and report the id. ${shape} Do not inspect files, edit code, or contact any other gateway or external system.`,
    },
  }))
}
