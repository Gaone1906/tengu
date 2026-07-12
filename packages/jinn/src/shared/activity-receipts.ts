const ACTIVITY_RECEIPT_ID_MAX_CHARS = 96;
const ACTIVITY_RESULT_MAX_CHARS = 16_000;
const ACTIVITY_RECEIPT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

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
