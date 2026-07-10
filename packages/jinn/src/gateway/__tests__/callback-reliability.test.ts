import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-reliability-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Queue = typeof import("../../sessions/queue.js");

let api: Api;
let registry: Registry;
let queueModule: Queue;

function makeResponse() {
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

async function postNotification(
  context: import("../api.js").ApiContext,
  sessionId: string,
  message: string,
) {
  const req = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({
      message,
      role: "notification",
      displayMessage: `Display: ${message}`,
    }))]),
    {
      method: "POST",
      url: `/api/sessions/${sessionId}/message`,
      headers: {
        host: "gateway.test",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  expect(captured.status).toBe(200);
  return captured.body;
}

async function clearVisibleQueue(
  context: import("../api.js").ApiContext,
  sessionId: string,
) {
  const req = Object.assign(Readable.from([]), {
    method: "DELETE",
    url: `/api/sessions/${sessionId}/queue`,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  });
  const captured = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  expect(captured.status).toBe(200);
  return captured.body;
}

async function eventually(assertion: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function makeEngine(seenPrompts: string[]): Engine {
  return {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      seenPrompts.push(opts.prompt);
      return {
        sessionId: `stub-${seenPrompts.length}`,
        result: `acknowledged ${seenPrompts.length}`,
      };
    },
  };
}

function makeContext(engine: Engine, queue: {
  enqueue: (...args: never[]) => Promise<void>;
  clearCancelled: (sessionKey: string) => void;
}) {
  const config = {
    gateway: {},
    engines: { default: "stub", stub: {} },
    sessions: {},
    mcp: {},
  };
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["stub", engine]]),
      getQueue: () => queue,
    },
  } as unknown as import("../api.js").ApiContext;
}

function createParent(suffix: string) {
  return registry.createSession({
    engine: "stub",
    source: "web",
    sourceRef: `web:callback-parent:${suffix}`,
    sessionKey: `web:callback-parent:${suffix}`,
    connector: "web",
    prompt: "wait for child callbacks",
  });
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  queueModule = await import("../../sessions/queue.js");
  registry.initDb();
});

beforeEach(() => {
  registry.initDb().exec(`
    DELETE FROM work_item_events;
    DELETE FROM queue_items;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM work_items;
  `);
});

describe("parent callback reliability", () => {
  it("delivers two rapid child callbacks exactly once each", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("rapid");

    await Promise.all([
      postNotification(context, parent.id, "callback-one"),
      postNotification(context, parent.id, "callback-two"),
    ]);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toHaveLength(2);
    });
    expect(seenPrompts).toEqual(["callback-one", "callback-two"]);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(2);
  });

  it("replays an accepted but unconsumed callback after a simulated restart", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent("restart");
    const preRestartQueue = {
      clearCancelled: () => {},
      enqueue: async () => {},
    };

    await postNotification(makeContext(engine, preRestartQueue), parent.id, "callback-after-restart");

    expect(registry.listAllPendingQueueItems()).toEqual([
      expect.objectContaining({
        sessionId: parent.id,
        prompt: "callback-after-restart",
        internal: true,
      }),
    ]);
    expect(registry.getQueueItems(parent.sessionKey)).toEqual([]);
    expect(registry.cancelAllPendingQueueItems(parent.sessionKey)).toBe(0);
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue));

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["callback-after-restart"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
  });

  it("does not discard an internal callback when the operator clears visible queued messages", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("visible-clear");
    queue.pauseQueue(parent.sessionKey);

    await postNotification(context, parent.id, "callback-survives-visible-clear");
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);

    expect(await clearVisibleQueue(context, parent.id)).toMatchObject({
      status: "cleared",
      cancelled: 0,
    });
    queue.resumeQueue(parent.sessionKey);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["callback-survives-visible-clear"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
  });
});
