import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getWorkItem } from "../work-items/store.js";
import {
  claimDelegationCompletionNudge,
  clearDelegationCompletionGuard,
  getSession,
  markDelegationCompletionSurfaced,
  releaseDelegationCompletionNudge,
} from "./registry.js";

const META_KEY = "delegationCompletionContract";
export const DELEGATION_COMPLETION_TRACKED_META_KEY = "delegationCompletionTracked";
const OPEN_EXECUTION_STATUSES = new Set(["backlog", "assigned", "executing"]);

const EXPLICIT_UNFINISHED_SIGNAL = /\b(?:i (?:am|['’]m) still working (?:on|through)|i (?:will|['’]ll) continue|(?:(?:the|this|my)\s+)?(?:task|work|implementation|fix|patch|change|migration|feature|deliverable)\s+(?:is|remains)\s+(?:incomplete|still in progress)|not (?:done|finished|complete))\b/i;
const TERMINAL_SIGNAL = /\b(final report|completed|complete|done|finished|shipped|implemented|resolved|all tests pass(?:ed)?|(?:tests?|checks?) (?:now )?pass(?:ed)?|ready for review|ready to merge|(?:the )?(?:pr|patch) (?:is )?ready|commit (?:sha|hash)|hand(?:-| )?off)\b/i;
const PARENT_WAIT_SIGNAL = /\?|\b(need (?:your|the parent's) input|please confirm|which (?:option|approach)|should i|would you|let me know|blocked (?:on|by)|waiting on|awaiting (?:approval|confirmation|input)|waiting for (?:approval|confirmation|input|you|the parent)|(?:need|missing|without|awaiting) (?:the )?(?:credentials?|access|permissions?|api key|token|secret))\b/i;

export const DELEGATION_COMPLETION_NUDGE =
  "Delegation completion contract: your linked Todo is still open and your last reply was only a progress update. Continue the existing task now. Do not stop at another progress note; finish the work and post your complete final report to the parent.";

export const DELEGATION_COMPLETION_NUDGE_DISPLAY =
  "Completion contract: continuing this delegated task to a final report.";

type GuardState = "nudged" | "surfaced";

interface Guard {
  workItemId: string;
  state: GuardState;
}

export type DelegationCompletionOutcome = "pass" | "nudged" | "surface" | "suppress";

export interface DelegationCompletionDeps {
  postFollowUp: (sessionId: string, message: string, displayMessage: string) => Promise<void>;
}

function readGuard(session: Session): Guard | null {
  const raw = session.transportMeta?.[META_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const guard = raw as Record<string, unknown>;
  if (typeof guard.workItemId !== "string") return null;
  if (guard.state !== "nudged" && guard.state !== "surfaced") return null;
  return { workItemId: guard.workItemId, state: guard.state };
}

function isProgressOnly(text: string): boolean {
  const terminalCandidate = text.replace(/\bnot\s+(?:done|finished|complete)\b/gi, " ");
  // Incidental mentions of work, running services, remaining items, or next
  // steps are not evidence that the delegated task remains unfinished. The
  // additive nudge requires a first-person continuation assertion, a task-bound
  // incomplete/still-in-progress assertion, or explicit negated completion.
  const hasExplicitUnfinished = EXPLICIT_UNFINISHED_SIGNAL.test(text);
  const hasTerminal = TERMINAL_SIGNAL.test(terminalCandidate);
  // Mixed terminal + unfinished clauses are ambiguous. Under the fail-safe
  // contract, ambiguity surfaces to the parent; it never authorizes a nudge.
  if (hasTerminal && hasExplicitUnfinished) return false;
  return hasExplicitUnfinished && !hasTerminal && !PARENT_WAIT_SIGNAL.test(text);
}

function isStructurallyAwaitingParent(session: Session): boolean {
  return session.transportMeta?.awaitingParent === true || session.transportMeta?.delegationAwaitingParent === true;
}

/**
 * Gate the ordinary parent-completion callback for a narrowly qualified child.
 *
 * DESIGN BIAS — conservative and fail-safe:
 * The auto-nudge is only an additive optimization over the existing parent
 * callback. Structural provenance is mandatory and text is only a secondary
 * refinement. Any missing evidence, ambiguity, parse collision, or failed CAS
 * returns `pass`, preserving the normal surface-to-parent behavior. Missed
 * nudges are acceptable; false nudges are the harm this contract prevents.
 *
 * The persisted guard is deliberately independent of engine attempt ids: the
 * contract nudge creates a new attempt, and that next idle settlement must
 * surface instead of becoming another nudge.
 */
export async function enforceDelegationCompletionContract(
  session: Session,
  result: { result?: string | null; error?: string | null },
  deps: DelegationCompletionDeps,
): Promise<DelegationCompletionOutcome> {
  if (!session.parentSessionId || session.status !== "idle" || result.error) return "pass";
  if (!session.workItemId) return "pass";
  if (session.transportMeta?.[DELEGATION_COMPLETION_TRACKED_META_KEY] !== true) return "pass";
  if (isStructurallyAwaitingParent(session)) return "pass";

  const item = getWorkItem(session.workItemId);
  if (!item || !OPEN_EXECUTION_STATUSES.has(item.status)) return "pass";

  const existing = readGuard(session);
  if (existing?.workItemId === session.workItemId) {
    if (existing.state === "surfaced") return "pass";
    if (!markDelegationCompletionSurfaced(session.id, session.workItemId)) {
      const persisted = getSession(session.id);
      return persisted && readGuard(persisted)?.workItemId === session.workItemId ? "suppress" : "pass";
    }
    return "surface";
  }

  const text = result.result?.trim() ?? "";
  if (!text || !isProgressOnly(text)) return "pass";

  const guarded = claimDelegationCompletionNudge(session.id, session.workItemId);
  if (!guarded) {
    const persisted = getSession(session.id);
    return persisted && readGuard(persisted)?.workItemId === session.workItemId ? "suppress" : "pass";
  }
  try {
    await deps.postFollowUp(session.id, DELEGATION_COMPLETION_NUDGE, DELEGATION_COMPLETION_NUDGE_DISPLAY);
    return "nudged";
  } catch (error) {
    releaseDelegationCompletionNudge(session.id, session.workItemId);
    logger.warn(
      `[delegation-contract] failed to nudge child ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "pass";
  }
}

/** A genuine operator/user follow-up starts a fresh completion-contract cycle. */
export function clearDelegationCompletionContract(session: Session): Session {
  const guard = readGuard(session);
  if (!guard) return session;
  return clearDelegationCompletionGuard(session.id, guard.workItemId) ?? getSession(session.id) ?? session;
}
