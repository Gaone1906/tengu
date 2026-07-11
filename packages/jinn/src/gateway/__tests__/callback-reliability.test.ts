import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-reliability-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Queue = typeof import("../../sessions/queue.js");
type Callbacks = typeof import("../../sessions/callbacks.js");
type WorkItems = typeof import("../../work-items/store.js");

let api: Api;
let registry: Registry;
let queueModule: Queue;
let callbacks: Callbacks;
let workItems: WorkItems;

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

async function postCallbackDelivery(
  context: import("../api.js").ApiContext,
  sessionId: string,
  callbackDeliveryId: string,
) {
  const req = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({ callbackDeliveryId }))]),
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
}, events: Array<{ event: string; data: unknown }> = []) {
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
    emit: (event: string, data: unknown) => events.push({ event, data }),
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["stub", engine]]),
      getQueue: () => queue,
    },
  } as unknown as import("../api.js").ApiContext;
}

function createParent(suffix: string, source: "web" | "talk" = "web") {
  return registry.createSession({
    engine: "stub",
    source,
    sourceRef: `${source}:callback-parent:${suffix}`,
    sessionKey: `${source}:callback-parent:${suffix}`,
    connector: source,
    prompt: "wait for child callbacks",
  });
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  queueModule = await import("../../sessions/queue.js");
  callbacks = await import("../../sessions/callbacks.js");
  workItems = await import("../../work-items/store.js");
  registry.initDb();
});

beforeEach(() => {
  registry.initDb().exec(`
    DELETE FROM work_item_events;
    DELETE FROM callback_deliveries;
    DELETE FROM queue_items;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM work_items;
  `);
});

describe("parent callback reliability", () => {
  it("collapses six real settlement callbacks through the sender, HTTP route, SQLite, and queue", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue, events);
    const parent = createParent("real-sender-six");
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:callback-child:real-six",
      sessionKey: "web:callback-child:real-six",
      connector: "web",
      employee: "worker",
      parentSessionId: parent.id,
      prompt: "complete delegated work",
    });
    const attempt = registry.beginSessionAttempt(child.id)!;
    const completed = registry.completeSessionAttempt(child.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
    const originalFetch = globalThis.fetch;
    const routeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const req = Object.assign(
        Readable.from([Buffer.from(String(init?.body ?? ""))]),
        {
          method: init?.method ?? "GET",
          url: `${target.pathname}${target.search}`,
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
      return {
        ok: captured.status >= 200 && captured.status < 300,
        status: captured.status,
        json: async () => captured.body,
      } as Response;
    });
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    try {
      for (let index = 0; index < 6; index++) {
        callbacks.notifyParentSession(completed, { result: "one immutable completion" });
      }

      await eventually(() => {
        expect(queue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toEqual([expect.stringContaining("one immutable completion")]);
        expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
        expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
      });
      expect(routeFetch).toHaveBeenCalledTimes(6);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains the completion guard and suppresses the parent when nudge acceptance loses its response", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const acceptedWithoutExecution = {
      clearCancelled: () => {},
      enqueue: async () => {},
    };
    const context = makeContext(engine, acceptedWithoutExecution);
    const parent = createParent("nudge-response-loss");
    const item = workItems.createWorkItem({
      title: "Complete bounded callback work",
      status: "executing",
      source: "delegation",
    });
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:callback-child:nudge-response-loss",
      sessionKey: "web:callback-child:nudge-response-loss",
      connector: "web",
      employee: "worker",
      parentSessionId: parent.id,
      transportMeta: { delegationCompletionTracked: true },
      prompt: "complete delegated work",
    });
    workItems.linkSession(item.id, child.id);
    const attempt = registry.beginSessionAttempt(child.id)!;
    const completed = registry.completeSessionAttempt(child.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
    const originalFetch = globalThis.fetch;
    let loseAcceptedResponse = true;
    const routeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const req = Object.assign(
        Readable.from([Buffer.from(String(init?.body ?? ""))]),
        {
          method: init?.method ?? "GET",
          url: `${target.pathname}${target.search}`,
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
      if (target.pathname === `/api/sessions/${child.id}/message` && loseAcceptedResponse) {
        loseAcceptedResponse = false;
        throw new Error("accepted response lost");
      }
      return {
        ok: captured.status >= 200 && captured.status < 300,
        status: captured.status,
        json: async () => captured.body,
      } as Response;
    });
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    try {
      callbacks.notifyParentSession(completed, {
        result: "Progress update: I will continue with the remaining implementation.",
      });

      await eventually(() => {
        const receipt = registry.initDb().prepare(`
          SELECT status FROM callback_deliveries WHERE callback_kind = 'delegation-completion-nudge'
        `).get();
        expect(receipt).toEqual({ status: "accepted" });
      });
      expect(routeFetch).toHaveBeenCalledOnce();
      expect(registry.getMessages(child.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getMessages(parent.id)).toEqual([]);
      expect(registry.initDb().prepare(`
        SELECT COUNT(*) AS n FROM callback_deliveries WHERE callback_kind = 'parent-completion'
      `).get()).toEqual({ n: 0 });
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts six duplicate callback deliveries as one message, queue item, arrival, and parent turn", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const context = makeContext(engine, queue, events);
    const parent = createParent("idempotent-six");
    const delivery = registry.claimCallbackDelivery({
      parentSessionId: parent.id,
      childSessionId: "child-completed",
      attemptToken: "attempt-generation-1",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: {
        message: "one engine callback",
        displayMessage: "Worker replied\nOne result",
        meta: {
          kind: "child-reply",
          employee: "worker",
          childSessionId: "child-completed",
          fullMessage: "One result",
        },
      },
    }).delivery;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postCallbackDelivery(context, parent.id, delivery.id)),
    );
    // Simulate an accepted response being lost and the HTTP client retrying.
    responses.push(await postCallbackDelivery(context, parent.id, delivery.id));

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["one engine callback"]);
    });
    expect(responses.filter((response) => response.status === "queued")).toHaveLength(1);
    expect(responses.filter((response) => response.status === "duplicate")).toHaveLength(6);
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toEqual([
      expect.objectContaining({
        content: "Worker replied\nOne result",
        meta: expect.objectContaining({ kind: "child-reply", childSessionId: "child-completed" }),
      }),
    ]);
    const stored = registry.getCallbackDelivery(delivery.id)!;
    expect(stored).toMatchObject({ status: "accepted" });
    expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM queue_items WHERE id = ?").get(stored.queueItemId))
      .toEqual({ n: 1 });
    expect(events.filter(({ event }) => event === "session:notification")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: parent.id, message: "Worker replied\nOne result" }),
      }),
    ]);
  });

  it("replays one accepted callback queue intent after restart without accepting or announcing it twice", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent("callback-restart");
    const delivery = registry.claimCallbackDelivery({
      parentSessionId: parent.id,
      childSessionId: "child-restart",
      attemptToken: "attempt-restart-1",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: {
        message: "callback after restart",
        displayMessage: "Worker replied\nRestart result",
      },
    }).delivery;
    const preRestartQueue = {
      clearCancelled: () => {},
      enqueue: async () => {},
    };

    await postCallbackDelivery(makeContext(engine, preRestartQueue, events), parent.id, delivery.id);
    await postCallbackDelivery(makeContext(engine, preRestartQueue, events), parent.id, delivery.id);

    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue, events));

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["callback after restart"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
    expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
  });

  it("replays an accepted callback queue intent for a non-web parent after restart", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent("talk-restart", "talk");
    const delivery = registry.claimCallbackDelivery({
      parentSessionId: parent.id,
      childSessionId: "child-talk-restart",
      attemptToken: "attempt-talk-restart-1",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "talk-attachment",
      payload: {
        message: "attached callback after restart",
        displayMessage: "Attached worker replied\nRestart result",
      },
    }).delivery;
    const preRestartQueue = {
      clearCancelled: () => {},
      enqueue: async () => {},
    };

    await postCallbackDelivery(makeContext(engine, preRestartQueue), parent.id, delivery.id);
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue));

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["attached callback after restart"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
  });

  it("delivers a legitimate resumed attempt as a second callback", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("resume-generation");
    const base = {
      parentSessionId: parent.id,
      childSessionId: "child-resumed",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
    };
    const first = registry.claimCallbackDelivery({
      ...base,
      attemptToken: "attempt-1",
      payload: { message: "first attempt", displayMessage: "First attempt" },
    }).delivery;
    const resumed = registry.claimCallbackDelivery({
      ...base,
      attemptToken: "attempt-2",
      payload: { message: "resumed attempt", displayMessage: "Resumed attempt" },
    }).delivery;

    await postCallbackDelivery(context, parent.id, first.id);
    await postCallbackDelivery(context, parent.id, resumed.id);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["first attempt", "resumed attempt"]);
    });
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(2);
  });

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
