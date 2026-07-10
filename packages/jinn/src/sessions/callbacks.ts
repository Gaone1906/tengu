import { getSession, listSessionsBySource } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";
import { hydrateAllAttachments, talkSessionsAttachedTo } from "../talk/attachments.js";
import type { ChatBlockEnvelope, JsonObject } from "../shared/types.js";
import { enforceDelegationCompletionContract } from "./delegation-completion-contract.js";

export interface ManagerVisibilityDetails {
  manager: string;
  managerDisplay: string;
  delegator: string | null;
  delegatorDisplay: string;
  employee: string;
  employeeDisplay: string;
  childSessionId: string;
  workItemId: string;
  title: string;
}

/**
 * Give a manager lightweight visibility into one skip-level delegation. The
 * session-message route persists this notification in the restart-safe internal
 * queue before its manager turn starts. Fire-and-forget, like parent callbacks.
 */
export function notifyManagerVisibility(
  managerSessionId: string,
  details: ManagerVisibilityDetails,
): void {
  const message =
    `👀 Skip-level visibility: ${details.delegatorDisplay} delegated directly to ${details.employeeDisplay}.\n\n` +
    `Task: ${details.title}\n` +
    `Todo: ${details.workItemId}\n` +
    `Child session: ${details.childSessionId}\n\n` +
    `You retain manager visibility; no action is required unless coordination or review is needed.`;
  const displayMessage =
    `👀 Skip-level visibility · ${details.employeeDisplay}\n${_clean(details.title, 220)}`;
  const meta: JsonObject = {
    kind: "manager-visibility",
    manager: details.manager,
    delegator: details.delegator ?? "operator",
    employee: details.employee,
    childSessionId: details.childSessionId,
    workItemId: details.workItemId,
  };

  _sendRaw(managerSessionId, message, displayMessage, { meta }).catch((error) => {
    logger.warn(`[callbacks] Failed to notify manager session ${managerSessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): void {
  // Attachment wakes are a SEPARATE relationship from parent ownership: a talk
  // session can soft-link any session and must be woken when it finishes, even if
  // that session has no parent (or its parent is elsewhere). So this runs before
  // the parent early-returns and is independent of alwaysNotify.
  notifyAttachedTalkSessions(childSession, result);

  if (!childSession.parentSessionId) return;

  // Run asynchronously — do not await in the caller
  _sendNotification(childSession, result, options).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Label for a talk wake: title → employee → "a thread". */
function talkLabel(s: Session): string {
  return s.title || s.employee || "a thread";
}

/**
 * Talk-tailored wake (voice-friendly): no UUIDs/URLs in the engine `message`, a
 * clean banner in `displayMessage`. Shared by owned-thread callbacks and
 * attached-session wakes so both speak in the same voice.
 */
export function buildTalkWake(
  label: string,
  result: { result?: string | null; error?: string | null },
): { message: string; displayMessage: string } {
  if (result.error) {
    const raw = result.error.trim();
    const errPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
    return {
      message:
        `⚠️ Thread "${label}" hit an error.\n\n` +
        `${errPreview}\n\n` +
        `Tell the operator plainly in one short sentence — no IDs, no URLs — and offer a next step.`,
      displayMessage: `⚠️ Thread "${label}" hit an error\n${_clean(raw, 220)}`,
    };
  }
  const raw = (result.result || "").trim() || "(no output)";
  const llmPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  return {
    message:
      `📩 Thread "${label}" reported back.\n\n` +
      `Reply preview:\n${llmPreview}\n\n` +
      `Narrate the outcome aloud in 1–2 short sentences — no IDs, no URLs, no markdown. ` +
      `If there is a link or detail worth seeing, push a card. ` +
      `To follow up, delegate to this thread via /api/talk/delegate (its id is in your roster).`,
    displayMessage: `📩 Thread "${label}" reported back\n${_clean(raw, 220)}`,
  };
}

/**
 * Wake every talk session that has ATTACHED the just-finished session. Fire-and-
 * forget. De-dup: an owned child (parent IS the talk session) is already woken by
 * the parent-callback path, so it's skipped here to avoid a double notification.
 */
export function notifyAttachedTalkSessions(
  completedSession: Session,
  result: { result?: string | null; error?: string | null },
): void {
  _notifyAttached(completedSession, result).catch((err) => {
    logger.warn(`[callbacks] Failed to wake attached talk sessions: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _notifyAttached(
  completedSession: Session,
  result: { result?: string | null; error?: string | null },
): Promise<void> {
  // Lazy one-time scan so attachments persisted before a restart are visible
  // (this is the first/primary talkSessionsAttachedTo consumer on the wake path).
  hydrateAllAttachments({
    getSession,
    listTalkSessions: () => listSessionsBySource("talk", 50),
  });
  const talkIds = talkSessionsAttachedTo(completedSession.id);
  if (talkIds.length === 0) return;

  const { message, displayMessage } = buildTalkWake(talkLabel(completedSession), result);
  for (const talkId of talkIds) {
    if (talkId === completedSession.parentSessionId) continue; // owned child — already notified
    const talk = getSession(talkId);
    if (!talk || talk.source !== "talk") continue;
    if (talk.status === "error") continue;
    await _sendRaw(talkId, message, displayMessage);
  }
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
): void {
  if (!childSession.parentSessionId) return;

  const parent = getSession(childSession.parentSessionId);
  if (parent?.workflowProvenance?.kind === "run") return;
  const isTalkParent = parent?.source === "talk";

  let message: string;
  if (isTalkParent) {
    const label = talkLabel(childSession);
    message = `🔄 Thread "${label}" has resumed after rate limit cleared.`;
  } else {
    const employeeName = childSession.employee || "Unknown";
    message = `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`;
  }

  _sendRaw(childSession.parentSessionId, message).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return; // Parent gone or expired
  if (parent.status === "error") return; // Parent already in error — skip
  // Workflow parents reuse parentSessionId strictly for list grouping. They are
  // synthetic run projections, not engine conversations to wake with delegation
  // callbacks; phase completion is consumed by the workflow reconciler instead.
  if (parent.workflowProvenance?.kind === "run") return;

  // Delegation completion contract: a narrowly-qualified progress-only idle
  // settlement gets one durable follow-up instead of prematurely waking the
  // parent. The next idle settlement is surfaced and can never nudge again.
  const contract = await enforceDelegationCompletionContract(childSession, result, {
    postFollowUp: (sessionId, message, displayMessage) => _sendRaw(sessionId, message, displayMessage),
  });
  if (contract === "nudged") return;
  if (contract === "surface") {
    const latest = result.result?.trim() || "(no output)";
    result = {
      ...result,
      result:
        `⚠️ Delegation completion contract: the child settled idle again after its single automatic continuation nudge. ` +
        `No further nudge was sent; parent review is required.\n\nLatest reply:\n${latest}`,
    };
  }
  if (options?.alwaysNotify === false && contract !== "surface") return;

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  // Dual audience: `message` is what the parent ENGINE (e.g. the COO) reads —
  // it carries full context and the API hints it needs to follow up.
  // `displayMessage` is the clean, human-facing version shown in the web UI
  // notification banner.
  //
  // For /talk parents (source:"talk") the engine is the voice orchestrator: UUIDs
  // and raw API endpoints must NOT appear (they'd be read aloud). Use a label-based
  // wake message with a narration instruction instead.
  const isTalkParent = parent.source === "talk";

  let message: string;
  let displayMessage: string;
  let notificationMeta: JsonObject | undefined;
  let notificationBlock: ChatBlockEnvelope | undefined;
  if (isTalkParent) {
    ({ message, displayMessage } = buildTalkWake(talkLabel(childSession), result));
  } else if (result.error) {
    message = `⚠️ Employee "${employeeName}" (child session ${childId}) hit an error and could not finish: ${result.error}`;
    displayMessage = `⚠️ ${employeeName} couldn't finish\n${_clean(result.error, 220)}`;
    notificationMeta = childNotificationMeta("child-error", childSession);
  } else {
    const raw = (result.result || "").trim() || "(no output)";
    const llmPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
    message =
      `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
      `Reply preview:\n${llmPreview}\n\n` +
      `To read the full reply: GET /api/sessions/${childId}?last=N · ` +
      `to follow up: POST /api/sessions/${childId}/message`;
    displayMessage = `📩 ${employeeName} replied\n${_clean(raw, 220)}`;
    notificationMeta = childNotificationMeta("child-reply", childSession);
  }

  if (!isTalkParent && childSession.workItemId) {
    notificationBlock = {
      op: "patch",
      block: {
        id: `dg-${childSession.workItemId}`,
        type: "delegation",
        version: 1,
        status: result.error ? "error" : "done",
        payload: { repliedAt: Date.now() },
      },
    };
  }

  await _sendRaw(childSession.parentSessionId!, message, displayMessage, {
    meta: notificationMeta,
    block: notificationBlock,
  });
}

function childNotificationMeta(kind: "child-reply" | "child-error", childSession: Session): JsonObject {
  const employee = childSession.employee || "Unknown";
  const storedDisplay = childSession.transportMeta?.delegationEmployeeDisplay;
  const employeeDisplay = typeof storedDisplay === "string" && storedDisplay.trim()
    ? storedDisplay.trim()
    : employee
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  return { kind, employee, employeeDisplay, childSessionId: childSession.id };
}

/** Trim to a word boundary for a tidy human-facing preview. */
function _clean(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Send a hardcoded notification to the configured Discord channel.
 * Used for rate-limit alerts that must not depend on the LLM.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyDiscordChannel(message: string): void {
  _sendDiscordNotification(message).catch((err) => {
    logger.warn(`[callbacks] Failed to send Discord notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendDiscordNotification(message: string): Promise<void> {
  let connector = "discord";
  let channel: string | undefined;
  const gateway = internalGatewayConnection();

  try {
    const config = loadConfig();
    connector = config.notifications?.connector || "discord";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping Discord notification");
    return;
  }

  const response = await fetch(`${gateway.baseUrl}/api/connectors/${connector}/send`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({ channel, text: message }),
  });
  if (!response.ok) throw new Error(`connector notification failed (${response.status})`);
}

async function _sendRaw(
  parentSessionId: string,
  message: string,
  displayMessage?: string,
  structured?: { meta?: JsonObject; block?: ChatBlockEnvelope },
): Promise<void> {
  const gateway = internalGatewayConnection();

  const response = await fetch(`${gateway.baseUrl}/api/sessions/${parentSessionId}/message`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({
      message,
      role: "notification",
      ...(displayMessage ? { displayMessage } : {}),
      ...(structured?.meta ? { meta: structured.meta } : {}),
      ...(structured?.block ? { block: structured.block } : {}),
    }),
  });
  if (!response.ok) throw new Error(`parent notification failed (${response.status})`);
}

function internalGatewayConnection(): { baseUrl: string; token?: string } {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let fallbackHost: string | undefined;
  let fallbackPort = 7777;
  try {
    const config = loadConfig();
    fallbackHost = config.gateway?.host;
    fallbackPort = config.gateway?.port || 7777;
  } catch {
    // Use gateway.json/defaults if config is unavailable.
  }
  const port = info?.port ?? fallbackPort;
  return {
    baseUrl: gatewayBaseUrl({ port, host: info?.host }, fallbackHost),
    token: info?.token,
  };
}

function internalGatewayHeaders(gateway: { token?: string }): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(gateway.token ? { authorization: `Bearer ${gateway.token}` } : {}),
  };
}
