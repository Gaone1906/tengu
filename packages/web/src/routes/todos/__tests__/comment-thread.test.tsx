import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCommentPageWire, WorkItemCommentWire } from "@/lib/api"
import { CommentThread, buildCommentThread } from "../comment-thread"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

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

function page(comments: WorkItemCommentWire[]): WorkItemCommentPageWire {
  return { comments, total: comments.length, limit: 500, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function renderThread(initial: WorkItemCommentPageWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CommentThread workItemId="JIN-7" tail={initial} byName={new Map()} />
    </QueryClientProvider>,
  )
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
})

describe("CommentThread", () => {
  beforeEach(() => {
    authFetch.mockReset()
  })

  it("renders the thread with count, reply indent, and a [deleted] tombstone", async () => {
    const comments = [
      comment({ id: "wic_00000000000a", body: "root comment", author: "operator", authorKind: "operator" }),
      comment({ id: "wic_00000000000b", parentCommentId: "wic_00000000000a", body: "agent reply", author: "a-lead", authorKind: "employee" }),
      comment({ id: "wic_00000000000c", body: "", deletedAt: "2026-07-23T12:00:00.000Z" }),
    ]
    authFetch.mockResolvedValue(jsonResponse(page(comments)))
    renderThread(page(comments))

    expect(await screen.findByText("root comment")).toBeTruthy()
    expect(screen.getByTestId("comment-count").textContent).toContain("3")
    expect(screen.getByText("agent reply")).toBeTruthy()
    expect(screen.getByText("a-lead")).toBeTruthy()
    expect(screen.getByText("[deleted]")).toBeTruthy()
    // The reply renders inside its parent's replies container (single-level indent).
    const replies = screen.getByTestId("comment-replies-wic_00000000000a")
    expect(within(replies).getByText("agent reply")).toBeTruthy()
  })

  it("posts a new comment from the composer", async () => {
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ comment: comment({ id: "wic_00000000000d", body: "typed" }) }, 201)
      return jsonResponse(page([]))
    })
    renderThread(page([]))

    fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "typed" } })
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      expect(post).toBeTruthy()
      expect(post![0]).toBe("/api/work-items/JIN-7/comments")
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ body: "typed" })
    })
  })

  it("sends parentCommentId when replying to a comment", async () => {
    const root = comment({ id: "wic_00000000000a", body: "root comment" })
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ comment: comment({ id: "wic_00000000000e" }) }, 201)
      return jsonResponse(page([root]))
    })
    renderThread(page([root]))

    fireEvent.click(await screen.findByRole("button", { name: "Reply" }))
    fireEvent.change(screen.getByPlaceholderText("Reply…"), { target: { value: "my reply" } })
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      expect(post).toBeTruthy()
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ body: "my reply", parentCommentId: "wic_00000000000a" })
    })
  })

  it("offers Edit only on operator-authored comments, Delete on any, and round-trips both", async () => {
    const mine = comment({ id: "wic_00000000000a", body: "operator words" })
    const theirs = comment({ id: "wic_00000000000b", body: "agent words", author: "a-lead", authorKind: "employee" })
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ comment: { ...mine, body: "operator words v2", editedAt: "2026-07-23T13:00:00.000Z" } })
      if (init?.method === "DELETE") return jsonResponse({ comment: { ...theirs, body: "", deletedAt: "2026-07-23T13:00:00.000Z" } })
      return jsonResponse(page([mine, theirs]))
    })
    renderThread(page([mine, theirs]))

    await screen.findByText("operator words")
    const mineItem = screen.getByTestId("comment-wic_00000000000a")
    const theirsItem = screen.getByTestId("comment-wic_00000000000b")
    expect(within(mineItem).getByRole("button", { name: "Edit" })).toBeTruthy()
    expect(within(theirsItem).queryByRole("button", { name: "Edit" })).toBeNull()
    expect(within(theirsItem).getByRole("button", { name: "Delete" })).toBeTruthy()

    fireEvent.click(within(mineItem).getByRole("button", { name: "Edit" }))
    const editBox = within(mineItem).getByDisplayValue("operator words")
    fireEvent.change(editBox, { target: { value: "operator words v2" } })
    fireEvent.click(within(mineItem).getByRole("button", { name: "Save" }))
    await waitFor(() => {
      const patchCall = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
      expect(patchCall).toBeTruthy()
      expect(patchCall![0]).toBe("/api/work-items/JIN-7/comments/wic_00000000000a")
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ body: "operator words v2" })
    })

    fireEvent.click(within(theirsItem).getByRole("button", { name: "Delete" }))
    await waitFor(() => {
      const deleteCall = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      expect(deleteCall).toBeTruthy()
      expect(deleteCall![0]).toBe("/api/work-items/JIN-7/comments/wic_00000000000b")
    })
  })
})
