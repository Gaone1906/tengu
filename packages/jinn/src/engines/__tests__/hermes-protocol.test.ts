// packages/jinn/src/engines/__tests__/hermes-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeModelChoice, splitModelChoice, rpcRequest, mapSessionUpdate,
  accumulateAgentText,
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
});

// Regression: Hermes delivers streamed answer text as incremental
// agent_message_chunk frames AND (on some turns — e.g. after a
// transform_llm_output plugin sets response_transformed, or when streaming was
// skipped) a FINAL agent_message_chunk carrying the FULL reply. Both share the
// same wire kind, so a naive `resultText += chunk` doubles the reply
// ("pineapplepineapple"). accumulateAgentText treats a cumulative full-text
// frame (one that starts with everything accumulated so far) as a snapshot and
// REPLACES instead of appending. Frame shapes captured from real hermes acp
// (hermes-agent v0.17.0, openai-codex:gpt-5.5).
describe("accumulateAgentText", () => {
  // Helper: fold a sequence of chunks the way hermes-acp onNote does.
  const fold = (chunks: string[]) =>
    chunks.reduce(
      (acc, chunk) => accumulateAgentText(acc, chunk).text,
      "",
    );

  it("appends pure incremental chunks (chunks-only stream)", () => {
    expect(fold(["hel", "lo"])).toBe("hello");
    expect(fold(["The", " quick", " brown", " fox"])).toBe("The quick brown fox");
  });

  it("replaces (does not double) a full-text snapshot after chunks", () => {
    // Real capture: "pine" + "apple" increments, then a full "pineapple" frame.
    expect(fold(["pine", "apple", "pineapple"])).toBe("pineapple");
  });

  it("replaces when a one-shot reply is followed by its identical snapshot", () => {
    // Real capture: "banana" (single chunk == full reply), then "banana" snapshot.
    expect(fold(["banana", "banana"])).toBe("banana");
  });

  it("handles a snapshots-only stream (no prior increments)", () => {
    expect(fold(["hello"])).toBe("hello");
    expect(fold(["hello", "hello world"])).toBe("hello world");
  });

  it("keeps a transformed snapshot that extends the streamed prefix", () => {
    // Increments stream "hello"; a transform rewrites the final to "hello world".
    expect(fold(["hel", "lo", "hello world"])).toBe("hello world");
  });

  it("does NOT treat a fresh suffix as a snapshot (no false replace)", () => {
    // A legitimate continuation is a suffix, never a re-send of the whole prefix.
    expect(fold(["hello", " world"])).toBe("hello world");
    // Repeated word with a separator streams as a suffix — must append.
    expect(fold(["banana", " banana"])).toBe("banana banana");
  });

  it("reports isSnapshot so the caller can emit text_snapshot vs text", () => {
    expect(accumulateAgentText("pineapple", "pineapple")).toEqual({ text: "pineapple", isSnapshot: true });
    expect(accumulateAgentText("pine", "apple")).toEqual({ text: "pineapple", isSnapshot: false });
    expect(accumulateAgentText("", "pine")).toEqual({ text: "pine", isSnapshot: false });
  });
});
