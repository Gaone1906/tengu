import { describe, it, expect, beforeAll, vi, type Mock } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, ensureSessionCapability } from "../../mcp/identity.js";

// linkSession is wrapped in a passthrough spy so the codex-review finding-1
// regression can inject a failure BETWEEN spawn and link (crash-window proof).
// All other tests hit the real implementation through the spy.
vi.mock("../../work-items/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../work-items/store.js")>();
  return { ...actual, linkSession: vi.fn(actual.linkSession) };
});

/**
 * GRS-017d — POST /api/delegations, the delegation transaction.
 *
 * Route-level suite driving the REAL handleApiRequest + registry + work-item
 * store (temp JINN_HOME; engine dispatch stubbed — GRS-015 pattern). What it
 * pins, mirroring the GRS-003b-2b cron-bridge suite:
 *
 *   1. THE TRANSACTION: one call mints the work item, spawns the child session,
 *      and links the two — in-process, never 3 composed HTTP calls, so there is
 *      no client-side partial-failure window.
 *   2. MINT-BEFORE-SPAWN: a spawn failure (engine unavailable) leaves the
 *      durable `open` intent with zero linked sessions and NO session row — a
 *      recoverable record, never an orphaned session without intent.
 *   3. VALIDATION-BEFORE-MINT: a 400 (bad params, unknown employee, bad model)
 *      mints nothing — garbage requests must not litter the work-item table.
 *   4. IDENTITY: caller-parented via x-jinn-caller-session; marker-without-
 *      identity fails CLOSED (403, codex finding 2); operator (no headers)
 *      delegates parentless; explicit body.parentSessionId wins.
 */

// Isolated home for registry DB + org dir. Set BEFORE the dynamic api import.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-delegations-route-"));
process.env.JINN_HOME = tmpHome;

// A real employee for the employee-path assertions (scanOrg requires name+persona).
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-emp.yaml"),
  ["name: qa-emp", "department: qa", "engine: codex", "model: gpt-5.5", "persona: QA employee for route tests", ""].join("\n"),
);
// GRS-017f: an employee whose CONFIGURED model this gateway doesn't register
// (only gpt-5.5 is known for codex here) — the misconfig the clear error targets.
fs.writeFileSync(
  path.join(tmpHome, "org", "stale-emp.yaml"),
  ["name: stale-emp", "department: qa", "engine: codex", "model: legacy-sonnet", "persona: employee pinned to an unregistered model", ""].join("\n"),
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;

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

// Engine availability is a per-test switch: flipping it OFF is the spawn-failure
// injection the mint-before-spawn ordering test needs.
let engineAvailable = true;
// Every engine.run invocation is captured so tests can assert what the web
// dispatch path actually hands the engine (the identity-stamped resolvedMcp).
const engineRuns: Array<Record<string, unknown>> = [];
const engineStub = {
  name: "stub",
  run: async (opts: Record<string, unknown>) => {
    // Snapshot the DB link AT TURN START — the codex finding-1 pin: the work
    // item ↔ session link must already be durable when the worker runs.
    const row = reg
      .initDb()
      .prepare("SELECT work_item_id FROM sessions WHERE id = ?")
      .get(String(opts.sessionId)) as { work_item_id: string | null } | undefined;
    engineRuns.push({ ...opts, workItemIdAtRunStart: row?.work_item_id ?? null });
    return { result: "ok" };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const queueStub = {
  // Unlike the 017a harness (which never runs enqueued turns), this suite
  // EXECUTES them: the identity-seam tests must observe what runWebSession
  // hands engine.run. The engine itself is still the stub above.
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
const apiCtx = {
  // mcp.gateway enabled so the dispatch path resolves the builtin jinn server —
  // the identity-seam test below asserts the session id is stamped onto it. The
  // codex engine mapping must exist for runWebSession to reach engine.run.
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    sessions: {},
    mcp: { gateway: { enabled: true } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => (engineAvailable ? engineStub : undefined),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function call(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await call("POST", "/api/sessions", { prompt, engine: "codex" });
  expect(resp.status).toBe(201);
  return resp.body.id as string;
}

function workItemCount(): number {
  return store.listWorkItems().length;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  // GRS-017e-fix: jinn attachment requires the armed-ok smoke gate (unarmed
  // fails closed). A booted gateway arms it at boot; this suite drives the
  // dispatch path without a boot, so arm it here — the identity-seam tests
  // below assert the jinn server (with the stamped session id) reaches the
  // engine, which needs a positive attach decision.
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

describe("POST /api/delegations — the transaction (happy paths)", () => {
  it("one call mints + spawns + links: employee delegation, operator caller (parentless)", async () => {
    const resp = await call("POST", "/api/delegations", {
      employee: "qa-emp",
      task: "Audit the QA fixtures and report gaps.",
      title: "QA fixture audit",
    });
    expect(resp.status).toBe(201);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    expect(workItemId).toMatch(/^wi_/);
    expect(sessionId).toBeTruthy();

    // The durable intent record, shaped from the delegation.
    const item = store.getWorkItem(workItemId)!;
    expect(item.title).toBe("QA fixture audit");
    expect(item.body).toBe("Audit the QA fixtures and report gaps.");
    expect(item.source).toBe("delegation");
    expect(item.sourceRef).toMatch(/^delegate:operator:/);
    expect(item.assignee).toBe("qa-emp");
    expect(item.department).toBe("qa");
    // Reconciled AFTER the link: the running linked session derives `active`.
    expect(item.status).toBe("executing");

    // The execution attempt, linked + employee-resolved.
    const session = reg.getSession(sessionId)!;
    expect(session.employee).toBe("qa-emp");
    expect(session.engine).toBe("codex");
    expect(session.model).toBe("gpt-5.5");
    expect(session.parentSessionId).toBeFalsy(); // operator caller → parentless
    expect(session.status).toBe("running");

    // Link is queryable through the existing surface.
    const linked = await call("GET", `/api/work-items/${workItemId}/sessions`);
    expect(linked.status).toBe(200);
    expect((linked.body as Array<{ id: string }>).map((s) => s.id)).toContain(sessionId);
  });

  it("a session caller is auto-parent-linked and stamped into the sourceRef", async () => {
    const parentId = await createOperatorSession("I am the delegating COO");
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "child chore", title: "child chore" },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );
    expect(resp.status).toBe(201);
    const session = reg.getSession(resp.body.sessionId)!;
    expect(session.parentSessionId).toBe(parentId);
    const item = store.getWorkItem(resp.body.workItemId)!;
    expect(item.sourceRef).toMatch(new RegExp(`^delegate:${parentId}:`));
  });

  it("an explicit body parentSessionId wins over the header (internal callers unchanged)", async () => {
    const a = await createOperatorSession("a");
    const b = await createOperatorSession("b");
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t", parentSessionId: b },
      { [CALLER_SESSION_HEADER]: a, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(a) },
    );
    expect(resp.status).toBe(201);
    expect(reg.getSession(resp.body.sessionId)!.parentSessionId).toBe(b);
  });

  it("a tool-marked delegation with an unknown caller id is refused fail-closed", async () => {
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t" },
      { "x-jinn-caller-session": "no-such-session", "x-jinn-tool-call": "jinn-mcp" },
    );
    expect(resp.status).toBe(403);
    expect(resp.body.error).toMatch(/caller identity unavailable/i);
  });

  it("a bare-engine delegation works without an employee, and the title defaults from the task", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "One specific chore\nwith detail lines" });
    expect(resp.status).toBe(201);
    const item = store.getWorkItem(resp.body.workItemId)!;
    expect(item.assignee).toBeNull();
    expect(item.title).toContain("One specific chore");
  });

  it("re-running linkSession for the same pair is idempotent — no updated_at churn", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "idem", title: "idem" });
    expect(resp.status).toBe(201);
    const before = store.getWorkItem(resp.body.workItemId)!.updatedAt;
    store.linkSession(resp.body.workItemId, resp.body.sessionId); // the re-link
    expect(store.getWorkItem(resp.body.workItemId)!.updatedAt).toBe(before);
  });
});

describe("web dispatch path — the GRS-017a identity seam reaches the engine (QA catch)", () => {
  it("engine.run receives resolvedMcp with JINN_SESSION_ID stamped on the jinn server for the DELEGATED session", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "identity seam check", title: "seam" });
    expect(resp.status).toBe(201);
    const sessionId = resp.body.sessionId as string;
    // dispatchWebSessionRun is fire-and-forget; wait for the stub engine turn.
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === sessionId);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    const resolved = run!.resolvedMcp as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(resolved).toBeDefined();
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_ID).toBe(sessionId);
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_CAPABILITY).toEqual(expect.any(String));
  });

  it("engine.run receives the stamped identity for plain POST /api/sessions spawns too (same missed block)", async () => {
    const id = await createOperatorSession("seam check for plain spawns");
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === id);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    const resolved = run!.resolvedMcp as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_ID).toBe(id);
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_CAPABILITY).toEqual(expect.any(String));
  });
});

describe("POST /api/delegations — link-before-dispatch (codex review finding 1)", () => {
  it("the engine turn only starts AFTER the work item ↔ session link is durable", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "ordering pin", title: "ordering pin" });
    expect(resp.status).toBe(201);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === sessionId);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    expect(run!.workItemIdAtRunStart).toBe(workItemId);
  });

  it("a failure injected BETWEEN spawn and link halts the transaction: nothing dispatched, no orphan, intent preserved", async () => {
    (store.linkSession as Mock).mockImplementationOnce(() => {
      throw new Error("injected crash between spawn and link");
    });
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "crash window", title: "crash window" });

    // The route reports the partial failure with BOTH preserved ids.
    expect(resp.status).toBe(500);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    expect(workItemId).toMatch(/^wi_/);
    expect(sessionId).toBeTruthy();
    expect(String(resp.body.error)).toMatch(/link/i);

    // No orphan: the work item survives as recoverable `backlog` intent…
    expect(store.getWorkItem(workItemId)!.status).toBe("backlog");
    // …the session row exists but was NEVER marked running or dispatched…
    expect(reg.getSession(sessionId)!.status).toBe("idle");
    await new Promise((r) => setTimeout(r, 50)); // give any (wrong) dispatch a chance to surface
    expect(engineRuns.find((r) => r.sessionId === sessionId)).toBeUndefined();
    // …and it is re-linkable (linkSession is idempotent-in-writes and the rows are intact).
    store.linkSession(workItemId, sessionId);
    expect(reg.listSessionsByWorkItem(workItemId).map((s) => s.id)).toContain(sessionId);
  });
});

describe("POST /api/delegations — body shape guard (codex review finding 2)", () => {
  it("a JSON null body is a structured 400, not a 500 TypeError, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", null);
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/JSON object/i);
    expect(workItemCount()).toBe(before);
  });

  it("a JSON array body is a structured 400 too", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", []);
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/JSON object/i);
    expect(workItemCount()).toBe(before);
  });
});

describe("POST /api/delegations — mint-before-spawn ordering (the GRS-003b-2b contract)", () => {
  it("a spawn failure preserves the minted OPEN intent: no session row, no orphan, recoverable item", async () => {
    engineAvailable = false;
    try {
      const sessionsBefore = reg.listSessions().length;
      const resp = await call("POST", "/api/delegations", { engine: "codex", task: "doomed chore", title: "doomed" });
      // The spawn failed, but the response still carries the preserved intent.
      expect(resp.status).toBe(502);
      expect(resp.body.workItemId).toMatch(/^wi_/);
      expect(String(resp.body.error)).toMatch(/engine/i);

      const item = store.getWorkItem(resp.body.workItemId)!;
      expect(item.status).toBe("backlog"); // durable intent, reconciler-visible
      expect(reg.listSessionsByWorkItem(item.id)).toHaveLength(0); // zero linked attempts
      expect(reg.listSessions().length).toBe(sessionsBefore); // no orphaned session row
    } finally {
      engineAvailable = true;
    }
  });
});

describe("POST /api/delegations — validation BEFORE mint (400s never litter the table)", () => {
  it("missing task mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "qa-emp" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/task/i);
    expect(workItemCount()).toBe(before);
  });

  it("neither employee nor engine mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/employee or engine/i);
    expect(workItemCount()).toBe(before);
  });

  it("an unknown employee is a readable 400 naming the discovery surface, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "nobody-here", task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown employee "nobody-here"/i);
    expect(String(resp.body.error)).toMatch(/\/api\/org/);
    expect(workItemCount()).toBe(before);
  });

  it("an invalid model is the structured selection 400 passed through, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { engine: "codex", model: "not-a-model", task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown model/i);
    expect(workItemCount()).toBe(before);
  });

  it("an employee whose CONFIGURED model isn't registered yields the clear employee-named error, and mints nothing (GRS-017f)", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "stale-emp", task: "t" });
    expect(resp.status).toBe(400);
    const err = String(resp.body.error);
    expect(err).toMatch(/stale-emp/); // names the employee
    expect(err).toMatch(/legacy-sonnet/); // names its configured model
    expect(err).toMatch(/gpt-5\.5/); // names the known-model set
    expect(err).toMatch(/config\.yaml/); // names the register-in-config fix
    expect(err).toMatch(/stale-emp\.yaml/); // points at the employee YAML fix
    expect(err).not.toMatch(/^unknown model/); // NOT the cryptic bare-engine string
    expect(workItemCount()).toBe(before);
  });

  it("POST /api/sessions surfaces the SAME employee-named error for the same misconfigured employee — spawn/delegate consistency (GRS-017f)", async () => {
    const resp = await call("POST", "/api/sessions", { employee: "stale-emp", prompt: "hi" });
    expect(resp.status).toBe(400);
    const err = String(resp.body.error);
    expect(err).toMatch(/stale-emp/);
    expect(err).toMatch(/legacy-sonnet/);
    expect(err).toMatch(/gpt-5\.5/);
  });
});

describe("POST /api/delegations — fail-closed tool identity (codex finding 2)", () => {
  it("the tool-origin marker WITHOUT an identity is refused (403) and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t" },
      { "x-jinn-tool-call": "jinn-mcp" },
    );
    expect(resp.status).toBe(403);
    expect(String(resp.body.error)).toMatch(/caller identity unavailable/i);
    expect(workItemCount()).toBe(before);
  });
});
