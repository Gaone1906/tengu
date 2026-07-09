import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

// Fresh JINN_HOME before importing api/registry (SESSIONS_DB resolves at import).
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-activity-home-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let registry: Registry;

function seed(id: string, status: string, lastActivity: string): void {
  registry.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude','web',?, ?, ?, ?)",
  ).run(id, `web:${id}`, status, lastActivity, lastActivity);
}

// Mirrors the privileged-read-guard harness: operator path (no auth headers),
// transport state passes the DB status through, and no backgroundActivity so
// sessionHasRuntimeActivity is false.
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {}, portal: { portalName: "Jinn" } }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  const chunks: Buffer[] = [];
  const res = {
    writeHead() { return this; },
    setHeader() { return this; },
    write(b?: Buffer | string) { if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return true; },
    end(b?: Buffer | string) { if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  } as unknown as ServerResponse;
  return { res, get body() { const t = Buffer.concat(chunks).toString("utf-8"); return t ? JSON.parse(t) : null; } };
}

async function activity() {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: "/api/activity",
    headers: { host: "gateway.test" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  const cap = makeRes();
  await api.handleApiRequest(req, cap.res, apiCtx);
  return cap.body as Array<{ event: string; payload: { sessionId: string } }>;
}

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  api = await import("../api.js");
});

describe("GET /api/activity — bounded window must not starve on non-emitting newest rows", () => {
  it("returns 30 events even when the 101 newest sessions are all non-emitting (interrupted)", async () => {
    // 101 interrupted rows NEWER than 35 idle rows. interrupted emits no event;
    // idle emits session:completed. The old single-100-window path returned 0.
    for (let i = 0; i < 101; i++) {
      seed(`intr-${i}`, "interrupted", `2026-07-09T10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`);
    }
    for (let i = 0; i < 35; i++) {
      seed(`idle-${i}`, "idle", `2026-07-08T10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`);
    }

    const events = await activity();
    expect(events).toHaveLength(30);
    // Every returned event is a completed idle session (the only emitters here).
    expect(events.every((e) => e.event === "session:completed")).toBe(true);
    expect(events.every((e) => e.payload.sessionId.startsWith("idle-"))).toBe(true);
  });

  it("caps at 30 and returns newest-first when there are plenty of emitters", async () => {
    // Add 50 newer idle sessions; the newest 30 of those should be returned.
    for (let i = 0; i < 50; i++) {
      seed(`fresh-${String(i).padStart(2, "0")}`, "idle", `2026-07-10T10:00:00.${String(i).padStart(3, "0")}Z`);
    }
    const events = await activity();
    expect(events).toHaveLength(30);
    // Newest-first: ts strictly non-increasing.
    const ids = events.map((e) => e.payload.sessionId);
    expect(ids.every((id) => id.startsWith("fresh-"))).toBe(true);
    expect(ids[0]).toBe("fresh-49");
  });
});
