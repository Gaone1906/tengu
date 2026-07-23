import { describe, it, expect } from "vitest"
import { legalTargets, canDropOn } from "../legal-targets"
import type { WorkItemStatusWire } from "../api"

/* Slice 6 — the client legality map. The full matrix is pinned here; the
 * SERVER parity lives in packages/jinn/src/work-items/__tests__/
 * board-legality-parity.test.ts, which probes transition() behaviorally
 * against the same transition-edges.json this module reads. */

const statuses = (targets: ReturnType<typeof legalTargets>) => targets.map((t) => t.status)

describe("legalTargets — manual operator moves, ungated", () => {
  const MATRIX: Record<WorkItemStatusWire, WorkItemStatusWire[]> = {
    // executing reachable only from backlog/assigned (manual-start rule).
    backlog: ["assigned", "executing", "in_review", "blocked", "done", "cancelled", "escalated"],
    assigned: ["backlog", "executing", "in_review", "blocked", "done", "cancelled", "escalated"],
    executing: ["in_review", "blocked", "done", "cancelled", "escalated"],
    // Send back is a review verdict, never a manual move: executing absent.
    in_review: ["done", "blocked", "cancelled", "escalated"],
    // Unblock resumes through backlog/assigned; executing absent (manual rule).
    blocked: ["backlog", "assigned", "in_review", "done", "cancelled", "escalated"],
    // Sticky terminals exit on the human surface only — which this is.
    escalated: ["backlog", "assigned", "in_review", "done", "blocked", "cancelled"],
    done: ["backlog"],
    cancelled: ["backlog"],
  }

  for (const [from, expected] of Object.entries(MATRIX) as [WorkItemStatusWire, WorkItemStatusWire[]][]) {
    it(`from ${from} offers exactly [${expected.join(", ")}]`, () => {
      const targets = legalTargets(from)
      expect(statuses(targets)).toEqual(expected)
      expect(targets.every((t) => !t.gated)).toBe(true)
    })
  }

  it("never offers the current status or an illegal edge", () => {
    for (const from of Object.keys(MATRIX) as WorkItemStatusWire[]) {
      const offered = statuses(legalTargets(from))
      expect(offered).not.toContain(from)
    }
    expect(statuses(legalTargets("executing"))).not.toContain("backlog")
    expect(statuses(legalTargets("in_review"))).not.toContain("executing")
  })
})

describe("legalTargets — the roll-up close gate", () => {
  it("gates done AND cancelled with the open-children reason", () => {
    const targets = legalTargets("executing", { openChildren: 3 })
    const done = targets.find((t) => t.status === "done")
    const cancelled = targets.find((t) => t.status === "cancelled")
    expect(done).toEqual({ status: "done", gated: true, reason: "3 sub-tasks still open" })
    expect(cancelled).toEqual({ status: "cancelled", gated: true, reason: "3 sub-tasks still open" })
    // Gated ≠ illegal: the rows are PRESENT (pickers render them disabled).
    expect(statuses(targets)).toContain("done")
  })

  it("singular reason for one open child", () => {
    const done = legalTargets("in_review", { openChildren: 1 }).find((t) => t.status === "done")
    expect(done?.reason).toBe("1 sub-task still open")
  })

  it("does not gate non-close targets", () => {
    const targets = legalTargets("executing", { openChildren: 2 })
    expect(targets.find((t) => t.status === "in_review")?.gated).toBe(false)
    expect(targets.find((t) => t.status === "blocked")?.gated).toBe(false)
  })
})

describe("canDropOn — drag legality", () => {
  it("legal ungated edges are live targets", () => {
    expect(canDropOn("backlog", "executing")).toBe(true)
    expect(canDropOn("done", "backlog")).toBe(true)
  })
  it("illegal edges are not targets", () => {
    expect(canDropOn("in_review", "executing")).toBe(false)
    expect(canDropOn("executing", "backlog")).toBe(false)
    expect(canDropOn("done", "done")).toBe(false)
  })
  it("a gated column dims like an illegal one", () => {
    expect(canDropOn("executing", "done", { openChildren: 2 })).toBe(false)
    expect(canDropOn("executing", "done", { openChildren: 0 })).toBe(true)
  })
})
