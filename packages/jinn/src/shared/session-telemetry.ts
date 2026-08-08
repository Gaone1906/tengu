import fs from "node:fs";
import path from "node:path";
import { CLAUDE_LIMITS_DIR, ENGINE_LIMITS_DIR } from "./paths.js";
import { parseClaudeStatuslineSnapshot } from "./engine-limits.js";
import { getSession } from "../sessions/registry.js";
import type { Employee, Session } from "./types.js";

/**
 * Per-session Claude usage telemetry (Tengu step 1). Scans the same
 * `<sessionId>.json` statusline snapshots shared/engine-limits.ts reads for
 * the account-level Limits page, but keeps EVERY live session's row instead
 * of picking one freshest file — two or more sessions inside the same 5-hour
 * window is the normal case once the continuous loop (step 8) is running, and
 * only a per-session view can tell them apart.
 */

export interface SessionTelemetry {
  sessionId: string;
  employee: string | null;
  employeeDisplayName?: string;
  model: string | null;
  workItemId: string | null;
  status: Session["status"];
  contextUsedPct?: number;
  fiveHourUsedPct?: number;
  fiveHourResetsAt?: string;
  sevenDayUsedPct?: number;
  sevenDayResetsAt?: string;
  costUsd?: number;
  capturedAt?: string;
  stale: boolean;
}

type ParsedSessionSnapshot = Omit<SessionTelemetry, "sessionId" | "employee" | "employeeDisplayName" | "model" | "workItemId" | "status">;

const MISSING_OR_MALFORMED_SNAPSHOT: ParsedSessionSnapshot = { stale: true };

/**
 * Parse one session's statusline snapshot file. Missing and malformed files
 * degrade identically — a session with no readable telemetry is
 * indistinguishable from one whose file is corrupt, and both are simply
 * "stale" to a caller: there is no live usage number to show. Never throws.
 */
function readSessionSnapshot(file: string): ParsedSessionSnapshot {
  try {
    const parsed = parseClaudeStatuslineSnapshot(file);
    const fiveHour = parsed.windows.find((w) => w.name === "5h");
    const sevenDay = parsed.windows.find((w) => w.name === "7d");
    return {
      contextUsedPct: parsed.context?.usedPercent,
      fiveHourUsedPct: fiveHour?.usedPercent,
      fiveHourResetsAt: fiveHour?.resetsAtIso,
      sevenDayUsedPct: sevenDay?.usedPercent,
      sevenDayResetsAt: sevenDay?.resetsAtIso,
      costUsd: parsed.costUsd,
      capturedAt: parsed.capturedAtIso,
      stale: parsed.stale,
    };
  } catch {
    return MISSING_OR_MALFORMED_SNAPSHOT;
  }
}

export interface CollectSessionTelemetryOptions {
  /** Directory to scan; defaults to CLAUDE_LIMITS_DIR. Override in tests. */
  dir?: string;
  /** Employee roster to enrich display names — e.g. gateway/org.ts's
   *  scanOrg(). Optional and injected rather than resolved here: shared/
   *  modules stay independent of gateway/'s org-scanning machinery. */
  employees?: ReadonlyMap<string, Employee>;
}

/**
 * One row per live session with a captured snapshot, joined to the session
 * registry (employee, model, linked work item, status) and, if given, an
 * employee roster for display names. A snapshot file with no matching session
 * (deleted/duplicated session) is skipped — there is nothing to join it to.
 */
export function collectSessionTelemetry(opts: CollectSessionTelemetryOptions = {}): SessionTelemetry[] {
  const dir = opts.dir ?? CLAUDE_LIMITS_DIR;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const rows: SessionTelemetry[] = [];
  for (const name of files) {
    const sessionId = name.slice(0, -".json".length);
    const session = getSession(sessionId);
    if (!session) continue;
    const snapshot = readSessionSnapshot(path.join(dir, name));
    const employee = session.employee ? opts.employees?.get(session.employee) : undefined;
    rows.push({
      sessionId,
      employee: session.employee,
      employeeDisplayName: employee?.displayName,
      model: session.model,
      workItemId: session.workItemId ?? null,
      status: session.status,
      ...snapshot,
    });
  }
  return rows;
}

export interface AccountLimitsRollup {
  fiveHourUsedPct?: number;
  fiveHourResetsAt?: string;
  sevenDayUsedPct?: number;
  sevenDayResetsAt?: string;
}

/**
 * Account-level usage takes the MAX used% across every live (non-stale)
 * session snapshot, not the freshest file. Claude's 5-hour/7-day windows are
 * account-wide, so with two sessions running concurrently the freshest-file
 * heuristic (shared/engine-limits.ts's account collector) can under-report:
 * whichever session happened to write last wins, even when another session's
 * snapshot — captured inside the SAME window — shows a higher used%. The true
 * account figure is the max observed in the window, not the latest write.
 */
export function rollupAccountLimits(entries: readonly SessionTelemetry[]): AccountLimitsRollup {
  const live = entries.filter((entry) => !entry.stale);
  const rollup: AccountLimitsRollup = {};
  for (const entry of live) {
    if (entry.fiveHourUsedPct !== undefined
      && (rollup.fiveHourUsedPct === undefined || entry.fiveHourUsedPct > rollup.fiveHourUsedPct)) {
      rollup.fiveHourUsedPct = entry.fiveHourUsedPct;
      rollup.fiveHourResetsAt = entry.fiveHourResetsAt;
    }
    if (entry.sevenDayUsedPct !== undefined
      && (rollup.sevenDayUsedPct === undefined || entry.sevenDayUsedPct > rollup.sevenDayUsedPct)) {
      rollup.sevenDayUsedPct = entry.sevenDayUsedPct;
      rollup.sevenDayResetsAt = entry.sevenDayResetsAt;
    }
  }
  return rollup;
}

/** Durable one-row-per-5-hour-window log of the account's `sevenDay.used%`,
 *  alongside the per-session snapshots in the same engine-limits dir. */
export const SEVEN_DAY_WINDOW_LOG_FILE = path.join(ENGINE_LIMITS_DIR, "seven-day-window-log.json");
// ~12.5 days of history at one 5-hour window per entry — enough for the
// pacing controller's week-over-week comparisons without unbounded growth.
const SEVEN_DAY_WINDOW_LOG_MAX_ENTRIES = 60;

export interface SevenDayWindowSample {
  /** ISO `resets_at` of the 5-hour window this sample was captured in — the
   *  window's identity, and the dedupe key so a window is recorded once. */
  windowResetsAt: string;
  sevenDayUsedPct: number;
  capturedAt: string;
}

function readWindowLog(file: string): SevenDayWindowSample[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as SevenDayWindowSample[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append a `sevenDay.used%` sample at a 5-hour window boundary, keyed by that
 * window's `resetsAt` so calling this again mid-window is a no-op. The pacing
 * controller (M4, later in this lane) needs the per-window delta —
 * `samples[n].sevenDayUsedPct - samples[n-1].sevenDayUsedPct` — which only a
 * durable, one-sample-per-window log can give it; a live snapshot alone only
 * ever shows the running total, never what one window actually spent.
 */
export function recordSevenDayWindowSample(
  rollup: Pick<AccountLimitsRollup, "fiveHourResetsAt" | "sevenDayUsedPct">,
  file: string = SEVEN_DAY_WINDOW_LOG_FILE,
): SevenDayWindowSample[] {
  const log = readWindowLog(file);
  if (rollup.fiveHourResetsAt === undefined || rollup.sevenDayUsedPct === undefined) return log;
  if (log.some((sample) => sample.windowResetsAt === rollup.fiveHourResetsAt)) return log;

  const next = [
    ...log,
    {
      windowResetsAt: rollup.fiveHourResetsAt,
      sevenDayUsedPct: rollup.sevenDayUsedPct,
      capturedAt: new Date().toISOString(),
    },
  ].slice(-SEVEN_DAY_WINDOW_LOG_MAX_ENTRIES);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

export function readSevenDayWindowLog(file: string = SEVEN_DAY_WINDOW_LOG_FILE): SevenDayWindowSample[] {
  return readWindowLog(file);
}
