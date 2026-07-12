import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeRouteBackedFetch(
  context: import("../api.js").ApiContext,
  behavior: { failBefore?: number; throwAfterAccepted?: number } = {},
) {
  let calls = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls <= (behavior.failBefore ?? 0)) throw new Error(`pre-accept timeout ${calls}`);
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
      method: init?.method ?? "GET",
      url: `${target.pathname}${target.search}`,
      headers: {
        host: "gateway.test",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    });
    const captured = makeResponse();
    await api.handleApiRequest(req as never, captured.res, context);
    if (calls <= (behavior.throwAfterAccepted ?? 0)) throw new Error(`accepted response lost ${calls}`);
    return { ok: captured.status >= 200 && captured.status < 300, status: captured.status } as Response;
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
  it("accepts replayed manager visibility once at the durable parent boundary", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue, events);
    const manager = createParent("manager-visibility");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeRouteBackedFetch(context) as unknown as typeof fetch;
    const details = {
      manager: "team-lead",
      managerDisplay: "Team Lead",
      delegator: "org-root",
      delegatorDisplay: "Org Root",
      employee: "worker",
      employeeDisplay: "Worker",
      childSessionId: "visibility-child",
      workItemId: "wi_visibility_boundary",
      title: "Inspect durable visibility",
    };

    try {
      for (let index = 0; index < 6; index++) callbacks.notifyManagerVisibility(manager.id, details);

      await eventually(() => {
        expect(queue.isRunning(manager.sessionKey)).toBe(false);
        expect(seenPrompts).toHaveLength(1);
      });
      const accepted = registry.initDb().prepare(`
        SELECT id, status FROM callback_deliveries WHERE callback_kind = 'manager-visibility'
      `).get();
      callbacks.notifyManagerVisibility(manager.id, details);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(registry.initDb().prepare(`
        SELECT COUNT(*) AS n FROM callback_deliveries WHERE callback_kind = 'manager-visibility'
      `).get()).toEqual({ n: 1 });
      expect(registry.initDb().prepare(`
        SELECT id, status FROM callback_deliveries WHERE callback_kind = 'manager-visibility'
      `).get()).toEqual(accepted);
      expect(registry.getMessages(manager.id).filter((message) => message.role === "notification"))
        .toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps repeated rate-limit lifecycle callbacks nonterminal and independent from completion", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue, events);
    const parent = createParent("rate-lifecycle");
    const item = workItems.createWorkItem({
      title: "Complete work after the rate limit clears",
      status: "executing",
      source: "delegation",
    });
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:rate-lifecycle-child",
      sessionKey: "web:rate-lifecycle-child",
      connector: "web",
      employee: "worker",
      parentSessionId: parent.id,
      transportMeta: { delegationCompletionTracked: true },
      prompt: "complete after a rate limit",
    });
    workItems.linkSession(item.id, child.id);
    registry.applyBlockEnvelope(parent.id, {
      op: "put",
      block: {
        id: `dg-${item.id}`,
        type: "delegation",
        version: 1,
        status: "running",
        payload: {
          employee: "worker",
          employeeDisplay: "Worker",
          title: item.title,
          childSessionId: child.id,
          workItemId: item.id,
          dispatchedAt: Date.now(),
        },
      },
    });
    const attempt = registry.beginSessionAttempt(child.id)!;
    registry.completeSessionAttempt(child.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    });
    expect(registry.claimDelegationCompletionNudge(child.id, item.id)).toBeTruthy();
    const rateLimited = registry.getSession(child.id)!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeRouteBackedFetch(context) as unknown as typeof fetch;

    try {
      for (let index = 0; index < 4; index++) callbacks.notifyRateLimited(rateLimited);

      await eventually(() => {
        expect(queue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toHaveLength(1);
      });
      const rateLimitedPayload = JSON.parse((registry.initDb().prepare(`
        SELECT payload FROM callback_deliveries WHERE callback_kind = 'rate-limited'
      `).get() as { payload: string }).payload) as Record<string, unknown>;
      expect(rateLimitedPayload).not.toHaveProperty("meta");
      expect(rateLimitedPayload).not.toHaveProperty("block");
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
      expect(registry.getMessages(parent.id).flatMap((message) => message.blocks ?? []))
        .toContainEqual(expect.objectContaining({ id: `dg-${item.id}`, status: "running" }));
      expect(workItems.getWorkItem(item.id)).toMatchObject({ status: "executing", closedAt: null });

      for (let index = 0; index < 4; index++) callbacks.notifyRateLimitResumed(rateLimited);
      for (let index = 0; index < 4; index++) {
        callbacks.notifyParentSession(rateLimited, { result: "one final escalation" });
      }

      await eventually(() => {
        expect(queue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toHaveLength(3);
      });
      expect(registry.initDb().prepare(`
        SELECT callback_kind AS kind, COUNT(*) AS n
        FROM callback_deliveries
        GROUP BY callback_kind
        ORDER BY callback_kind
      `).all()).toEqual([
        { kind: "parent-completion", n: 1 },
        { kind: "rate-limit-resumed", n: 1 },
        { kind: "rate-limited", n: 1 },
      ]);
      expect(registry.getMessages(parent.id).filter((message) => message.meta?.kind === "child-reply"))
        .toHaveLength(1);
      expect(registry.getMessages(parent.id).flatMap((message) => message.blocks ?? []))
        .toContainEqual(expect.objectContaining({ id: `dg-${item.id}`, status: "done" }));
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "surfaced" },
      });
      expect(events.filter(({ event, data }) =>
        event === "session:notification"
        && (data as { meta?: { kind?: string } }).meta?.kind === "child-reply",
      )).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["web", "talk"] as const)(
    "collapses six identical rate-limit-resumed callbacks for a %s parent",
    async (source) => {
      const seenPrompts: string[] = [];
      const events: Array<{ event: string; data: unknown }> = [];
      const engine = makeEngine(seenPrompts);
      const queue = new queueModule.SessionQueue();
      const context = makeContext(engine, queue, events);
      const parent = createParent(`rate-resumed-${source}`, source);
      const child = registry.createSession({
        engine: "stub",
        source: "web",
        sourceRef: `web:rate-resumed-child:${source}`,
        sessionKey: `web:rate-resumed-child:${source}`,
        connector: "web",
        employee: "worker",
        title: "Rate limited work",
        parentSessionId: parent.id,
        prompt: "resume after rate limit",
      });
      const attempt = registry.beginSessionAttempt(child.id)!;
      const resumed = registry.updateSession(child.id, {
        status: "running",
        attemptOutcome: null,
      })!;
      expect(resumed.attemptToken).toBe(attempt.attemptToken);
      const originalFetch = globalThis.fetch;
      const routeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
          method: init?.method ?? "GET",
          url: `${target.pathname}${target.search}`,
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
        return { ok: captured.status >= 200 && captured.status < 300, status: captured.status } as Response;
      });
      globalThis.fetch = routeFetch as unknown as typeof fetch;

      try {
        for (let index = 0; index < 6; index++) callbacks.notifyRateLimitResumed(resumed);

        await eventually(() => {
          expect(queue.isRunning(parent.sessionKey)).toBe(false);
          expect(seenPrompts).toHaveLength(1);
        });
        expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
        expect(registry.initDb().prepare(`
          SELECT COUNT(*) AS n FROM callback_deliveries WHERE callback_kind = 'rate-limit-resumed'
        `).get()).toEqual({ n: 1 });
        expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("keeps rate-limit waiting and resumed receipts independently deliverable", async () => {
    const parent = createParent("rate-kinds");
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:rate-kind-child",
      sessionKey: "web:rate-kind-child",
      connector: "web",
      employee: "worker",
      parentSessionId: parent.id,
      prompt: "rate kind distinction",
    });
    const attempt = registry.beginSessionAttempt(child.id)!;
    const active = registry.getSession(child.id)!;
    expect(active.attemptToken).toBe(attempt.attemptToken);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("hold both receipts pending")) as unknown as typeof fetch;

    try {
      callbacks.notifyRateLimited(active);
      callbacks.notifyRateLimitResumed(active);
      await eventually(() => {
        const rows = registry.initDb().prepare(`
          SELECT callback_kind AS kind FROM callback_deliveries ORDER BY callback_kind
        `).all();
        expect(rows).toEqual([{ kind: "rate-limit-resumed" }, { kind: "rate-limited" }]);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
      expect(routeFetch).toHaveBeenCalledOnce();
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

  it("recovers a pending completion nudge before scanning orphan guards at startup", async () => {
    const engine = makeEngine([]);
    const acceptedWithoutExecution = { clearCancelled: () => {}, enqueue: async () => {} };
    const context = makeContext(engine, acceptedWithoutExecution);
    const parent = createParent("startup-nudge-order");
    const item = workItems.createWorkItem({
      title: "Recover a pending continuation",
      status: "executing",
      source: "delegation",
    });
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:startup-nudge-child",
      sessionKey: "web:startup-nudge-child",
      connector: "web",
      employee: "worker",
      parentSessionId: parent.id,
      transportMeta: { delegationCompletionTracked: true },
      prompt: "continue after startup",
    });
    workItems.linkSession(item.id, child.id);
    const attempt = registry.beginSessionAttempt(child.id)!;
    const idle = registry.completeSessionAttempt(child.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
    registry.claimDelegationCompletionNudge(idle.id, item.id);
    registry.claimCallbackDelivery({
      parentSessionId: idle.id,
      childSessionId: idle.id,
      attemptToken: idle.attemptToken!,
      terminalOutcome: "succeeded",
      terminalVersion: idle.attemptTerminalVersion!,
      callbackKind: "delegation-completion-nudge",
      payload: { message: "continue existing task", displayMessage: "continuing task" },
    });
    const orphanParent = createParent("startup-unrelated-orphan");
    const orphanItem = workItems.createWorkItem({
      title: "Surface an unrelated orphan",
      status: "executing",
      source: "delegation",
    });
    const orphan = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:startup-unrelated-orphan",
      sessionKey: "web:startup-unrelated-orphan",
      connector: "web",
      parentSessionId: orphanParent.id,
      transportMeta: { delegationCompletionTracked: true },
      prompt: "orphaned continuation",
    });
    workItems.linkSession(orphanItem.id, orphan.id);
    const orphanAttempt = registry.beginSessionAttempt(orphan.id)!;
    registry.completeSessionAttempt(orphan.id, orphanAttempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    });
    registry.claimDelegationCompletionNudge(orphan.id, orphanItem.id);
    const requestPaths: string[] = [];
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requestPaths.push(target.pathname);
      if (target.pathname === `/api/sessions/${child.id}/message`) await pendingGate;
      const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
        method: init?.method ?? "GET",
        url: `${target.pathname}${target.search}`,
        headers: {
          host: "gateway.test",
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
      });
      const captured = makeResponse();
      await api.handleApiRequest(req as never, captured.res, context);
      return { ok: true, status: captured.status } as Response;
    }) as unknown as typeof fetch;

    try {
      const recovery = callbacks.recoverCallbackStateOnStartup();
      await eventually(() => expect(requestPaths).toHaveLength(1));
      expect(requestPaths[0]).toBe(`/api/sessions/${child.id}/message`);
      releasePending();
      await expect(recovery).resolves.toEqual({
        pendingRecovered: 1,
        orphanedRecovered: 1,
      });
      expect(registry.getMessages(child.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getMessages(parent.id)).toEqual([]);
      expect(registry.getMessages(orphanParent.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("quarantines a poison row and still recovers the following valid receipt across restart", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const context = makeContext(makeEngine(seenPrompts), new queueModule.SessionQueue(), events);
    const parent = createParent("poison-restart");
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: "web:poison-restart-child",
      sessionKey: "web:poison-restart-child",
      connector: "web",
      parentSessionId: parent.id,
      prompt: "finish after poison",
    });
    const database = registry.initDb();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO callback_deliveries (
        id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
        terminal_version, callback_kind, payload, status, created_at
      ) VALUES ('poison-before-valid', ?, ?, 'poison-attempt', 'failed', 1,
        'parent-completion', '{bad json', 'pending', '2026-01-01T00:00:00.000Z')
    `).run(parent.id, child.id);
    database.pragma("ignore_check_constraints = OFF");
    const valid = registry.claimCallbackDelivery({
      parentSessionId: parent.id,
      childSessionId: child.id,
      attemptToken: "valid-attempt",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: { message: "valid after poison", displayMessage: "valid after poison" },
    }).delivery;
    const originalFetch = globalThis.fetch;
    const routeFetch = makeRouteBackedFetch(context);
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    try {
      await expect(callbacks.recoverCallbackStateOnStartup()).resolves.toEqual({
        pendingRecovered: 1,
        orphanedRecovered: 0,
      });
      await eventually(() => expect(seenPrompts).toEqual(["valid after poison"]));
      await expect(callbacks.recoverCallbackStateOnStartup()).resolves.toEqual({
        pendingRecovered: 0,
        orphanedRecovered: 0,
      });
      expect(registry.getCallbackDelivery(valid.id)).toMatchObject({ status: "accepted" });
      expect(database.prepare(`
        SELECT status, last_error AS lastError FROM callback_deliveries WHERE id = 'poison-before-valid'
      `).get()).toMatchObject({ status: "dead_letter", lastError: expect.stringMatching(/invalid payload json/i) });
      expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
      expect(routeFetch).toHaveBeenCalledOnce();
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

  it.each(["web", "talk"] as const)(
    "keeps an accepted %s callback queue intent pending while its engine is unavailable",
    async (source) => {
      const seenPrompts: string[] = [];
      const events: Array<{ event: string; data: unknown }> = [];
      const engine = makeEngine(seenPrompts);
      const parent = createParent(`missing-engine-${source}`, source);
      const delivery = registry.claimCallbackDelivery({
        parentSessionId: parent.id,
        childSessionId: `child-missing-engine-${source}`,
        attemptToken: `attempt-missing-engine-${source}`,
        terminalOutcome: "succeeded",
        terminalVersion: 1,
        callbackKind: source === "web" ? "parent-completion" : "talk-attachment",
        payload: {
          message: `callback survives ${source} engine outage`,
          displayMessage: "Worker replied\nEngine outage result",
        },
      }).delivery;
      const preRestartQueue = {
        clearCancelled: () => {},
        enqueue: async () => {},
      };

      await postCallbackDelivery(makeContext(engine, preRestartQueue, events), parent.id, delivery.id);
      const accepted = registry.getCallbackDelivery(delivery.id)!;
      const messageId = accepted.messageId;
      const queueItemId = accepted.queueItemId;
      expect(accepted).toMatchObject({ status: "accepted" });
      expect(messageId).toBeTruthy();
      expect(queueItemId).toBeTruthy();

      const postRestartQueue = new queueModule.SessionQueue();
      const restoredContext = makeContext(engine, postRestartQueue, events);
      let engineAvailable = false;
      restoredContext.sessionManager.getEngine = () => engineAvailable ? engine : undefined;

      api.resumePendingWebQueueItems(restoredContext);

      expect(seenPrompts).toEqual([]);
      expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({
        status: "accepted",
        messageId,
        queueItemId,
      });
      expect(registry.listAllPendingQueueItems()).toEqual([
        expect.objectContaining({ id: queueItemId, status: "pending" }),
      ]);

      engineAvailable = true;
      api.resumePendingWebQueueItems(restoredContext);

      await eventually(() => {
        expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toEqual([`callback survives ${source} engine outage`]);
        expect(registry.listAllPendingQueueItems()).toEqual([]);
      });
      expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({
        status: "accepted",
        messageId,
        queueItemId,
      });
      expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
        .toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    },
  );

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

describe("callback live retry sweep", () => {
  afterEach(() => {
    callbacks.__resetCallbackRetrySweepForTest();
    vi.useRealTimers();
  });

  function createCompletedChild(parentId: string, suffix: string) {
    const child = registry.createSession({
      engine: "stub",
      source: "web",
      sourceRef: `web:retry-child:${suffix}`,
      sessionKey: `web:retry-child:${suffix}`,
      connector: "web",
      employee: "worker",
      parentSessionId: parentId,
      prompt: "complete retry work",
    });
    const attempt = registry.beginSessionAttempt(child.id)!;
    return registry.completeSessionAttempt(child.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
  }

  it("automatically retries one pre-accept timeout after persisted backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("live-retry");
    const child = createCompletedChild(parent.id, "live-retry");
    const routeFetch = makeRouteBackedFetch(context, { failBefore: 1 });
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    callbacks.notifyParentSession(child, { result: "retry once" });
    await vi.advanceTimersByTimeAsync(0);
    expect(routeFetch).toHaveBeenCalledOnce();
    const pending = registry.listPendingCallbackDeliveries()[0];
    expect(pending).toMatchObject({ attemptCount: 1, status: "pending", lastError: expect.stringContaining("timeout") });

    await vi.advanceTimersByTimeAsync(callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS[0] - 1);
    expect(routeFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTicks();

    expect(routeFetch).toHaveBeenCalledTimes(2);
    expect(registry.getCallbackDelivery(pending.id)).toMatchObject({ status: "accepted", attemptCount: 2 });
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(seenPrompts).toHaveLength(1);
  });

  it("restores the persisted timer without sending early after restart during backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    const engine = makeEngine([]);
    const context = makeContext(engine, new queueModule.SessionQueue());
    const parent = createParent("restart-backoff");
    const child = createCompletedChild(parent.id, "restart-backoff");
    const failingFetch = vi.fn().mockRejectedValue(new Error("offline"));
    globalThis.fetch = failingFetch as unknown as typeof fetch;

    callbacks.notifyParentSession(child, { result: "retry after restart" });
    await vi.advanceTimersByTimeAsync(0);
    const delivery = registry.listPendingCallbackDeliveries()[0];
    callbacks.__resetCallbackRetrySweepForTest();
    const routeFetch = makeRouteBackedFetch(context);
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    await expect(callbacks.recoverPendingCallbackDeliveries()).resolves.toBe(0);
    expect(routeFetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS[0]);
    await vi.runAllTicks();

    expect(routeFetch).toHaveBeenCalledOnce();
    expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({ status: "accepted", attemptCount: 2 });
  });

  it("never retries an accepted receipt when its HTTP response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(30_000));
    const engine = makeEngine([]);
    const context = makeContext(engine, new queueModule.SessionQueue());
    const parent = createParent("accepted-immunity");
    const child = createCompletedChild(parent.id, "accepted-immunity");
    const routeFetch = makeRouteBackedFetch(context, { throwAfterAccepted: 1 });
    globalThis.fetch = routeFetch as unknown as typeof fetch;

    callbacks.notifyParentSession(child, { result: "accepted once" });
    await vi.advanceTimersByTimeAsync(0);
    const delivery = registry.initDb().prepare(`
      SELECT id FROM callback_deliveries WHERE callback_kind = 'parent-completion'
    `).get() as { id: string };
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);

    expect(routeFetch).toHaveBeenCalledOnce();
    expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({ status: "accepted", attemptCount: 1 });
  });

  it("dead-letters an exhausted receipt and never retries it again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(40_000));
    const parent = createParent("retry-exhaustion");
    const child = createCompletedChild(parent.id, "retry-exhaustion");
    const failingFetch = vi.fn().mockRejectedValue(new Error("permanent outage"));
    globalThis.fetch = failingFetch as unknown as typeof fetch;

    callbacks.notifyParentSession(child, { result: "eventually dead letter" });
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTicks();
    }
    const delivery = registry.initDb().prepare(`SELECT id FROM callback_deliveries`).get() as { id: string };
    expect(registry.getCallbackDelivery(delivery.id)).toMatchObject({
      status: "dead_letter",
      attemptCount: callbacks.CALLBACK_DELIVERY_MAX_ATTEMPTS,
      deadLetteredAt: expect.any(Number),
    });
    const attemptsAtExhaustion = failingFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(failingFetch).toHaveBeenCalledTimes(attemptsAtExhaustion);
  });
});
