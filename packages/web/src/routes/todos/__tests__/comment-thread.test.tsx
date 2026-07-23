import { describe, expect, it } from "vitest"
import type { WorkItemCommentWire } from "@/lib/api"
import { buildCommentThread } from "../comment-thread"

/* The pure thread builder — the one comment renderer is the task page's
 * Activity feed (its interaction pins live in task-sections.test.tsx; the
 * sheet-era CommentThread component retired at the stage-C cutover). */

function comment(overrides: Partial<WorkItemCommentWire>): WorkItemCommentWire {
  return {
    id: "wic_000000000001",
    workItemId: "JIN-7",
    parentCommentId: null,
    authorKind: "operator",
    author: "operator",
    body: "hello",
    createdAt: "2026-07-23T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

describe("buildCommentThread", () => {
  it("groups single-level replies under their top-level parent, chronologically", () => {
    const root1 = comment({ id: "wic_00000000000a", body: "first root" })
    const reply = comment({ id: "wic_00000000000b", parentCommentId: "wic_00000000000a", body: "a reply" })
    const root2 = comment({ id: "wic_00000000000c", body: "second root", createdAt: "2026-07-23T11:00:00.000Z" })
    const thread = buildCommentThread([root1, reply, root2])
    expect(thread.map((n) => n.comment.id)).toEqual(["wic_00000000000a", "wic_00000000000c"])
    expect(thread[0].replies.map((r) => r.id)).toEqual(["wic_00000000000b"])
  })

  it("promotes a reply whose parent fell outside the loaded page instead of dropping it", () => {
    const orphan = comment({ id: "wic_00000000000d", parentCommentId: "wic_unloaded", body: "orphan reply" })
    const thread = buildCommentThread([orphan])
    expect(thread).toHaveLength(1)
    expect(thread[0].comment.id).toBe("wic_00000000000d")
    expect(thread[0].comment.parentCommentId).toBeNull()
  })
})
