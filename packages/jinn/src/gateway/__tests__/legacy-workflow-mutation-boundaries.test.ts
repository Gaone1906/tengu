import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, ensureSessionCapability } from "../../mcp/identity.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-legacy-workflow-boundaries-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");
let api: Api;
let registry: Registry;
let workItems: WorkItems;

const engineRuns: Array<Record<string, unknown>> = [];
const events: Array<{ event: string; payload: unknown }> = [];
const restartGateway = vi.fn();
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

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  registry.initDb();
});

afterAll(() => {
  registry.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("legacy Workflow run mutation boundaries", () => {
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
      registry.claimCallbackDelivery({
        parentSessionId: legacy.id,
        childSessionId: "historical-child",
        attemptToken: "historical-attempt",
        terminalOutcome: "succeeded",
        terminalVersion: 1,
        callbackKind: "parent-completion",
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

    const delivery = registry.claimCallbackDelivery({
      parentSessionId: parent.id,
      childSessionId: delegated.body.sessionId,
      attemptToken: "ordinary-callback-attempt",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: { message: "Ordinary callback", displayMessage: "Ordinary callback" },
    }).delivery;
    const callback = await request("POST", `/api/sessions/${parent.id}/message`, {
      callbackDeliveryId: delivery.id,
      message: "Ordinary callback",
      displayMessage: "Ordinary callback",
      role: "notification",
    });
    expect(callback.status).toBe(200);
    expect(registry.getCallbackDelivery(delivery.id)?.status).toBe("accepted");
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
