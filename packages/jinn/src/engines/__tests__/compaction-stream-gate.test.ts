import { describe, expect, it } from "vitest";
import { CompactionStreamGate } from "../claude-interactive.js";
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

  it("re-decides per message after reset", () => {
    const gate = new CompactionStreamGate();
    gate.accept(text("<analysis>dropped"));
    gate.end();
    gate.reset();
    const out = [...gate.accept(text("Real reply.")), ...gate.end()];
    expect(joined(out)).toBe("Real reply.");
  });
});
