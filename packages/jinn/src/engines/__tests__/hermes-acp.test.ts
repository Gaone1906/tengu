// packages/jinn/src/engines/__tests__/hermes-acp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { HermesAcpEngine } from "../hermes-acp.js";

// ---------------------------------------------------------------------------
// Fake-server helpers
// ---------------------------------------------------------------------------

/** Standard fake Hermes server: answers initialize/session.new/set_mode/prompt
 *  and streams one answer chunk + usage_update before the prompt result.
 *  Accepts an optional per-message callback for capture. */
function fakeServer(onMessage?: (msg: Record<string, unknown>) => void) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      onMessage?.(msg);
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const note = (params: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new")
        reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/load") reply({});
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        const sid = ((msg.params as Record<string, unknown>)?.sessionId as string) ?? "S1";
        note({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
        note({ sessionId: sid, update: { sessionUpdate: "usage_update", size: 1000, used: 42 } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

/** Fake server that rejects session/load but answers session/new normally. */
function fakeServerLoadFail() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const replyErr = (error: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }) + "\n");
      const note = (params: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/load")
        replyErr({ code: -32000, message: "session not found" });
      else if (msg.method === "session/new")
        reply({ sessionId: "NEW-1", models: { currentModelId: "hermes:default", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        note({ sessionId: "NEW-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback ok" } } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

/** Fake server whose prompt fails before producing any assistant text. */
function fakeServerPromptError() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const replyErr = (error: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new")
        reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt")
        replyErr({ code: -32000, message: "Provided authentication token is expired. Please try signing in again." });
    }
  });
  return rpc;
}

/** Fake server whose prompt completes without any assistant text. */
function fakeServerEmptyPromptResult() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new")
        reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") reply({ stopReason: "end_turn" });
    }
  });
  return rpc;
}

// ---------------------------------------------------------------------------
// Test engines
// ---------------------------------------------------------------------------

class TestEngine extends HermesAcpEngine {
  protected spawnProc() {
    const rpc = fakeServer();
    return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HermesAcpEngine.run", () => {
  it("streams text + context and returns the hermes session id", async () => {
    const eng = new TestEngine();
    const deltas: any[] = [];
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-1", onStream: (d) => deltas.push(d) });
    expect(r.sessionId).toBe("S1");
    expect(r.result).toBe("ok");
    expect(r.contextTokens).toBe(42);
    expect(deltas).toContainEqual({ type: "text", content: "ok" });
    expect(eng.isAlive("jinn-1")).toBe(true);
  });

  // Fix 1 — systemPrompt prepended on fresh session
  it("prepends systemPrompt to prompt on a fresh (non-resume) session", async () => {
    let capturedPromptText = "";

    class SysPromptEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServer((msg) => {
          if (msg.method === "session/prompt") {
            const params = msg.params as Record<string, unknown>;
            const arr = params?.prompt as Array<{ text: string }> | undefined;
            capturedPromptText = arr?.[0]?.text ?? "";
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new SysPromptEngine();
    await eng.run({ prompt: "user question", cwd: "/tmp", sessionId: "sys-1", systemPrompt: "PERSONA-XYZ" });
    expect(capturedPromptText).toContain("PERSONA-XYZ");
    expect(capturedPromptText).toContain("user question");
  });

  it("refreshes platform session context when resumeSessionId is set", async () => {
    let capturedPromptText = "";

    class ResumeEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServer((msg) => {
          if (msg.method === "session/prompt") {
            const params = msg.params as Record<string, unknown>;
            const arr = params?.prompt as Array<{ text: string }> | undefined;
            capturedPromptText = arr?.[0]?.text ?? "";
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new ResumeEngine();
    await eng.run({
      prompt: "user question",
      cwd: "/tmp",
      sessionId: "jinn-resume",
      resumeSessionId: "S1",
      systemPrompt: [
        "# You are Jimbo",
        "PERSONA-XYZ",
        "## Current session",
        "- Session ID: duplicated-jinn-session",
        "- Source: web",
        "## Current configuration",
        "- Gateway: http://127.0.0.1:7777",
        "## Organization",
        "- Should not be repeated on resume",
      ].join("\n"),
    });
    expect(capturedPromptText).toContain("## Jinn platform context refresh");
    expect(capturedPromptText).toContain("- Session ID: duplicated-jinn-session");
    expect(capturedPromptText).toContain("- Gateway: http://127.0.0.1:7777");
    expect(capturedPromptText).not.toContain("PERSONA-XYZ");
    expect(capturedPromptText).not.toContain("Should not be repeated on resume");
    expect(capturedPromptText).toContain("user question");
  });

  // Fix 2(b) — handshake timeout: run() resolves with error instead of hanging
  it("resolves with error (not hangs) when handshake times out", async () => {
    class HangEngine extends HermesAcpEngine {
      protected handshakeTimeoutMs = 50; // milliseconds — fast for tests

      protected spawnProc() {
        const toServer = new PassThrough();
        const fromServer = new PassThrough();
        // fromServer never emits anything — initialize request never resolves
        const rpc = new HermesRpc(toServer, fromServer);
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new HangEngine();
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-hang" });
    expect(r.error).toMatch(/handshake timeout/);
    expect(r.sessionId).toBe("");
    expect(r.result).toBe("");
    // The timed-out proc must be evicted so the next turn respawns clean.
    expect(eng.isAlive("jinn-hang")).toBe(false);
  }, 5_000);

  // Fix 3 — session/load failure falls back to session/new
  it("falls back to session/new when session/load fails, returning the new session id", async () => {
    class LoadFailEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServerLoadFail();
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new LoadFailEngine();
    const r = await eng.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "jinn-stale",
      resumeSessionId: "stale-id",
    });
    expect(r.error).toBeUndefined();
    expect(r.sessionId).toBe("NEW-1");
    expect(r.result).toBe("fallback ok");
  });

  it("evicts the ACP process when a prompt fails before producing text", async () => {
    let killed = false;
    class PromptErrorEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServerPromptError();
        return { rpc, killProc: () => { killed = true; }, isAliveProc: () => !killed, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new PromptErrorEngine();
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-auth-expired" });
    expect(r.result).toBe("");
    expect(r.error).toMatch(/authentication token is expired/);
    expect(killed).toBe(true);
    expect(eng.isAlive("jinn-auth-expired")).toBe(false);
  });

  it("treats an empty prompt completion as an error instead of silent success", async () => {
    class EmptyResultEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServerEmptyPromptResult();
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new EmptyResultEngine();
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-empty" });
    expect(r.result).toBe("");
    expect(r.error).toMatch(/no assistant text/);
  });

  // GRS-018 — the resolved MCP set is emitted into the ACP session handshake.
  // Before this, both call sites hardcoded `mcpServers: []`, so an attached jinn
  // server exposed NO tools to a Hermes session (state.json honest limit).
  describe("ACP mcpServers emit (GRS-018)", () => {
    // The mapper injects JINN_GATEWAY_TOKEN from the gateway process env into
    // the jinn server (Hermes filters inherited env for MCP subprocesses).
    // Pin it to a known value so the wire assertion is deterministic
    // regardless of the test runner's own environment.
    const ORIGINAL_TOKEN = process.env.JINN_GATEWAY_TOKEN;
    beforeEach(() => { process.env.JINN_GATEWAY_TOKEN = "test-bearer-token"; });
    afterEach(() => {
      if (ORIGINAL_TOKEN === undefined) delete process.env.JINN_GATEWAY_TOKEN;
      else process.env.JINN_GATEWAY_TOKEN = ORIGINAL_TOKEN;
    });

    const RESOLVED = {
      mcpServers: {
        jinn: {
          command: "/usr/bin/node",
          args: ["/dist/mcp/server-entry.js"],
          env: { JINN_GATEWAY_URL: "http://127.0.0.1:7777" },
        },
      },
    };
    const EXPECTED_WIRE = [
      {
        name: "jinn",
        command: "/usr/bin/node",
        args: ["/dist/mcp/server-entry.js"],
        env: [
          { name: "JINN_GATEWAY_URL", value: "http://127.0.0.1:7777" },
          { name: "JINN_GATEWAY_TOKEN", value: "test-bearer-token" },
        ],
      },
    ];

    it("session/new carries the mapped resolvedMcp servers", async () => {
      let captured: unknown = "never-called";
      class CaptureEngine extends HermesAcpEngine {
        protected spawnProc() {
          const rpc = fakeServer((msg) => {
            if (msg.method === "session/new") captured = (msg.params as Record<string, unknown>)?.mcpServers;
          });
          return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
        }
      }
      const eng = new CaptureEngine();
      const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-mcp-new", resolvedMcp: RESOLVED });
      expect(r.error).toBeUndefined();
      expect(captured).toEqual(EXPECTED_WIRE);
    });

    it("session/load carries the mapped servers too (resume path)", async () => {
      let captured: unknown = "never-called";
      class CaptureEngine extends HermesAcpEngine {
        protected spawnProc() {
          const rpc = fakeServer((msg) => {
            if (msg.method === "session/load") captured = (msg.params as Record<string, unknown>)?.mcpServers;
          });
          return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
        }
      }
      const eng = new CaptureEngine();
      await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-mcp-load", resumeSessionId: "S1", resolvedMcp: RESOLVED });
      expect(captured).toEqual(EXPECTED_WIRE);
    });

    it("emits [] when no resolvedMcp is provided (unchanged behavior)", async () => {
      let captured: unknown = "never-called";
      class CaptureEngine extends HermesAcpEngine {
        protected spawnProc() {
          const rpc = fakeServer((msg) => {
            if (msg.method === "session/new") captured = (msg.params as Record<string, unknown>)?.mcpServers;
          });
          return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
        }
      }
      const eng = new CaptureEngine();
      await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-mcp-none" });
      expect(captured).toEqual([]);
    });
  });
});
