import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  createSessionCommGuards,
  sessionCommGuards,
  LATERAL_MAX_SENDS,
  LATERAL_WINDOW_MS,
  LATERAL_MAX_HOPS,
  LATERAL_HOP_TTL_MS,
  PRUNE_EVERY_OPS,
} from "../session-comm-guards.js";
import { buildSessionTools } from "../../mcp/session-tools.js";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * GRS-017c — the STORM/ABUSE matrix: every substrate guard provably fires on
 * its exact trigger, as committed regressions. Two tiers:
 *
 *   UNIT (fake clock) — rate-window edge arithmetic (exactly 10 / the 11th /
 *   rollover at exactly WINDOW_MS), hop-refusal-consumes-no-rate, lazy pruning
 *   + stats, TTL expiry.
 *
 *   INTEGRATION (real routes + registry, temp JINN_HOME) — the adversarial
 *   scenarios a QA engine throws: fan-out storm (one sender → many peers),
 *   a 5-session relay chain dying on the hop budget, N concurrent sends racing
 *   one sender's window (the synchronous-guard invariant, end-to-end), a
 *   spoofed-caller flood leaving ZERO guard state, and the descendant walk
 *   under a deep chain + a separate branch. (Two-peer ping-pong death and the
 *   operator hop-reset live in mcp/__tests__/session-tools.test.ts since 017a.)
 *
 * Restart-survival is deliberately NOT tested: guard state is argued
 * in-memory-only (module docstring — a restart kills the storm's actors; the
 * worst case is one fresh budget; durable guard state is an unearned primitive).
 */

// Isolated registry DB for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-storm-home-"));

/* ── UNIT: window/hop edge arithmetic ───────────────────────────────────────── */

describe("rate-window edges (fake clock)", () => {
  it(`send ${LATERAL_MAX_SENDS} is allowed, send ${LATERAL_MAX_SENDS + 1} refused, and capacity returns at EXACTLY window age`, () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    // Sends staggered at t=0,1,…,9 so window slots expire one at a time.
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) {
      expect(g.checkSendAllowed("a").ok).toBe(true);
      now = i + 1;
    }
    expect(g.checkSendAllowed("a").ok).toBe(false);
    // The first send was at t=0; at exactly t=WINDOW_MS its age is not < WINDOW → expired.
    now = LATERAL_WINDOW_MS;
    const v = g.checkSendAllowed("a");
    expect(v.ok).toBe(true);
    // ...but only ONE slot returned (the t=1..9 sends are still inside the window).
    expect(g.checkSendAllowed("a").ok).toBe(false);
  });

  it("a hop-budget refusal consumes NO rate capacity (hop check runs first)", () => {
    const g = createSessionCommGuards(() => 0);
    g.recordDelivery("a", LATERAL_MAX_HOPS);
    for (let i = 0; i < 3; i++) {
      const denied = g.checkSendAllowed("a");
      expect(!denied.ok && denied.status === 400).toBe(true);
    }
    g.clearInboundHop("a");
    // Full window still available — the hop refusals left no residue.
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) {
      expect(g.checkSendAllowed("a").ok).toBe(true);
    }
  });

  it("hop TTL expiry mid-chain resets the budget (stale relay tags don't strand a sender)", () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    g.recordDelivery("a", LATERAL_MAX_HOPS - 1);
    let v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === LATERAL_MAX_HOPS).toBe(true);
    now += LATERAL_HOP_TTL_MS + 1;
    v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === 1).toBe(true);
  });
});

describe("lazy pruning + stats (memory bound)", () => {
  it(`sweeps expired senders/hop tags after ${PRUNE_EVERY_OPS} guard ops`, () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    // 300 one-shot senders + 300 hop tags at t=0.
    for (let i = 0; i < 300; i++) {
      g.checkSendAllowed(`s-${i}`);
      g.recordDelivery(`t-${i}`, 1);
    }
    expect(g.stats().senders).toBe(300);
    expect(g.stats().hopEntries).toBe(300);
    // Everything expires; the next PRUNE_EVERY_OPS ops trigger a sweep.
    now = LATERAL_WINDOW_MS + LATERAL_HOP_TTL_MS + 1;
    for (let i = 0; i < PRUNE_EVERY_OPS; i++) g.checkSendAllowed("active");
    const after = g.stats();
    expect(after.hopEntries).toBe(0);
    expect(after.senders).toBe(1); // only the live "active" sender remains
  });
});

/* ── INTEGRATION: real routes + registry ────────────────────────────────────── */

type Api = typeof import("../api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;

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
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId?: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: callerSessionId ? ensureSessionCapability(callerSessionId) : undefined,
  };
}

function tool(name: string): JinnMcpTool {
  const t = buildSessionTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await apiFetch()("http://gateway.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, engine: "codex" }),
  });
  expect(resp.status).toBe(201);
  return (JSON.parse(await resp.text()) as { id: string }).id;
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
});

beforeEach(() => {
  sessionCommGuards.reset();
});

describe("storm matrix — integration against the real routes", () => {
  it(`FAN-OUT STORM: one sender messaging ${LATERAL_MAX_SENDS} distinct peers is fine; peer ${LATERAL_MAX_SENDS + 1} trips the per-sender cap`, async () => {
    const sender = await createOperatorSession("storm sender");
    const peers: string[] = [];
    for (let i = 0; i <= LATERAL_MAX_SENDS; i++) peers.push(await createOperatorSession(`peer ${i}`));
    const ctx = ctxFor(sender);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) {
      await tool("send_to_session").handler({ sessionId: peers[i], message: `fanout ${i}` }, ctx);
    }
    // The cap is per SENDER across all targets — a fresh target does not help.
    await expect(
      tool("send_to_session").handler({ sessionId: peers[LATERAL_MAX_SENDS], message: "one more" }, ctx),
    ).rejects.toThrow(/429.*rate cap/is);
  });

  it(`RELAY CHAIN A→B→C→D→E: delivery to E carries hop ${LATERAL_MAX_HOPS}/${LATERAL_MAX_HOPS}; E's forward attempt is refused`, async () => {
    const ids: string[] = [];
    for (const label of ["A", "B", "C", "D", "E"]) ids.push(await createOperatorSession(`relay ${label}`));
    const [a, b, c, d, e] = ids;
    await tool("send_to_session").handler({ sessionId: b, message: "relay this" }, ctxFor(a)); // hop 1
    await tool("send_to_session").handler({ sessionId: c, message: "relay this" }, ctxFor(b)); // hop 2
    await tool("send_to_session").handler({ sessionId: d, message: "relay this" }, ctxFor(c)); // hop 3
    await tool("send_to_session").handler({ sessionId: e, message: "relay this" }, ctxFor(d)); // hop 4
    const banner = registry.getMessages(e).at(-1)!;
    expect(banner.content).toContain(`hop ${LATERAL_MAX_HOPS}/${LATERAL_MAX_HOPS}`);
    await expect(tool("send_to_session").handler({ sessionId: a, message: "keep relaying" }, ctxFor(e))).rejects.toThrow(
      /400.*hop budget.*escalate/is,
    );
  });

  it(`CONCURRENCY: ${LATERAL_MAX_SENDS + 5} sends racing one sender's window admit EXACTLY ${LATERAL_MAX_SENDS} (synchronous-guard invariant, end-to-end)`, async () => {
    const sender = await createOperatorSession("racer");
    const target = await createOperatorSession("race target");
    const ctx = ctxFor(sender);
    const results = await Promise.allSettled(
      Array.from({ length: LATERAL_MAX_SENDS + 5 }, (_, i) =>
        tool("send_to_session").handler({ sessionId: target, message: `race ${i}` }, ctx),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toBe(LATERAL_MAX_SENDS);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/429/);
    }
  });

  it("SPOOF FLOOD: unknown caller ids are refused 403 and leave ZERO guard state (memory-bound proof)", async () => {
    const target = await createOperatorSession("spoof target");
    const before = sessionCommGuards.stats();
    for (let i = 0; i < 25; i++) {
      await expect(
        tool("send_to_session").handler({ sessionId: target, message: "spoofed" }, ctxFor(`ghost-${i}`)),
      ).rejects.toThrow(/caller identity unavailable/i);
    }
    expect(sessionCommGuards.stats()).toEqual(before);
    expect(registry.getMessages(target).some((m) => m.content.includes("spoofed"))).toBe(false);
  });

  it("DESCENDANT WALK, deep + branched: root stops a depth-5 leaf; a cousin branch is refused; the walk is header-scoped only", async () => {
    const root = await createOperatorSession("deep root");
    // Build a spawn chain root → c1 → c2 → c3 → c4 → leaf via the real tool.
    let parent = root;
    let leaf = root;
    for (let depth = 1; depth <= 5; depth++) {
      const spawned = (await tool("spawn_session").handler({ prompt: `depth ${depth}`, engine: "codex" }, ctxFor(parent))) as {
        sessionId: string;
      };
      parent = spawned.sessionId;
      leaf = spawned.sessionId;
    }
    // A separate branch: another root with one child (the "cousin").
    const otherRoot = await createOperatorSession("other root");
    const cousin = (await tool("spawn_session").handler({ prompt: "cousin", engine: "codex" }, ctxFor(otherRoot))) as {
      sessionId: string;
    };

    const stopped = (await tool("stop_session").handler({ sessionId: leaf }, ctxFor(root))) as { action: string };
    expect(stopped.action).toBe("stopped");
    await expect(tool("stop_session").handler({ sessionId: cousin.sessionId }, ctxFor(root))).rejects.toThrow(/403.*descendant/is);
    // No header (operator/UI) → unrestricted, unchanged.
    const op = await apiFetch()(`http://gateway.test/api/sessions/${cousin.sessionId}/stop`, { method: "POST" });
    expect(op.status).toBe(200);
  });
});
