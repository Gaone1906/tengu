import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildOrgTools } from "../org-tools.js";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * GRS-017b — the org/employees MCP tool group.
 *
 * Tiers:
 *   1. UNIT — stub fetch: routes, filter arithmetic (AND semantics, case
 *      insensitivity), persona passthrough, empty/over-filter self-correction
 *      data, no-filter refusal, 404 → discovery hint.
 *   2. INTEGRATION — real org routes + a temp ORG_DIR with generic employee
 *      YAMLs (privacy firewall: synthetic names only).
 */

// Isolated home for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-org-home-"));

interface SeenCall {
  url: string;
  method: string;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId = "session-test",
  sessionCapability = "cap-test",
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = { url: typeof input === "string" ? input : input.toString(), method: init?.method ?? "GET" };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7777", fetchFn, callerSessionId, sessionCapability };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildOrgTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const ORG_BODY = {
  departments: ["platform", "growth"],
  employees: [
    { name: "platform-lead", displayName: "Platform Lead", department: "platform", rank: "manager", engine: "codex", role: "Leads platform", parentName: null, directReports: ["platform-worker"] },
    { name: "platform-worker", displayName: "Platform Worker", department: "platform", rank: "senior", engine: "claude", role: "Builds platform", parentName: "platform-lead", directReports: [] },
    { name: "growth-writer", displayName: "Growth Writer", department: "growth", rank: "senior", engine: "claude", role: "Writes growth", parentName: null, directReports: [] },
  ],
  hierarchy: { root: null, sorted: [], warnings: [] },
};

describe("org tools — registry + schemas", () => {
  it("exposes the 3 org tools; only get_employee has a required arg", () => {
    const tools = buildOrgTools();
    expect(tools.map((t) => t.name)).toEqual(["list_employees", "get_employee", "find_employees"]);
    expect(tool("get_employee").inputSchema.required).toEqual(["name"]);
    expect(tool("find_employees").inputSchema.required).toBeUndefined();
    expect(tool("list_employees").description).toBe(
      "List compact employee rows: name, role, rank, department, engine, reporting. Use role/persona fit before spawning.",
    );
    expect(tool("find_employees").description).toContain("role, not full personas");
  });
});

describe("org tools — unit (stub gateway)", () => {
  it("find_employees ANDs the passed filters, case-insensitively, and returns compact rows without personas", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: ORG_BODY }));
    const out = (await tool("find_employees").handler({ department: "Platform", rank: "SENIOR" }, ctx)) as {
      matches: Array<Record<string, unknown>>;
      hint: string;
    };
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/org");
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({ name: "platform-worker", role: "Builds platform", reportsTo: "platform-lead" });
    expect(JSON.stringify(out.matches)).not.toContain("persona");
    expect(out.hint).toContain("get_employee");
  });

  it("a single filter matches broadly; engine filter works", async () => {
    const { ctx } = stub(() => ({ status: 200, body: ORG_BODY }));
    const seniors = (await tool("find_employees").handler({ rank: "senior" }, ctx)) as { matches: unknown[] };
    expect(seniors.matches).toHaveLength(2);
    const codex = (await tool("find_employees").handler({ engine: "codex" }, ctx)) as { matches: Array<{ name: string }> };
    expect(codex.matches.map((m) => m.name)).toEqual(["platform-lead"]);
  });

  it("zero matches return the OBSERVED value sets for self-correction (deterministic, no judgment)", async () => {
    const { ctx } = stub(() => ({ status: 200, body: ORG_BODY }));
    const out = (await tool("find_employees").handler({ department: "platfrom" }, ctx)) as { matches: unknown[]; hint: string };
    expect(out.matches).toHaveLength(0);
    expect(out.hint).toContain("department ∈ {growth, platform}");
  });

  it("no filters at all is refused with a pointer at the roster tool (no gateway call)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: ORG_BODY }));
    await expect(tool("find_employees").handler({}, ctx)).rejects.toThrow(/at least one filter.*list_employees/is);
    expect(calls).toHaveLength(0);
  });

  it("get_employee passes the full record (incl. persona) through with a delegation hint; 404 → discovery hint", async () => {
    const full = { name: "platform-worker", persona: "You build the platform.", department: "platform", rank: "senior" };
    const ok = stub(() => ({ status: 200, body: full }));
    const out = (await tool("get_employee").handler({ name: "platform-worker" }, ok.ctx)) as {
      employee: Record<string, unknown>;
      hint: string;
    };
    expect(ok.calls[0].url).toBe("http://127.0.0.1:7777/api/org/employees/platform-worker");
    expect(out.employee.persona).toBe("You build the platform.");
    expect(out.hint).toContain('spawn_session { employee: "platform-worker"');

    const missing = stub(() => ({ status: 404, body: { error: "Not found" } }));
    await expect(tool("get_employee").handler({ name: "ghost" }, missing.ctx)).rejects.toThrow(
      /"ghost" not found.*find_employees/is,
    );
  });

  it("list_employees passes the org body through verbatim", async () => {
    const { ctx } = stub(() => ({ status: 200, body: ORG_BODY }));
    const out = (await tool("list_employees").handler({}, ctx)) as typeof ORG_BODY;
    expect(out.employees).toHaveLength(3);
    expect(out.departments).toEqual(["platform", "growth"]);
  });
});

/* ── Integration: real org routes + a temp ORG_DIR (generic names only) ─────── */

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
let integrationCallerId: string;

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

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" } }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
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

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  integrationCallerId = registry.createSession({ engine: "codex", source: "web", sourceRef: "org-caller", employee: "org-caller" }).id;
  // Generic synthetic org — three YAMLs under the temp ORG_DIR.
  const orgDir = path.join(process.env.JINN_HOME!, "org");
  fs.mkdirSync(path.join(orgDir, "platform"), { recursive: true });
  fs.mkdirSync(path.join(orgDir, "growth"), { recursive: true });
  const write = (rel: string, y: string) => fs.writeFileSync(path.join(orgDir, rel), y);
  write("platform/a-lead.yaml", "name: a-lead\ndisplayName: A Lead\nrank: manager\nengine: codex\npersona: Leads the platform team.\n");
  write(
    "platform/a-worker.yaml",
    "name: a-worker\ndisplayName: A Worker\nrank: senior\nengine: claude\nreportsTo: a-lead\npersona: You are Builds the platform.\n",
  );
  write("growth/b-writer.yaml", "name: b-writer\ndisplayName: B Writer\nrank: senior\nengine: claude\npersona: Writes growth content.\n");
});

describe("org tools — integration against the real org routes", () => {
  it("discovery flow: find by department+rank → get the persona → the hint names the spawn tool", async () => {
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://gateway.test",
      fetchFn: apiFetch(),
      callerSessionId: integrationCallerId,
      sessionCapability: ensureSessionCapability(integrationCallerId),
    };

    const found = (await tool("find_employees").handler({ department: "platform", rank: "senior" }, ctx)) as {
      matches: Array<{ name: string; role: string; reportsTo: string | null }>;
    };
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ name: "a-worker", role: "Builds the platform", reportsTo: "a-lead" });
    expect(JSON.stringify(found.matches)).not.toContain("persona");

    const got = (await tool("get_employee").handler({ name: "a-worker" }, ctx)) as {
      employee: { persona: string; parentName: string | null };
      hint: string;
    };
    expect(got.employee.persona).toBe("You are Builds the platform.");
    expect(got.employee.parentName).toBe("a-lead");
    expect(got.hint).toContain("spawn_session");

    const none = (await tool("find_employees").handler({ engine: "grok" }, ctx)) as { matches: unknown[]; hint: string };
    expect(none.matches).toHaveLength(0);
    expect(none.hint).toContain("engine ∈ {claude, codex}");
  });
});
