import fs from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import { collectSessionTelemetry } from "../shared/session-telemetry.js";
import { evaluateGovernor } from "../shared/governor.js";
import { getSession } from "../sessions/registry.js";
import { performInPlaceCompaction, type ContextCompactionResult } from "../sessions/compaction.js";
import { logger } from "../shared/logger.js";
import type { Employee, Engine, GovernorConfig } from "../shared/types.js";

const DEFAULT_DEBOUNCE_MS = 1000;

export interface ContextCompactionWatcherDeps {
  getEngine: (name: string) => Engine | undefined;
  /** Resolved at check time, not at start time — a config reload must not
   *  require a restart to pick up a new contextCompactPct. */
  governorConfig?: () => GovernorConfig | undefined;
  /** Resolves the compacting session's employee record, so the /compact call's
   *  cwd follows resolveSessionCwd instead of always JINN_HOME. */
  employees?: () => ReadonlyMap<string, Employee>;
  debounceMs?: number;
  /** Test override; defaults to CLAUDE_LIMITS_DIR. */
  dir?: string;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * One check pass: scan every live session's telemetry snapshot, and for each
 * IDLE session whose context has crossed the governor's compaction threshold,
 * trigger `performInPlaceCompaction`. Split out from
 * `startContextCompactionWatcher` so the decision logic is testable without
 * chokidar's async file-watch machinery — feed it a directory with a snapshot
 * file already written and await the returned promises directly.
 *
 * Only IDLE sessions are compacted. A session mid-turn already owns its PTY's
 * turn resolver (hook-registry.ts refuses a second concurrent listener for
 * the same session), so triggering `/compact` while a real turn is in flight
 * would race it — the next idle-to-idle gap picks it up instead.
 * `inFlight` dedupes a session across repeated ticks while its own
 * compaction call is still running.
 */
export function checkContextCompaction(
  deps: ContextCompactionWatcherDeps,
  inFlight: Set<string> = new Set(),
): Promise<ContextCompactionResult>[] {
  const dir = deps.dir ?? CLAUDE_LIMITS_DIR;
  let rows;
  try {
    rows = collectSessionTelemetry({ dir });
  } catch (err) {
    logger.warn(`[context-compaction] telemetry scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const pending: Promise<ContextCompactionResult>[] = [];
  for (const row of rows) {
    if (row.status !== "idle") continue;
    if (inFlight.has(row.sessionId)) continue;

    const decision = evaluateGovernor({ contextUsedPct: row.contextUsedPct }, deps.governorConfig?.());
    if (decision.action !== "handoff") continue;

    const session = getSession(row.sessionId);
    if (!session || !session.engineSessionId) continue;
    const engine = deps.getEngine(session.engine);
    if (!engine) continue;

    inFlight.add(row.sessionId);
    const attempt = performInPlaceCompaction({
      session,
      employee: row.employee ?? "unassigned",
      employeeRecord: row.employee ? deps.employees?.().get(row.employee) : undefined,
      engine,
      engineModel: session.model ?? undefined,
      decision,
    })
      .catch((err) => {
        logger.warn(`[context-compaction] compaction failed for session ${row.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        return { compacted: false, handoffReinjected: false } satisfies ContextCompactionResult;
      })
      .finally(() => { inFlight.delete(row.sessionId); });
    pending.push(attempt);
  }
  return pending;
}

/**
 * Step 7's explicit 80%-context trigger, evaluated on every (free) telemetry
 * write — the same statusline-write cadence session-telemetry-broadcaster.ts
 * already watches, applied to D5's other half (context pressure, not usage
 * pressure). Not a polling agent: it is pure arithmetic over a file that's
 * already being written for free.
 */
export function startContextCompactionWatcher(deps: ContextCompactionWatcherDeps): () => Promise<void> {
  const dir = deps.dir ?? CLAUDE_LIMITS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const inFlight = new Set<string>();

  const watcher: FSWatcher = watch(dir, { ignoreInitial: true, depth: 0 });
  watcher.on("all", debounce(() => { checkContextCompaction(deps, inFlight); }, deps.debounceMs ?? DEFAULT_DEBOUNCE_MS));

  return () => watcher.close();
}
