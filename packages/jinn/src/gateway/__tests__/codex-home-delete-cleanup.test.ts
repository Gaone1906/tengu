import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";

/**
 * BUG-1 follow-up — the per-session Codex CODEX_HOME overlay holds a
 * session-scoped capability in its 0600 config.toml. Deleting a session via the
 * public API (single DELETE and bulk-delete) must remove that overlay, or the
 * secret + dir leak on disk and accumulate. JINN_HOME is redirected to a temp
 * dir BEFORE any module import so CODEX_HOMES_DIR resolves under it (never the
 * real ~/.jinn).
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-codex-home-del-"));
process.env.JINN_HOME = tmpHome;

fs.writeFileSync(
  path.join(tmpHome, "config.yaml"),
  yaml.dump({
    gateway: {},
    engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
    portal: { portalName: "Portal COO", setupComplete: true },
    stt: { languages: ["en"] },
    connectors: {},
    mcp: {},
    sessions: {},
  }),
);

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let api: Api;
let registry: Registry;
let CODEX_HOMES_DIR: string;

const apiCtx = {
  getConfig: () => yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, unknown>,
  reloadConfig: () => {},
  reloadOrg: () => {},
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
      clearQueue: () => {},
    }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

async function call(method: string, urlPath: string, body?: unknown) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

/** Fabricate the on-disk overlay prepareCodexSessionHome would have created. */
function seedCodexHome(sessionId: string): string {
  const dir = path.join(CODEX_HOMES_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[mcp_servers.jinn]\n[mcp_servers.jinn.env]\nJINN_SESSION_CAPABILITY = "cap-secret"\n',
    { mode: 0o600 },
  );
  return dir;
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  const paths = (await import("../../shared/paths.js")) as Paths;
  CODEX_HOMES_DIR = paths.CODEX_HOMES_DIR;
  registry.initDb();
});

describe("session delete removes the per-session Codex CODEX_HOME overlay", () => {
  it("DELETE /api/sessions/:id removes the overlay dir (secret does not leak)", async () => {
    const s = registry.createSession({ engine: "codex", source: "web", sourceRef: "del-1", title: "del-1" });
    const dir = seedCodexHome(s.id);
    expect(fs.existsSync(dir)).toBe(true);

    const res = await call("DELETE", `/api/sessions/${s.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "deleted" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("POST /api/sessions/bulk-delete removes every deleted session's overlay dir", async () => {
    const a = registry.createSession({ engine: "codex", source: "web", sourceRef: "bulk-a", title: "bulk-a" });
    const b = registry.createSession({ engine: "codex", source: "web", sourceRef: "bulk-b", title: "bulk-b" });
    const dirA = seedCodexHome(a.id);
    const dirB = seedCodexHome(b.id);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const res = await call("POST", "/api/sessions/bulk-delete", { ids: [a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deleted");
    expect(res.body.count).toBe(2);
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(false);
  });
});
