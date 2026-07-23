import type { WorkflowAttemptInterruptionCause } from "../shared/types.js";

export const USER_MESSAGE_INTERRUPTION_REASON = "Interrupted: new message received";

/** Recover an explicit workflow interruption cause from its durable error text. */
export function workflowAttemptInterruptionCause(
  error: string | null | undefined,
): WorkflowAttemptInterruptionCause {
  return error === USER_MESSAGE_INTERRUPTION_REASON
    ? "user-message"
    : "attempt-stop";
}
