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
