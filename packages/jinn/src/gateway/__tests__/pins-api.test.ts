import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pins-api-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let registry: Registry;

const emit = vi.fn();
const context = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {}, portal: { portalName: "Jinn" } }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function makeResponse() {
  const chunks: Buffer[] = [];
  let status = 200;
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    write(body?: Buffer | string) { if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return true; },
    end(body?: Buffer | string) { if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const text = Buffer.concat(chunks).toString("utf-8");
      return text ? JSON.parse(text) : null;
    },
  };
}

async function request(method: string, url: string, body?: unknown) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  const captured = makeResponse();
  await api.handleApiRequest(req, captured.res, context);
  return { status: captured.status, body: captured.body };
}

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  api = await import("../api.js");
  registry.initDb();
});

describe("chat pin API", () => {
  it("round-trips session and employee keys through the same idempotent routes", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:session-api" });
    expect(await request("POST", "/api/pins", { key: session.id })).toMatchObject({ status: 200 });
    expect(await request("POST", "/api/pins", { key: session.id })).toMatchObject({ status: 200 });
    expect(await request("POST", "/api/pins", { key: "emp:research" })).toMatchObject({ status: 200 });

    const listed = await request("GET", "/api/pins");
    expect(listed.status).toBe(200);
    expect(listed.body.pins).toEqual(expect.arrayContaining([
      { key: session.id, kind: "session", pinnedAt: expect.any(String) },
      { key: "emp:research", kind: "employee", pinnedAt: expect.any(String) },
    ]));
    expect(listed.body.pins.filter((pin: { key: string }) => pin.key === session.id)).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith("pins:changed", {});

    expect(await request("DELETE", "/api/pins/emp%3Aresearch")).toMatchObject({ status: 200 });
    expect(await request("DELETE", "/api/pins/emp%3Aresearch")).toMatchObject({ status: 200 });
    expect((await request("GET", "/api/pins")).body.pins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "emp:research" })]),
    );
    await request("DELETE", `/api/pins/${encodeURIComponent(session.id)}`);
  });

  it("returns pinned non-archived sessions newest first in the normal serialized shape", async () => {
    const older = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:api-older" });
    const newer = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:api-newer" });
    const archived = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:api-archived" });
    const unpinned = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:api-unpinned" });
    const database = registry.initDb();
    database.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2026-02-01T00:00:00.000Z", older.id);
    database.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2026-02-02T00:00:00.000Z", newer.id);
    registry.pinChat(older.id);
    registry.pinChat(newer.id);
    registry.pinChat(archived.id);
    registry.archiveSession(archived.id);

    const pinned = await request("GET", "/api/sessions?pinned=1");
    const all = await request("GET", "/api/sessions?limit=0");

    expect(pinned.status).toBe(200);
    expect(pinned.body.map((session: { id: string }) => session.id)).toEqual([newer.id, older.id]);
    expect(pinned.body[0]).toEqual(all.body.find((session: { id: string }) => session.id === newer.id));
    expect(pinned.body.map((session: { id: string }) => session.id)).not.toContain(unpinned.id);
  });

  it("never lists a pin for a deleted session", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:api-deleted" });
    registry.pinChat(session.id);
    expect(registry.deleteSession(session.id)).toBe(true);

    const listed = await request("GET", "/api/pins");
    expect(listed.body.pins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: session.id })]),
    );
  });

  it("filters an orphaned session key even if the database invariant was bypassed", async () => {
    registry.initDb().prepare(
      "INSERT INTO chat_pins (pin_key, pinned_at) VALUES (?, ?)",
    ).run("missing-session", "2026-01-01T00:00:00.000Z");

    const listed = await request("GET", "/api/pins");
    expect(listed.body.pins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "missing-session" })]),
    );
  });

  it("rejects missing and empty keys", async () => {
    expect(await request("POST", "/api/pins", {})).toMatchObject({ status: 400 });
    expect(await request("POST", "/api/pins", { key: "  " })).toMatchObject({ status: 400 });
  });
});
