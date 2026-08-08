import { logger } from "../shared/logger.js";
import { getSession } from "../sessions/registry.js";
import { addComment } from "../work-items/comments.js";

export const SECURITY_EMPLOYEE_NAME = "security";

export interface SecurityBlockInput {
  jinnSessionId: string;
  toolName: string;
  reason: string;
  cwd?: string;
}

/**
 * Turn a policy block into an attributed, audit-trail-visible record: a
 * work-item comment from the `security` system employee when the session is
 * linked to a Todo, otherwise a structured log line. Best-effort and never
 * throws — the 451 response the caller already sent is the actual gate; this
 * is receipt-keeping on top of it, not part of the decision.
 */
export function recordSecurityBlock(input: SecurityBlockInput): void {
  const { jinnSessionId, toolName, reason, cwd } = input;
  try {
    const session = getSession(jinnSessionId);
    const workItemId = session?.workItemId;
    if (workItemId) {
      addComment({
        workItemId,
        author: SECURITY_EMPLOYEE_NAME,
        authorKind: "system",
        body: `**${toolName} blocked** — ${reason}${cwd ? `\n\ncwd: \`${cwd}\`` : ""}`,
      });
      return;
    }
    logger.warn(
      `security: blocked ${toolName} for session ${jinnSessionId} with no linked work item — ${reason}`,
    );
  } catch (err) {
    logger.warn(
      `security: failed to record block receipt for session ${jinnSessionId}: ${(err as Error).message}`,
    );
  }
}
