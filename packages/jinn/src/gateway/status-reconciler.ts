import type { GatewayEmit } from "../shared/gateway-events.js";
import type { Engine } from "../shared/types.js";
import { listSessions, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";

const DEFAULT_INTERVAL_MS = 15_000;
/** runWebSession's heartbeat refreshes lastActivity every 5s while a turn is in
 *  flight. A "running" session whose heartbeat is older than this has no live
 *  turn driving it — the completion event was lost.
 *
 *  Queued-but-not-started turns are safe: the POST handler sets
 *  status:"running" + lastActivity synchronously at enqueue, and runWebSession
 *  re-sets both when the queued turn actually starts (and the 5s heartbeat
 *  takes over). Worst case a long-delayed queue item gets its spinner cleared
 *  here and re-armed by session:started when the turn begins. */
const DEFAULT_STALE_MS = 45_000;

export interface StatusReconcilerDeps {
  engines: Map<string, Engine>;
  emit: GatewayEmit;
  intervalMs?: number;
  staleMs?: number;
  /** Test override. */
  now?: () => number;
  /** Carry-over between sweeps: sessions seen stuck once. A session is only
   *  reset on the SECOND consecutive sweep that finds it stuck — a single
   *  observation can be the benign seconds between a turn's process exiting
   *  and the gateway persisting its final status. Created by
   *  startStatusReconciler; tests may pass their own. */
  pendingStuck?: Set<string>;
}

/** One sweep: unstick sessions stuck at status:"running" with no live turn.
 *  Returns the number of sessions fixed. Exported for tests. */
export function sweepOnce(deps: StatusReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let fixed = 0;
  for (const session of listSessions({ status: "running" })) {
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    const staleFor = now - last;
    if (staleFor < staleMs) {
      deps.pendingStuck?.delete(session.id); // fresh heartbeat — recovered, clear any mark
      continue; // heartbeat is live — a turn is in flight
    }
    const engine = deps.engines.get(session.engine);
    // Same live-turn probe as the API status path: interactive engines expose
    // isTurnRunning (warm-but-idle PTYs must not count); headless engines
    // approximate with isAlive; an unknown engine cannot have a live turn.
    const turnRunning = !!engine && (
      "isTurnRunning" in engine
        ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id)
        : (typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
          ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(session.id)
          : false)
    );
    if (turnRunning) {
      deps.pendingStuck?.delete(session.id); // live turn — clear any mark
      continue;
    }
    // Session qualifies as stuck: stale heartbeat + no live turn.
    const pending = deps.pendingStuck;
    if (pending && !pending.has(session.id)) {
      pending.add(session.id);
      continue; // confirm on the next sweep — could be a turn-boundary race
    }
    pending?.delete(session.id);
    updateSession(session.id, {
      status: "interrupted",
      attemptOutcome: "interrupted",
      lastActivity: new Date(now).toISOString(),
      lastError: "Interrupted: engine turn ended without a terminal result",
    });
    deps.emit("session:completed", {
      sessionId: session.id,
      employee: session.employee ?? undefined,
      title: session.title,
      result: null,
      error: null,
    });
    logger.warn(
      `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — marked interrupted`,
    );
    fixed++;
  }
  return fixed;
}

/** Start the periodic sweep. Returns a stop function. */
export function startStatusReconciler(deps: StatusReconcilerDeps): () => void {
  const pendingStuck = deps.pendingStuck ?? new Set<string>();
  const timer = setInterval(() => {
    try {
      sweepOnce({ ...deps, pendingStuck });
    } catch (err) {
      logger.warn(`[reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
