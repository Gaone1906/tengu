import { describe, it, expect } from "vitest"
import { ApiError, TodoApiError, type WorkItemCompactWire, type WorkItemStatusWire } from "../api"
import {
  stateKeyOf,
  deriveNeedsYou,
  provenanceSuffix,
  provenanceLabel,
  compareRank,
  rankBetween,
  activeFilterCount,
  matchesDueFilter,
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

describe("stateKeyOf", () => {
  it("keeps the true glyph key — blocked/escalated stay themselves, in_review maps to review", () => {
    expect(stateKeyOf("in_review")).toBe("review")
    expect(stateKeyOf("blocked")).toBe("blocked")
    expect(stateKeyOf("escalated")).toBe("escalated")
    expect(stateKeyOf("executing")).toBe("executing")
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
    expect(set).toHaveLength(4)
  })
  it("is empty when nothing is pending/escalated/blocked", () => {
    expect(deriveNeedsYou([compact({ id: "x", status: "executing" })])).toHaveLength(0)
  })
})



describe("provenance whisper", () => {
  it("parses the machine-minted sourceRef suffix for cron and workflow", () => {
    expect(provenanceSuffix("cron", "cron:daily-digest:2026-07-05T09:00:00Z")).toBe("daily-digest")
    expect(provenanceSuffix("workflow", "workflow:release-train:run_9")).toBe("release-train")
    expect(provenanceSuffix("human", "anything")).toBeNull()
    expect(provenanceSuffix("cron", null)).toBeNull()
  })
  it("labels provenance with the suffix when present and never leaks transport ids", () => {
    expect(provenanceLabel("cron", "cron:daily-digest:2026-07-05T09:00:00Z")).toBe("Cron · daily-digest")
    expect(provenanceLabel("human", null)).toBe("You")
    expect(provenanceLabel("workflow", "workflow:wi_private_def:run")).toBe("Workflow")
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
  it("round-trips through URL search params", () => {
    const f: TodoFilters = { status: "done", assignee: "jinn-dev", department: "platform", source: "cron", date: "week", label: "infra", due: "overdue", q: "digest" }
    expect(filtersFromSearchParams(filtersToSearchParams(f))).toEqual(f)
    expect(filtersFromSearchParams(new URLSearchParams("due=nonsense"))).toEqual({ status: "open" })
    // Defaults serialize to an empty string (clean URLs).
    expect(filtersToSearchParams({ status: "open" }).toString()).toBe("")
    expect(filtersToSearchParams({ status: "open", q: "wi_private_42" }).toString()).toBe("")
    expect(filtersFromSearchParams(new URLSearchParams("q=wi_private_42"))).toEqual({ status: "open" })
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual({ status: "open" })
    // Garbage params are ignored, not thrown.
    expect(filtersFromSearchParams(new URLSearchParams("status=nope&source=bad&date=huh"))).toEqual({ status: "open" })
  })
  it("counts set chips for the Clear control", () => {
    expect(activeFilterCount({ status: "open" })).toBe(0)
    expect(activeFilterCount({ status: "open", q: "roadmap" })).toBe(0)
    expect(activeFilterCount({ status: "done", assignee: "x", date: "today" })).toBe(3)
    expect(activeFilterCount({ status: "open", label: "infra", due: "week" })).toBe(2)
  })

  it("due windows filter client-side: forward-looking windows from start of today, Overdue strictly past", () => {
    // NOW = 2026-07-05T12:00Z (a Sunday); windows use local midnight.
    expect(matchesDueFilter(null, "week", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-06T00:00:00.000Z", undefined, NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-05T09:00:00.000Z", "overdue", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-05T13:00:00.000Z", "overdue", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-05T13:00:00.000Z", "today", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-06T13:00:00.000Z", "today", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-09T13:00:00.000Z", "week", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-20T13:00:00.000Z", "week", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-20T13:00:00.000Z", "month", NOW)).toBe(true)
    expect(matchesDueFilter("2026-09-20T13:00:00.000Z", "month", NOW)).toBe(false)
    // Yesterday's overdue item is NOT "due this week" — Overdue is its lens.
    expect(matchesDueFilter("2026-07-04T09:00:00.000Z", "week", NOW)).toBe(false)
    expect(matchesDueFilter("invalid", "week", NOW)).toBe(false)
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
