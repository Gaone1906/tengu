/**
 * Limits-page freshness regression guard.
 *
 * The old page fetched once on mount and never again, and it trusted the
 * server's frozen `stale` boolean. A tab left open for hours kept showing the
 * mount-time snapshot with mount-time labels, presenting 19h-old data as
 * "current". These tests pin the client-owned freshness policy: a bounded,
 * deduplicated refresh on mount / expiry-while-visible / visibility-return /
 * reconnect; a display-time freshness derivation that stays honest as time
 * passes; preservation of last-known authoritative windows across a degraded
 * response; a request timeout that never wedges; and a display clock that
 * advances independent of fetch completion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"

const getEngineLimits = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    getEngineLimits: (...args: unknown[]) => getEngineLimits(...args),
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
  LIMITS_REQUEST_TIMEOUT_MS,
  LIMITS_TICK_MS,
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
  getEngineLimits.mockReset()
  getEngineLimits.mockResolvedValue(response())
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

  it("distinguishes unavailable (CLI missing) from unsupported (no quota endpoint)", () => {
    const now = Date.now()
    expect(deriveFreshness(snapshot({ status: "error", error: "x", windows: [] }), now).kind).toBe("error")
    expect(deriveFreshness(snapshot({ status: "unavailable", windows: [] }), now).kind).toBe("unavailable")
    expect(deriveFreshness(snapshot({ status: "unsupported", windows: [] }), now).kind).toBe("unsupported")
  })

  it("never reports preserved last-known windows as fresh, even when their age is recent", () => {
    const now = Date.now()
    const preserved = snapshot({
      status: "snapshot",
      refreshedAt: new Date(now - 2 * 60_000).toISOString(), // only 2 min old
      windows: [{ name: "5h", usedPercent: 42 }],
      error: "Couldn’t refresh — showing last-known values (provider error).",
    })
    expect(deriveFreshness(preserved, now).kind).toBe("stale")
  })
})

describe("useEngineLimits — bounded, deduplicated refresh policy", () => {
  it("fetches once on initial mount", async () => {
    renderHook(() => useEngineLimits())
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("does not storm on rerenders", async () => {
    const { rerender } = renderHook(() => useEngineLimits())
    await flush()
    rerender()
    rerender()
    rerender()
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("re-fetches when the freshness window expires while visible", async () => {
    vi.useFakeTimers()
    renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_REFRESH_INTERVAL_MS + 10) })
    expect(getEngineLimits.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("does not poll while the tab is hidden", async () => {
    vi.useFakeTimers()
    renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility("hidden") })
    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_REFRESH_INTERVAL_MS * 3) })
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
  })

  it("re-fetches when the tab returns to the foreground", async () => {
    renderHook(() => useEngineLimits())
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility("hidden") })
    await act(async () => { setVisibility("visible") })
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(2)
  })

  it("re-fetches on reconnect (connectionSeq change)", async () => {
    const { rerender } = renderHook(() => useEngineLimits())
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
    gateway = { ...gateway, connectionSeq: 2 }
    rerender()
    await flush()
    expect(getEngineLimits).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent triggers into a single in-flight request", async () => {
    let resolve!: (v: EngineLimitsResponse) => void
    getEngineLimits.mockImplementation(
      () => new Promise<EngineLimitsResponse>((r) => { resolve = r }),
    )
    const { result, rerender } = renderHook(() => useEngineLimits())
    await Promise.resolve()
    // Fire visibility-return AND reconnect while the mount fetch is still pending.
    await act(async () => { setVisibility("hidden") })
    await act(async () => { setVisibility("visible") })
    gateway = { ...gateway, connectionSeq: 3 }
    rerender()
    expect(getEngineLimits).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(response()) })
    expect(result.current.refreshing).toBe(false)
  })

  it("keeps last-known data when a refresh fails (restart recovery)", async () => {
    const good = response([snapshot({ windows: [{ name: "5h", usedPercent: 42 }] })])
    getEngineLimits.mockResolvedValueOnce(good)
    const { result } = renderHook(() => useEngineLimits())
    await flush()
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(42)

    getEngineLimits.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    act(() => { result.current.refresh() })
    await flush()
    // Data survives; error surfaced alongside it.
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(42)
    expect(result.current.error).toContain("ECONNREFUSED")
  })
})

describe("useEngineLimits — degraded-response preservation", () => {
  it("preserves last authoritative windows when a later 200 is degraded, retaining its age", async () => {
    const capturedAt = new Date(Date.now() - 3 * 60_000).toISOString()
    const authoritative = response([
      snapshot({ refreshedAt: capturedAt, windows: [{ name: "5h", usedPercent: 42, windowDurationMins: 300 }] }),
    ])
    // A real provider-level error arriving as HTTP 200 with no usable windows.
    const degraded = response([
      snapshot({ status: "error", error: "provider blew up", windows: [], refreshedAt: new Date().toISOString() }),
    ])
    getEngineLimits.mockResolvedValueOnce(authoritative).mockResolvedValueOnce(degraded)

    const { result } = renderHook(() => useEngineLimits())
    await flush()
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(42)

    act(() => { result.current.refresh() })
    await flush()
    const claude = result.current.data?.engines.claude
    // Authoritative windows preserved, with their ORIGINAL capture time…
    expect(claude?.windows?.[0].usedPercent).toBe(42)
    expect(claude?.refreshedAt).toBe(capturedAt)
    // …and the current degradation surfaced honestly beside it.
    expect(claude?.error).toContain("provider blew up")
    // Never fresh: the preserved snapshot classifies as stale-last-known.
    expect(deriveFreshness(claude!, Date.now()).kind).toBe("stale")
  })

  it("uses the new snapshot when it carries usable windows (no stale preservation)", async () => {
    getEngineLimits
      .mockResolvedValueOnce(response([snapshot({ windows: [{ name: "5h", usedPercent: 42 }] })]))
      .mockResolvedValueOnce(response([snapshot({ windows: [{ name: "5h", usedPercent: 71 }] })]))
    const { result } = renderHook(() => useEngineLimits())
    await flush()
    act(() => { result.current.refresh() })
    await flush()
    expect(result.current.data?.engines.claude.windows?.[0].usedPercent).toBe(71)
    expect(result.current.data?.engines.claude.error).toBeFalsy()
  })
})

describe("useEngineLimits — timeout recovery + display clock", () => {
  it("recovers from a never-resolving request and accepts a later trigger", async () => {
    vi.useFakeTimers()
    getEngineLimits.mockReturnValue(new Promise<EngineLimitsResponse>(() => {})) // never resolves
    const { result } = renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.refreshing).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_REQUEST_TIMEOUT_MS + 10) })
    // Wedge cleared: not refreshing, honest error, request count still 1.
    expect(result.current.refreshing).toBe(false)
    expect(result.current.error?.toLowerCase()).toContain("time")
    expect(getEngineLimits).toHaveBeenCalledTimes(1)

    // A subsequent manual trigger must fire a fresh request (in-flight released).
    getEngineLimits.mockResolvedValueOnce(response())
    await act(async () => { result.current.refresh() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getEngineLimits).toHaveBeenCalledTimes(2)
  })

  it("advances the display clock while visible, independent of fetch completion", async () => {
    vi.useFakeTimers()
    getEngineLimits.mockResolvedValue(response())
    const { result } = renderHook(() => useEngineLimits())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const before = result.current.now
    const callsAfterMount = getEngineLimits.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(LIMITS_TICK_MS + 10) })
    expect(result.current.now).toBeGreaterThan(before)
    // The clock tick must not itself trigger a network refresh.
    expect(getEngineLimits.mock.calls.length).toBe(callsAfterMount)
  })
})
