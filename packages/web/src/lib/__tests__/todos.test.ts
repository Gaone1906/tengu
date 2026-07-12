import { describe, it, expect } from "vitest"
import { ApiError, TodoApiError, type Employee, type WorkItemCompactWire, type WorkItemStatusWire } from "../api"
import {
  displayGroupOf,
  attentionOf,
  stateKeyOf,
  groupBoard,
  headerCountsFromTotals,
  deriveNeedsYou,
  needsYouCount,
  groupPeople,
  provenanceSuffix,
  provenanceLabel,
  monogram,
  formatCost,
  compareRank,
  rankBetween,
  statusesFor,
  isHistoryView,
  isDefaultFilters,
  activeFilterCount,
  filtersToSearchParams,
  filtersFromSearchParams,
  dateBucketOf,
  groupHistory,
  isTodoVersionConflictError,
  isTodoIdempotencyConflictError,
  operatorSafeTodoError,
  type TodoFilters,
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

describe("conditional edit errors", () => {
  it("classifies only the typed idempotency conflict code", () => {
    expect(isTodoIdempotencyConflictError(new TodoApiError(409, "private", "todo_idempotency_conflict"))).toBe(true)
    expect(isTodoIdempotencyConflictError(new TodoApiError(409, "private", "todo_version_conflict"))).toBe(false)
    expect(isTodoIdempotencyConflictError(new Error("TODO_IDEMPOTENCY_CONFLICT"))).toBe(false)
  })

  it.each([
    "todo_version_conflict",
    "WORK_ITEM_VERSION_CONFLICT",
  ])("classifies the explicit %s code as a version conflict", (code) => {
    expect(isTodoVersionConflictError(new TodoApiError(400, "private diagnostic", code))).toBe(true)
  })

  it.each([
    new TodoApiError(409, "generic conflict"),
    new TodoApiError(412, "generic precondition"),
    new TodoApiError(409, "different conflict", "todo_idempotency_conflict"),
    new Error("WORK_ITEM_VERSION_CONFLICT"),
  ])("does not route a non-version error to reconciliation", (error) => {
    expect(isTodoVersionConflictError(error)).toBe(false)
  })

  it.each([
    ["todo_idempotency_conflict", "This edit request conflicts with an earlier request. Reload remote to discard all local edits before starting a new edit."],
    ["todo_precondition_required", "This Todo requires a current version before it can be saved. Reload it and try again."],
    ["todo_invalid_version", "This Todo version is invalid. Reload it and try again."],
    ["todo_invalid_patch", "This Todo edit is invalid. Review the changed fields and try again."],
  ])("uses closed safe copy for %s without exposing backend diagnostics", (code, safeCopy) => {
    const error = new TodoApiError(400, "SQLITE_BUSY /srv/private.db token=secret", code)

    expect(operatorSafeTodoError(error, "Safe fallback")).toBe(safeCopy)
    expect(error).toMatchObject({
      name: "TodoApiError",
      code,
      message: "SQLITE_BUSY /srv/private.db token=secret",
    })
    expect(operatorSafeTodoError(error, "Safe fallback")).not.toMatch(/SQLITE_BUSY|private\.db|secret/)
    expect(error).toBeInstanceOf(ApiError)
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
  it("always returns the five groups in ledger order (moving work first)", () => {
    expect(groupBoard([]).map((g) => g.group)).toEqual(["executing", "review", "assigned", "backlog", "done"])
  })
})

describe("header counts (from gateway totals — never capped rows)", () => {
  it("sums the open-status totals and passes the recent-done total through", () => {
    expect(
      headerCountsFromTotals({ backlog: 27, assigned: 4, executing: 3, blocked: 1, in_review: 2, escalated: 1, done: 12 }),
    ).toEqual({ open: 38, doneRecent: 12 })
  })
  it("treats missing totals as zero (loading / cancelled excluded)", () => {
    expect(headerCountsFromTotals({})).toEqual({ open: 0, doneRecent: 0 })
    expect(headerCountsFromTotals({ cancelled: 9, done: 2 })).toEqual({ open: 0, doneRecent: 2 })
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

describe("manual rank (design-todos §4.5/§7.3)", () => {
  it("orders ranked items ascending, ranked before unranked, unranked by updatedAt desc", () => {
    const a = compact({ id: "a", status: "backlog", rank: 2 })
    const b = compact({ id: "b", status: "backlog", rank: 1 })
    const c = compact({ id: "c", status: "backlog", updatedAt: "2026-07-05T10:00:00.000Z" })
    const d = compact({ id: "d", status: "backlog", updatedAt: "2026-07-05T11:30:00.000Z" })
    const sorted = [a, b, c, d].sort(compareRank)
    expect(sorted.map((i) => i.id)).toEqual(["b", "a", "d", "c"])
  })
  it("computes midpoints and open-ended edge ranks", () => {
    expect(rankBetween(1, 3)).toBe(2)
    expect(rankBetween(5, null)).toBe(5 + 1024)
    expect(rankBetween(null, 5)).toBe(5 - 1024)
    expect(rankBetween(null, null)).toBe(0)
  })
})

describe("filters (design-todos §4.3)", () => {
  it("expands the open/all lenses into their status fan-out", () => {
    expect(statusesFor({ status: "open" })).toEqual([
      "backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done",
    ])
    expect(statusesFor({ status: "all" })).toContain("cancelled")
    expect(statusesFor({ status: "done" })).toEqual(["done"])
  })
  it("marks closed-status lenses as history views", () => {
    expect(isHistoryView({ status: "done" })).toBe(true)
    expect(isHistoryView({ status: "cancelled" })).toBe(true)
    expect(isHistoryView({ status: "all" })).toBe(true)
    expect(isHistoryView({ status: "open" })).toBe(false)
    expect(isHistoryView({ status: "executing" })).toBe(false)
  })
  it("round-trips through URL search params", () => {
    const f: TodoFilters = { status: "done", assignee: "jinn-dev", department: "platform", source: "cron", date: "week", q: "digest" }
    expect(filtersFromSearchParams(filtersToSearchParams(f))).toEqual(f)
    // Defaults serialize to an empty string (clean URLs).
    expect(filtersToSearchParams({ status: "open" }).toString()).toBe("")
    expect(filtersToSearchParams({ status: "open", q: "wi_private_42" }).toString()).toBe("")
    expect(filtersFromSearchParams(new URLSearchParams("q=wi_private_42"))).toEqual({ status: "open" })
    expect(isDefaultFilters(filtersFromSearchParams(new URLSearchParams()))).toBe(true)
    // Garbage params are ignored, not thrown.
    expect(filtersFromSearchParams(new URLSearchParams("status=nope&source=bad&date=huh"))).toEqual({ status: "open" })
  })
  it("counts set chips for the Clear control", () => {
    expect(activeFilterCount({ status: "open" })).toBe(0)
    expect(activeFilterCount({ status: "open", q: "roadmap" })).toBe(0)
    expect(activeFilterCount({ status: "done", assignee: "x", date: "today" })).toBe(3)
  })
})

describe("history grouping (design-todos §3)", () => {
  it("buckets by day and drops empty buckets, newest-first inside each", () => {
    // NOW = 2026-07-05T12:00Z; local-midnight boundaries make same-day safe picks.
    expect(dateBucketOf("2026-07-05T11:00:00.000Z", NOW)).toBe("today")
    expect(dateBucketOf("invalid", NOW)).toBe("earlier")
    const groups = groupHistory(
      [
        compact({ id: "t1", status: "done", updatedAt: "2026-07-05T09:00:00.000Z" }),
        compact({ id: "t2", status: "done", updatedAt: "2026-07-05T11:00:00.000Z" }),
        compact({ id: "old", status: "done", updatedAt: "2026-05-01T10:00:00.000Z" }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.bucket)).toEqual(["today", "earlier"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["t2", "t1"])
    expect(groups[0].label).toBe("Today")
  })
})
