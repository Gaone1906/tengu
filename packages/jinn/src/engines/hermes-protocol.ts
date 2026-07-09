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

export type HermesTextOp = "append" | "replace" | "drop";

/**
 * Fold one streamed answer-text chunk into the accumulated reply.
 *
 * Hermes delivers answer text as incremental `agent_message_chunk` frames while
 * streaming, then may emit a FINAL `agent_message_chunk` carrying the ENTIRE
 * reply (the acp server's `update_agent_message_text` path — fired when a
 * `transform_llm_output` plugin rewrote the output, or when token streaming was
 * skipped). Both share the same wire kind, so a naive `acc += chunk` doubles the
 * reply, and content alone cannot tell an increment from the final full frame:
 * a transform can REPLACE the reply with shorter/unrelated text (a redaction —
 * whose prefix does NOT match the streamed text), and a legitimately repeated
 * chunk ("ha","ha") looks like a re-send. A content heuristic gets both wrong.
 *
 * So the regime is EXPLICIT on the wire. hermes-agent >= 0.17.1 tags the final
 * frame with `_meta.hermes.final` (see {@link isFinalMessageUpdate}):
 *   - `final` (marked)  → REPLACE unconditionally — even if shorter/unrelated,
 *     so a redaction wins and the streamed text never survives.
 *   - otherwise         → APPEND — legitimate repeats are never swallowed.
 *
 * `legacyDedupe` is the compatibility fallback for OLD hermes binaries that
 * don't send the marker (the caller enables it only when the initialize
 * capability is absent — see {@link initAdvertisesFinalMarker}): an unmarked
 * frame that exactly equals everything accumulated so far is the re-sent full
 * reply and is DROPPED, keeping the original doubling bug fixed. A pre-marker
 * binary whose transform REPLACED the reply with new text (rare) cannot be
 * distinguished and will append — accepted; the marker fixes it going forward.
 */
export function reduceAgentText(
  acc: string,
  chunk: string,
  opts: { final: boolean; legacyDedupe: boolean },
): { text: string; op: HermesTextOp } {
  if (opts.final) return { text: chunk, op: "replace" };
  if (opts.legacyDedupe && acc && chunk === acc) return { text: acc, op: "drop" };
  return { text: acc + chunk, op: "append" };
}

/** True when an ACP `session/update` carries the hermes final-full-reply marker. */
export function isFinalMessageUpdate(update: Record<string, unknown> | null | undefined): boolean {
  const meta = update && typeof update === "object" ? (update as Record<string, unknown>)._meta : undefined;
  const hermes = meta && typeof meta === "object" ? (meta as Record<string, unknown>).hermes : undefined;
  return !!(hermes && typeof hermes === "object" && (hermes as Record<string, unknown>).final === true);
}

/**
 * True when the `initialize` result advertises that this hermes build tags its
 * final full-reply frame (`agentCapabilities._meta.hermes.finalMessageMarker`).
 * When false (older binary), the caller falls back to exact-equality dedupe.
 */
export function initAdvertisesFinalMarker(initResult: unknown): boolean {
  const r = initResult && typeof initResult === "object" ? (initResult as Record<string, unknown>) : undefined;
  const caps = r && typeof r.agentCapabilities === "object" ? (r.agentCapabilities as Record<string, unknown>) : undefined;
  const meta = caps && typeof caps._meta === "object" ? (caps._meta as Record<string, unknown>) : undefined;
  const hermes = meta && typeof meta.hermes === "object" ? (meta.hermes as Record<string, unknown>) : undefined;
  return !!(hermes && hermes.finalMessageMarker === true);
}

export function extractPromptText(prompt: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: prompt }];
}
