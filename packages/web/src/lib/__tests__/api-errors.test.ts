import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const { api, ApiError } = await import("../api")

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
})
