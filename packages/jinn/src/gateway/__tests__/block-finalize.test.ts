import { describe, expect, it } from "vitest";
import type { StreamDelta } from "../../shared/types.js";
import { foldPartialText, formatEngineErrorAssistantMessage, normalizeBlockDeltaForTurn, shouldPersistFinalAssistantMessage } from "../api.js";

describe("foldPartialText (mid-turn partial accumulation)", () => {
  const text = (content: string): StreamDelta => ({ type: "text", content });
  const snap = (content: string): StreamDelta => ({ type: "text_snapshot", content });

  it("appends incremental text deltas", () => {
    expect(foldPartialText("", text("hel"))).toBe("hel");
    expect(foldPartialText("hel", text("lo"))).toBe("hello");
  });

  it("REPLACES on a snapshot, even a shorter/redacted one (no length gate)", () => {
    // The CRITICAL leak: streamed "secret answer", then a shorter marked final
    // "[REDACTED]" — the partial text must become the redaction, not stay long.
    expect(foldPartialText("secret answer", snap("[REDACTED]"))).toBe("[REDACTED]");
    // Longer snapshot (monotonic grok/antigravity) also replaces — unchanged behavior.
    expect(foldPartialText("hello", snap("hello world"))).toBe("hello world");
    // Equal snapshot is a no-op replace.
    expect(foldPartialText("hello", snap("hello"))).toBe("hello");
  });

  it("ignores non-text deltas", () => {
    expect(foldPartialText("keep", { type: "tool_use", content: "bash" })).toBe("keep");
    expect(foldPartialText("keep", { type: "context", content: "42" })).toBe("keep");
  });
});

describe("block finalization", () => {
  it("persists the final assistant row when the turn produced text", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "Done.",
      quietPreempted: false,
    })).toBe(true);
  });

  it("does not turn a result-less blocks-only completion into a final boundary", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "",
      quietPreempted: false,
    })).toBe(false);
  });

  it("does not persist preempted turns", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "Done.",
      quietPreempted: true,
    })).toBe(false);
  });

  it("formats engine errors as an assistant-visible message", () => {
    expect(formatEngineErrorAssistantMessage("Hermes turn ended with no assistant text"))
      .toBe("⛔ Hermes turn ended with no assistant text");
  });

  it("drops malformed block deltas before scoping ids", () => {
    const result = normalizeBlockDeltaForTurn({
      type: "block",
      block: { op: "put", block: { type: "task-list", version: 1, payload: { items: [] } } },
    } as unknown as StreamDelta, 1_700_000_000_000);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("block id");
  });

  it("scopes valid block ids to the current turn", () => {
    const result = normalizeBlockDeltaForTurn({
      type: "block",
      content: "",
      block: {
        op: "put",
        block: {
          id: "plan",
          type: "task-list",
          version: 1,
          payload: { items: [{ id: "a", text: "Read code" }] },
        },
      },
    }, 1_700_000_000_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delta.block?.block.id).toMatch(/^plan:t/);
      expect(result.delta.content).toBe("task-list: 1 item");
    }
  });
});
