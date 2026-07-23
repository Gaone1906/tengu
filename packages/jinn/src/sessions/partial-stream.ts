import type { ChatBlockEnvelope, StreamDelta } from "../shared/types.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import {
  applyBlockEnvelope,
  insertPartialMessage,
  settlePartialToolMessage,
  updatePartialMessage,
} from "./registry.js";

function scopeBlockEnvelopeForTurn(
  envelope: ChatBlockEnvelope,
  turnStartedAt: number,
): ChatBlockEnvelope {
  const suffix = `t${turnStartedAt.toString(36)}`;
  if (envelope.block.id.endsWith(`:${suffix}`)) return envelope;
  const maxBaseLength = Math.max(1, 96 - suffix.length - 1);
  const baseId = envelope.block.id.slice(0, maxBaseLength);
  return {
    ...envelope,
    block: {
      ...envelope.block,
      id: `${baseId}:${suffix}`,
    },
  };
}

export function normalizeBlockDeltaForTurn(
  delta: StreamDelta,
  turnStartedAt: number,
): { ok: true; delta: StreamDelta } | { ok: false; error: string } {
  if (delta.type !== "block") return { ok: true, delta };
  const initial = validateBlockEnvelope(delta.block);
  if (!initial.ok) return initial;
  const scoped = scopeBlockEnvelopeForTurn(initial.envelope, turnStartedAt);
  const validated = validateBlockEnvelope(scoped);
  if (!validated.ok) return validated;
  return {
    ok: true,
    delta: {
      ...delta,
      content: delta.content || blockFallbackText(validated.envelope.block),
      block: validated.envelope,
    },
  };
}

/**
 * Fold a streamed text/text_snapshot delta into the accumulated partial text.
 * Incremental text appends; an authoritative snapshot always replaces.
 */
export function foldPartialText(curText: string, delta: StreamDelta): string {
  if (delta.type === "text_snapshot") {
    return typeof delta.content === "string" ? delta.content : curText;
  }
  if (delta.type === "text") {
    return curText + (typeof delta.content === "string" ? delta.content : "");
  }
  return curText;
}

export interface PartialStreamWriter {
  persist(delta: StreamDelta): void;
  finish(): void;
}

/** Persist one engine turn's live stream as coalesced partial transcript rows. */
export function createPartialStreamWriter(sessionId: string): PartialStreamWriter {
  let partialSeq = 0;
  let curTextId: string | null = null;
  let curText = "";
  const openPartialTools: Array<{
    messageId: string;
    toolName: string;
    toolId?: string;
  }> = [];
  let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearScheduledFlush = () => {
    if (!partialFlushTimer) return;
    clearTimeout(partialFlushTimer);
    partialFlushTimer = null;
  };
  const flushPartialText = () => {
    partialFlushTimer = null;
    if (!curText.trim()) return;
    if (curTextId) updatePartialMessage(curTextId, curText);
    else curTextId = insertPartialMessage(sessionId, "assistant", curText, partialSeq++);
  };

  return {
    persist(delta) {
      if (delta.type === "text" || delta.type === "text_snapshot") {
        if (typeof delta.content !== "string") return;
        curText = foldPartialText(curText, delta);
        if (delta.type === "text_snapshot") {
          clearScheduledFlush();
          flushPartialText();
        } else if (!partialFlushTimer) {
          partialFlushTimer = setTimeout(flushPartialText, 600);
        }
        return;
      }

      if (delta.type === "tool_use") {
        clearScheduledFlush();
        flushPartialText();
        const tool = delta.toolName || String(delta.content ?? "");
        const messageId = insertPartialMessage(
          sessionId,
          "assistant",
          `Using ${tool}`,
          partialSeq++,
          tool,
          delta.toolId,
        );
        openPartialTools.push({
          messageId,
          toolName: tool,
          ...(delta.toolId ? { toolId: delta.toolId } : {}),
        });
        curTextId = null;
        curText = "";
        return;
      }

      if (delta.type === "tool_result") {
        const matchIndex = delta.toolId
          ? openPartialTools.findIndex((entry) => entry.toolId === delta.toolId)
          : (() => {
              if (!delta.toolName) return -1;
              for (let index = openPartialTools.length - 1; index >= 0; index--) {
                if (openPartialTools[index]?.toolName === delta.toolName) return index;
              }
              return -1;
            })();
        if (matchIndex < 0) return;
        const [match] = openPartialTools.splice(matchIndex, 1);
        if (!match) return;
        const activityReceiptId = extractActivityReceiptId({
          activityReceiptId: delta.activityReceiptId,
        });
        settlePartialToolMessage(
          match.messageId,
          `Used ${match.toolName}`,
          activityReceiptId,
        );
        return;
      }

      if (delta.type === "block" && delta.block) {
        clearScheduledFlush();
        flushPartialText();
        applyBlockEnvelope(sessionId, delta.block, delta.content, {
          partial: true,
          seq: partialSeq++,
        });
        curTextId = null;
        curText = "";
      }
    },
    finish() {
      clearScheduledFlush();
      flushPartialText();
    },
  };
}
