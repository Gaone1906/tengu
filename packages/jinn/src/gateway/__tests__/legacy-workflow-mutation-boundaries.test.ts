import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, ensureSessionCapability } from "../../mcp/identity.js";
import { HookRegistry } from "../hook-registry.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-legacy-workflow-boundaries-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");
let api: Api;
let registry: Registry;
let workItems: WorkItems;
let callbacks: typeof import("../../sessions/callbacks.js");
const processFetch = globalThis.fetch;

const engineRuns: Array<Record<string, unknown>> = [];
const events: Array<{ event: string; payload: unknown }> = [];
const restartGateway = vi.fn();
const hookRegistry = new HookRegistry(30_000, 5_000, 10);
const unclaimedHooks = vi.fn();
hookRegistry.setUnclaimedHookHandler(unclaimedHooks);
const engine = {
  name: "codex",
  run: vi.fn(async (opts: Record<string, unknown>) => {
    engineRuns.push(opts);
    return { result: "ok" };
  }),
  isAlive: () => false,
  kill: () => undefined,
  killAll: () => undefined,
};
const queue = {
  enqueue: async (_key: string, run: () => Promise<void>) => run(),
  clearCancelled: () => undefined,
  clearQueue: () => undefined,
  pauseQueue: () => undefined,
  resumeQueue: () => undefined,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const context = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
    sessions: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  restartGateway,
  hookRegistry,
  hookSecret: "hook-secret",
  emit: (event: string, payload: unknown) => events.push({ event, payload }),
  sessionManager: {
    getEngine: (name: string) => name === "codex" ? engine : undefined,
    getEngines: () => new Map([["codex", engine]]),
    getQueue: () => queue,
  },
} as unknown as import("../api.js").ApiContext;

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this;
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
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
) {
  const cap = responseCapture();
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url: pathname,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    socket: { remoteAddress },
  });
  await api.handleApiRequest(req as Parameters<Api["handleApiRequest"]>[0], cap.res, context);
  return cap;
}

function legacyParent(suffix: string) {
  return registry.createSession({
    engine: "workflow",
    source: "web",
    sourceRef: `workflow-run:${suffix}:parent`,
    sessionKey: `workflow-run:${suffix}:parent`,
    workflowProvenance: {
      kind: "run",
      workflowId: "release-review",
      workflowName: "release-review",
      runId: suffix,
      triggerSource: "manual",
    },
  });
}

function uploadPaths(): string[] {
  const root = path.join(home, "uploads");
  if (!fs.existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      paths.push(path.relative(root, full));
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return paths.sort();
}

function durableSnapshot() {
  const database = registry.initDb();
  return {
    sessions: database.prepare("SELECT * FROM sessions ORDER BY id").all(),
    messages: database.prepare("SELECT * FROM messages ORDER BY id").all(),
    queue: database.prepare("SELECT * FROM queue_items ORDER BY id").all(),
    callbacks: database.prepare("SELECT * FROM callback_deliveries ORDER BY id").all(),
    todos: workItems.listWorkItems().sort((a, b) => a.id.localeCompare(b.id)),
    files: registry.listFiles().sort((a, b) => a.id.localeCompare(b.id)),
    uploadPaths: uploadPaths(),
  };
}

function hookRuntimeSnapshot() {
  const state = hookRegistry as unknown as {
    listeners: Map<string, unknown>;
    buffer: Map<string, unknown[]>;
    unclaimedTimers: Map<string, unknown>;
  };
  return {
    listeners: [...state.listeners.keys()].sort(),
    buffered: [...state.buffer.keys()].sort(),
    timers: [...state.unclaimedTimers.keys()].sort(),
  };
}

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function waitForSettledSession(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (registry.getSession(sessionId)?.status !== "running") return;
    // A wall-clock poll (not a bare setImmediate spin) so a saturated CI event
    // loop still gets real time to drain timers/IO before we give up.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session ${sessionId} did not settle`);
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  callbacks = await import("../../sessions/callbacks.js");
  registry.initDb();
  globalThis.fetch = async () => {
    throw new Error("legacy workflow boundary test callback transport is offline");
  };
});

afterAll(() => {
  globalThis.fetch = processFetch;
  hookRegistry.dispose();
  registry.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks.__resetCallbackRetrySweepForTest();
});

describe("legacy Workflow run mutation boundaries", () => {
  it("guards an explicit legacy parent before replaying an operator delegation receipt", async () => {
    const key = "operator-replay-before-legacy-guard";
    const first = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Create the original ordinary delegation",
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    await waitForSettledSession(first.body.sessionId);
    const legacy = legacyParent("delegation-replay-explicit");
    const before = durableSnapshot();
    const runsBefore = engineRuns.length;
    const eventsBefore = events.length;

    const replay = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Create the original ordinary delegation",
      idempotencyKey: key,
      parentSessionId: legacy.id,
    });

    expect(replay.status).toBe(409);
    expect(replay.body.legacyWorkflowRun).toEqual({
      workflowId: "release-review",
      runId: "delegation-replay-explicit",
      openPath: "/workflow/release-review?mode=runs&run=delegation-replay-explicit",
    });
    expect(durableSnapshot()).toEqual(before);
    expect(engineRuns).toHaveLength(runsBefore);
    expect(events).toHaveLength(eventsBefore);
  });

  it("guards a caller-derived legacy parent before replaying a pre-upgrade receipt", async () => {
    const legacy = legacyParent("delegation-replay-derived");
    const key = "pre-upgrade-derived-replay";
    const digest = crypto.createHash("sha256").update(`${legacy.id}\0${key}`).digest("hex");
    const item = workItems.createWorkItem({
      title: "Historical delegation receipt",
      body: "Compatibility evidence",
      source: "session",
      sourceRef: `session:${legacy.id}:historical-receipt`,
    });
    const receipt = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: `historical-receipt:${legacy.id}`,
      sessionKey: `delegation-idempotency:${digest}`,
      parentSessionId: legacy.id,
    });
    workItems.linkSession(item.id, receipt.id);
    const before = durableSnapshot();
    const runsBefore = engineRuns.length;
    const eventsBefore = events.length;

    const replay = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Retry historical receipt",
      idempotencyKey: key,
    }, callerHeaders(legacy.id));

    expect(replay.status).toBe(409);
    expect(replay.body.legacyWorkflowRun).toEqual({
      workflowId: "release-review",
      runId: "delegation-replay-derived",
      openPath: "/workflow/release-review?mode=runs&run=delegation-replay-derived",
    });
    expect(durableSnapshot()).toEqual(before);
    expect(engineRuns).toHaveLength(runsBefore);
    expect(events).toHaveLength(eventsBefore);
  });

  it("keeps an ordinary delegation replay effect-free and validates bad idempotency input first", async () => {
    const key = "ordinary-replay-control";
    const beforeRuns = engineRuns.length;
    const first = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Ordinary idempotent delegation",
      idempotencyKey: key,
    });
    await waitForSettledSession(first.body.sessionId);
    const afterFirst = durableSnapshot();
    const afterFirstRuns = engineRuns.length;
    const replay = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Ordinary idempotent delegation",
      idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      workItemId: first.body.workItemId,
      sessionId: first.body.sessionId,
    });
    expect(durableSnapshot()).toEqual(afterFirst);
    expect(afterFirstRuns).toBe(beforeRuns + 1);
    expect(engineRuns).toHaveLength(afterFirstRuns);

    const legacy = legacyParent("delegation-invalid-idempotency");
    const invalid = await request("POST", "/api/delegations", {
      engine: "codex",
      task: "Invalid input remains invalid",
      idempotencyKey: "   ",
      parentSessionId: legacy.id,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/idempotencyKey must be a non-empty string/);
  });

  it.each(["SessionStart", "Stop"] as const)(
    "rejects an authenticated %s hook before legacy state or HookRegistry mutation",
    async (hookEvent) => {
      vi.useFakeTimers();
      try {
        const suffix = `hook-${hookEvent.toLowerCase()}`;
        const legacy = legacyParent(suffix);
        registry.updateSession(legacy.id, {
          transportMeta: { keep: "historical-hook-evidence" },
          engineSessionId: "historical-native-id",
          engineSessions: { workflow: { id: "historical-native-id" } },
        });
        registry.insertMessage(legacy.id, "notification", "Historical hook evidence");
        const seen: string[] = [];
        if (hookEvent === "SessionStart") {
          hookRegistry.register(legacy.id, (hook) => seen.push(hook.hook_event_name));
        }
        const before = durableSnapshot();
        const runtimeBefore = hookRuntimeSnapshot();
        const eventsBefore = events.length;
        const fallbackBefore = unclaimedHooks.mock.calls.length;

        const response = await request("POST", "/api/internal/hook", {
          jinnSessionId: legacy.id,
          hook: {
            hook_event_name: hookEvent,
            session_id: `new-native-${hookEvent}`,
            ...(hookEvent === "Stop" ? { last_assistant_message: "Must not be delivered" } : {}),
          },
        }, { "x-jinn-hook-secret": "hook-secret" });

        expect(response.status).toBe(409);
        expect(response.body.legacyWorkflowRun).toEqual({
          workflowId: "release-review",
          runId: suffix,
          openPath: `/workflow/release-review?mode=runs&run=${suffix}`,
        });
        expect(durableSnapshot()).toEqual(before);
        expect(hookRuntimeSnapshot()).toEqual(runtimeBefore);
        expect(seen).toEqual([]);
        expect(events).toHaveLength(eventsBefore);
        expect(vi.getTimerCount()).toBe(0);
        await vi.runAllTimersAsync();
        expect(unclaimedHooks).toHaveBeenCalledTimes(fallbackBefore);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves ordinary authenticated hook delivery and write-once Claude native identity capture", async () => {
    const ordinary = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:ordinary-hook-control",
      sessionKey: "web:ordinary-hook-control",
    });
    const seen: string[] = [];
    hookRegistry.register(ordinary.id, (hook) => seen.push(hook.hook_event_name));

    const start = await request("POST", "/api/internal/hook", {
      jinnSessionId: ordinary.id,
      hook: { hook_event_name: "SessionStart", session_id: "claude-native-control" },
    }, { "x-jinn-hook-secret": "hook-secret" });
    const afterStart = registry.initDb().prepare("SELECT * FROM sessions WHERE id = ?").get(ordinary.id);
    const stop = await request("POST", "/api/internal/hook", {
      jinnSessionId: ordinary.id,
      hook: { hook_event_name: "Stop", session_id: "claude-native-control" },
    }, { "x-jinn-hook-secret": "hook-secret" });

    expect(start.status).toBe(200);
    expect(stop.status).toBe(200);
    expect(seen).toEqual(["SessionStart", "Stop"]);
    expect(registry.getSession(ordinary.id)).toMatchObject({
      engineSessionId: "claude-native-control",
      engineSessions: { claude: { id: "claude-native-control" } },
    });
    expect(registry.initDb().prepare("SELECT * FROM sessions WHERE id = ?").get(ordinary.id)).toEqual(afterStart);
  });

  it("keeps hook authentication, validation, policy, and unknown-target behavior ahead of classification", async () => {
    const legacy = legacyParent("hook-validation-order");
    const badSecret = await request("POST", "/api/internal/hook", {
      jinnSessionId: legacy.id,
      hook: { hook_event_name: "Stop" },
    }, { "x-jinn-hook-secret": "wrong-secret" });
    expect(badSecret.status).toBe(403);

    const nonLoopback = await request("POST", "/api/internal/hook", {
      jinnSessionId: legacy.id,
      hook: { hook_event_name: "Stop" },
    }, { "x-jinn-hook-secret": "hook-secret" }, "10.0.0.5");
    expect(nonLoopback.status).toBe(403);

    const malformed = await request("POST", "/api/internal/hook", {}, {
      "x-jinn-hook-secret": "hook-secret",
    });
    expect(malformed.status).toBe(400);

    const blocked = await request("POST", "/api/internal/hook", {
      jinnSessionId: legacy.id,
      hook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    }, { "x-jinn-hook-secret": "hook-secret" });
    expect(blocked.status).toBe(451);

    const unknown = `unknown-hook-target-${Date.now()}`;
    const accepted = await request("POST", "/api/internal/hook", {
      jinnSessionId: unknown,
      hook: { hook_event_name: "SessionStart", session_id: "unknown-native" },
    }, { "x-jinn-hook-secret": "hook-secret" });
    expect(accepted.status).toBe(200);
    const buffered: string[] = [];
    hookRegistry.register(unknown, (hook) => buffered.push(hook.hook_event_name));
    expect(buffered).toEqual(["SessionStart"]);
  });

  it("rejects a restart before queue, Session, marker, callback, timer, emit, or restart state changes", async () => {
    vi.useFakeTimers();
    try {
      const legacy = legacyParent("restart-boundary");
      registry.updateSession(legacy.id, {
        status: "running",
        transportMeta: { keep: "historical" },
      });
      registry.insertMessage(legacy.id, "notification", "Historical restart evidence");
      const queueItemId = registry.enqueueQueueItem(legacy.id, legacy.sessionKey, "Historical restart queue");
      registry.initDb().prepare("UPDATE queue_items SET status = 'running' WHERE id = ?").run(queueItemId);
      registry.claimSessionDelivery({
        targetSessionId: legacy.id,

        sourceKind: "session",
        sourceId: "historical-child",
        sourceAttempt: "historical-attempt",
        sourceOutcome: "succeeded",
        sourceVersion: 1,
        deliveryKind: "parent-completion",
        payload: { message: "Historical callback", displayMessage: "Historical callback" },
      });
      const before = durableSnapshot();
      const runsBefore = engineRuns.length;
      const eventsBefore = events.length;

      const response = await request("POST", "/api/system/restart", undefined, {
        "x-jinn-session-id": legacy.id,
      });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "Historical Workflow session is read-only.",
        legacyWorkflowRun: {
          workflowId: "release-review",
          runId: "restart-boundary",
          openPath: "/workflow/release-review?mode=runs&run=restart-boundary",
        },
      });
      expect(durableSnapshot()).toEqual(before);
      expect(engineRuns).toHaveLength(runsBefore);
      expect(events).toHaveLength(eventsBefore);
      expect(restartGateway).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(restartGateway).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["delegation explicit parent", "/api/delegations", { engine: "codex", task: "Do not delegate", parentSessionId: "__PARENT__" }, false],
    ["delegation caller-derived parent", "/api/delegations", { engine: "codex", task: "Do not delegate" }, true],
    ["session explicit parent", "/api/sessions", { engine: "codex", prompt: "Do not spawn", parentSessionId: "__PARENT__" }, false],
    ["session caller-derived parent", "/api/sessions", { engine: "codex", prompt: "Do not spawn" }, true],
  ] as const)("rejects %s before every durable or runtime mutation", async (label, pathname, template, derived) => {
    const suffix = `parent-boundary-${label.replaceAll(" ", "-")}`;
    const legacy = legacyParent(suffix);
    const body = JSON.parse(JSON.stringify(template).replace("__PARENT__", legacy.id));
    const before = durableSnapshot();
    const runsBefore = engineRuns.length;
    const eventsBefore = events.length;

    const response = await request("POST", pathname, body, derived ? callerHeaders(legacy.id) : {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Historical Workflow session is read-only.",
      legacyWorkflowRun: {
        workflowId: "release-review",
        runId: suffix,
        openPath: `/workflow/release-review?mode=runs&run=${suffix}`,
      },
    });
    expect(durableSnapshot()).toEqual(before);
    expect(engineRuns).toHaveLength(runsBefore);
    expect(events).toHaveLength(eventsBefore);
  });

  it("preserves ordinary parent creation, delegation ownership, and callback acceptance", async () => {
    const parent = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:ordinary-parent-control",
      sessionKey: "web:ordinary-parent-control",
    });
    const spawned = await request(
      "POST",
      "/api/sessions",
      { engine: "codex", prompt: "Ordinary child" },
      callerHeaders(parent.id),
    );
    expect(spawned.status).toBe(201);
    expect(registry.getSession(spawned.body.id)?.parentSessionId).toBe(parent.id);

    const delegated = await request(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "Ordinary delegated child" },
      callerHeaders(parent.id),
    );
    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({
      parentSessionId: parent.id,
      workItemId: delegated.body.workItemId,
    });
    expect(workItems.getWorkItem(delegated.body.workItemId)?.status).toBe("executing");
    expect(registry.getMessages(parent.id).flatMap((message) => message.blocks ?? []))
      .toContainEqual(expect.objectContaining({ type: "delegation", status: "running" }));

    const delivery = registry.claimSessionDelivery({
      targetSessionId: parent.id,

      sourceKind: "session",
      sourceId: delegated.body.sessionId,
      sourceAttempt: "ordinary-callback-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "Ordinary callback", displayMessage: "Ordinary callback" },
    }).delivery;
    const callback = await request("POST", `/api/sessions/${parent.id}/message`, {
      callbackDeliveryId: delivery.id,
      message: "Ordinary callback",
      displayMessage: "Ordinary callback",
      role: "notification",
    });
    expect(callback.status).toBe(200);
    expect(registry.getSessionDelivery(delivery.id)?.status).toBe("accepted");
    expect(registry.getMessages(parent.id)).toContainEqual(expect.objectContaining({
      role: "notification",
      content: "Ordinary callback",
    }));
  });

  it("keeps legacy interrupted projections out of both startup and endpoint resumable sets", async () => {
    const ordinary = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:ordinary-interrupted",
    });
    registry.updateSession(ordinary.id, {
      status: "interrupted",
      engineSessionId: "ordinary-engine-session",
    });
    const legacy = legacyParent("interrupted-boundary");
    registry.updateSession(legacy.id, {
      status: "interrupted",
      engineSessionId: "legacy-engine-session",
    });
    const database = registry.initDb();
    const legacyBefore = database.prepare("SELECT * FROM sessions WHERE id = ?").get(legacy.id);

    expect(registry.getInterruptedSessions().map((session) => session.id)).toContain(ordinary.id);
    expect(registry.getInterruptedSessions().map((session) => session.id)).not.toContain(legacy.id);
    const endpoint = await request("GET", "/api/sessions/interrupted");
    expect(endpoint.status).toBe(200);
    expect(endpoint.body.map((session: { id: string }) => session.id)).toContain(ordinary.id);
    expect(endpoint.body.map((session: { id: string }) => session.id)).not.toContain(legacy.id);
    expect(database.prepare("SELECT * FROM sessions WHERE id = ?").get(legacy.id)).toEqual(legacyBefore);
  });
});
