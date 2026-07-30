import type { WorkflowError } from "./runtime.js";

/**
 * How a workflow decides whether a failed attempt is worth re-dispatching.
 *
 * The boundary is "did the work happen and fail" versus "did the attempt never
 * land". An attempt that never landed costs nothing to repeat — the retry is the
 * SAME request, not a second one. An employee that ran and reported failure is a
 * verdict: re-dispatching it pays twice for a decision already made and can
 * override a phase that deliberately refused to proceed.
 *
 * Most of that is decided STRUCTURALLY, by which path the failure arrived on —
 * a `startAttempt` throw or a gateway restart is an undelivered attempt whatever
 * its message says, and a submitted failure is a verdict whatever its message
 * says. The signatures below are only for the one path with no structure to read:
 * an engine reporting that its turn failed, where the provider's reason exists
 * solely as prose.
 *
 * There the list is closed and anything unrecognised is terminal. Guessing
 * generously spends real money on real failures, so the default is deny.
 */
const TRANSPORT_SIGNATURES: readonly RegExp[] = [
  // Provider fault codes, surfaced verbatim by the engines (e.g. the Claude PTY's
  // "Interactive turn failed: server_error").
  /\b(?:server_error|api_error|overloaded_error|overloaded)\b/i,
  // HTTP 5xx, but only in status context — a bare "503" in a diagnostic is not a
  // status code, and matching one would retry a genuine failure.
  /\b(?:HTTP|status)(?:\s+code)?\s*[:=]?\s*5\d\d\b/i,
  /\b(?:bad gateway|service unavailable|gateway time-?out|internal server error)\b/i,
  // Socket and DNS faults from the fetch/PTY transport.
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/,
  /\b(?:socket hang up|fetch failed|network error)\b/i,
];

/**
 * Whether an engine diagnostic describes an upstream/transport fault.
 *
 * Deliberately NOT included: `rate_limit` (the session manager owns rate-limit
 * waiting, so a workflow retry on top of it is pure quota burn) and
 * `billing_error`/`invalid_request`/`permission_error` (a retry cannot fix a
 * credential, a quota, or a malformed request).
 */
export function isTransportFailure(message: string): boolean {
  return TRANSPORT_SIGNATURES.some((signature) => signature.test(message));
}

/**
 * Wrap a failure whose only account of itself is its message: an engine turn that
 * reported an error, or a run-level fault (an unavailable employee, control flow
 * that did not settle). Retryable only when the message names a transport fault.
 */
export function workflowError(error: unknown, nodeId: string, attempt?: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: "workflow-step-failed",
    message: value.message,
    retryable: isTransportFailure(value.message),
    nodeId,
    ...(attempt ? { attempt } : {}),
  };
}

/**
 * A dispatch that threw before the attempt reached a session. Nothing ran, so
 * this is the undelivered-attempt case by construction — no message-matching,
 * because the diagnostic belongs to whatever failed to spawn, not to a provider.
 */
export function dispatchFailure(error: unknown, nodeId: string, attempt: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return { code: "workflow-dispatch-failed", message: value.message, retryable: true, nodeId, attempt };
}

/**
 * An attempt killed under the runtime — most often a gateway restart while it was
 * running. The turn was interrupted rather than judged, so like a timeout or a
 * missing output block there is no verdict to honour and the phase re-runs.
 */
export function interruptedAttemptFailure(message: string, nodeId: string, attempt: number): WorkflowError {
  return { code: "workflow-attempt-interrupted", message, retryable: true, nodeId, attempt };
}
