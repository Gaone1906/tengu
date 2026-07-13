/**
 * Limits-page freshness regression guard.
 *
 * The old page fetched once on mount and never again, and it trusted the
 * server's frozen `stale` boolean. A tab left open for hours kept showing the
 * mount-time snapshot with mount-time labels, presenting 19h-old data as
 * "current". These tests pin the client-owned freshness policy: a bounded,
 * deduplicated refresh on mount / expiry-while-visible / visibility-return /
 * reconnect, plus a display-time freshness derivation that stays honest as
 * time passes regardless of the server's boolean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"

const refreshEngineLimits = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    refreshEngineLimits: (...args: unknown[]) => refreshEngineLimits(...args),
  },
}))

// Mutable fake gateway context — connectionSeq bumps model a reconnect.
let gateway = { connectionSeq: 1, connected: true }
vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => gateway,
}))

import {
  useEngineLimits,
  deriveFreshness,
  LIMITS_REFRESH_INTERVAL_MS,
  LIMITS_FRESHNESS_MS,
} from "../use-engine-limits"

function snapshot(over: Partial<EngineLimitEngineSnapshot> = {}): EngineLimitEngineSnapshot {
  return {
    name: "claude",
    available: true,
    status: "snapshot",
    source: "claude-statusline",
    refreshedAt: new Date().toISOString(),
    models: [],
    windows: [{ name: "5h", usedPercent: 20, windowDurationMins: 300 }],
    ...over,
  }
}

function response(engines: EngineLimitEngineSnapshot[] = [snapshot()]): EngineLimitsResponse {
  return {
    generatedAt: new Date().toISOString(),
    default: "claude",
    engines: Object.fromEntries(engines.map((e) => [e.name, e])),
  }
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  refreshEngineLimits.mockReset()
  refreshEngineLimits.mockResolvedValue(response())
  gateway = { connectionSeq: 1, connected: true }
  setVisibility("visible")
})

afterEach(() => {
  vi.useRealTimers()
})

describe("deriveFreshness — honest display-time classification", () => {
  it("classifies a 19h-old snapshot as stale even when the server says stale:false", () => {
    const now = Date.now()
    const engine = snapshot({
      status: "snapshot",
      stale: false, // frozen server boolean from 19h ago
      refreshedAt: new Date(now - 19 * 60 * 60_000).toISOString(),
    })
    const fresh = deriveFreshness(engine, now)
    expect(fresh.kind).toBe("stale")
    expect(fresh.ageMs).toBeGreaterThan(LIMITS_FRESHNESS_MS)
  })

  it("classifies a snapshot within the freshness window as fresh", () => {
    const now = Date.now()
    const engine = snapshot({ refreshedAt: new Date(now - 60_000).toISOString() })
    expect(deriveFreshness(engine, now).kind).toBe("fresh")
  })

  it("reports live for a genuinely live source and never marks it stale", () => {
    const now = Date.now()
    const engine = snapshot({
      status: "live",
      refreshedAt: new Date(now - 19 * 60 * 60_000).toISOString(),
    })
    expect(deriveFreshness(engine, now).kind).toBe("live")
  })

  it("maps error and unsupported statuses distinctly", () => {
    const now = Date.now()
    expect(deriveFreshness(snapshot({ status: "error", error: "x" }), now).kind).toBe("error")
    expect(deriveFreshness(snapshot({ status: "unsupported" }), now).kind).toBe("unsupported")
  })
})

describe("useEngineLimits — bounded, deduplicated refresh policy", () => {
  it("fetches once on initial mount", async () => {
    renderHook(() => useEngineLimits())
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("does not storm on rerenders", async () => {
    const { rerender } = renderHook(() => useEngineLimits())
    await flush()
    rerender()
    rerender()
    rerender()
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("re-fetches when the freshness window expires while visible", async () => {
    vi.useFakeTimers()
    renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_REFRESH_INTERVAL_MS + 10) })
    expect(refreshEngineLimits.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("does not poll while the tab is hidden", async () => {
    vi.useFakeTimers()
    renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility("hidden") })
    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_REFRESH_INTERVAL_MS * 3) })
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("re-fetches when the tab returns to the foreground", async () => {
    renderHook(() => useEngineLimits())
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility("hidden") })
    await act(async () => { setVisibility("visible") })
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(2)
  })

  it("re-fetches on reconnect (connectionSeq change)", async () => {
    const { rerender } = renderHook(() => useEngineLimits())
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
    gateway = { ...gateway, connectionSeq: 2 }
    rerender()
    await flush()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent triggers into a single in-flight request", async () => {
    let resolve!: (v: EngineLimitsResponse) => void
    refreshEngineLimits.mockImplementation(
      () => new Promise<EngineLimitsResponse>((r) => { resolve = r }),
    )
    const { result, rerender } = renderHook(() => useEngineLimits())
    await Promise.resolve()
    // Fire visibility-return AND reconnect while the mount fetch is still pending.
    await act(async () => { setVisibility("hidden") })
    await act(async () => { setVisibility("visible") })
    gateway = { ...gateway, connectionSeq: 3 }
    rerender()
    expect(refreshEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(response()) })
    expect(result.current.refreshing).toBe(false)
  })

  it("keeps last-known data when a refresh fails (restart recovery)", async () => {
    const good = response([snapshot({ windows: [{ name: "5h", usedPercent: 42 }] })])
    refreshEngineLimits.mockResolvedValueOnce(good)
    const { result } = renderHook(() => useEngineLimits())
    await flush()
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(42)

    refreshEngineLimits.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    act(() => { result.current.refresh() })
    await flush()
    // Data survives; error surfaced alongside it.
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(42)
    expect(result.current.error).toContain("ECONNREFUSED")
  })
})
