import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * GRS-020b live-QA catch — the WEB dispatch path (POST /api/sessions →
 * runWebSession) built its bootstrap WITHOUT `jinnMcpAttached`, so the context
 * diet (017b org prose + 020b knowledge index) never applied to web-created
 * sessions even though the same path attaches the jinn MCP server to the
 * engine. Caught live: the codex agent's composed prompt carried the full
 * knowledge index. This suite drives the REAL handleApiRequest with a
 * capturing engine stub (the delegations-route harness) and pins:
 *
 *   1. jinn attached → engine.run's systemPrompt carries the 2-line knowledge
 *      MANIFEST, not the per-file index (and the 017b belt manifest text).
 *   2. mcp.gateway.enabled: false (kill switch) → the full index, byte-shaped
 *      as before — non-attached sessions keep today's bootstrap.
 */

// Isolated home BEFORE the api import. Seed knowledge so the index/manifest
// distinction is observable.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-web-diet-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "knowledge"), { recursive: true });
fs.writeFileSync(path.join(tmpHome, "knowledge", "seeded-diet-fixture.md"), "# Fixture\n\nbody\n");
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-emp.yaml"),
  ["name: qa-emp", "department: qa", "engine: codex", "model: gpt-5.5", "persona: QA employee for diet tests", ""].join("\n"),
);

type Api = typeof import("../api.js");
let api: Api;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

const engineRuns: Array<Record<string, unknown>> = [];
const engineStub = {
  name: "stub",
  run: async (opts: Record<string, unknown>) => {
    engineRuns.push(opts);
    return { result: "ok" };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => {
    await fn();
  },
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

// mcp.gateway.enabled is a per-test switch: true = the jinn belt attaches
// (diet on), false = the global kill switch (diet off, legacy bootstrap).
let mcpEnabled = true;
const apiCtx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    sessions: {},
    mcp: { browser: { enabled: false }, gateway: { enabled: mcpEnabled } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function spawnWebSession(prompt: string): Promise<Record<string, unknown>> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ prompt, employee: "qa-emp" }))]), {
    method: "POST",
    url: "/api/sessions",
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  expect(cap.status).toBe(201);
  const id = cap.body.id as string;
  // dispatchWebSessionRun is fire-and-forget; wait for the stub engine turn.
  let run: Record<string, unknown> | undefined;
  for (let i = 0; i < 100 && !run; i++) {
    run = engineRuns.find((r) => r.sessionId === id);
    if (!run) await new Promise((r) => setTimeout(r, 10));
  }
  expect(run, "engine.run was never invoked for the spawned session").toBeDefined();
  return run!;
}

beforeAll(async () => {
  api = await import("../api.js");
  // Attachment requires the armed-ok smoke gate (unarmed fails closed); a booted
  // gateway arms it at boot, this suite drives dispatch without a boot.
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

describe("web-spawn context diet (POST /api/sessions → runWebSession)", () => {
  it("jinn attached → the composed systemPrompt carries the knowledge MANIFEST, never the index", async () => {
    mcpEnabled = true;
    engineRuns.length = 0;
    const run = (await spawnWebSession("diet-on probe")) as { systemPrompt?: string; resolvedMcp?: { mcpServers?: Record<string, unknown> } };
    // Control: the same run really attached the jinn server to the engine.
    expect(Boolean(run.resolvedMcp?.mcpServers?.["jinn"])).toBe(true);
    const prompt = String(run.systemPrompt ?? "");
    expect(prompt).toContain("## Knowledge base");
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("read_knowledge { path }");
    expect(prompt).not.toContain("seeded-diet-fixture.md");
    expect(prompt).not.toContain("**knowledge/** (");
  });

  it("mcp kill switch → the full legacy index, no manifest (non-attached bootstraps unchanged)", async () => {
    mcpEnabled = false;
    engineRuns.length = 0;
    const run = (await spawnWebSession("diet-off probe")) as { systemPrompt?: string; resolvedMcp?: unknown };
    expect(run.resolvedMcp).toBeUndefined();
    const prompt = String(run.systemPrompt ?? "");
    expect(prompt).toContain("seeded-diet-fixture.md");
    expect(prompt).toContain("Read them directly when needed.");
    expect(prompt).not.toContain("search_knowledge");
  });
});
