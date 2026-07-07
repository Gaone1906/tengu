import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

// Isolate the registry before importing API/registry modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-switch-api-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  api = await import("../api.js");
  reg.initDb();
});

beforeEach(() => {
  const db = reg.initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

function cfg(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7777 },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: {
        default: "opus",
        models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
      },
      codex: {
        default: "gpt-5.5",
        models: [{ id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
      },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function ctx(transportState: "idle" | "queued" | "running" | "error" | "interrupted"): ApiContext {
  return {
    getConfig: cfg,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: () => transportState,
      }),
      getEngines: () => new Map(),
    },
  } as unknown as ApiContext;
}

describe("PATCH /api/sessions/:id engine switch", () => {
  it("allows an errored idle session to switch engines and clears the stale error", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:error-switch",
      model: "opus",
      effortLevel: "high",
    });
    reg.updateSession(session.id, {
      status: "error",
      lastError: "Interactive turn failed: invalid_request",
      engineSessionId: "claude-native",
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/sessions/${session.id}`, {
        engine: "codex",
        model: "gpt-5.5",
        effortLevel: "medium",
      }),
      cap.res,
      ctx("error"),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      id: session.id,
      engine: "codex",
      model: "gpt-5.5",
      effortLevel: "medium",
      status: "idle",
      lastError: null,
    });
  });

  it("still blocks switching while transport work is running", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:running-switch",
      model: "opus",
      effortLevel: "high",
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/sessions/${session.id}`, { engine: "codex", model: "gpt-5.5" }),
      cap.res,
      ctx("running"),
    );

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/cannot switch engine/i);
  });
});
