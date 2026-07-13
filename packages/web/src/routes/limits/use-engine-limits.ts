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
/** Abort a single refresh after this long so a hung request can never wedge the
 *  in-flight guard and discard every subsequent trigger. */
export const LIMITS_REQUEST_TIMEOUT_MS = 8_000
/** Display-clock cadence: advances the freshness labels/states while the page
 *  stays open, independent of whether a fetch ever completes. */
export const LIMITS_TICK_MS = 30_000

export type FreshnessKind =
  | "live"
  | "fresh"
  | "stale"
  | "error"
  | "unavailable"
  | "unsupported"
  | "nodata"
export interface FreshnessView {
  kind: FreshnessKind
  /** Age of the last-known snapshot at evaluation time, when one exists. */
  ageMs?: number
}

function classifyAge(ageMs: number): FreshnessView {
  return ageMs > LIMITS_FRESHNESS_MS ? { kind: "stale", ageMs } : { kind: "fresh", ageMs }
}

function hasObservedWindows(engine: EngineLimitEngineSnapshot | undefined): boolean {
  return engine?.windows?.some((w) => w.usedPercent !== undefined) ?? false
}

/**
 * Classify an engine's freshness at *display* time, from its captured-at
 * timestamp against `nowMs` — never from the server's `stale` boolean, which
 * freezes the instant the response is fetched and would otherwise let a
 * long-open tab keep presenting hours-old data as current.
 */
export function deriveFreshness(engine: EngineLimitEngineSnapshot, nowMs: number): FreshnessView {
  const hasObserved = hasObservedWindows(engine)
  // Retained last-known windows annotated with a current refresh failure (see
  // mergeAuthoritative): never fresh — surface as stale-last-known with its
  // real age so the current error can sit beside honest data.
  if (hasObserved && engine.error) {
    const t = engine.refreshedAt ? Date.parse(engine.refreshedAt) : NaN
    return { kind: "stale", ageMs: Number.isFinite(t) ? Math.max(0, nowMs - t) : undefined }
  }
  if (engine.status === "error") return { kind: "error" }
  if (engine.status === "unavailable") return { kind: "unavailable" }
  if (engine.status === "unsupported") return { kind: "unsupported" }
  if (engine.status === "live") return { kind: "live" }

  const t = engine.refreshedAt ? Date.parse(engine.refreshedAt) : NaN
  if (!Number.isFinite(t)) {
    return hasObserved ? { kind: "stale" } : { kind: "nodata" }
  }
  const ageMs = Math.max(0, nowMs - t)
  // `static` = capability-only (no observed usage window) → not a freshness claim.
  if (engine.status === "static" && !hasObserved) return { kind: "nodata", ageMs }
  return classifyAge(ageMs)
}

function degradedReason(engine: EngineLimitEngineSnapshot): string {
  return engine.error || engine.unsupportedReason || `provider ${engine.status}`
}

/**
 * Merge a fresh response over the last-known one, per engine. When the new
 * snapshot for an engine lacks usable windows (a degraded error/unavailable/
 * unsupported response arriving as HTTP 200) but the previous one had
 * authoritative windows, retain those windows AND their original captured-at
 * timestamp, and attach the current degradation as an error so the UI shows
 * honest stale last-known data beside the live failure. Never overwrites good
 * data with an empty snapshot.
 */
export function mergeAuthoritative(
  prev: EngineLimitsResponse | null,
  next: EngineLimitsResponse,
): EngineLimitsResponse {
  if (!prev) return next
  const engines: Record<string, EngineLimitEngineSnapshot> = { ...next.engines }
  for (const [name, ne] of Object.entries(next.engines)) {
    if (hasObservedWindows(ne)) continue
    const pe = prev.engines[name]
    if (pe && hasObservedWindows(pe)) {
      engines[name] = {
        ...pe, // keep authoritative windows + original refreshedAt/status/plan
        error: `Couldn’t refresh — showing last-known values (${degradedReason(ne)}).`,
      }
    }
  }
  return { ...next, engines }
}

export interface EngineLimitsState {
  data: EngineLimitsResponse | null
  phase: "loading" | "ready"
  refreshing: boolean
  error: string | null
  /** Bounded display clock — pass to deriveFreshness/label helpers so freshness
   *  advances while the page stays open, independent of fetch completion. */
  now: number
  refresh: () => void
}

/**
 * Owns the Limits page's refresh policy: initial load, expiry-while-visible,
 * visibility-return, and reconnect — all funnelled through one in-flight guard
 * so coincident triggers coalesce into a single request. Each request is
 * abort-bounded so a hung fetch can never wedge the guard; a failed or
 * degraded refresh keeps the last-known data (restart/offline recovery) and
 * surfaces the error beside it; and a display clock keeps freshness honest
 * even when no fetch ever completes.
 */
export function useEngineLimits(): EngineLimitsState {
  const { connectionSeq } = useGateway()
  const visible = usePageVisibility()
  const [data, setData] = useState<EngineLimitsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)

    const controller = new AbortController()
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      inFlight.current = false
      setRefreshing(false)
      setLoaded(true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      controller.abort()
      setError("Timed out refreshing engine limits.")
      settle()
    }, LIMITS_REQUEST_TIMEOUT_MS)

    api
      .getEngineLimits(undefined, { signal: controller.signal })
      .then((res) => {
        if (settled) return
        setData((prev) => mergeAuthoritative(prev, res))
        setError(null)
      })
      .catch((err) => {
        if (settled || controller.signal.aborted) return // timeout path already handled
        setError(err instanceof Error ? err.message : "Failed to load engine limits")
      })
      .finally(settle)
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

  // Display clock: advance `now` while visible so freshness labels/states move
  // forward on their own, even if a fetch hangs or the snapshot never changes.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), LIMITS_TICK_MS)
    return () => clearInterval(id)
  }, [visible])

  return { data, phase: loaded ? "ready" : "loading", refreshing, error, now, refresh }
}
