import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Connector, Engine, EngineResult, IncomingMessage, Target } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attempt-race-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Reconcile = typeof import("../../work-items/reconcile.js");
type Manager = typeof import("../../sessions/manager.js");

let api: Api;
let registry: Registry;
let store: Store;
let reconcile: Reconcile;
let managerModule: Manager;

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
  authenticated = true,
) {
  const headers = {
    host: authenticated ? "gateway.test" : "127.0.0.1:7777",
    ...(authenticated ? { authorization: "Bearer test-token" } : {}),
    ...(!authenticated ? {
      origin: "http://127.0.0.1:7777",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    } : {}),
    "content-type": "application/json",
  };
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers,
      rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
      ...(!authenticated ? {
        socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 7777 },
      } : {}),
    },
  );
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, context);
  return cap;
}

function trustItemFor(sessionId: string, sourceRef: string) {
  const item = store.createWorkItem({
    title: "Race-sensitive execution",
    status: "executing",
    source: "cron",
    sourceRef,
  });
  store.linkSession(item.id, sessionId);
  return item;
}

function connectorStub(): Connector {
  const target: Target = { channel: "test" };
  return {
    name: "test",
    id: "test",
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => ({ threading: false, messageEdits: false, reactions: false, attachments: false }),
    getHealth: () => ({ status: "running", capabilities: { threading: false, messageEdits: false, reactions: false, attachments: false } }),
    reconstructTarget: () => target,
    sendMessage: async () => undefined,
    replyMessage: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    editMessage: async () => {},
    onMessage: () => {},
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  reconcile = await import("../../work-items/reconcile.js");
  managerModule = await import("../../sessions/manager.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM work_item_events; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions; DELETE FROM work_items;");
});

describe("stop versus successful completion", () => {
  it("lets the unauthenticated loopback dashboard create a session when gateway auth is disabled", async () => {
    const engine: Engine = {
      name: "codex",
      run: async () => ({ sessionId: "loopback-browser-engine", result: "ok" }),
    };
    const queue = new (await import("../../sessions/queue.js")).SessionQueue();
    const context = {
      getConfig: () => ({
        gateway: { host: "127.0.0.1" },
        engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
        models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", label: "GPT-5.5" }] } },
        sessions: {},
        mcp: {},
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
      source: "web",
      prompt: "hello from the local dashboard",
      engine: "codex",
    }, false);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ engine: "codex" });
  });

  it("keeps an HTTP-stopped attempt interrupted when its engine resolves successfully afterward", async () => {
    const run = deferred<EngineResult>();
    const started = deferred<void>();
    const engine: Engine = {
      name: "codex",
      run: async () => {
        started.resolve();
        return run.promise;
      },
    };
    const queue = new (await import("../../sessions/queue.js")).SessionQueue();
    const context = {
      getConfig: () => ({
        gateway: {},
        engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
        models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", label: "GPT-5.5" }] } },
        sessions: {},
        mcp: {},
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

    const created = await request(context, "POST", "/api/sessions", { prompt: "run the race", engine: "codex" });
    expect(created.status).toBe(201);
    const sessionId = created.body.id as string;
    const item = trustItemFor(sessionId, "cron:attempt-race:http");
    await started.promise;

    const stopped = await request(context, "POST", `/api/sessions/${sessionId}/stop`);
    expect(stopped.status).toBe(200);
    expect(registry.getSession(sessionId)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });

    run.resolve({ sessionId: "engine-http", result: "finished after stop" });
    for (let i = 0; i < 2000 && queue.isRunning(registry.getSession(sessionId)!.sessionKey); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(registry.getSession(sessionId)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("blocked");
  });

  it("keeps a manager-reset attempt interrupted when its engine resolves successfully afterward", async () => {
    const run = deferred<EngineResult>();
    const started = deferred<void>();
    const engine: Engine = {
      name: "stub",
      run: async () => {
        started.resolve();
        return run.promise;
      },
    };
    const manager = new managerModule.SessionManager(
      { gateway: {}, engines: { default: "stub", stub: {} }, sessions: {}, mcp: {} } as never,
      new Map([["stub", engine]]),
    );
    const msg: IncomingMessage = {
      connector: "test",
      source: "test",
      sessionKey: "test:attempt-race:manager",
      replyContext: {},
      channel: "test",
      user: "operator",
      userId: "operator",
      text: "run the manager race",
      attachments: [],
      raw: {},
    };

    const route = manager.route(msg, connectorStub());
    await started.promise;
    const session = registry.getSessionBySessionKey(msg.sessionKey)!;
    const item = trustItemFor(session.id, "cron:attempt-race:manager");

    manager.resetSession(msg.sessionKey);
    expect(registry.getSession(session.id)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    run.resolve({ sessionId: "engine-manager", result: "finished after reset" });
    await route;

    expect(registry.getSession(session.id)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("blocked");
  });
});
