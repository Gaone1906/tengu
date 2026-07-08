import { describe, it, expect } from "vitest"
import { humanizeCron, triggerSummaryOf, relativeTime, lastRunSummary, nodeStatusLine } from "../status-line"
import type { CanvasNode } from "../canvas-model"
import type { WorkflowRunSummaryWire } from "@/lib/api"

/* GRS-019 — the plain-language vocabulary the list + node cards render. */

const node = (over: Partial<CanvasNode>): CanvasNode => ({
  id: "n",
  kind: "step",
  title: "n",
  role: "implement",
  who: "codex",
  status: "pending",
  isCurrent: false,
  gates: [],
  ...over,
})

describe("nodeStatusLine", () => {
  it("keeps the honest vocabulary: running is never 'Done'", () => {
    expect(nodeStatusLine(node({ status: "running" }))).toBe("Running")
    expect(nodeStatusLine(node({ status: "passed" }))).toBe("Done")
    expect(nodeStatusLine(node({ status: "completed" }))).toBe("Done")
  })
  it("parked reads as the approval doorbell", () => {
    expect(nodeStatusLine(node({ status: "parked" }))).toBe("Waits for your approval")
  })
  it("dispatched stays completion-unknown, never Done", () => {
    expect(nodeStatusLine(node({ status: "dispatched" }))).toContain("unknown")
  })
  it("appends a quiet checks count when the node carries gates", () => {
    const gates = [
      { id: "g1", kind: "artifact" as const, description: "a", passed: true },
      { id: "g2", kind: "artifact" as const, description: "b", passed: false },
    ]
    expect(nodeStatusLine(node({ status: "passed", gates }))).toBe("Done · 1/2 checks")
  })
})

describe("humanizeCron", () => {
  it("covers the common shapes", () => {
    expect(humanizeCron("*/5 * * * *")).toBe("Every 5 min")
    expect(humanizeCron("0 */2 * * *")).toBe("Every 2 hours")
    expect(humanizeCron("0 */1 * * *")).toBe("Every hour")
    expect(humanizeCron("15 * * * *")).toBe("Every hour")
    expect(humanizeCron("0 8 * * *")).toBe("Daily at 08:00")
    expect(humanizeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30")
  })
  it("falls back to the raw expression rather than guessing", () => {
    expect(humanizeCron("0 8 1 * *")).toBe("0 8 1 * *")
    expect(humanizeCron("not-a-cron")).toBe("not-a-cron")
  })
})

describe("triggerSummaryOf", () => {
  it("reads the schedule trigger node", () => {
    expect(
      triggerSummaryOf({
        nodes: [
          { id: "t", type: "trigger", label: "T", position: { x: 0, y: 0 }, trigger: { kind: "schedule", cron: "0 */2 * * *" } },
        ],
      }),
    ).toBe("Every 2 hours")
  })
  it("manual trigger and missing trigger both read Manual", () => {
    expect(
      triggerSummaryOf({ nodes: [{ id: "t", type: "trigger", label: "T", position: { x: 0, y: 0 }, trigger: { kind: "manual" } }] }),
    ).toBe("Manual")
    expect(triggerSummaryOf({ nodes: [] })).toBe("Manual")
  })
})

describe("lastRunSummary", () => {
  const now = new Date("2026-07-05T12:00:00Z")
  const run = (status: WorkflowRunSummaryWire["status"]): WorkflowRunSummaryWire => ({
    runId: "run-1",
    workflowId: "w",
    status,
    trigger: { kind: "manual" },
    startedAt: "2026-07-05T10:00:00Z",
    endedAt: null,
    stepCount: 1,
    parked: status === "parked",
  })
  it("maps each run status to a quiet two-word-ish label", () => {
    expect(lastRunSummary(run("parked"), now)).toEqual({ tone: "wait", label: "Waiting for you" })
    expect(lastRunSummary(run("completed"), now)).toEqual({ tone: "ok", label: "Ran 2h ago" })
    expect(lastRunSummary(run("failed"), now)).toEqual({ tone: "fail", label: "Failed 2h ago" })
    expect(lastRunSummary(run("running"), now)).toEqual({ tone: "busy", label: "Running now" })
    expect(lastRunSummary(undefined, now)).toEqual({ tone: "none", label: "No runs yet" })
  })
  it("dispatched never reads as a success", () => {
    const s = lastRunSummary(run("dispatched"), now)
    expect(s.tone).not.toBe("ok")
    expect(s.label).toContain("Dispatched")
  })
})

describe("relativeTime", () => {
  const now = new Date("2026-07-05T12:00:00Z")
  it("compacts to minutes/hours/days", () => {
    expect(relativeTime("2026-07-05T11:59:40Z", now)).toBe("just now")
    expect(relativeTime("2026-07-05T11:30:00Z", now)).toBe("30m ago")
    expect(relativeTime("2026-07-05T06:00:00Z", now)).toBe("6h ago")
    expect(relativeTime("2026-07-03T12:00:00Z", now)).toBe("2d ago")
  })
})
