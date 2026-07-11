import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, StreamDelta } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-streamed-settlement-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");

let api: Api;
let registry: Registry;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function request(
  context: import("../api.js").ApiContext,
  method: string,
  url: string,
  body?: unknown,
) {
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: {
        host: "gateway.test",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    },
  );
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, context);
  return cap;
}

async function waitForSettlement(sessionId: string) {
  for (let i = 0; i < 200; i++) {
    const session = registry.getSession(sessionId);
    if (session && session.status !== "running") return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} did not settle`);
}

async function runTurn(
  deltas: StreamDelta[],
  result: EngineResult,
): Promise<{ context: import("../api.js").ApiContext; sessionId: string; reload: Record<string, unknown> }> {
  const engine: Engine = {
    name: "codex",
    run: async (opts: EngineRunOpts) => {
      for (const delta of deltas) opts.onStream?.(delta);
      return result;
    },
  };
  const queue = new (await import("../../sessions/queue.js")).SessionQueue();
  const context = {
    getConfig: () => ({
      gateway: {},
      engines: { default: "codex", codex: { bin: "codex", model: "gpt-test" } },
      models: { codex: { default: "gpt-test", models: [{ id: "gpt-test", label: "Test" }] } },
      sessions: {},
      mcp: { gateway: { enabled: false }, browser: { enabled: false } },
    }),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["codex", engine]]),
      getQueue: () => queue,
    },
  } as unknown as import("../api.js").ApiContext;

  const created = await request(context, "POST", "/api/sessions", {
    prompt: "perform the task",
    engine: "codex",
  });
  expect(created.status).toBe(201);
  const sessionId = created.body.id as string;
  await waitForSettlement(sessionId);
  const reloaded = await request(context, "GET", `/api/sessions/${sessionId}`);
  expect(reloaded.status).toBe(200);
  return { context, sessionId, reload: reloaded.body as Record<string, unknown> };
}

function normalizedRows(reload: Record<string, unknown>) {
  return (reload.messages as Array<Record<string, unknown>>).map((message) => ({
    role: message.role,
    content: message.content,
    partial: message.partial === true,
    toolCall: message.toolCall,
    blockTypes: Array.isArray(message.blocks)
      ? (message.blocks as Array<Record<string, unknown>>).map((block) => block.type)
      : [],
  }));
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
});

beforeEach(() => {
  registry.initDb().exec("DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});

describe("completed streamed-turn settlement", () => {
  it("reloads the same completed fold membership as the live web completion path", async () => {
    const { reload } = await runTurn([
      { type: "text", content: "Inspecting the workspace." },
      { type: "tool_use", content: "Bash", toolName: "Bash" },
      { type: "tool_result", content: "ok", toolName: "Bash" },
      {
        type: "block",
        content: "Temporary plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            payload: { items: [{ id: "step", text: "Inspect", status: "done" }] },
          },
        },
      },
      {
        type: "block",
        content: "Delegated verification",
        block: {
          op: "put",
          block: {
            id: "handoff",
            type: "delegation",
            version: 1,
            payload: {
              employee: "qa-lead",
              employeeDisplay: "QA Lead",
              title: "Verify the change",
              childSessionId: "child-session",
              workItemId: "work-item",
              dispatchedAt: 1,
            },
          },
        },
      },
      { type: "text", content: "Verification returned clean." },
    ], { sessionId: "engine-1", result: "Completed successfully." });

    expect(normalizedRows(reload)).toEqual([
      { role: "user", content: "perform the task", partial: false, toolCall: undefined, blockTypes: [] },
      { role: "assistant", content: "Inspecting the workspace.", partial: false, toolCall: undefined, blockTypes: [] },
      { role: "assistant", content: "Used Bash", partial: false, toolCall: "Bash", blockTypes: [] },
      { role: "assistant", content: "Delegated verification", partial: false, toolCall: undefined, blockTypes: ["delegation"] },
      { role: "assistant", content: "Verification returned clean.", partial: false, toolCall: undefined, blockTypes: [] },
      { role: "assistant", content: "Completed successfully.", partial: false, toolCall: undefined, blockTypes: [] },
    ]);
  });

  it("dedupes one exact streamed result row but keeps the canonical final after tool evidence", async () => {
    const { reload } = await runTurn([
      { type: "text", content: "FINAL ANSWER" },
      { type: "tool_use", content: "Bash", toolName: "Bash" },
      { type: "tool_result", content: "ok", toolName: "Bash" },
    ], { sessionId: "engine-2", result: "FINAL ANSWER" });

    expect(normalizedRows(reload).map(({ content }) => content)).toEqual([
      "perform the task",
      "Used Bash",
      "FINAL ANSWER",
    ]);
  });

  it("keeps concatenating prose fragments as evidence and appends the canonical full result", async () => {
    const { reload } = await runTurn([
      { type: "text", content: "first" },
      { type: "tool_use", content: "Read", toolName: "Read" },
      { type: "tool_result", content: "ok", toolName: "Read" },
      { type: "text", content: "final" },
    ], { sessionId: "engine-3", result: "first final" });

    expect(normalizedRows(reload).map(({ content }) => content)).toEqual([
      "perform the task",
      "first",
      "Used Read",
      "final",
      "first final",
    ]);
  });

  it("does not manufacture a final boundary for a result-less completion", async () => {
    const { reload } = await runTurn([
      { type: "text", content: "unfinished prose" },
      { type: "tool_use", content: "Read", toolName: "Read" },
    ], { sessionId: "engine-empty", result: "" });

    expect(normalizedRows(reload)).toEqual([
      { role: "user", content: "perform the task", partial: false, toolCall: undefined, blockTypes: [] },
    ]);
  });

  it("preserves completed evidence before a canonical terminal error row", async () => {
    const { reload } = await runTurn([
      { type: "text", content: "Checking the failing operation." },
      { type: "tool_use", content: "Read", toolName: "Read" },
      { type: "tool_result", content: "failed", toolName: "Read" },
    ], { sessionId: "engine-error", result: "", error: "operation failed" });

    expect(normalizedRows(reload).map(({ content }) => content)).toEqual([
      "perform the task",
      "Checking the failing operation.",
      "Used Read",
      "Error: operation failed",
    ]);
  });

  it("drops partials and the late result after an explicit stop", async () => {
    const result = deferred<EngineResult>();
    const started = deferred<void>();
    const engine: Engine = {
      name: "codex",
      run: async (opts: EngineRunOpts) => {
        opts.onStream?.({ type: "text", content: "stale interim" });
        opts.onStream?.({ type: "tool_use", content: "Bash", toolName: "Bash" });
        started.resolve();
        return result.promise;
      },
    };
    const queue = new (await import("../../sessions/queue.js")).SessionQueue();
    const context = {
      getConfig: () => ({
        gateway: {},
        engines: { default: "codex", codex: { bin: "codex", model: "gpt-test" } },
        models: { codex: { default: "gpt-test", models: [{ id: "gpt-test", label: "Test" }] } },
        sessions: {},
        mcp: { gateway: { enabled: false }, browser: { enabled: false } },
      }),
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../api.js").ApiContext;

    const created = await request(context, "POST", "/api/sessions", { prompt: "stop this", engine: "codex" });
    const sessionId = created.body.id as string;
    await started.promise;
    expect((await request(context, "POST", `/api/sessions/${sessionId}/stop`)).status).toBe(200);
    result.resolve({ sessionId: "engine-stopped", result: "stale final" });
    const sessionKey = registry.getSession(sessionId)!.sessionKey;
    for (let i = 0; i < 200 && queue.isRunning(sessionKey); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(registry.getMessages(sessionId).map((message) => message.content)).toEqual(["stop this"]);
    expect(registry.getSession(sessionId)?.status).toBe("interrupted");
  });
});
