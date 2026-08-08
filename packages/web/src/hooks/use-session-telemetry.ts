import { useEffect, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { usePageVisibility } from "@/hooks/use-page-visibility"
import type { GatewayEventMap } from "@jinn/gateway-events"

/** Display-clock cadence: advances reset-countdown labels between broadcasts,
 *  independent of whether a new event ever arrives. Mirrors LIMITS_TICK_MS in
 *  routes/limits/use-engine-limits.ts. */
export const SESSION_TELEMETRY_TICK_MS = 30_000

export type SessionTelemetryEvent = GatewayEventMap["session:telemetry"]
export type SessionTelemetryRow = SessionTelemetryEvent["sessions"][number]

export interface SessionTelemetryState {
  data: SessionTelemetryEvent | null
  phase: "loading" | "ready"
  /** Bounded display clock — pass to reset-countdown/freshness helpers so they
   *  advance while the page stays open, independent of the next broadcast. */
  now: number
}

/**
 * Owns the live session-telemetry view (Tengu steps 1–3) — the Limits page's
 * per-session cards and the nav-rail status dot both read from this. Modeled
 * on routes/limits/use-engine-limits.ts's state shape, but the transport is
 * push, not pull: the gateway already debounces `session:telemetry` to ~1s
 * and carries the full payload (session rows, account rollup, progress
 * rollups) on the existing live-events WebSocket, so there is nothing to poll
 * and no refresh() to expose — every consumer just reads the latest
 * broadcast.
 */
export function useSessionTelemetry(): SessionTelemetryState {
  const { subscribe } = useGateway()
  const visible = usePageVisibility()
  const [data, setData] = useState<SessionTelemetryEvent | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    return subscribe((frame) => {
      if (frame.event === "session:telemetry") {
        setData(frame.payload)
      }
    })
  }, [subscribe])

  // Display clock: advance `now` while visible so reset countdowns move
  // forward on their own even between broadcasts.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), SESSION_TELEMETRY_TICK_MS)
    return () => clearInterval(id)
  }, [visible])

  return { data, phase: data ? "ready" : "loading", now }
}

export type GovernorTone = "green" | "amber" | "red"

/** Green <60% / amber 60–80% / red ≥80%, the same three-color status-dot
 *  language the Limits page's engine cards and the Cron page already use.
 *  Takes the worse of the two windows — either can be the binding constraint. */
export function deriveGovernorTone(
  account: SessionTelemetryEvent["account"] | undefined,
): GovernorTone | null {
  const pct = Math.max(account?.fiveHourUsedPct ?? -1, account?.sevenDayUsedPct ?? -1)
  if (pct < 0) return null
  if (pct >= 80) return "red"
  if (pct >= 60) return "amber"
  return "green"
}
