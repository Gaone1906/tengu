import { getSession, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";

/**
 * Clears a session out of the `waiting` state a rate-limit pause (either the
 * engine's own usage-limit wait-and-retry loop, sessions/rate-limit-handler.ts,
 * or the usage governor's halt, sessions/handoff.ts) leaves it in.
 *
 * Historically this only ever ran inline inside POST /api/sessions/:id/message,
 * gated on the incoming write being a genuine user message — correct for "the
 * user cleared the limit provider-side and is retrying", but it meant NOTHING
 * could clear `waiting` without a human typing into the chat. The governor's
 * scheduled resume (a cron fire, no user in the loop) needs the identical state
 * transition without a message attached, so it is extracted here and called
 * from both the message handler (still message-gated, unchanged behavior) and
 * gateway/api.ts's resumeGovernorHaltedSession (unconditional, programmatic).
 */
export interface ClearWaitingResult {
  sessionId: string;
  /** False when the session did not exist or was not actually `waiting` —
   *  calling this on an already-clear session is a harmless no-op. */
  cleared: boolean;
}

export function clearWaitingState(sessionId: string, opts?: { reason?: string }): ClearWaitingResult {
  const session = getSession(sessionId);
  if (!session || session.status !== "waiting") {
    return { sessionId, cleared: false };
  }
  updateSession(sessionId, {
    status: "idle",
    lastActivity: new Date().toISOString(),
    lastError: null,
  });
  logger.info(`Session ${sessionId} cleared out of "waiting"${opts?.reason ? ` (${opts.reason})` : ""}`);
  return { sessionId, cleared: true };
}
