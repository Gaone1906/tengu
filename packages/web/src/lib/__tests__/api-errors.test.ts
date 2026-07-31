import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const { api, ApiError, TodoApiError } = await import("../api")

describe("typed API errors", () => {
  beforeEach(() => authFetch.mockReset())

  it("unwraps the legacy sessions envelope for pinned-session version skew", async () => {
    const sessions = [{ id: "session-pinned" }]
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      sessions,
      counts: { __direct__: 1 },
      perGroup: 50,
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    await expect(api.getPinnedSessions()).resolves.toEqual(sessions)
  })

  it("preserves the current pinned-session array response", async () => {
    const sessions = [{ id: "session-current" }]
    authFetch.mockResolvedValue(new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    await expect(api.getPinnedSessions()).resolves.toEqual(sessions)
  })

  it("posts every rich-create field exactly once", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      workItem: { id: "OPS-7", title: "Ship the ledger" },
    }), { status: 201, headers: { "Content-Type": "application/json" } }))

    await api.createWorkItem({
      title: "Ship the ledger",
      body: "Keep the board intact.",
      acceptance: "List and board both work.",
      department: "operations",
      priority: 3,
      dueAt: "2026-08-12T12:00:00.000Z",
      parentId: "OPS-2",
      labels: ["lbl-design", "lbl-release"],
    })

    expect(authFetch).toHaveBeenCalledTimes(1)
    const [path, fetchInit] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe("/api/work-items")
    expect(fetchInit.method).toBe("POST")
    expect(JSON.parse(String(fetchInit.body))).toEqual({
      title: "Ship the ledger",
      body: "Keep the board intact.",
      acceptance: "List and board both work.",
      department: "operations",
      priority: 3,
      dueAt: "2026-08-12T12:00:00.000Z",
      parentId: "OPS-2",
      labels: ["lbl-design", "lbl-release"],
    })
  })

  it("retains HTTP status and an optional machine code without making diagnostics UI copy", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      code: "WORK_ITEM_VERSION_CONFLICT",
      currentVersion: 17,
      error: "SQLITE_BUSY /srv/private.db token=secret",
    }), { status: 412, headers: { "Content-Type": "application/json" } }))

    const request = api.getWorkItem("wi_typed_error")
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({
      status: 412,
      code: "WORK_ITEM_VERSION_CONFLICT",
      currentVersion: 17,
      message: "SQLITE_BUSY /srv/private.db token=secret",
    })
  })

  it("sends the canonical conditional edit body and preserves replay metadata", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      workItem: { id: "private-id", title: "Desired", version: 8, rank: 512 },
      replayed: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    const result = await api.updateWorkItem("private-id", {
      patch: { title: "Desired" },
      expectedVersion: 7,
      idempotencyKey: "crypto-key",
    })

    const [path, fetchInit] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe("/api/work-items/private-id")
    expect(fetchInit.method).toBe("PATCH")
    expect(JSON.parse(String(fetchInit.body))).toEqual({
      title: "Desired",
      expectedVersion: 7,
      idempotencyKey: "crypto-key",
    })
    expect(result).toMatchObject({ workItem: { version: 8 }, replayed: true })
    expectTypeOf(result.workItem.version).toEqualTypeOf<number>()
    expect(result.workItem.rank).toBe(512)
    expectTypeOf(result.workItem.rank).toEqualTypeOf<number | null>()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected version %s before transport",
    async (expectedVersion) => {
      await expect(api.updateWorkItem("private-id", {
        patch: { title: "Desired" },
        expectedVersion,
        idempotencyKey: "crypto-key",
      })).rejects.toThrow("positive safe integer")
      expect(authFetch).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, "8", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed authoritative response version %s",
    async (version) => {
      authFetch.mockResolvedValue(new Response(JSON.stringify({
        workItem: { id: "private-id", title: "Desired", version },
        replayed: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))

      await expect(api.updateWorkItem("private-id", {
        patch: { title: "Desired" },
        expectedVersion: 7,
        idempotencyKey: "crypto-key",
      })).rejects.toThrow("invalid authoritative version")
    },
  )

  it.each([undefined, "false", 0, 1, null])(
    "rejects malformed replay metadata %s",
    async (replayed) => {
      authFetch.mockResolvedValue(new Response(JSON.stringify({
        workItem: { id: "private-id", title: "Desired", version: 8 },
        replayed,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))

      await expect(api.updateWorkItem("private-id", {
        patch: { title: "Desired" },
        expectedVersion: 7,
        idempotencyKey: "crypto-key",
      })).rejects.toThrow("invalid replay metadata")
    },
  )

  it("rethrows conditional edit failures as a structured Todo API error", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      code: "WORK_ITEM_VERSION_CONFLICT",
      currentVersion: 19,
      error: "private backend diagnostic",
    }), { status: 409, headers: { "Content-Type": "application/json" } }))

    const request = api.updateWorkItem("private-id", {
      patch: { title: "Desired" },
      expectedVersion: 7,
      idempotencyKey: "crypto-key",
    })

    await expect(request).rejects.toBeInstanceOf(TodoApiError)
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: "WORK_ITEM_VERSION_CONFLICT",
      currentVersion: 19,
      message: "private backend diagnostic",
    })
  })
})
