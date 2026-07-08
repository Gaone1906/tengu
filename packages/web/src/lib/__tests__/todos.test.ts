import { describe, it, expect } from "vitest"
import type { Employee, WorkItemCompactWire, WorkItemStatusWire } from "../api"
import {
  displayGroupOf,
  attentionOf,
  stateKeyOf,
  groupBoard,
  isRecentDone,
  headerCounts,
  deriveNeedsYou,
  needsYouCount,
  groupPeople,
  provenanceSuffix,
  provenanceLabel,
  monogram,
  formatCost,
} from "../todos"

const NOW = Date.parse("2026-07-05T12:00:00.000Z")

function compact(over: Partial<WorkItemCompactWire> & { id: string; status: WorkItemStatusWire }): WorkItemCompactWire {
  return {
    title: over.title ?? over.id,
    assignee: over.assignee ?? null,
    department: over.department ?? null,
    source: over.source ?? "human",
    updatedAt: over.updatedAt ?? "2026-07-05T11:00:00.000Z",
    ...over,
    sourceRef: over.sourceRef ?? null,
    approvalState: over.approvalState ?? null,
    approvalRequest: over.approvalRequest ?? null,
    approvalRef: over.approvalRef ?? null,
    approvalTarget: over.approvalTarget ?? null,
    approvalEscalatedAt: over.approvalEscalatedAt ?? null,
  }
}

function emp(name: string, displayName = name): Employee {
  return { name, displayName, department: "platform", rank: "senior", engine: "claude", model: "opus", persona: "" }
}

describe("displayGroupOf / attention / stateKey", () => {
  it("maps each status to its board group; blocked→executing, escalated→review, cancelled hidden", () => {
    expect(displayGroupOf("backlog")).toBe("backlog")
    expect(displayGroupOf("assigned")).toBe("assigned")
    expect(displayGroupOf("executing")).toBe("executing")
    expect(displayGroupOf("blocked")).toBe("executing")
    expect(displayGroupOf("in_review")).toBe("review")
    expect(displayGroupOf("escalated")).toBe("review")
    expect(displayGroupOf("done")).toBe("done")
    expect(displayGroupOf("cancelled")).toBeNull()
  })
  it("keeps the attention overlay and the true glyph key", () => {
    expect(attentionOf("blocked")).toBe("blocked")
    expect(attentionOf("escalated")).toBe("escalated")
    expect(attentionOf("executing")).toBeNull()
    expect(stateKeyOf("in_review")).toBe("review")
    expect(stateKeyOf("blocked")).toBe("blocked") // sits in Executing but stays blocked
  })
})

describe("groupBoard", () => {
  it("drops cancelled and folds blocked/escalated into their groups, native-first", () => {
    const groups = groupBoard([
      compact({ id: "exec", status: "executing" }),
      compact({ id: "blk", status: "blocked" }),
      compact({ id: "rev", status: "in_review" }),
      compact({ id: "esc", status: "escalated" }),
      compact({ id: "cancel", status: "cancelled" }),
    ])
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.items.map((i) => i.id)]))
    expect(byGroup.executing).toEqual(["exec", "blk"]) // native before attention
    expect(byGroup.review).toEqual(["rev", "esc"])
    // cancelled appears in no group
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain("cancel")
  })
  it("always returns the five groups in order", () => {
    expect(groupBoard([]).map((g) => g.group)).toEqual(["backlog", "assigned", "executing", "review", "done"])
  })
})

describe("recent-done window + header counts", () => {
  it("counts a done item as recent within the window and not outside it", () => {
    expect(isRecentDone(compact({ id: "d", status: "done", updatedAt: "2026-07-04T12:00:00.000Z" }), NOW)).toBe(true)
    expect(isRecentDone(compact({ id: "d", status: "done", updatedAt: "2026-06-01T12:00:00.000Z" }), NOW)).toBe(false)
    expect(isRecentDone(compact({ id: "x", status: "executing" }), NOW)).toBe(false)
  })
  it("splits open vs done-recent", () => {
    const counts = headerCounts(
      [
        compact({ id: "a", status: "executing" }),
        compact({ id: "b", status: "blocked" }),
        compact({ id: "c", status: "done", updatedAt: "2026-07-05T09:00:00.000Z" }),
        compact({ id: "e", status: "done", updatedAt: "2026-05-01T09:00:00.000Z" }),
        compact({ id: "f", status: "cancelled" }),
      ],
      NOW,
    )
    expect(counts).toEqual({ open: 2, doneRecent: 1 })
  })
})

describe("deriveNeedsYou", () => {
  it("preserves the server's updated-first order and only keeps attention items", () => {
    const items = [
      compact({ id: "blk1", status: "blocked" }),
      compact({ id: "ap1", status: "in_review", approvalState: "pending" }),
      compact({ id: "esc1", status: "escalated" }),
      compact({ id: "both", status: "escalated", approvalState: "pending" }),
      compact({ id: "done1", status: "done", approvalState: "approved" }),
    ]
    const set = deriveNeedsYou(items)
    expect(set.map((item) => item.id)).toEqual(["blk1", "ap1", "esc1", "both"])
    expect(needsYouCount(set)).toBe(4)
  })
  it("is empty when nothing is pending/escalated/blocked", () => {
    expect(needsYouCount(deriveNeedsYou([compact({ id: "x", status: "executing" })]))).toBe(0)
  })
})

describe("groupPeople", () => {
  it("open-only queues, sorted by count then name, with a canonical dist order", () => {
    const items = [
      compact({ id: "1", status: "executing", assignee: "jinn-dev" }),
      compact({ id: "2", status: "escalated", assignee: "jinn-dev" }),
      compact({ id: "3", status: "assigned", assignee: "jinn-dev" }),
      compact({ id: "4", status: "done", assignee: "jinn-dev" }), // excluded (terminal)
      compact({ id: "5", status: "in_review", assignee: "support-bot" }),
    ]
    const people = groupPeople(items, [emp("growth-eng", "Growth Eng"), emp("support-bot", "Support Bot"), emp("jinn-dev", "Jinn Dev")])
    expect(people.map((p) => p.employee.name)).toEqual(["jinn-dev", "support-bot", "growth-eng"]) // 3,1,0 open
    expect(people[0].openCount).toBe(3)
    // dist canonical order: executing, escalated, assigned (in_review/blocked/backlog absent)
    expect(people[0].dist).toEqual(["executing", "escalated", "assigned"])
    // idle employee reads all-clear (empty queue)
    expect(people[2].items).toEqual([])
    // queue sorted by priority: escalated first
    expect(people[0].items[0].status).toBe("escalated")
  })
})

describe("provenance / monogram / cost", () => {
  it("parses the sourceRef suffix for machine-minted items", () => {
    expect(provenanceSuffix("cron", "cron:nightly-verify:2026-07-05T00:00:00Z")).toBe("nightly-verify")
    expect(provenanceSuffix("workflow", "workflow:release:run-42")).toBe("release")
    expect(provenanceSuffix("delegation", "session:abc:123")).toBeNull()
    expect(provenanceSuffix("cron", null)).toBeNull()
  })
  it("labels provenance with the word and optional suffix", () => {
    expect(provenanceLabel("human")).toBe("You")
    expect(provenanceLabel("delegation")).toBe("Delegation")
    expect(provenanceLabel("cron", "cron:release-watch:2026-07-04T00:00:00Z")).toBe("Cron · release-watch")
  })
  it("builds monograms", () => {
    expect(monogram("Jinn Dev")).toBe("JD")
    expect(monogram("Chief of Staff")).toBe("CO") // first two words
    expect(monogram("growth")).toBe("GR")
  })
  it("formats cost only when a budget is set", () => {
    expect(formatCost(2.1, 10)).toBe("$2.10 / $10")
    expect(formatCost(4.6, 10)).toBe("$4.60 / $10")
    expect(formatCost(0, null)).toBeNull()
    expect(formatCost(1.5, 7.5)).toBe("$1.50 / $7.50")
  })
})
