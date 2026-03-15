import type { JinnConfig, Employee, Engine } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { listSessions, updateSession } from "./registry.js";
import { logger } from "../shared/logger.js";

/**
 * Check all running sessions and kill any that exceed their time or cost limits.
 * Called periodically by the gateway.
 */
export function enforceSessionLimits(
  config: JinnConfig,
  engines: Map<string, Engine>,
  employees: Map<string, Employee>,
): void {
  const running = listSessions({ status: "running" });
  const now = Date.now();

  for (const session of running) {
    // Resolve limits: employee override > global config
    const employee = session.employee ? employees.get(session.employee) : undefined;
    const maxDurationMs = (config.sessions?.maxDurationMinutes ?? 30) * 60 * 1000;
    const maxCost = employee?.maxCostUsd ?? config.sessions?.maxCostUsd ?? 10;

    // Check duration
    const startedAt = new Date(session.createdAt).getTime();
    const elapsed = now - startedAt;
    if (elapsed > maxDurationMs) {
      logger.warn(
        `Session ${session.id} exceeded max duration (${Math.round(elapsed / 60000)}min > ${config.sessions?.maxDurationMinutes ?? 30}min). Killing.`,
      );
      killSession(session.id, session.engine, engines, "Exceeded max duration");
      continue;
    }

    // Check cost
    if (session.totalCost > maxCost) {
      logger.warn(
        `Session ${session.id} exceeded max cost ($${session.totalCost.toFixed(2)} > $${maxCost.toFixed(2)}). Killing.`,
      );
      killSession(session.id, session.engine, engines, "Exceeded max cost");
    }
  }
}

function killSession(
  sessionId: string,
  engineName: string,
  engines: Map<string, Engine>,
  reason: string,
): void {
  const engine = engines.get(engineName);
  if (engine && isInterruptibleEngine(engine)) {
    engine.kill(sessionId, reason);
  }
  updateSession(sessionId, {
    status: "error",
    lastActivity: new Date().toISOString(),
    lastError: reason,
  });
}
