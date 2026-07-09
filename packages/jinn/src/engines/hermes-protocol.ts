// packages/jinn/src/engines/hermes-protocol.ts
import type { ChatBlockStatus, JsonObject, StreamDelta } from "../shared/types.js";

export function encodeModelChoice(provider: string | undefined, model: string): string {
  const m = (model || "").trim();
  const p = (provider || "").trim().toLowerCase();
  if (!m) return "";
  return p ? `${p}:${m}` : m;
}

export function splitModelChoice(choiceId: string): { provider?: string; model: string } {
  const idx = (choiceId || "").indexOf(":");
  if (idx <= 0) return { provider: undefined, model: choiceId };
  return { provider: choiceId.slice(0, idx), model: choiceId.slice(idx + 1) };
}

export function rpcRequest(id: number, method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}
export function rpcNotification(method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

export interface HermesUpdate {
  deltas: StreamDelta[];
  contextTokens?: number;
  commands?: string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function normalizePlanStatus(status: unknown): ChatBlockStatus {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed" || s === "complete" || s === "done" || s === "success") return "done";
  if (s === "in_progress" || s === "running" || s === "active") return "running";
  if (s === "failed" || s === "error" || s === "cancelled") return "error";
  return "queued";
}

function mapPlan(update: Record<string, unknown>): StreamDelta | null {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  const items = entries
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const text = textOf(e.content ?? e.text ?? e.title).trim();
      if (!text) return null;
      const item: JsonObject = {
        id: typeof e.id === "string" && e.id.trim() ? e.id : `plan-${index}`,
        text,
        status: normalizePlanStatus(e.status),
      };
      if (typeof e.priority === "string" && e.priority.trim()) item.priority = e.priority;
      return item;
    })
    .filter((item): item is JsonObject => !!item);
  if (items.length === 0) return null;
  const running = items.filter((item) => item.status === "running").length;
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;
  const status: ChatBlockStatus = running > 0 ? "running" : failed > 0 ? "error" : done === items.length ? "done" : "queued";
  return {
    type: "block",
    content: `Plan: ${items.length} items`,
    block: {
      op: "put",
      block: {
        id: "hermes-plan",
        type: "task-list",
        version: 1,
        status,
        sourceEngine: "hermes",
        title: "Plan",
        summary: `${done}/${items.length} done`,
        payload: { items },
      },
    },
  };
}

export function mapSessionUpdate(update: Record<string, unknown>): HermesUpdate {
  const kind = String(update.sessionUpdate ?? update.type ?? "");
  const deltas: StreamDelta[] = [];
  switch (kind) {
    case "agent_message_chunk":
    case "agent_message_text": {
      const t = textOf(update.content ?? update.text);
      if (t) deltas.push({ type: "text", content: t });
      return { deltas };
    }
    case "agent_thought_chunk":
    case "agent_thought_text":
      // Reasoning — never emit as answer text. (Optionally a status delta.)
      return { deltas };
    case "tool_call": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const name = String(update.title ?? update.kind ?? update.name ?? "tool");
      const input = update.rawInput ?? update.input;
      deltas.push({
        type: "tool_use", content: name, toolId: id, toolName: name,
        input: input !== undefined ? JSON.stringify(input).slice(0, 200) : undefined,
      });
      return { deltas };
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const status = String(update.status ?? "");
      if (status === "completed" || status === "failed") {
        deltas.push({ type: "tool_result", content: status, toolId: id });
      }
      return { deltas };
    }
    case "plan": {
      const delta = mapPlan(update);
      if (delta) deltas.push(delta);
      return { deltas };
    }
    case "usage_update": {
      const used = typeof update.used === "number" ? update.used : undefined;
      if (used !== undefined) deltas.push({ type: "context", content: String(used) });
      return { deltas, contextTokens: used };
    }
    case "available_commands_update": {
      const cmds = Array.isArray(update.availableCommands)
        ? (update.availableCommands as Array<{ name?: string }>).map((c) => String(c.name ?? "")).filter(Boolean)
        : [];
      return { deltas, commands: cmds };
    }
    default:
      return { deltas };
  }
}

/**
 * Fold one streamed answer-text chunk into the accumulated reply.
 *
 * Hermes delivers answer text as incremental `agent_message_chunk` frames while
 * streaming, then may emit a FINAL `agent_message_chunk` carrying the ENTIRE
 * reply (the acp server's `update_agent_message_text` path — fired when a
 * `transform_llm_output` plugin rewrote the output, i.e. `response_transformed`,
 * or when token streaming was skipped). Both the increments and the full-text
 * frame share the same wire kind (`agent_message_chunk`), so appending the
 * full-text frame on top of the increments doubles the reply
 * ("pineapple" + snapshot "pineapple" → "pineapplepineapple").
 *
 * A cumulative full-text frame contains everything accumulated so far as a
 * prefix, so we treat a chunk that starts with the whole accumulation as a
 * snapshot and REPLACE; anything else is a fresh suffix and appends. This
 * mirrors the `text` (append) vs `text_snapshot` (replace) split the grok and
 * antigravity adapters already use. `isSnapshot` lets the caller forward the
 * right delta type to the UI so the live stream doesn't double-render either.
 *
 * Ambiguity note: a reply that legitimately re-sends its full prefix as a single
 * separator-less chunk (e.g. streamed as "banana" + "banana" meaning the literal
 * "bananabanana") is indistinguishable at the wire from the snapshot case and
 * collapses to one copy. Real hermes snapshots are common; that pathological
 * double is not, so replace is the correct trade.
 */
export function accumulateAgentText(acc: string, chunk: string): { text: string; isSnapshot: boolean } {
  if (acc && chunk.startsWith(acc)) return { text: chunk, isSnapshot: true };
  return { text: acc + chunk, isSnapshot: false };
}

export function extractPromptText(prompt: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: prompt }];
}
