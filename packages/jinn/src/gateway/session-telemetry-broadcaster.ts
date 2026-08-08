import fs from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { Employee } from "../shared/types.js";
import { CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import { collectSessionTelemetry, rollupAccountLimits } from "../shared/session-telemetry.js";
import { computeEmployeeProgress, computeRootProgress } from "../work-items/progress.js";
import { getWorkItem } from "../work-items/store.js";
import { logger } from "../shared/logger.js";

const DEFAULT_DEBOUNCE_MS = 1000;

export interface SessionTelemetryBroadcasterDeps {
  emit: GatewayEmit;
  /** Resolved at broadcast time, not at start time — an org reload must not
   *  require a restart to pick up new display names. */
  employees?: () => ReadonlyMap<string, Employee>;
  debounceMs?: number;
  /** Test override; defaults to CLAUDE_LIMITS_DIR. */
  dir?: string;
}

/**
 * One broadcast payload: every live session's telemetry (enriched with its
 * current Todo's title, when linked), the account-wide rollup, and progress
 * for exactly the Todo roots those sessions are actually touching — not a
 * full-tree scan, which would grow unbounded with backlog size. Exported for
 * tests.
 */
export function buildSessionTelemetrySnapshot(deps: Pick<SessionTelemetryBroadcasterDeps, "employees" | "dir">) {
  const employees = deps.employees?.();
  const sessions = collectSessionTelemetry({
    ...(deps.dir !== undefined ? { dir: deps.dir } : {}),
    ...(employees ? { employees } : {}),
  });
  const account = rollupAccountLimits(sessions);

  const rootIds = new Set<string>();
  const enrichedSessions = sessions.map((session) => {
    if (!session.workItemId) return session;
    const item = getWorkItem(session.workItemId);
    if (!item) return session;
    rootIds.add(item.rootId);
    return { ...session, currentTodoTitle: item.title };
  });

  return {
    sessions: enrichedSessions,
    account,
    rootProgress: [...rootIds].map((rootId) => computeRootProgress(rootId)),
    employeeProgress: computeEmployeeProgress(),
    capturedAt: new Date().toISOString(),
  };
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Broadcasts `session:telemetry` (Tengu steps 1–3) whenever a live Claude
 * session's statusline snapshot changes — the only thing that moves
 * `contextUsedPct`/`fiveHourUsedPct` — debounced ~1s so a burst of assistant
 * messages across several concurrent sessions collapses into one event.
 *
 * Watches `CLAUDE_LIMITS_DIR` directly (chokidar, matching gateway/watcher.ts)
 * rather than hooking a session-lifecycle call site the way
 * work-items/live-events.ts does for Todo writes: those snapshot files are
 * written by the `claude` CLI's own statusline process, entirely outside our
 * call stack, so there is no in-process write to notify from.
 */
export function startSessionTelemetryBroadcaster(deps: SessionTelemetryBroadcasterDeps): () => Promise<void> {
  const dir = deps.dir ?? CLAUDE_LIMITS_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const emitNow = () => {
    try {
      const snapshot = buildSessionTelemetrySnapshot({ employees: deps.employees, dir: deps.dir });
      deps.emit("session:telemetry", snapshot);
    } catch (err) {
      logger.warn(`[session-telemetry] broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const watcher: FSWatcher = watch(dir, { ignoreInitial: true, depth: 0 });
  watcher.on("all", debounce(emitNow, deps.debounceMs ?? DEFAULT_DEBOUNCE_MS));

  return () => watcher.close();
}
