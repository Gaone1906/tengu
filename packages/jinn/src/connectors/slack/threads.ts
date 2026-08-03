import type { ReplyContext } from "../../shared/types.js";

export interface SlackMessageEventLike {
  channel: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export function deriveSessionKey(event: SlackMessageEventLike, prefix = "slack"): string {
  if (event.channel_type === "im") return `${prefix}:dm:${event.user || "unknown"}`;
  // Thread replies key off thread_ts (the root's ts), so they land on the root's session.
  const ts = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : event.ts;
  return `${prefix}:${event.channel}:${ts}`;
}

export function buildReplyContext(event: SlackMessageEventLike): ReplyContext {
  // For DMs, don't set thread (DMs don't support threading the same way)
  if (event.channel_type === "im") {
    return {
      channel: event.channel,
      thread: null,
      messageTs: event.ts ?? null,
    };
  }

  // For channel messages, always set thread so bot replies in a thread
  // For root messages: thread = ts (starts a thread under the root)
  // For thread replies: thread = thread_ts (continues existing thread)
  const thread = event.thread_ts && event.thread_ts !== event.ts
    ? event.thread_ts
    : event.ts ?? null;

  return {
    channel: event.channel,
    thread,
    messageTs: event.ts ?? null,
  };
}

export function isOldSlackMessage(ts: string | undefined, bootTimeMs: number): boolean {
  if (!ts) return false;
  const secs = Number(ts.split(".")[0]);
  if (!Number.isFinite(secs)) return false;
  return secs * 1000 < bootTimeMs;
}
