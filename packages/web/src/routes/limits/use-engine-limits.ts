import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import type { EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"
import { useGateway } from "@/hooks/use-gateway"
import { usePageVisibility } from "@/hooks/use-page-visibility"

/** Re-fetch cadence while the tab is visible. Bounded (one timer) and paused
 *  when hidden so a backgrounded dashboard never storms the gateway. */
export const LIMITS_REFRESH_INTERVAL_MS = 60_000
/** How long a captured snapshot may be presented as current before it is
 *  labelled stale. Mirrors the collector's own 30-minute staleness threshold. */
export const LIMITS_FRESHNESS_MS = 30 * 60_000

export type FreshnessKind = "live" | "fresh" | "stale" | "error" | "unsupported" | "nodata"
export interface FreshnessView {
  kind: FreshnessKind
  /** Age of the last-known snapshot at evaluation time, when one exists. */
  ageMs?: number
}

function classifyAge(ageMs: number): FreshnessView {
  return ageMs > LIMITS_FRESHNESS_MS ? { kind: "stale", ageMs } : { kind: "fresh", ageMs }
}

/**
 * Classify an engine's freshness at *display* time, from its captured-at
 * timestamp against `nowMs` — never from the server's `stale` boolean, which
 * freezes the instant the response is fetched and would otherwise let a
 * long-open tab keep presenting hours-old data as current.
 */
export function deriveFreshness(engine: EngineLimitEngineSnapshot, nowMs: number): FreshnessView {
  if (engine.status === "error") return { kind: "error" }
  if (engine.status === "unsupported") return { kind: "unsupported" }
  if (engine.status === "live") return { kind: "live" }

  const hasObserved = engine.windows?.some((w) => w.usedPercent !== undefined) ?? false
  const t = engine.refreshedAt ? Date.parse(engine.refreshedAt) : NaN
  if (!Number.isFinite(t)) {
    return hasObserved ? { kind: "stale" } : { kind: "nodata" }
  }
  const ageMs = Math.max(0, nowMs - t)
  // `static` = capability-only (no observed usage window) → not a freshness claim.
  if (engine.status === "static" && !hasObserved) return { kind: "nodata", ageMs }
  return classifyAge(ageMs)
}

export interface EngineLimitsState {
  data: EngineLimitsResponse | null
  phase: "loading" | "ready"
  refreshing: boolean
  error: string | null
  refresh: () => void
}

/**
 * Owns the Limits page's refresh policy: initial load, expiry-while-visible,
 * visibility-return, and reconnect — all funnelled through one in-flight guard
 * so coincident triggers coalesce into a single request. A failed refresh keeps
 * the last-known data (restart/offline recovery) and surfaces the error beside
 * it; it never blanks the page.
 */
export function useEngineLimits(): EngineLimitsState {
  const { connectionSeq } = useGateway()
  const visible = usePageVisibility()
  const [data, setData] = useState<EngineLimitsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    api
      .refreshEngineLimits()
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load engine limits"))
      .finally(() => {
        inFlight.current = false
        setRefreshing(false)
        setLoaded(true)
      })
  }, [])

  // Initial load.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Expiry: one bounded timer, live only while the tab is visible.
  useEffect(() => {
    if (!visible) return
    const id = setInterval(refresh, LIMITS_REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [visible, refresh])

  // Visibility return: refresh when the tab comes back to the foreground.
  const prevVisible = useRef(visible)
  useEffect(() => {
    if (visible && !prevVisible.current) refresh()
    prevVisible.current = visible
  }, [visible, refresh])

  // Reconnect: refresh when the gateway socket re-opens (connectionSeq bumps).
  const prevSeq = useRef(connectionSeq)
  useEffect(() => {
    if (connectionSeq !== prevSeq.current) {
      prevSeq.current = connectionSeq
      refresh()
    }
  }, [connectionSeq, refresh])

  return { data, phase: loaded ? "ready" : "loading", refreshing, error, refresh }
}
