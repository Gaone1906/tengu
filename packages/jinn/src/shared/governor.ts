import fs from "node:fs";
import path from "node:path";
import type { GovernorConfig } from "./types.js";
import { CLAUDE_LIMITS_DIR } from "./paths.js";

export const DEFAULT_GOVERNOR_STOP_PCT = 80;

/** Per-session/account Claude usage snapshot, shaped to match the eventual
 *  shared/session-telemetry.ts sensor output — evaluateGovernor consumes this
 *  shape whether it comes from that module or the local fallback reader below. */
export interface GovernorTelemetry {
  fiveHourUsedPct?: number;
  fiveHourResetsAt?: string;
  sevenDayUsedPct?: number;
  sevenDayResetsAt?: string;
  contextUsedPct?: number;
  capturedAt?: string;
  stale?: boolean;
}

export type GovernorAction = "run" | "handoff" | "halt";

export interface GovernorDecision {
  action: GovernorAction;
  reason: string;
  /** ISO timestamp of the window reset that would clear a "halt". Absent for
   *  "run" and "handoff" — context compaction has no window to wait out. */
  resumeAt?: string;
}

function resolveThreshold(configured: number | undefined): number {
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GOVERNOR_STOP_PCT;
}

export function resolveGovernorConfig(config: GovernorConfig | undefined): Required<GovernorConfig> {
  return {
    fiveHourStopPct: resolveThreshold(config?.fiveHourStopPct),
    sevenDayStopPct: resolveThreshold(config?.sevenDayStopPct),
    contextCompactPct: resolveThreshold(config?.contextCompactPct),
  };
}

/**
 * Deterministic usage governor. Tracks both the 5-hour and 7-day Claude usage
 * windows independently and halts if EITHER would cross its stop threshold —
 * the 7-day cap is checked first because it's the harder stop (a 5-hour halt
 * clears in hours; a 7-day halt clears in days), so its reason wins when both
 * windows are over threshold at once. Context usage is a separate, softer
 * signal ("handoff" — compact in place, D5) and never blocks a spawn.
 */
export function evaluateGovernor(
  telemetry: GovernorTelemetry,
  config: GovernorConfig | undefined,
): GovernorDecision {
  const thresholds = resolveGovernorConfig(config);

  if (
    typeof telemetry.sevenDayUsedPct === "number" &&
    telemetry.sevenDayUsedPct >= thresholds.sevenDayStopPct
  ) {
    return {
      action: "halt",
      reason: `7-day usage at ${telemetry.sevenDayUsedPct}% has reached the ${thresholds.sevenDayStopPct}% stop threshold`,
      resumeAt: telemetry.sevenDayResetsAt,
    };
  }

  if (
    typeof telemetry.fiveHourUsedPct === "number" &&
    telemetry.fiveHourUsedPct >= thresholds.fiveHourStopPct
  ) {
    return {
      action: "halt",
      reason: `5-hour usage at ${telemetry.fiveHourUsedPct}% has reached the ${thresholds.fiveHourStopPct}% stop threshold`,
      resumeAt: telemetry.fiveHourResetsAt,
    };
  }

  if (
    typeof telemetry.contextUsedPct === "number" &&
    telemetry.contextUsedPct >= thresholds.contextCompactPct
  ) {
    return {
      action: "handoff",
      reason: `context usage at ${telemetry.contextUsedPct}% has reached the ${thresholds.contextCompactPct}% compaction threshold`,
    };
  }

  return { action: "run", reason: "usage within thresholds" };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Freshest `<sessionId>.json` statusline snapshot in a Claude engine-limits
 * directory, preferring one that actually carries rate-limit data. Mirrors
 * shared/engine-limits.ts's own account-level file-selection heuristic; kept
 * as a local copy rather than an import so the governor's enforcement path
 * has no dependency on that module's internals.
 */
function latestClaudeSnapshotFile(dir: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .map((file) => {
        let hasRateLimits = false;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
          hasRateLimits = !!parsed?.rate_limits?.five_hour || !!parsed?.rate_limits?.seven_day;
        } catch { /* ignore corrupt snapshots here; fall through to the next-best file */ }
        return { file, hasRateLimits, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.find((f) => f.hasRateLimits)?.file ?? files[0]?.file ?? null;
  } catch {
    return null;
  }
}

/**
 * Free, local, network-free telemetry read for the enforcement call site — the
 * same statusline snapshot the Limits page falls back to (shared/engine-limits.ts),
 * not the OAuth usage API. Claude's 5-hour/7-day windows are account-wide, so any
 * session's freshest snapshot reflects current account usage regardless of which
 * session is about to spawn. Returns {} (→ "run") when no snapshot exists yet.
 */
export function readLocalGovernorTelemetry(): GovernorTelemetry {
  const latest = latestClaudeSnapshotFile(CLAUDE_LIMITS_DIR);
  if (!latest) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(latest, "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};

    const rateLimits = isRecord(parsed.rate_limits) ? parsed.rate_limits : {};
    const fiveHour = isRecord(rateLimits.five_hour) ? rateLimits.five_hour : undefined;
    const sevenDay = isRecord(rateLimits.seven_day) ? rateLimits.seven_day : undefined;
    const context = isRecord(parsed.context_window) ? parsed.context_window : undefined;

    const fiveHourResetsAtSec = fiveHour ? num(fiveHour.resets_at) : undefined;
    const sevenDayResetsAtSec = sevenDay ? num(sevenDay.resets_at) : undefined;

    const stat = fs.statSync(latest);
    return {
      fiveHourUsedPct: fiveHour ? num(fiveHour.used_percentage) : undefined,
      fiveHourResetsAt: fiveHourResetsAtSec ? new Date(fiveHourResetsAtSec * 1000).toISOString() : undefined,
      sevenDayUsedPct: sevenDay ? num(sevenDay.used_percentage) : undefined,
      sevenDayResetsAt: sevenDayResetsAtSec ? new Date(sevenDayResetsAtSec * 1000).toISOString() : undefined,
      contextUsedPct: context ? num(context.used_percentage) : undefined,
      capturedAt: typeof parsed.captured_at === "string" ? parsed.captured_at : new Date(stat.mtimeMs).toISOString(),
      stale: Date.now() - stat.mtimeMs > 30 * 60_000,
    };
  } catch {
    return {};
  }
}
