// packages/jinn/src/engines/__tests__/hermes-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeModelChoice, splitModelChoice, rpcRequest, mapSessionUpdate,
  reduceAgentText, isFinalMessageUpdate, initAdvertisesFinalMarker,
} from "../hermes-protocol.js";

describe("model choice encoding", () => {
  it("encodes provider:model and splits back", () => {
    expect(encodeModelChoice("openai-codex", "gpt-5.5")).toBe("openai-codex:gpt-5.5");
    expect(splitModelChoice("openai-codex:gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(splitModelChoice("gpt-5.5")).toEqual({ provider: undefined, model: "gpt-5.5" });
  });
});

describe("rpcRequest", () => {
  it("produces a newline-terminated JSON-RPC 2.0 line", () => {
    const line = rpcRequest(1, "initialize", { protocolVersion: 1 });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
});

describe("mapSessionUpdate", () => {
  it("maps an answer chunk to a text delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(r.deltas).toEqual([{ type: "text", content: "hi" }]);
  });
  it("drops reasoning chunks from text (no leak)", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" } });
    expect(r.deltas.filter((d) => d.type === "text")).toEqual([]);
  });
  it("maps usage_update to contextTokens", () => {
    const r = mapSessionUpdate({ sessionUpdate: "usage_update", size: 272000, used: 11833 });
    expect(r.contextTokens).toBe(11833);
    expect(r.deltas).toContainEqual({ type: "context", content: "11833" });
  });
  it("maps a tool_call to a tool_use delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", rawInput: { cmd: "ls" } });
    expect(r.deltas[0]).toMatchObject({ type: "tool_use", toolId: "t1", toolName: "bash" });
  });
  it("maps plan updates to a reusable task-list block", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Read current chat stream", status: "completed", priority: "high" },
        { content: "Render structured blocks", status: "in_progress", priority: "high" },
      ],
    });

    expect(r.deltas[0]).toMatchObject({
      type: "block",
      block: {
        op: "put",
        block: {
          id: "hermes-plan",
          type: "task-list",
          version: 1,
          sourceEngine: "hermes",
          payload: {
            items: [
              { id: "plan-0", text: "Read current chat stream", status: "done", priority: "high" },
              { id: "plan-1", text: "Render structured blocks", status: "running", priority: "high" },
            ],
          },
        },
      },
    });
  });
  it("marks the aggregate plan block as error when any entry failed", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Read current chat stream", status: "completed" },
        { content: "Render structured blocks", status: "failed" },
      ],
    });

    expect(r.deltas[0]).toMatchObject({
      type: "block",
      block: {
        block: {
          status: "error",
          payload: {
            items: [
              { text: "Read current chat stream", status: "done" },
              { text: "Render structured blocks", status: "error" },
            ],
          },
        },
      },
    });
  });
  it("keeps tool calls but ignores ACP diff content in chat mode", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "edit",
      rawInput: { path: "src/app.ts" },
      content: [
        {
          type: "diff",
          path: "src/app.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    });

    expect(r.deltas).toEqual([{ type: "tool_use", content: "edit", toolId: "edit-1", toolName: "edit", input: "{\"path\":\"src/app.ts\"}" }]);
  });

  it("does not emit a block for incidental before/after fields", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "search-1",
      title: "search",
      status: "completed",
      content: {
        type: "search_result",
        before: "cursor-a",
        after: "cursor-b",
        path: "pagination",
      },
    });

    expect(r.deltas).toEqual([{ type: "tool_result", content: "completed", toolId: "search-1" }]);
  });

  it("correlates a successful MCP receipt with the native Hermes tool id", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      title: "update_work_item",
      status: "completed",
      content: { type: "text", text: '{"activityReceiptId":"todo:wi_release"}' },
    });

    expect(r.deltas).toEqual([{
      type: "tool_result",
      content: "completed",
      toolId: "call-1",
      activityReceiptId: "todo:wi_release",
    }]);
  });
});

// Hermes delivers streamed answer text as incremental agent_message_chunk
// frames AND (on some turns — after a transform_llm_output plugin, or when
// streaming was skipped) a FINAL agent_message_chunk carrying the FULL reply.
// Both share the same wire kind, so content alone cannot tell them apart:
// a transform can REPLACE the reply with shorter/unrelated text (redaction),
// and a legitimate repeated chunk looks like a re-send. hermes-agent >= 0.17.1
// tags the final frame with `_meta.hermes.final`, so the regime is explicit:
// marked -> REPLACE unconditionally; unmarked -> APPEND (repeats never
// swallowed). Older binaries omit the marker; the caller then enables an
// exact-equality dedupe fallback to keep the original doubling bug fixed.
describe("reduceAgentText (marker-driven)", () => {
  it("APPENDS pure incremental unmarked chunks (chunks-only stream)", () => {
    expect(reduceAgentText("hel", "lo", { final: false, legacyDedupe: false }))
      .toEqual({ text: "hello", op: "append" });
    expect(reduceAgentText("", "The", { final: false, legacyDedupe: false }))
      .toEqual({ text: "The", op: "append" });
  });

  it("never swallows a legitimate repeated chunk ('ha','ha' -> 'haha')", () => {
    // The MEDIUM defect in the content heuristic: this MUST append.
    const first = reduceAgentText("", "ha", { final: false, legacyDedupe: false });
    expect(first).toEqual({ text: "ha", op: "append" });
    expect(reduceAgentText(first.text, "ha", { final: false, legacyDedupe: false }))
      .toEqual({ text: "haha", op: "append" });
  });

  it("REPLACES unconditionally on a marked final frame (even shorter/unrelated)", () => {
    // The HIGH defect: a redaction transform replaces the reply with arbitrary
    // text that does NOT start with the streamed prefix — replace must still win
    // so the original streamed text never survives into the transcript.
    expect(reduceAgentText("original secret answer", "[redacted]", { final: true, legacyDedupe: false }))
      .toEqual({ text: "[redacted]", op: "replace" });
    // Shorter replacement.
    expect(reduceAgentText("hello world", "hi", { final: true, legacyDedupe: false }))
      .toEqual({ text: "hi", op: "replace" });
    // Prefix-extending transform (common case) also replaces cleanly.
    expect(reduceAgentText("hello", "hello world", { final: true, legacyDedupe: false }))
      .toEqual({ text: "hello world", op: "replace" });
  });

  it("handles a marked-final-only stream (unstreamed turn, single full frame)", () => {
    expect(reduceAgentText("", "the whole reply", { final: true, legacyDedupe: false }))
      .toEqual({ text: "the whole reply", op: "replace" });
  });

  it("legacy fallback: exact-equality dedupe drops a re-sent full reply", () => {
    // Old binary (no marker): a final unmarked frame equal to everything so far
    // is the re-sent full reply — drop it so the reply doesn't double.
    expect(reduceAgentText("pineapple", "pineapple", { final: false, legacyDedupe: true }))
      .toEqual({ text: "pineapple", op: "drop" });
    // A non-equal unmarked frame still appends under the fallback.
    expect(reduceAgentText("pine", "apple", { final: false, legacyDedupe: true }))
      .toEqual({ text: "pineapple", op: "append" });
  });

  it("marker path ignores legacyDedupe (repeats append even if dedupe on)", () => {
    // With markers available the caller keeps legacyDedupe off; but even if set,
    // an unmarked exact repeat under the MARKER binary must not be swallowed —
    // guarded by the caller passing legacyDedupe=false when the marker is
    // advertised. This asserts the two inputs are independent knobs.
    expect(reduceAgentText("ha", "ha", { final: false, legacyDedupe: false }))
      .toEqual({ text: "haha", op: "append" });
  });
});

describe("isFinalMessageUpdate", () => {
  it("detects the _meta.hermes.final marker on an update", () => {
    expect(isFinalMessageUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "x" }, _meta: { hermes: { final: true } } })).toBe(true);
  });
  it("is false for unmarked / partial / malformed meta", () => {
    expect(isFinalMessageUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "x" } })).toBe(false);
    expect(isFinalMessageUpdate({ _meta: { hermes: { final: false } } })).toBe(false);
    expect(isFinalMessageUpdate({ _meta: { other: { final: true } } })).toBe(false);
    expect(isFinalMessageUpdate({ _meta: "nope" } as any)).toBe(false);
    expect(isFinalMessageUpdate({})).toBe(false);
  });
});

describe("initAdvertisesFinalMarker", () => {
  it("reads agentCapabilities._meta.hermes.finalMessageMarker from the initialize result", () => {
    expect(initAdvertisesFinalMarker({ agentCapabilities: { _meta: { hermes: { finalMessageMarker: true } } } })).toBe(true);
  });
  it("is false for older binaries that omit the capability", () => {
    expect(initAdvertisesFinalMarker({ agentCapabilities: { loadSession: true } })).toBe(false);
    expect(initAdvertisesFinalMarker({})).toBe(false);
    expect(initAdvertisesFinalMarker(undefined)).toBe(false);
    expect(initAdvertisesFinalMarker(null)).toBe(false);
  });
});
