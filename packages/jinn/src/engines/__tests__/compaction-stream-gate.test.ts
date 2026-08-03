import { describe, expect, it } from "vitest";
import { CompactionStreamGate, sseEventToDeltas } from "../claude-interactive.js";
import type { StreamDelta } from "../../shared/types.js";

const text = (content: string): StreamDelta[] => [{ type: "text", content }];
const joined = (deltas: StreamDelta[]): string => deltas.map((d) => String(d.content ?? "")).join("");

/**
 * Claude Code's auto-compaction call reaches the SSE proxy with the main agent's
 * tools and sentinel, so it used to stream its `<analysis>…<summary>…` payload into
 * the chat as a giant assistant bubble (the "summary leakage" + raw `<analysis>`
 * tag users reported). The gate drops that one message and nothing else.
 */
describe("CompactionStreamGate", () => {
  it("drops a compaction summary message entirely", () => {
    const gate = new CompactionStreamGate();
    const out = [
      ...gate.accept(text("<anal")),
      ...gate.accept(text("ysis>\nLet me work through")),
      ...gate.accept(text("</analysis>\n<summary>This session is being continued</summary>")),
      ...gate.end(),
    ];
    expect(out).toEqual([]);
  });

  it("passes a normal reply through, losing nothing", () => {
    const gate = new CompactionStreamGate();
    const out = [
      ...gate.accept(text("Here")),
      ...gate.accept(text(" is the answer.")),
      ...gate.end(),
    ];
    expect(joined(out)).toBe("Here is the answer.");
  });

  it("releases held text for a reply shorter than the opener", () => {
    const gate = new CompactionStreamGate();
    const out = [...gate.accept(text("<a")), ...gate.end()];
    expect(joined(out)).toBe("<a");
  });

  it("passes a tool call immediately and flushes text held before it", () => {
    const gate = new CompactionStreamGate();
    const out = gate.accept([
      { type: "text", content: "<" },
      { type: "tool_use", content: "Bash", toolName: "Bash" },
    ]);
    expect(out.map((d) => d.type)).toEqual(["text", "tool_use"]);
  });

  /**
   * Regression guard: every real message opens with message_start, which
   * sseEventToDeltas turns into a `context` delta. The gate used to treat any
   * non-text delta as proof of a real reply, so that first `context` latched
   * `pass` and the gate dropped nothing in production — while these tests
   * passed, because they fed it text directly and never replayed the real seam.
   * Drive the actual event through sseEventToDeltas so the seam is covered.
   */
  it("still drops a compaction summary that opens with a real message_start context delta", () => {
    const gate = new CompactionStreamGate();
    const startDeltas = sseEventToDeltas({
      type: "message_start",
      message: { usage: { input_tokens: 152340 } },
    } as never);
    expect(startDeltas.map((d) => d.type)).toEqual(["context"]);

    gate.reset();
    const out = [
      ...gate.accept(startDeltas),
      ...gate.accept(text("<analysis>\nLet me work through")),
      ...gate.accept(text("</analysis>\n<summary>continued</summary>")),
      ...gate.end(),
    ];
    // The context delta is metadata and must survive; the summary text must not.
    expect(out.map((d) => d.type)).toEqual(["context"]);
    expect(joined(out.filter((d) => d.type === "text"))).toBe("");
  });

  it("forwards the context delta and still passes a normal reply after it", () => {
    const gate = new CompactionStreamGate();
    const startDeltas = sseEventToDeltas({
      type: "message_start",
      message: { usage: { input_tokens: 900, cache_read_input_tokens: 100 } },
    } as never);
    gate.reset();
    const out = [...gate.accept(startDeltas), ...gate.accept(text("Here is the answer.")), ...gate.end()];
    expect(out.map((d) => d.type)).toEqual(["context", "text"]);
    expect(joined(out.filter((d) => d.type === "context"))).toBe("1000");
    expect(joined(out.filter((d) => d.type === "text"))).toBe("Here is the answer.");
  });

  it("re-decides per message after reset", () => {
    const gate = new CompactionStreamGate();
    gate.accept(text("<analysis>dropped"));
    gate.end();
    gate.reset();
    const out = [...gate.accept(text("Real reply.")), ...gate.end()];
    expect(joined(out)).toBe("Real reply.");
  });

  /**
   * Issue #102. `<suggestion>` is a model-generated *suggested next user turn*. It must
   * not reach the transcript, but unlike `<analysis>` it must be STRIPPED, not dropped:
   * it is usually fused to the front of a genuine reply, and dropping the message would
   * trade an information leak for silent data loss.
   */
  describe("suggestion blocks", () => {
    it("strips a leading suggestion block and keeps the reply behind it", () => {
      const gate = new CompactionStreamGate();
      const out = [
        ...gate.accept(text("<suggestion>keep going</suggestion>Leg 1 returned.")),
        ...gate.end(),
      ];
      expect(joined(out)).toBe("Leg 1 returned.");
      expect(joined(out)).not.toContain("keep going");
    });

    /** Edge case from the report: the opening tag arrives split across stream deltas. */
    it("strips a suggestion whose opening tag is split across deltas", () => {
      const gate = new CompactionStreamGate();
      const out = [
        ...gate.accept(text("<sugg")),
        ...gate.accept(text("estion>only notify me for todos i create")),
        ...gate.accept(text("</suggestion>CTO's message crossed.")),
        ...gate.end(),
      ];
      expect(joined(out)).toBe("CTO's message crossed.");
      expect(joined(out)).not.toContain("notify me");
    });

    it("emits nothing for a standalone suggestion message", () => {
      const gate = new CompactionStreamGate();
      const out = [
        ...gate.accept(text("<suggestion>Sounds good, keep going</suggestion>")),
        ...gate.end(),
      ];
      expect(out).toEqual([]);
    });

    /** Edge case from the report: the message ends mid-block. Fail closed. */
    it("fails closed on an unterminated suggestion block", () => {
      const gate = new CompactionStreamGate();
      const out = [
        ...gate.accept(text("<suggestion>go with literal source == 'human'")),
        ...gate.accept(text(" and re-arm")),
        ...gate.end(),
      ];
      expect(out).toEqual([]);
    });

    it("releases held text when the opener turns out not to be a suggestion", () => {
      const gate = new CompactionStreamGate();
      const out = [
        ...gate.accept(text("<sug")),
        ...gate.accept(text("ar is sweet.")),
        ...gate.end(),
      ];
      expect(joined(out)).toBe("<sugar is sweet.");
    });

    it("forwards the message_start context delta and still strips the suggestion after it", () => {
      const gate = new CompactionStreamGate();
      const startDeltas = sseEventToDeltas({
        type: "message_start",
        message: { usage: { input_tokens: 4200 } },
      } as never);
      gate.reset();
      const out = [
        ...gate.accept(startDeltas),
        ...gate.accept(text("<suggestion>write the final report to Onyx</suggestion>Report written.")),
        ...gate.end(),
      ];
      expect(out.map((d) => d.type)).toEqual(["context", "text"]);
      expect(joined(out.filter((d) => d.type === "text"))).toBe("Report written.");
    });
  });
});
