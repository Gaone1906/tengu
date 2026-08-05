import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connector,
  Engine,
  EngineResult,
  EngineRunOpts,
  IncomingMessage,
  JinnConfig,
  Target,
} from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-platform-dispatch-"));
process.env.JINN_HOME = home;

vi.mock("../../shared/rateLimit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/rateLimit.js")>();
  return {
    ...actual,
    computeNextRetryDelayMs: () => ({ delayMs: 0 }),
    computeRateLimitDeadlineMs: () => Date.now() + 60_000,
  };
});

type Registry = typeof import("../registry.js");
type ManagerModule = typeof import("../manager.js");
type Api = typeof import("../../gateway/api.js");

let registry: Registry;
let managerModule: ManagerModule;
let api: Api;

function makeConfig(port = 7799): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port },
    engines: {
      default: "codex",
      claude: { bin: process.execPath, model: "model-beta" },
      codex: { bin: process.execPath, model: "model-alpha", effortLevel: "medium" },
    },
    models: {
      codex: { default: "model-alpha", models: [{ id: "model-alpha", label: "Alpha" }] },
      claude: { default: "model-beta", models: [{ id: "model-beta", label: "Beta" }] },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    sessions: {},
    mcp: {},
    portal: { setupComplete: true },
  } as JinnConfig;
}

function capturingEngine(
  name: string,
  runs: EngineRunOpts[],
  resultForRun: (runNumber: number) => EngineResult = () => ({ sessionId: `${name}-native`, result: "ok" }),
): Engine {
  return {
    name,
    run: async (opts) => {
      runs.push(opts);
      return resultForRun(runs.length);
    },
  };
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

function incoming(text: string, channel = "channel-a"): IncomingMessage {
  return {
    connector: "test",
    source: "test",
    sessionKey: "test:platform-context",
    replyContext: {},
    channel,
    user: "operator",
    userId: "operator",
    text,
    attachments: [],
    raw: {},
  };
}

function headingCount(run: EngineRunOpts): number {
  return run.platformContextRefresh?.match(/## Jinn platform context refresh/g)?.length ?? 0;
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

async function request(context: import("../../gateway/api.js").ApiContext, method: string, url: string, body?: unknown) {
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

async function waitForRuns(runs: EngineRunOpts[], count: number): Promise<void> {
  for (let i = 0; i < 100 && runs.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(runs).toHaveLength(count);
}

async function waitForStatus(sessionId: string, status: "idle" | "error"): Promise<void> {
  for (let i = 0; i < 100 && registry.getSession(sessionId)?.status !== status; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(registry.getSession(sessionId)?.status).toBe(status);
}

beforeAll(async () => {
  registry = await import("../registry.js");
  managerModule = await import("../manager.js");
  api = await import("../../gateway/api.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(async () => {
  (await import("../../shared/db.js")).initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("SessionManager platform context dispatch", () => {
  it("keeps a refresh pending when a rate-limit retry fails", async () => {
    const runs: EngineRunOpts[] = [];
    const results: EngineResult[] = [
      { sessionId: "codex-native", result: "ok" },
      { sessionId: "codex-native", result: "", error: "usage limit", rateLimit: { status: "rejected" } },
      { sessionId: "codex-native", result: "", error: "transient retry failure", cost: 0.01 },
      { sessionId: "codex-native", result: "ok" },
      { sessionId: "codex-native", result: "ok" },
    ];
    const engine = capturingEngine("codex", runs, (runNumber) => results[runNumber - 1]);
    const manager = new managerModule.SessionManager(makeConfig(), new Map([["codex", engine]]), "boot-a" as any);
    const connector = connectorStub();

    await manager.route(incoming("initial success"), connector);
    const session = registry.getSessionBySessionKey("test:platform-context")!;
    const initialFingerprint = registry.getEngineSessionRef(session, "codex").platformContextFingerprint;

    manager.setConfig(makeConfig(7800));
    await manager.route(incoming("failed retry refresh"), connector);
    expect(runs.slice(1, 3).map(headingCount)).toEqual([1, 1]);
    expect(registry.getEngineSessionRef(registry.getSession(session.id)!, "codex").platformContextFingerprint).toBe(initialFingerprint);

    await manager.route(incoming("successful refresh"), connector);
    expect(headingCount(runs[3])).toBe(1);
    const acceptedFingerprint = registry.getEngineSessionRef(registry.getSession(session.id)!, "codex").platformContextFingerprint;
    expect(acceptedFingerprint).not.toBe(initialFingerprint);

    await manager.route(incoming("stable after success"), connector);
    expect(headingCount(runs[4])).toBe(0);
  });

  it("keeps a failed refresh pending until a successful turn accepts it", async () => {
    const runs: EngineRunOpts[] = [];
    let failNext = false;
    const engine = capturingEngine("codex", runs, () => {
      if (failNext) {
        failNext = false;
        return { sessionId: "codex-native", result: "", error: "transient engine failure", cost: 0.01 };
      }
      return { sessionId: "codex-native", result: "ok" };
    });
    const engines = new Map<string, Engine>([["codex", engine]]);
    const manager = new managerModule.SessionManager(makeConfig(), engines, "boot-a" as any);
    const connector = connectorStub();

    await manager.route(incoming("initial success"), connector);
    const session = registry.getSessionBySessionKey("test:platform-context")!;
    const initialFingerprint = registry.getEngineSessionRef(session, "codex").platformContextFingerprint;

    manager.setConfig(makeConfig(7800));
    failNext = true;
    await manager.route(incoming("failed refresh"), connector);
    expect(headingCount(runs[1])).toBe(1);
    expect(registry.getEngineSessionRef(registry.getSession(session.id)!, "codex").platformContextFingerprint).toBe(initialFingerprint);

    await manager.route(incoming("successful refresh"), connector);
    expect(headingCount(runs[2])).toBe(1);
    const acceptedFingerprint = registry.getEngineSessionRef(registry.getSession(session.id)!, "codex").platformContextFingerprint;
    expect(acceptedFingerprint).not.toBe(initialFingerprint);

    await manager.route(incoming("stable after success"), connector);
    expect(headingCount(runs[3])).toBe(0);
    expect(registry.getEngineSessionRef(registry.getSession(session.id)!, "codex").platformContextFingerprint).toBe(acceptedFingerprint);
  });

  it("refreshes exactly once per relevant mismatch and preserves per-engine fingerprints", async () => {
    const alphaRuns: EngineRunOpts[] = [];
    const betaRuns: EngineRunOpts[] = [];
    const engines = new Map<string, Engine>([
      ["codex", capturingEngine("codex", alphaRuns)],
      ["claude", capturingEngine("claude", betaRuns)],
    ]);
    let config = makeConfig();
    const manager = new managerModule.SessionManager(config, engines, "boot-a" as any);
    const connector = connectorStub();

    await manager.route(incoming("turn 1"), connector);
    await manager.route(incoming("turn 2"), connector);
    await manager.route(incoming("turn 3"), connector);

    expect(alphaRuns[0].resumeSessionId).toBeUndefined();
    expect(alphaRuns[0].systemPrompt).toContain("- Active engine: codex");
    expect(alphaRuns.slice(1, 3).map(headingCount)).toEqual([0, 0]);
    const session = registry.getSessionBySessionKey("test:platform-context")!;
    const initialFingerprint = registry.getEngineSessionRef(session, "codex").platformContextFingerprint;
    expect(initialFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await manager.route(incoming("channel changed", "channel-b"), connector);
    await manager.route(incoming("channel stable", "channel-b"), connector);
    expect(alphaRuns.slice(3, 5).map(headingCount)).toEqual([1, 0]);

    registry.updateSession(session.id, { model: "model-alpha-2" });
    await manager.route(incoming("model changed", "channel-b"), connector);
    await manager.route(incoming("model stable", "channel-b"), connector);
    expect(alphaRuns.slice(5, 7).map(headingCount)).toEqual([1, 0]);

    config = makeConfig(7800);
    manager.setConfig(config);
    await manager.route(incoming("config changed", "channel-b"), connector);
    await manager.route(incoming("config stable", "channel-b"), connector);
    expect(alphaRuns.slice(7, 9).map(headingCount)).toEqual([1, 0]);

    const restarted = new managerModule.SessionManager(config, engines, "boot-b" as any);
    await restarted.route(incoming("after restart", "channel-b"), connector);
    await restarted.route(incoming("restart stable", "channel-b"), connector);
    expect(alphaRuns.slice(9, 11).map(headingCount)).toEqual([1, 0]);

    config = { ...config, portal: { ...config.portal, portalName: "Changed persona label", setupComplete: true } };
    restarted.setConfig(config);
    await restarted.route(incoming("non-platform context changed", "channel-b"), connector);
    expect(headingCount(alphaRuns[11])).toBe(0);

    registry.switchSessionEngine(session.id, "claude", { model: "model-beta" });
    await restarted.route(incoming("beta fresh", "channel-b"), connector);
    expect(betaRuns[0].resumeSessionId).toBeUndefined();
    expect(headingCount(betaRuns[0])).toBe(0);

    registry.switchSessionEngine(session.id, "codex", { model: "model-alpha-2" });
    await restarted.route(incoming("alpha restored", "channel-b"), connector);
    expect(alphaRuns.at(-1)?.resumeSessionId).toBe("codex-native");
    expect(headingCount(alphaRuns.at(-1)!)).toBe(0);

    const final = registry.getSession(session.id)!;
    expect(registry.getEngineSessionRef(final, "codex").platformContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.getEngineSessionRef(final, "claude").platformContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.getEngineSessionRef(final, "codex").platformContextFingerprint).not.toBe(
      registry.getEngineSessionRef(final, "claude").platformContextFingerprint,
    );
  });
});

describe("web API platform context dispatch", () => {
  it("keeps a historical Talk transcript and children visible while resuming it as a generic web turn", async () => {
    const runs: EngineRunOpts[] = [];
    const engine = capturingEngine("codex", runs, () => ({
      sessionId: "legacy-talk-native",
      result: "Generic resumed answer",
    }));
    const queue = new (await import("../queue.js")).SessionQueue();
    const config = makeConfig();
    const context = {
      config,
      gatewayBootId: "boot-a",
      getConfig: () => config,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../../gateway/api.js").ApiContext;

    const historical = registry.createSession({
      engine: "codex",
      source: "talk",
      sourceRef: "talk:historical",
      connector: "web",
      sessionKey: "talk:historical",
      title: "Historical voice session",
    });
    registry.recordEngineSessionId(historical.id, "codex", "legacy-talk-native", {
      model: "model-alpha",
      effortLevel: "medium",
    });
    registry.insertMessage(historical.id, "user", "Old spoken request");
    registry.insertMessage(historical.id, "assistant", "Old spoken answer");
    const child = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:historical-child",
      parentSessionId: historical.id,
      title: "Historical child",
    });

    const visible = await request(context, "GET", `/api/sessions/${historical.id}`);
    expect(visible.status).toBe(200);
    expect(visible.body.source).toBe("talk");
    expect(visible.body.messages.map((message: { content: string }) => message.content)).toEqual([
      "Old spoken request",
      "Old spoken answer",
    ]);
    const all = await request(context, "GET", "/api/sessions?limit=0");
    expect(all.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: historical.id, source: "talk" }),
      expect.objectContaining({ id: child.id, parentSessionId: historical.id }),
    ]));

    const resumed = await request(context, "POST", `/api/sessions/${historical.id}/message`, {
      message: "Continue this as an ordinary chat",
    });
    expect(resumed.status).toBe(200);
    await waitForRuns(runs, 1);
    await waitForStatus(historical.id, "idle");
    expect(runs[0]).toMatchObject({
      prompt: "Continue this as an ordinary chat",
      resumeSessionId: "legacy-talk-native",
      source: "web",
    });
    expect(runs[0].systemPrompt).not.toContain("# Voice mode");
    expect(runs[0].systemPrompt).not.toContain("/api/talk/");
    expect(registry.getMessages(historical.id).map((message) => message.content)).toEqual([
      "Old spoken request",
      "Old spoken answer",
      "Continue this as an ordinary chat",
      "Generic resumed answer",
    ]);
  });

  it("replays a historical Talk pending turn after startup through the generic web runtime", async () => {
    const runs: EngineRunOpts[] = [];
    const engine = capturingEngine("codex", runs, () => ({
      sessionId: "legacy-talk-pending-native",
      result: "Recovered generic answer",
    }));
    const queue = new (await import("../queue.js")).SessionQueue();
    const config = makeConfig();
    const context = {
      config,
      gatewayBootId: "boot-recovery",
      getConfig: () => config,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../../gateway/api.js").ApiContext;
    const historical = registry.createSession({
      engine: "codex",
      source: "talk",
      sourceRef: "talk:historical-pending",
      connector: "web",
      sessionKey: "talk:historical-pending",
      title: "Interrupted historical voice session",
    });
    registry.recordEngineSessionId(historical.id, "codex", "legacy-talk-pending-native", {
      model: "model-alpha",
      effortLevel: "medium",
    });
    registry.enqueueQueueItem(historical.id, historical.sessionKey, "Resume pending ordinary chat");

    api.resumePendingWebQueueItems(context);

    await waitForRuns(runs, 1);
    await waitForStatus(historical.id, "idle");
    expect(runs[0]).toMatchObject({
      prompt: "Resume pending ordinary chat",
      resumeSessionId: "legacy-talk-pending-native",
      source: "web",
    });
    expect(registry.getSession(historical.id)?.source).toBe("talk");
    expect(registry.listAllPendingQueueItems()).toEqual([]);
  });

  it("keeps a refresh pending when a rate-limit retry fails", async () => {
    const runs: EngineRunOpts[] = [];
    const results: EngineResult[] = [
      { sessionId: "codex-native", result: "ok" },
      { sessionId: "codex-native", result: "", error: "usage limit", rateLimit: { status: "rejected" } },
      { sessionId: "codex-native", result: "", error: "transient retry failure", cost: 0.01 },
      { sessionId: "codex-native", result: "ok" },
      { sessionId: "codex-native", result: "ok" },
    ];
    const engine = capturingEngine("codex", runs, (runNumber) => results[runNumber - 1]);
    const queue = new (await import("../queue.js")).SessionQueue();
    let config = makeConfig();
    const context = {
      config,
      gatewayBootId: "boot-a",
      getConfig: () => config,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../../gateway/api.js").ApiContext;

    const created = await request(context, "POST", "/api/sessions", {
      prompt: "initial success",
      engine: "codex",
      model: "model-alpha",
    });
    const sessionId = created.body.id as string;
    await waitForRuns(runs, 1);
    await waitForStatus(sessionId, "idle");
    const initialFingerprint = registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint;

    config = makeConfig(7800);
    context.config = config;
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "failed retry refresh" });
    await waitForRuns(runs, 3);
    await waitForStatus(sessionId, "error");
    expect(runs.slice(1, 3).map(headingCount)).toEqual([1, 1]);
    expect(registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint).toBe(initialFingerprint);

    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "successful refresh" });
    await waitForRuns(runs, 4);
    await waitForStatus(sessionId, "idle");
    expect(headingCount(runs[3])).toBe(1);
    const acceptedFingerprint = registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint;
    expect(acceptedFingerprint).not.toBe(initialFingerprint);

    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "stable after success" });
    await waitForRuns(runs, 5);
    await waitForStatus(sessionId, "idle");
    expect(headingCount(runs[4])).toBe(0);
  });

  it("keeps a failed refresh pending until a successful turn accepts it", async () => {
    const runs: EngineRunOpts[] = [];
    let failNext = false;
    const engine = capturingEngine("codex", runs, () => {
      if (failNext) {
        failNext = false;
        return { sessionId: "codex-native", result: "", error: "transient engine failure", cost: 0.01 };
      }
      return { sessionId: "codex-native", result: "ok" };
    });
    const queue = new (await import("../queue.js")).SessionQueue();
    let config = makeConfig();
    const context = {
      config,
      gatewayBootId: "boot-a",
      getConfig: () => config,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../../gateway/api.js").ApiContext;

    const created = await request(context, "POST", "/api/sessions", {
      prompt: "initial success",
      engine: "codex",
      model: "model-alpha",
    });
    const sessionId = created.body.id as string;
    await waitForRuns(runs, 1);
    await waitForStatus(sessionId, "idle");
    const initialFingerprint = registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint;

    config = makeConfig(7800);
    context.config = config;
    failNext = true;
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "failed refresh" });
    await waitForRuns(runs, 2);
    await waitForStatus(sessionId, "error");
    expect(headingCount(runs[1])).toBe(1);
    expect(registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint).toBe(initialFingerprint);

    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "successful refresh" });
    await waitForRuns(runs, 3);
    await waitForStatus(sessionId, "idle");
    expect(headingCount(runs[2])).toBe(1);
    const acceptedFingerprint = registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint;
    expect(acceptedFingerprint).not.toBe(initialFingerprint);

    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "stable after success" });
    await waitForRuns(runs, 4);
    await waitForStatus(sessionId, "idle");
    expect(headingCount(runs[3])).toBe(0);
    expect(registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint).toBe(acceptedFingerprint);
  });

  it("persists accepted fingerprints and emits one refresh after config or boot changes", async () => {
    const runs: EngineRunOpts[] = [];
    const engine = capturingEngine("codex", runs);
    const queue = new (await import("../queue.js")).SessionQueue();
    let config = makeConfig();
    const context = {
      config,
      gatewayBootId: "boot-a",
      getConfig: () => config,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: () => {},
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["codex", engine]]),
        getQueue: () => queue,
      },
    } as unknown as import("../../gateway/api.js").ApiContext;

    const created = await request(context, "POST", "/api/sessions", {
      prompt: "turn 1",
      engine: "codex",
      model: "model-alpha",
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.id as string;
    await waitForRuns(runs, 1);

    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "turn 2" });
    await waitForRuns(runs, 2);
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "turn 3" });
    await waitForRuns(runs, 3);
    expect(runs.slice(1, 3).map(headingCount)).toEqual([0, 0]);
    expect(registry.getEngineSessionRef(registry.getSession(sessionId)!, "codex").platformContextFingerprint).toMatch(/^[a-f0-9]{64}$/);

    config = makeConfig(7800);
    context.config = config;
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "config changed" });
    await waitForRuns(runs, 4);
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "config stable" });
    await waitForRuns(runs, 5);
    expect(runs.slice(3, 5).map(headingCount)).toEqual([1, 0]);

    (context as any).gatewayBootId = "boot-b";
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "after restart" });
    await waitForRuns(runs, 6);
    await request(context, "POST", `/api/sessions/${sessionId}/message`, { message: "restart stable" });
    await waitForRuns(runs, 7);
    expect(runs.slice(5, 7).map(headingCount)).toEqual([1, 0]);
  });
});
