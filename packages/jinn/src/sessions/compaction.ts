import fs from "node:fs";
import type { Engine, Session } from "../shared/types.js";
import type { GovernorDecision } from "../shared/governor.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { handoffPathFor } from "./handoff.js";

/**
 * Context compaction (docs/tengu/03-implementation-plan.md step 7, D5's other
 * half). Context usage over threshold is a compaction signal, NOT a halt:
 * compact IN PLACE and keep the session warm. This module never touches
 * session status and never schedules a resume — that is sessions/handoff.ts's
 * job, for the 5-hour/7-day "halt" decision only.
 *
 * `evaluateGovernor()` (shared/governor.ts) already computes the 80%-context
 * "handoff" action; this is what actually acts on it. Claude Code's own
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW env var (engines/claude-interactive.ts
 * buildPtyEnv) only widens the BUDGET auto-compact operates within — it says
 * nothing about the PERCENTAGE that trips it, which is undocumented and
 * engine-version-dependent. Verified against a live PTY (see
 * claude-interactive-compact-window.test.ts): claude clamps the requested
 * budget to min(modelContextWindow, requested), so on a 200K-window model the
 * env var is a no-op (200K is already the model's real ceiling) — it only
 * changes behaviour for native-1M models. Either way, nothing in that env var
 * gives us a KNOWN, engine-version-independent 80% trigger, so this function
 * is that trigger, built regardless of what the env var resolves to.
 */

export interface ContextCompactionOptions {
  session: Session;
  employee: string;
  /** Defaults to session.workItemId, then session.id — same fallback handoff.ts uses. */
  todoId?: string;
  engine: Engine;
  engineBin?: string;
  engineModel?: string;
  decision: GovernorDecision;
}

export interface ContextCompactionResult {
  compacted: boolean;
  handoffReinjected: boolean;
}

const NOT_TRIGGERED: ContextCompactionResult = { compacted: false, handoffReinjected: false };

/**
 * Runs `/compact` on a session's SAME engine session id (no halt, no status
 * change), then — only if the engine reports the turn's SessionStart fired
 * with `source: "compact"` — re-injects the session's handoff note (if one
 * exists) as a follow-up turn, so post-compaction context still knows what's
 * in flight. A test double (or an engine that doesn't surface the source)
 * simply skips re-injection rather than guessing that compaction happened.
 */
export async function performInPlaceCompaction(opts: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const { session, employee, engine, decision } = opts;
  if (decision.action !== "handoff") return NOT_TRIGGERED;
  if (!session.engineSessionId) {
    logger.warn(`Context compaction skipped for session ${session.id}: no engine session id yet`);
    return NOT_TRIGGERED;
  }

  const todoId = opts.todoId ?? session.workItemId ?? session.id;
  logger.info(`Context compaction triggered for session ${session.id} (${employee}/${todoId}): ${decision.reason}`);

  const compactResult = await engine.run({
    prompt: "/compact",
    resumeSessionId: session.engineSessionId,
    cwd: JINN_HOME,
    bin: opts.engineBin,
    model: opts.engineModel ?? session.model ?? undefined,
    sessionId: session.id,
  });

  if (compactResult.sessionStartSource !== "compact") {
    return { compacted: true, handoffReinjected: false };
  }

  const handoffPath = handoffPathFor(employee, todoId);
  let handoffContent: string;
  try {
    handoffContent = fs.readFileSync(handoffPath, "utf-8");
  } catch {
    return { compacted: true, handoffReinjected: false };
  }

  logger.info(`Re-injecting handoff ${handoffPath} into session ${session.id} after context compaction`);
  await engine.run({
    prompt: [
      "Context was just compacted (SessionStart source: compact). The summary above lost the",
      "in-flight detail below — read it before continuing; do not re-derive what it already tells you.",
      "",
      handoffContent,
    ].join("\n"),
    resumeSessionId: session.engineSessionId,
    cwd: JINN_HOME,
    bin: opts.engineBin,
    model: opts.engineModel ?? session.model ?? undefined,
    sessionId: session.id,
  });

  return { compacted: true, handoffReinjected: true };
}
