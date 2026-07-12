import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const { api, ApiError, TodoApiError } = await import("../api")

describe("typed API errors", () => {
  beforeEach(() => authFetch.mockReset())

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
      workItem: { id: "private-id", title: "Desired", version: 8 },
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
  })

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
