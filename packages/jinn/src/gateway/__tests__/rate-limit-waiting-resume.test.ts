import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

// Isolate the registry before importing API/registry modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-rate-limit-waiting-resume-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  api = await import("../api.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

function cfg(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7777 },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", label: "Opus" }] },
      codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", label: "GPT-5.5" }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer test-token" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return this; },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

// A queue mock that never actually invokes the enqueued turn — we only care that
// the POST handler pulls the session out of `waiting` before dispatch. Leaving the
// turn un-run keeps the assertion deterministic (no async beginSessionAttempt race).
function ctx(): ApiContext {
  const queue = {
    enqueue: vi.fn(async () => {}),
    clearCancelled: vi.fn(),
    clearQueue: vi.fn(),
    getPendingCount: () => 0,
    getTransportState: () => "idle" as const,
    isRunning: () => false,
  };
  return {
    getConfig: cfg,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: vi.fn(),
    sessionManager: {
      getQueue: () => queue,
      getEngine: () => ({ isAlive: () => false }),
      getEngines: () => new Map([["codex", { isAlive: () => false }]]),
    },
  } as unknown as ApiContext;
}

describe("POST /api/sessions/:id/message on a rate-limit-paused session", () => {
  it("breaks the stale usage-limit wait so the new message runs immediately", async () => {
    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:rl-resume",
      model: "gpt-5.5",
      effortLevel: "high",
    });
    // Simulate the wait-and-retry loop having parked the session until a Codex
    // reset that the user has since cleared provider-side.
    reg.updateSession(session.id, {
      status: "waiting",
      lastError: "Codex usage limit — resumes 2099-01-01T00:00:00.000Z",
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/sessions/${session.id}/message`, { message: "try again now" }),
      cap.res,
      ctx(),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ status: "queued", sessionId: session.id });

    // The session must no longer be stuck in `waiting` (the stale-limit state).
    const after = reg.getSession(session.id);
    expect(after?.status).not.toBe("waiting");
    expect(after?.lastError ?? null).toBeNull();
  });
});

// CRITICAL FIX regression (docs/tengu/03-implementation-plan.md step 6): before this,
// `waiting` cleared ONLY inside the POST /message handler above, gated on a genuine
// user-authored message. A governor-scheduled resume (a cron fire — no user, no HTTP
// message at all) had no way to clear it, so an unattended resume would dispatch
// straight into a session still marked `waiting` and silently do nothing. These pin
// the fix at both layers: the extracted primitive, and the governor's own call site.
describe("gateway/rate-limit-waiting-resume.ts — programmatic clear (no user message)", () => {
  it("clearWaitingState clears `waiting` without any HTTP request or message ever being sent", async () => {
    const { clearWaitingState } = await import("../rate-limit-waiting-resume.js");
    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:programmatic-resume",
      model: "gpt-5.5",
      effortLevel: "high",
    });
    reg.updateSession(session.id, {
      status: "waiting",
      lastError: "Usage governor halt: resumes 2099-01-01T00:00:00.000Z.",
    });

    const result = clearWaitingState(session.id, { reason: "governor scheduled resume" });

    expect(result).toEqual({ sessionId: session.id, cleared: true });
    const after = reg.getSession(session.id);
    expect(after?.status).not.toBe("waiting");
    expect(after?.lastError ?? null).toBeNull();
    // No message of any kind (user or notification) was ever inserted for this session.
    expect(reg.getMessages(session.id)).toHaveLength(0);
  });

  it("is a harmless no-op when the session is not actually waiting", async () => {
    const { clearWaitingState } = await import("../rate-limit-waiting-resume.js");
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:idle-noop", model: "gpt-5.5" });

    const result = clearWaitingState(session.id);

    expect(result).toEqual({ sessionId: session.id, cleared: false });
  });

  it("resumeGovernorHaltedSession clears `waiting` and dispatches the SAME session with no user message", async () => {
    const runCalls: Array<{ sessionId?: string; resumeSessionId?: string }> = [];
    const engineStub = {
      name: "codex",
      run: async (opts: { sessionId?: string; resumeSessionId?: string }) => {
        runCalls.push({ sessionId: opts.sessionId, resumeSessionId: opts.resumeSessionId });
        return { result: "ok", sessionId: "engine-native-id" };
      },
      isAlive: () => false,
      kill: () => {},
      killAll: () => {},
    };
    const dispatchQueue = {
      enqueue: vi.fn(async (_k: string, fn: () => Promise<void>) => { await fn(); }),
      clearCancelled: vi.fn(),
      clearQueue: vi.fn(),
      getPendingCount: () => 0,
      getTransportState: () => "idle" as const,
      isRunning: () => false,
    };
    const dispatchCtx = {
      getConfig: cfg,
      connectors: new Map(),
      startTime: Date.now(),
      gatewayAuthToken: "test-token",
      emit: vi.fn(),
      sessionManager: {
        getQueue: () => dispatchQueue,
        getEngine: () => engineStub,
        getEngines: () => new Map([["codex", engineStub]]),
      },
    } as unknown as ApiContext;

    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:governor-resume",
      model: "gpt-5.5",
      effortLevel: "high",
    });
    reg.updateSession(session.id, {
      engineSessionId: "engine-native-id",
      status: "waiting",
      lastError: "Usage governor halt: resumes 2099-01-01T00:00:00.000Z.",
    });

    const resumed = api.resumeGovernorHaltedSession(session.sessionKey, dispatchCtx);
    expect(resumed).toBe(true);

    for (let i = 0; i < 300 && runCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    expect(runCalls).toHaveLength(1);
    // Same session id throughout — this is a resume, never a fresh spawn.
    expect(runCalls[0]?.sessionId).toBe(session.id);
    const after = reg.getSession(session.id);
    expect(after?.status).not.toBe("waiting");
    // No user (or any other) message was ever inserted to trigger this.
    expect(reg.getMessages(session.id).some((m) => m.role === "user")).toBe(false);
  });
});
