import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-notes-route-registry-"));

type Api = typeof import("../api.js");
let api: Api;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-notes-route-data-"));
const emitted: Array<{ event: string; payload: unknown }> = [];
let notesEnabled = true;
let staleChat = {
  enabled: false,
  tokenThreshold: 42_000,
  staleAfterMinutes: 12,
};

function seed(relativePath: string, content: string): string {
  const absolutePath = path.join(home, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const apiContext = {
  getConfig: () => ({ gateway: { notesEnabled }, engines: { default: "codex" }, sessions: { staleChat } }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  jinnHome: home,
  gatewayAuthToken: "test-token",
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

async function request(
  method: string,
  target: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(encoded ? [Buffer.from(encoded)] : []), {
    method,
    url: target,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      ...(encoded ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  });
  const capture = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], capture.res, apiContext);
  let parsed: unknown = capture.text;
  try {
    parsed = JSON.parse(capture.text);
  } catch {
    // Keep non-JSON responses visible in assertion output.
  }
  return { status: capture.status, body: parsed };
}

beforeAll(async () => {
  api = await import("../api.js");
});

beforeEach(() => {
  notesEnabled = true;
  fs.rmSync(path.join(home, "knowledge"), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
  emitted.length = 0;
});

describe("Notes HTTP routes", () => {
  it("returns 404 for every Notes endpoint when disabled", async () => {
    notesEnabled = false;

    for (const [method, target, body] of [
      ["GET", "/api/notes", undefined],
      ["GET", "/api/notes/read?path=knowledge%2Fplan.md", undefined],
      ["POST", "/api/notes", { title: "Plan" }],
      ["PUT", "/api/notes", { path: "knowledge/plan.md", expectedRevision: "a".repeat(64), body: "Updated" }],
    ] as const) {
      expect((await request(method, target, body)).status).toBe(404);
    }
  });

  it("reports the Notes feature state", async () => {
    expect(await request("GET", "/api/features")).toMatchObject({
      status: 200,
      body: {
        notesEnabled: true,
        staleChat,
      },
    });
    notesEnabled = false;
    expect(await request("GET", "/api/features")).toMatchObject({ status: 200, body: { notesEnabled: false } });
  });

  it("lists recursive folders and reads one note", async () => {
    seed("knowledge/product/brief.md", "# Launch brief\n\nShip calmly.\n");

    const listed = await request("GET", "/api/notes");
    const read = await request("GET", "/api/notes/read?path=knowledge%2Fproduct%2Fbrief.md");

    expect(listed).toMatchObject({
      status: 200,
      body: {
        notes: [{ path: "knowledge/product/brief.md", title: "Launch brief", folder: "product" }],
        folders: [{ path: "product", name: "product", count: 1 }],
      },
    });
    expect(read).toMatchObject({ status: 200, body: { note: { title: "Launch brief", body: "Ship calmly." } } });
  });

  it("creates then revision-safely updates a note and emits change events", async () => {
    const created = await request("POST", "/api/notes", { title: "Ideas", body: "One", folder: "product" });
    expect(created).toMatchObject({
      status: 201,
      body: { note: { path: "knowledge/product/ideas.md", body: "One" } },
    });

    const updated = await request("PUT", "/api/notes", {
      path: created.body.note.path,
      expectedRevision: created.body.note.revision,
      append: "Two",
    });

    expect(updated).toMatchObject({ status: 200, body: { note: { body: "One\n\nTwo" } } });
    expect(emitted).toEqual([
      {
        event: "notes:changed",
        payload: { path: created.body.note.path, revision: created.body.note.revision, action: "created" },
      },
      {
        event: "notes:changed",
        payload: { path: updated.body.note.path, revision: updated.body.note.revision, action: "updated" },
      },
    ]);
  });

  it("maps invalid, forbidden, missing, and conflict results to stable statuses", async () => {
    expect((await request("GET", "/api/notes/read?path=%2Ftmp%2Fnote.md")).status).toBe(400);
    expect((await request("GET", "/api/notes/read?path=knowledge%2Fmissing.md")).status).toBe(404);

    const outside = seed("outside/secret.md", "# Secret\n");
    fs.symlinkSync(outside, path.join(home, "knowledge", "escaped.md"));
    expect((await request("GET", "/api/notes/read?path=knowledge%2Fescaped.md")).status).toBe(403);

    const created = await request("POST", "/api/notes", { title: "Plan", body: "One" });
    const first = await request("PUT", "/api/notes", {
      path: created.body.note.path,
      expectedRevision: created.body.note.revision,
      body: "Two",
    });
    const stale = await request("PUT", "/api/notes", {
      path: created.body.note.path,
      expectedRevision: created.body.note.revision,
      body: "Three",
    });
    expect(first.status).toBe(200);
    expect(stale).toMatchObject({
      status: 409,
      body: { currentRevision: first.body.note.revision },
    });
  });

  it("requires expectedRevision and rejects body plus append", async () => {
    expect((await request("PUT", "/api/notes", { path: "knowledge/plan.md", body: "Two" })).status).toBe(400);
    expect((await request("PUT", "/api/notes", {
      path: "knowledge/plan.md",
      expectedRevision: "a".repeat(64),
      body: "Two",
      append: "Three",
    })).status).toBe(400);
  });

  it("rejects encoded control bytes before a note can be read or written", async () => {
    seed("knowledge/plan.md", "# Plan\n\nSafe.\n");

    const read = await request("GET", "/api/notes/read?path=knowledge%2Fplan.md%00");
    const update = await request("PUT", "/api/notes", {
      path: `knowledge/plan.md${String.fromCharCode(0)}`,
      expectedRevision: "a".repeat(64),
      body: "Unsafe",
    });

    expect(read.status).toBe(400);
    expect(update.status).toBe(400);
    expect(fs.readFileSync(path.join(home, "knowledge", "plan.md"), "utf-8")).toContain("Safe.");
  });

  it("fails closed when a tool-marked caller lacks a bound capability", async () => {
    const toolHeaders = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE };

    expect((await request("GET", "/api/notes", undefined, toolHeaders)).status).toBe(403);
    expect((await request("POST", "/api/notes", { title: "Blocked" }, toolHeaders)).status).toBe(403);
    expect((await request("POST", "/api/notes", { title: "Operator" })).status).toBe(201);
  });
});
