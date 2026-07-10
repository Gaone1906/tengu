import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Connector,
  Engine,
  EngineRunOpts,
  IncomingMessage,
  JinnConfig,
  Target,
} from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-platform-dispatch-"));
process.env.JINN_HOME = home;

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

function capturingEngine(name: string, runs: EngineRunOpts[]): Engine {
  return {
    name,
    run: async (opts) => {
      runs.push(opts);
      return { sessionId: `${name}-native`, result: "ok" };
    },
  };
}

function connectorStub(): Connector {
  const target: Target = { channel: "test" };
  return {
    name: "test",
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

beforeAll(async () => {
  registry = await import("../registry.js");
  managerModule = await import("../manager.js");
  api = await import("../../gateway/api.js");
  registry.initDb();
});

beforeEach(() => {
  registry.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("SessionManager platform context dispatch", () => {
  it("refreshes exactly once per relevant mismatch and preserves per-engine fingerprints", async () => {
    const alphaRuns: EngineRunOpts[] = [];
    const betaRuns: EngineRunOpts[] = [];
    const engines = new Map<string, Engine>([
      ["codex", capturingEngine("codex", alphaRuns)],
      ["claude", capturingEngine("claude", betaRuns)],
    ]);
    let config = makeConfig();
    const manager = new managerModule.SessionManager(config, engines, [], "boot-a" as any);
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

    const restarted = new managerModule.SessionManager(config, engines, [], "boot-b" as any);
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
