import { createHash } from "node:crypto";

const ACTIVITY_RECEIPT_ID_MAX_CHARS = 96;
const ACTIVITY_RESULT_MAX_CHARS = 16_000;
const ACTIVITY_RECEIPT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const WORKFLOW_DEFINITION_ACTIVITY_PREFIX = "workflow-definition:";
const WORKFLOW_DEFINITION_DIGEST_CHARS = 16;

/** Stable activity block id for the full 128-character Workflow id domain.
 * Short ids remain readable; long ids retain a readable prefix plus a
 * collision-resistant digest while preserving the full identity in payload. */
export function workflowDefinitionActivityBlockId(workflowId: string): string {
  const full = `${WORKFLOW_DEFINITION_ACTIVITY_PREFIX}${workflowId}`;
  if (full.length <= ACTIVITY_RECEIPT_ID_MAX_CHARS) return full;
  const digest = createHash("sha256").update(workflowId).digest("hex").slice(0, WORKFLOW_DEFINITION_DIGEST_CHARS);
  const readableChars = ACTIVITY_RECEIPT_ID_MAX_CHARS
    - WORKFLOW_DEFINITION_ACTIVITY_PREFIX.length
    - 1
    - digest.length;
  return `${WORKFLOW_DEFINITION_ACTIVITY_PREFIX}${workflowId.slice(0, readableChars)}:${digest}`;
}

function exactResultObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (!value.trim() || value.length > ACTIVITY_RESULT_MAX_CHARS) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Extract the server-authored stable block id from one successful tool result.
 * Incidental prose, nested lookalikes, oversized values, and error results are
 * deliberately ignored so untrusted tool output cannot target transcript rows. */
export function extractActivityReceiptId(
  value: unknown,
  options?: { isError?: boolean },
): string | undefined {
  if (options?.isError) return undefined;
  const result = exactResultObject(value);
  if (!result || !Object.prototype.hasOwnProperty.call(result, "activityReceiptId")) return undefined;
  const id = result.activityReceiptId;
  if (typeof id !== "string" || id.length < 1 || id.length > ACTIVITY_RECEIPT_ID_MAX_CHARS) return undefined;
  return ACTIVITY_RECEIPT_ID_PATTERN.test(id) ? id : undefined;
}
