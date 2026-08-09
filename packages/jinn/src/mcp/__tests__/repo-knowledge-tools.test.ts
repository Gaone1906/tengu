import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildRepoKnowledgeTools, REPO_KNOWLEDGE_QUERY_CHAR_CAP } from "../repo-knowledge-tools.js";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * docs/tengu/18-council-specialists.md — the repo-knowledge tool group.
 * Same two-tier discipline as knowledge-tools.test.ts:
 *   1. UNIT (stub fetch) — the exact resolve-then-call route chain, tool-side
 *      caps, hints, error pass-through, read-tier capability binding.
 *   2. INTEGRATION (real handleApiRequest + two real specialist KBs) — the
 *      slice acceptance AND the load-bearing security property: a session
 *      bound to specialist A can search and read only A's chunks, never B's,
 *      however the query is phrased and whatever extra arguments are passed.
 */

// Isolated home BEFORE the api/org/knowledge-base modules ever load (they read
// JINN_HOME at import time via shared/paths.js) — mirrors knowledge-tools.test.ts.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-repo-kb-home-"));

// retrieval.ts embeds through embeddings.ts's real ONNX pipeline — swap in a
// deterministic fake keyed by text content so KNN ranking is meaningful
// without downloading the model (same fake as knowledge-base/retrieval.test.ts).
vi.mock("../../knowledge-base/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../knowledge-base/embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map((text) => vectorFor(text))),
  };
});

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  const buckets = ["specialista", "specialistb"];
  return buckets.map((bucket) => (lower.includes(bucket) ? 1 : 0)).concat(Array(384 - buckets.length).fill(0));
}

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;

let sessionA: string;
let sessionB: string;
let sessionGeneralist: string;
let sessionNoEmployee: string;
let chunkIdA: number;

const SPECIALIST_A = "kb-specialist-a";
const SPECIALIST_B = "kb-specialist-b";
const GENERALIST = "kb-generalist";

/* ── Unit-tier stub fetch ───────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId: string | null = "session-test",
  sessionCapability = callerSessionId ? "cap-test" : undefined,
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL) => {
    const call: SeenCall = { url: typeof input === "string" ? input : input.toString() };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://127.0.0.1:7777",
    fetchFn,
    ...(callerSessionId ? { callerSessionId } : {}),
    ...(sessionCapability ? { sessionCapability } : {}),
  };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildRepoKnowledgeTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("repo knowledge tools — registry + schemas", () => {
  it("exposes the 2 tools, neither taking an employee/repo argument", () => {
    const tools = buildRepoKnowledgeTools();
    expect(tools.map((t) => t.name)).toEqual(["search_repo_knowledge", "read_repo_chunk"]);
    for (const t of tools) {
      expect(Object.keys(t.inputSchema.properties)).not.toContain("employee");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("repo");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("name");
    }
    expect(tool("search_repo_knowledge").inputSchema.required).toEqual(["query"]);
    expect(tool("read_repo_chunk").inputSchema.required).toEqual(["chunkId"]);
  });
});

describe("repo knowledge tools — unit (stub gateway)", () => {
  it("resolves the caller's own identity before searching: session → employee → repo → kb/search", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.includes("/api/sessions/")) return { status: 200, body: { employee: "dev-specialist" } };
      if (call.url.includes("/api/org/employees/")) return { status: 200, body: { name: "dev-specialist", repo: "~/code/dev" } };
      return { status: 200, body: { chunks: [] } };
    });
    await tool("search_repo_knowledge").handler({ query: "how does auth work?" }, ctx);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/sessions/session-test",
      "/api/org/employees/dev-specialist",
      "/api/specialists/dev-specialist/kb/search",
    ]);
    const searchUrl = new URL(calls[2].url);
    expect(searchUrl.searchParams.get("q")).toBe("how does auth work?");
  });

  it("a tool argument named employee/repo/name cannot redirect the search — the schema has none", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.includes("/api/sessions/")) return { status: 200, body: { employee: "dev-specialist" } };
      if (call.url.includes("/api/org/employees/")) return { status: 200, body: { name: "dev-specialist", repo: "~/code/dev" } };
      return { status: 200, body: { chunks: [] } };
    });
    // A malicious/confused caller passes extra fields hoping to redirect scope.
    await tool("search_repo_knowledge").handler(
      { query: "secrets", employee: "someone-elses-specialist", repo: "/someone/else" } as Record<string, unknown>,
      ctx,
    );
    const searchUrl = new URL(calls[2].url);
    expect(searchUrl.pathname).toBe("/api/specialists/dev-specialist/kb/search");
    expect(searchUrl.pathname).not.toContain("someone-elses-specialist");
  });

  it("refuses when the session has no bound employee (generalist/COO/plain session)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { employee: null } }));
    await expect(tool("search_repo_knowledge").handler({ query: "a" }, ctx)).rejects.toThrow(/no bound employee/);
    expect(calls).toHaveLength(1);
  });

  it("refuses when the bound employee has no repo (a generalist by name)", async () => {
    const { ctx } = stub((call) => {
      if (call.url.includes("/api/sessions/")) return { status: 200, body: { employee: "coo" } };
      return { status: 200, body: { name: "coo" } };
    });
    await expect(tool("search_repo_knowledge").handler({ query: "a" }, ctx)).rejects.toThrow(/no repo configured/);
  });

  it("refuses an over-long query with a structured error BEFORE the search call", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.includes("/api/sessions/")) return { status: 200, body: { employee: "dev-specialist" } };
      return { status: 200, body: { name: "dev-specialist", repo: "~/code/dev" } };
    });
    await expect(
      tool("search_repo_knowledge").handler({ query: "x".repeat(REPO_KNOWLEDGE_QUERY_CHAR_CAP + 1) }, ctx),
    ).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0); // rejected locally before resolving identity or searching
  });

  it("read tier: requires a bound caller identity", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("search_repo_knowledge").handler({ query: "a" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(anon.calls).toHaveLength(0);
  });

  it("read_repo_chunk resolves identity the same way and reads by chunkId", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.includes("/api/sessions/")) return { status: 200, body: { employee: "dev-specialist" } };
      if (call.url.includes("/api/org/employees/")) return { status: 200, body: { name: "dev-specialist", repo: "~/code/dev" } };
      return { status: 200, body: { chunk: { id: 7, path: "src/a.ts", text: "full text" } } };
    });
    const out = (await tool("read_repo_chunk").handler({ chunkId: 7 }, ctx)) as { chunk: { text: string } };
    expect(calls[2].url).toContain("/api/specialists/dev-specialist/kb/chunks/7");
    expect(out.chunk.text).toBe("full text");
  });

  it("rejects a non-integer chunkId locally, before any HTTP call", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    await expect(tool("read_repo_chunk").handler({ chunkId: 1.5 }, ctx)).rejects.toThrow(/positive integer/);
    expect(calls).toHaveLength(0);
  });
});

/* ── Integration tier: real handleApiRequest + two real specialist KBs ─────── */

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

const home = process.env.JINN_HOME as string;

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: home,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from([]), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function writeSpecialistYaml(orgDir: string, name: string, repo: string): void {
  const dir = path.join(orgDir, "specialists");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${name}`,
      `rank: employee`,
      `engine: claude`,
      `model: sonnet`,
      `persona: You own the ${repo} repo.`,
      `repo: ${repo}`,
    ].join("\n"),
  );
}

function writeGeneralistYaml(orgDir: string, name: string): void {
  const dir = path.join(orgDir, "generalists");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    [`name: ${name}`, `displayName: ${name}`, `rank: manager`, `engine: claude`, `model: opus`, `persona: You run the council.`].join("\n"),
  );
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  const paths = await import("../../shared/paths.js");
  const store = await import("../../knowledge-base/store.js");
  (await import("../../shared/db.js")).initDb();

  writeSpecialistYaml(paths.ORG_DIR, SPECIALIST_A, "/repos/a");
  writeSpecialistYaml(paths.ORG_DIR, SPECIALIST_B, "/repos/b");
  writeGeneralistYaml(paths.ORG_DIR, GENERALIST);

  const dbA = store.initKbDb(SPECIALIST_A);
  store.replaceFileChunks(
    dbA,
    "src/a-auth.ts",
    [
      {
        path: "src/a-auth.ts",
        startLine: 1,
        endLine: 3,
        text: "specialistA owns this auth module and its rotating secret token",
        contentHash: "hash-a",
        source: "code",
        embedding: vectorFor("specialistA owns this auth module and its rotating secret token"),
      },
    ],
    { mtimeMs: 1, contentHash: "file-a" },
  );
  const rowA = dbA.prepare("SELECT id FROM kb_chunks WHERE path = ?").get("src/a-auth.ts") as { id: number };
  chunkIdA = rowA.id;

  const dbB = store.initKbDb(SPECIALIST_B);
  // Pad B's autoincrement id space so its real chunk's id cannot collide with
  // (and accidentally validate against) A's separate, independently-numbered
  // per-specialist database — each specialist's KB is its own SQLite file, so
  // ids repeat across specialists unless deliberately offset like this.
  for (let i = 0; i < 10; i++) {
    store.replaceFileChunks(
      dbB,
      `src/filler-${i}.ts`,
      [
        {
          path: `src/filler-${i}.ts`,
          startLine: 1,
          endLine: 1,
          text: `filler chunk ${i}`,
          contentHash: `hash-filler-${i}`,
          source: "code",
          embedding: vectorFor(`filler chunk ${i}`),
        },
      ],
      { mtimeMs: 1, contentHash: `file-filler-${i}` },
    );
  }
  store.replaceFileChunks(
    dbB,
    "src/b-billing.ts",
    [
      {
        path: "src/b-billing.ts",
        startLine: 1,
        endLine: 3,
        text: "specialistB owns this billing module and its rotating secret token",
        contentHash: "hash-b",
        source: "code",
        embedding: vectorFor("specialistB owns this billing module and its rotating secret token"),
      },
    ],
    { mtimeMs: 1, contentHash: "file-b" },
  );

  sessionA = registry.createSession({ engine: "codex", source: "web", sourceRef: "a", employee: SPECIALIST_A }).id;
  sessionB = registry.createSession({ engine: "codex", source: "web", sourceRef: "b", employee: SPECIALIST_B }).id;
  sessionGeneralist = registry.createSession({ engine: "codex", source: "web", sourceRef: "g", employee: GENERALIST }).id;
  sessionNoEmployee = registry.createSession({ engine: "codex", source: "web", sourceRef: "n" }).id;
});

function ctxFor(sessionId: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId: sessionId,
    sessionCapability: ensureSessionCapability(sessionId),
  };
}

describe("repo knowledge tools — integration against real routes/store", () => {
  it("the slice acceptance: a specialist searches its own repo and reads the hit's full text", async () => {
    const found = (await tool("search_repo_knowledge").handler({ query: "auth secret token" }, ctxFor(sessionA))) as {
      chunks: Array<{ id: number; path: string; text: string }>;
    };
    expect(found.chunks.length).toBeGreaterThan(0);
    expect(found.chunks[0].path).toBe("src/a-auth.ts");

    const read = (await tool("read_repo_chunk").handler({ chunkId: found.chunks[0].id }, ctxFor(sessionA))) as {
      chunk: { path: string; text: string };
    };
    expect(read.chunk.path).toBe("src/a-auth.ts");
    expect(read.chunk.text).toContain("specialistA owns this auth module");
  });

  it("SECURITY: specialist A's search never returns specialist B's chunks, even when the query names B directly", async () => {
    const found = (await tool("search_repo_knowledge").handler(
      { query: "specialistB billing module rotating secret token" },
      ctxFor(sessionA),
    )) as { chunks: Array<{ path: string; text: string }> };

    for (const chunk of found.chunks) {
      expect(chunk.path).not.toBe("src/b-billing.ts");
      expect(chunk.text).not.toContain("specialistB");
    }
  });

  it("SECURITY: A cannot read B's chunk by guessing/reusing B's chunkId — A's own KB has no such row", async () => {
    const foundB = (await tool("search_repo_knowledge").handler({ query: "billing secret token" }, ctxFor(sessionB))) as {
      chunks: Array<{ id: number }>;
    };
    const chunkIdB = foundB.chunks[0].id;

    await expect(tool("read_repo_chunk").handler({ chunkId: chunkIdB }, ctxFor(sessionA))).rejects.toThrow(/not found/);
  });

  it("SECURITY: specialist B, symmetrically, never sees A's chunks", async () => {
    const found = (await tool("search_repo_knowledge").handler({ query: "auth secret token specialistA" }, ctxFor(sessionB))) as {
      chunks: Array<{ path: string }>;
    };
    for (const chunk of found.chunks) expect(chunk.path).not.toBe("src/a-auth.ts");
  });

  it("a generalist session (bound employee, no repo) is refused before any KB call", async () => {
    await expect(tool("search_repo_knowledge").handler({ query: "anything" }, ctxFor(sessionGeneralist))).rejects.toThrow(
      /no repo configured/,
    );
  });

  it("a session with no bound employee at all is refused", async () => {
    await expect(tool("search_repo_knowledge").handler({ query: "anything" }, ctxFor(sessionNoEmployee))).rejects.toThrow(
      /no bound employee/,
    );
  });

  it("read_repo_chunk 404s a chunk id that was never indexed, with a readable error", async () => {
    await expect(tool("read_repo_chunk").handler({ chunkId: 999_999 }, ctxFor(sessionA))).rejects.toThrow(/not found/);
  });
});
