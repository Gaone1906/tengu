import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  invalidateTodoCaches,
  maximumTodoVersion,
  mergeTodoIntoCaches,
  newTodoEditRequest,
} from "../todo-edit-request"

describe("Todo conditional edit requests", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it("mints one cryptographically random key for an immutable request envelope", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111")
    const patch = { title: "Desired", assignee: null }

    const request = newTodoEditRequest(patch, 7)

    expect(request).toEqual({
      patch,
      expectedVersion: 7,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    })
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it("snapshots the caller-owned patch when minting the request", () => {
    const patch = { title: "Sent title", priority: 1 }

    const request = newTodoEditRequest(patch, 7)
    patch.title = "Mutated after mint"
    patch.priority = 3

    expect(request.patch).toEqual({ title: "Sent title", priority: 1 })
    expect(request.patch).not.toBe(patch)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected version %s before minting a request key",
    (expectedVersion) => {
      const randomUUID = vi.spyOn(crypto, "randomUUID")

      expect(() => newTodoEditRequest({ title: "Desired" }, expectedVersion)).toThrow("positive safe integer")
      expect(randomUUID).not.toHaveBeenCalled()
    },
  )
})

describe("Todo cache version authority", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it("chooses the maximum Todo version across adversarial duplicate caches", () => {
    queryClient.setQueryData(["work-items", "ledger", "backlog"], {
      pages: [{ workItems: [{ id: "private-id", version: 9 }] }],
      pageParams: [0],
    })
    queryClient.setQueryData(["work-item", "private-id"], {
      workItem: { id: "private-id", version: 4 },
    })
    queryClient.setQueryData(["work-items", "needs-attention", "me"], [
      { id: "private-id", version: 12 },
      { id: "other-id", version: 99 },
      { id: "private-id", version: 0 },
      { id: "private-id", version: 1.5 },
      { id: "private-id", version: Number.MAX_SAFE_INTEGER + 1 },
      { id: "private-id", version: "100" },
    ])

    expect(maximumTodoVersion(queryClient, "private-id")).toBe(12)
    expect(maximumTodoVersion(queryClient, "missing-id")).toBeUndefined()
  })

  it("merges only version-monotonic Todo rows throughout list and detail caches", () => {
    queryClient.setQueryData(["work-items", "ledger", "backlog"], {
      pages: [{ workItems: [
        { id: "private-id", title: "list old", version: 9 },
        { id: "other-id", title: "other", version: 1 },
      ] }],
      pageParams: [0],
    })
    queryClient.setQueryData(["work-item", "private-id"], {
      workItem: { id: "private-id", title: "detail newer", version: 11 },
      spendUsd: 3,
    })
    queryClient.setQueryData(["work-items", "needs-attention", "me"], [
      { id: "private-id", title: "needs equal", version: 10 },
    ])

    mergeTodoIntoCaches(queryClient, { id: "private-id", title: "server", version: 10 })

    expect(queryClient.getQueryData(["work-items", "ledger", "backlog"])).toMatchObject({
      pages: [{ workItems: [
        { id: "private-id", title: "server", version: 10 },
        { id: "other-id", title: "other", version: 1 },
      ] }],
    })
    expect(queryClient.getQueryData(["work-item", "private-id"])).toMatchObject({
      workItem: { id: "private-id", title: "detail newer", version: 11 },
      spendUsd: 3,
    })
    expect(queryClient.getQueryData(["work-items", "needs-attention", "me"])).toEqual([
      { id: "private-id", title: "server", version: 10 },
    ])
  })

  it("invalidates all Todo list/search caches and the exact detail cache", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    await invalidateTodoCaches(queryClient, "private-id")

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work-items"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work-item", "private-id"], exact: true })
  })
})
