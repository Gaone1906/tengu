import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * GRS-020b — the two knowledge routes against the REAL handleApiRequest with a
 * temp jinnHome: search (validation + snippet-only payloads) and read (the
 * containment status matrix: 400 shape-gate, 403 symlink escape, 404 missing,
 * 200 capped content). The store-level battery lives in
 * knowledge/__tests__/store.test.ts; this tier pins the HTTP contract.
 */

// Isolated home BEFORE the api import (registry reads JINN_HOME at load).
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-route-home-"));

type Api = typeof import("../api.js");
let api: Api;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-route-data-"));

function seed(rel: string, content: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

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
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const queueStub = {
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: home,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function get(pathAndQuery: string): Promise<{ status: number; body: any }> {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: pathAndQuery,
    headers: { host: "gateway.test" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  let body: unknown = cap.text;
  try {
    body = JSON.parse(cap.text);
  } catch {
    /* keep raw */
  }
  return { status: cap.status, body };
}

beforeAll(async () => {
  seed("knowledge/pricing-strategy.md", "# Pricing strategy\n\nThe axolotl tier was approved at 19 euro.\n");
  seed("docs/architecture.md", "# Architecture\n\nEngines are spawned by the gateway; axolotl billing lives here.\n");
  seed("secrets/api-keys.json", JSON.stringify({ secret: "TOPSECRET-route" }));
  fs.symlinkSync(path.join(home, "secrets", "api-keys.json"), path.join(home, "knowledge", "escape.md"));
  api = await import("../api.js");
});

describe("GET /api/knowledge/search", () => {
  it("finds seeded files in both roots, snippets only", async () => {
    const { status, body } = await get("/api/knowledge/search?q=axolotl");
    expect(status).toBe(200);
    const paths = body.results.map((r: any) => r.path);
    expect(paths).toContain("knowledge/pricing-strategy.md");
    expect(paths).toContain("docs/architecture.md");
    for (const r of body.results) {
      expect(Object.keys(r).sort()).toEqual(["matchCount", "path", "snippet", "title"]);
      expect(r.snippet).not.toContain("approved at 19 euro.\n"); // excerpt, not the body
    }
  });

  it("400s a missing/empty/oversized q; %00-only collapses to 400", async () => {
    expect((await get("/api/knowledge/search")).status).toBe(400);
    expect((await get("/api/knowledge/search?q=")).status).toBe(400);
    expect((await get("/api/knowledge/search?q=%00")).status).toBe(400);
    expect((await get(`/api/knowledge/search?q=${"x".repeat(2_000)}`)).status).toBe(400);
  });

  it("a NUL-tailed query behaves like the plain query (hardening parity with 020a)", async () => {
    const plain = await get("/api/knowledge/search?q=axolotl");
    const nul = await get("/api/knowledge/search?q=axolotl%00");
    expect(nul.status).toBe(200);
    expect(nul.body.results.map((r: any) => r.path)).toEqual(plain.body.results.map((r: any) => r.path));
  });
});

describe("GET /api/knowledge/read", () => {
  it("reads a file by relative path with the exact payload keys", async () => {
    const { status, body } = await get("/api/knowledge/read?path=knowledge%2Fpricing-strategy.md");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["content", "path", "title", "totalChars", "truncated"]);
    expect(body.content).toContain("approved at 19 euro");
    expect(body.truncated).toBe(false);
  });

  it("400s the shape-gate rejections (traversal, absolute, wrong root, wrong ext, nested, NUL)", async () => {
    for (const p of [
      "../../etc/passwd",
      "/etc/passwd",
      "knowledge/../secrets/api-keys.json",
      "secrets/api-keys.json",
      "docs/notes.txt",
      "knowledge/sub/foo.md",
      "knowledge/foo%00bar.md",
    ]) {
      const { status, body } = await get(`/api/knowledge/read?path=${encodeURIComponent(p).replace(/%2500/g, "%00")}`);
      expect(status, `expected 400 for ${p}`).toBe(400);
      expect(JSON.stringify(body)).not.toContain("TOPSECRET-route");
    }
    expect((await get("/api/knowledge/read")).status).toBe(400);
  });

  it("403s the symlink escape (realpath containment) without leaking content", async () => {
    const { status, body } = await get("/api/knowledge/read?path=knowledge%2Fescape.md");
    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toContain("TOPSECRET-route");
  });

  it("404s a missing file", async () => {
    expect((await get("/api/knowledge/read?path=knowledge%2Fnope.md")).status).toBe(404);
  });

  it("400s a trailing-NUL path — rejected on the raw param, never stripped-then-read (GRS-020b-fix)", async () => {
    // Pre-fix this returned 200 with the file body: the route's free-text
    // cleaner stripped the %00 and the trimmed valid path read through. The
    // read surface now rejects control bytes on the RAW param.
    const trailing = await get("/api/knowledge/read?path=knowledge%2Fpricing-strategy.md%00");
    expect(trailing.status).toBe(400);
    expect(JSON.stringify(trailing.body)).not.toContain("approved at 19 euro");
    // An embedded control byte (0x01) is rejected the same way — as a control
    // byte, not incidentally via the shape gate.
    const embedded = await get("/api/knowledge/read?path=knowledge%2Fpri%01cing-strategy.md");
    expect(embedded.status).toBe(400);
  });
});
