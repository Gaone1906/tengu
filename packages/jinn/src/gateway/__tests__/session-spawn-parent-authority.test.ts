import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * A session caller can never mint a PARENTLESS child.
 *
 * Parentlessness (plus no employee, plus no workflow provenance) is the shape
 * of the gateway's own top-level agent session, and that shape carries
 * operator-delegated authority — `asOperator` keys off it. The spawn route used
 * to fill in the caller as parent only when the body OMITTED parentSessionId,
 * so an explicit `null` produced the privileged shape in one hop.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-spawn-parent-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

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

const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const ctx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    sessions: {},
    mcp: { browser: { enabled: false }, gateway: { enabled: false } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => ({
      enqueue: async () => {},
      clearCancelled: () => {},
      clearQueue: () => {},
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function spawn(body: Record<string, unknown>, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: "/api/sessions",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, ctx);
  return cap;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

describe("POST /api/sessions — a session caller is always the parent", () => {
  it("overrides an explicit null parent with the caller, so the privileged shape cannot be forged", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "spawn-forger" });
    expect(reg.isPortalAgentSession(caller)).toBe(true); // the shape being reached for

    const cap = await spawn({ prompt: "escape my lineage", parentSessionId: null }, toolHeaders(caller.id));

    expect(cap.status).toBe(201);
    const child = reg.getSession(cap.body.id as string)!;
    expect(child.parentSessionId).toBe(caller.id);
    expect(reg.isPortalAgentSession(child)).toBe(false);
  });

  it("falls back to the caller when the named parent does not exist, and honours one that does", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "spawn-caller" });
    const other = reg.createSession({ engine: "codex", source: "web", sourceRef: "spawn-other" });

    const ghost = await spawn({ prompt: "name a ghost", parentSessionId: "no-such-session" }, toolHeaders(caller.id));
    expect(ghost.status).toBe(201);
    expect(reg.getSession(ghost.body.id as string)!.parentSessionId).toBe(caller.id);

    const named = await spawn({ prompt: "name a real one", parentSessionId: other.id }, toolHeaders(caller.id));
    expect(named.status).toBe(201);
    expect(reg.getSession(named.body.id as string)!.parentSessionId).toBe(other.id);
  });

  it("leaves the operator surface parentless, which is how the COO session exists at all", async () => {
    const cap = await spawn({ prompt: "operator spawn" }, { authorization: "Bearer test-token" });
    expect(cap.status).toBe(201);
    expect(reg.isPortalAgentSession(reg.getSession(cap.body.id as string)!)).toBe(true);
  });
});
