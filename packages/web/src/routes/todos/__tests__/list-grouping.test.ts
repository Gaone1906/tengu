import { describe, expect, it } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { groupTodoListItems } from "../list/group-items"

function item(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: null,
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: status === "blocked",
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank: null,
  }
}

describe("groupTodoListItems", () => {
  it("hoists an attention item outside the loaded status page", () => {
    const needsReview = item("PLA-21", "in_review")
    const groups = groupTodoListItems(
      {
        backlog: { items: [], total: 0 },
        assigned: { items: [], total: 0 },
        executing: { items: [], total: 0 },
        in_review: { items: [], total: 21 },
        blocked: { items: [], total: 0 },
        escalated: { items: [], total: 0 },
        done: { items: [], total: 0 },
        cancelled: { items: [], total: 0 },
      },
      [needsReview],
    )

    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual(["PLA-21"])
    expect(groups.find((group) => group.key === "in-review")?.items).toEqual([])
    expect(groups.find((group) => group.key === "in-review")?.count).toBe(20)
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "PLA-21")).toHaveLength(1)
  })

  it("hoists attention items exactly once and keeps an ordinary blocked item in Blocked", () => {
    const needsReview = item("ICI-1", "in_review")
    const needsBlocked = item("ICI-2", "blocked")
    const ordinaryBlocked = item("ICI-3", "blocked")
    const groups = groupTodoListItems(
      {
        backlog: { items: [], total: 0 },
        assigned: { items: [], total: 0 },
        executing: { items: [], total: 0 },
        in_review: { items: [needsReview], total: 1 },
        blocked: { items: [needsBlocked, ordinaryBlocked], total: 2 },
        escalated: { items: [], total: 0 },
        done: { items: [], total: 0 },
        cancelled: { items: [], total: 0 },
      },
      [needsReview, needsBlocked],
    )

    expect(groups.map((group) => group.key)).toEqual([
      "needs-you",
      "executing",
      "in-review",
      "assigned",
      "backlog",
      "blocked",
      "closed",
    ])
    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual([
      "ICI-1",
      "ICI-2",
    ])
    expect(groups.find((group) => group.key === "in-review")?.items).toEqual([])
    expect(groups.find((group) => group.key === "blocked")?.items.map(({ id }) => id)).toEqual(["ICI-3"])
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "ICI-1")).toHaveLength(1)
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "ICI-2")).toHaveLength(1)
  })
})
