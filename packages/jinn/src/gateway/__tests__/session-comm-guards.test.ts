import { describe, it, expect } from "vitest";
import {
  createSessionCommGuards,
  prepareLateralSend,
  isDescendantOf,
  headerString,
  resolveCallerIdentity,
  LATERAL_MAX_SENDS,
  LATERAL_WINDOW_MS,
  LATERAL_MAX_HOPS,
  LATERAL_HOP_TTL_MS,
} from "../session-comm-guards.js";
import {
  CALLER_SESSION_HEADER,
  CALLER_SESSION_CAPABILITY_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  UNIDENTIFIED_TOOL_CALL_ERROR,
} from "../../mcp/identity.js";
import type { Session } from "../../shared/types.js";

/**
 * GRS-017a — substrate guards for agent-initiated (lateral) session messaging.
 * Pure/in-memory module with an injected clock; these are the arithmetic tests
 * (rate window, hop decrement/expiry, descendant walk). The route wiring is
 * covered by the session-tools integration tier.
 */

function sess(id: string, extra: Partial<Session> = {}): Session {
  return { id, engine: "codex", source: "web", status: "idle", ...extra } as Session;
}

describe("rate cap — sliding window per sender", () => {
  it(`allows ${LATERAL_MAX_SENDS} sends in a window and refuses the next with retry info`, () => {
    let now = 1_000_000;
    const g = createSessionCommGuards(() => now);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) {
      expect(g.checkSendAllowed("a").ok).toBe(true);
      now += 1_000;
    }
    const denied = g.checkSendAllowed("a");
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(429);
      expect(denied.error).toMatch(/rate cap/i);
      expect(denied.error).toMatch(/\d+s/);
    }
  });

  it("the window slides — old sends expire and capacity returns", () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) g.checkSendAllowed("a");
    expect(g.checkSendAllowed("a").ok).toBe(false);
    now += LATERAL_WINDOW_MS + 1;
    expect(g.checkSendAllowed("a").ok).toBe(true);
  });

  it("senders are independent — one storming session does not starve another", () => {
    const g = createSessionCommGuards(() => 0);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) g.checkSendAllowed("a");
    expect(g.checkSendAllowed("a").ok).toBe(false);
    expect(g.checkSendAllowed("b").ok).toBe(true);
  });

  it("a refused send does not consume window capacity", () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) g.checkSendAllowed("a");
    for (let i = 0; i < 5; i++) expect(g.checkSendAllowed("a").ok).toBe(false);
    now += LATERAL_WINDOW_MS + 1;
    // All original sends expired together; the refused attempts left no residue.
    expect(g.checkSendAllowed("a").ok).toBe(true);
  });
});

describe("hop budget — relay chains are bounded", () => {
  it("a fresh sender sends at hop 1; each relay increments; the budget refuses beyond the max (cap=4)", () => {
    // Construct with an explicit cap of 4 so this compact arithmetic chain still
    // exercises the refusal boundary (the default is now 12).
    const g = createSessionCommGuards(() => 0, 4);
    // a → b (hop 1)
    let v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === 1).toBe(true);
    g.recordDelivery("b", 1);
    // b → a (hop 2)
    v = g.checkSendAllowed("b");
    expect(v.ok && v.hops === 2).toBe(true);
    g.recordDelivery("a", 2);
    // a → b (hop 3), b → a (hop 4)
    v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === 3).toBe(true);
    g.recordDelivery("b", 3);
    v = g.checkSendAllowed("b");
    expect(v.ok && v.hops === 4).toBe(true);
    g.recordDelivery("a", 4);
    // a → anywhere would be hop 5 → refused, readable
    const denied = g.checkSendAllowed("a");
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(400);
      expect(denied.error).toMatch(/hop budget/i);
      expect(denied.error).toMatch(/escalate/i);
    }
  });

  it("inbound hop state expires — a stale relay tag does not penalize later legit sends", () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    g.recordDelivery("b", LATERAL_MAX_HOPS);
    now += LATERAL_HOP_TTL_MS + 1;
    const v = g.checkSendAllowed("b");
    expect(v.ok && v.hops === 1).toBe(true);
  });

  it("a genuine user/operator message resets the target's relay chain", () => {
    const g = createSessionCommGuards(() => 0);
    g.recordDelivery("b", LATERAL_MAX_HOPS);
    g.clearInboundHop("b");
    const v = g.checkSendAllowed("b");
    expect(v.ok && v.hops === 1).toBe(true);
  });
});

describe("hop budget — configurable cap (default 12)", () => {
  it("defaults to LATERAL_MAX_HOPS (12) and admits a 12-deep chain, refusing the 13th", () => {
    const g = createSessionCommGuards(() => 0);
    expect(g.maxHops()).toBe(12);
    expect(LATERAL_MAX_HOPS).toBe(12);
    // Drive an inbound hop of 12 (the cap); the next outbound would be hop 13.
    let prev = "seed";
    for (let hop = 1; hop <= LATERAL_MAX_HOPS; hop++) {
      const v = g.checkSendAllowed(prev);
      expect(v.ok && v.hops === hop).toBe(true);
      const next = `s${hop}`;
      g.recordDelivery(next, hop);
      prev = next;
    }
    const denied = g.checkSendAllowed(prev); // would be hop 13
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/max 12/);
  });

  it("setMaxHops reconfigures the cap live (config apply / hot-reload)", () => {
    const g = createSessionCommGuards(() => 0);
    g.setMaxHops(6);
    expect(g.maxHops()).toBe(6);
    g.recordDelivery("x", 6); // inbound at the new cap
    expect(g.checkSendAllowed("x").ok).toBe(false); // hop 7 > 6 → refused
    // Widen the cap and the same sender can proceed.
    g.setMaxHops(20);
    g.recordDelivery("x", 6);
    const v = g.checkSendAllowed("x");
    expect(v.ok && v.hops === 7).toBe(true);
  });

  it("clamps a configured cap to [1, 64] and rejects non-finite values (never unbounded)", () => {
    const g = createSessionCommGuards(() => 0);
    g.setMaxHops(0);
    expect(g.maxHops()).toBe(1);
    g.setMaxHops(-5);
    expect(g.maxHops()).toBe(1);
    g.setMaxHops(1000);
    expect(g.maxHops()).toBe(64);
    g.setMaxHops(Number.NaN);
    expect(g.maxHops()).toBe(LATERAL_MAX_HOPS); // non-finite → default
    g.setMaxHops(7.9);
    expect(g.maxHops()).toBe(7); // floored
  });

  it("constructs with an explicit initial cap", () => {
    const g = createSessionCommGuards(() => 0, 3);
    expect(g.maxHops()).toBe(3);
  });
});

describe("prepareLateralSend — the route-side transform", () => {
  it("refuses self-messages before any state changes", () => {
    const g = createSessionCommGuards(() => 0);
    const out = prepareLateralSend({
      caller: sess("s1", { employee: "jinn-dev" }),
      targetSessionId: "s1",
      message: "hi me",
      guards: g,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.error).toMatch(/own session/i);
    }
    expect(g.checkSendAllowed("s1").ok).toBe(true); // nothing consumed
  });

  it("prefixes the engine prompt with sender identity + hop tag + reply hint, and builds a clean displayMessage", () => {
    const g = createSessionCommGuards(() => 0);
    g.recordDelivery("s1", 1); // s1 is relaying — outbound will be hop 2
    const out = prepareLateralSend({
      caller: sess("s1", { employee: "jinn-dev" }),
      targetSessionId: "s2",
      message: "please review the diff",
      guards: g,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prompt).toContain("📨");
      expect(out.prompt).toContain("s1");
      expect(out.prompt).toContain("jinn-dev");
      expect(out.prompt).toContain(`hop 2/${LATERAL_MAX_HOPS}`);
      expect(out.prompt).toContain("please review the diff");
      expect(out.prompt).toContain("send_to_session");
      expect(out.displayMessage).toBe(`📨 From jinn-dev [hop 2/${LATERAL_MAX_HOPS}]: please review the diff`);
      expect(out.hops).toBe(2);
      expect(out.meta).toEqual({
        kind: "agent-relay",
        fromSessionId: "s1",
        fromLabel: "jinn-dev",
        fromEmployee: "jinn-dev",
        hops: 2,
        maxHops: LATERAL_MAX_HOPS,
        fullMessage: "please review the diff",
      });
    }
  });

  it("falls back to the caller's source when it has no employee", () => {
    const g = createSessionCommGuards(() => 0);
    const out = prepareLateralSend({ caller: sess("s1", { source: "cron" }), targetSessionId: "s2", message: "m", guards: g });
    expect(out.ok && out.prompt.includes("cron")).toBe(true);
  });

  it("propagates guard refusals (rate cap) with their status", () => {
    const g = createSessionCommGuards(() => 0);
    for (let i = 0; i < LATERAL_MAX_SENDS; i++) g.checkSendAllowed("s1");
    const out = prepareLateralSend({ caller: sess("s1"), targetSessionId: "s2", message: "m", guards: g });
    expect(!out.ok && out.status === 429).toBe(true);
  });

  it("truncates a huge message in the displayMessage but never in the engine prompt", () => {
    const g = createSessionCommGuards(() => 0);
    const long = "x".repeat(17_000);
    const out = prepareLateralSend({ caller: sess("s1"), targetSessionId: "s2", message: long, guards: g });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prompt).toContain(long);
      expect(out.displayMessage.length).toBeLessThan(400);
      expect(out.meta.fullMessage).toBe("x".repeat(16_000));
      expect(out.meta.fullMessage).toHaveLength(16_000);
      expect(out.meta.hops).toBe(1);
      expect(out.meta.maxHops).toBe(LATERAL_MAX_HOPS);
    }
  });
});

describe("isDescendantOf — the stop-scoping walk", () => {
  const tree: Record<string, Session> = {
    root: sess("root"),
    child: sess("child", { parentSessionId: "root" }),
    grandchild: sess("grandchild", { parentSessionId: "child" }),
    stranger: sess("stranger"),
  };
  const get = (id: string) => tree[id];

  it("direct child and deeper descendants pass; strangers, self, and ancestors fail", () => {
    expect(isDescendantOf("child", "root", get)).toBe(true);
    expect(isDescendantOf("grandchild", "root", get)).toBe(true);
    expect(isDescendantOf("stranger", "root", get)).toBe(false);
    expect(isDescendantOf("root", "root", get)).toBe(false); // self is not a descendant
    expect(isDescendantOf("root", "child", get)).toBe(false); // ancestor, not descendant
  });

  it("survives a parent cycle without hanging", () => {
    const cyc: Record<string, Session> = {
      a: sess("a", { parentSessionId: "b" }),
      b: sess("b", { parentSessionId: "a" }),
    };
    expect(isDescendantOf("a", "zzz", (id) => cyc[id])).toBe(false);
  });
});

describe("headerString", () => {
  it("normalizes node header values", () => {
    expect(headerString("abc")).toBe("abc");
    expect(headerString(["abc", "def"])).toBe("abc");
    expect(headerString(undefined)).toBeUndefined();
    expect(headerString("  ")).toBeUndefined();
  });
});

describe("resolveCallerIdentity — the tool-origin discriminator (GRS-017 finding 2)", () => {
  it("no marker, no caller header → unauthenticated, never implicit operator", () => {
    expect(resolveCallerIdentity({})).toEqual({ kind: "unauthenticated" });
  });

  it("caller header present → session identity, with or without the marker (curl-with-header scoping parity preserved)", () => {
    expect(resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1" })).toEqual({ kind: "session", callerId: "s-1" });
    expect(
      resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE }),
    ).toEqual({ kind: "session", callerId: "s-1" });
  });

  it("scoped writes require the bound per-session capability for any caller-session claim", () => {
    const verifySessionCapability = (sessionId: string, capability: string) => sessionId === "s-1" && capability === "cap-s-1";
    const opts = { sessionExists: (id: string) => id === "s-1", verifySessionCapability, requireCapability: true };

    expect(resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1" }, opts)).toEqual({ kind: "unidentified-tool" });
    expect(resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1", [CALLER_SESSION_CAPABILITY_HEADER]: "cap-other" }, opts)).toEqual({ kind: "unidentified-tool" });
    expect(resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1", [CALLER_SESSION_CAPABILITY_HEADER]: "cap-s-1" }, opts)).toEqual({ kind: "session", callerId: "s-1" });
    expect(
      resolveCallerIdentity(
        { [CALLER_SESSION_HEADER]: "s-1", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_CAPABILITY_HEADER]: "cap-s-1" },
        opts,
      ),
    ).toEqual({ kind: "session", callerId: "s-1" });
    expect(
      resolveCallerIdentity({ [CALLER_SESSION_HEADER]: "s-1", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE }, opts),
    ).toEqual({ kind: "unidentified-tool" });
    expect(
      resolveCallerIdentity(
        { [CALLER_SESSION_HEADER]: "s-1", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_CAPABILITY_HEADER]: "cap-other" },
        opts,
      ),
    ).toEqual({ kind: "unidentified-tool" });
    expect(
      resolveCallerIdentity(
        { [CALLER_SESSION_HEADER]: "ghost", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_CAPABILITY_HEADER]: "cap-s-1" },
        opts,
      ),
    ).toEqual({ kind: "unidentified-tool" });
  });

  it("marker present + identity ABSENT → unidentified-tool: the fail-closed case, never operator", () => {
    expect(resolveCallerIdentity({ [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE })).toEqual({ kind: "unidentified-tool" });
    // an empty/whitespace caller header is malformed identity input, not the operator path
    expect(
      resolveCallerIdentity({ [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_HEADER]: "  " }),
    ).toEqual({ kind: "unidentified-tool" });
    // any non-empty marker value counts — the value is documentation, presence is the signal
    expect(resolveCallerIdentity({ [TOOL_CALL_HEADER]: "anything" })).toEqual({ kind: "unidentified-tool" });
  });

  it("present-but-empty identity headers fail closed instead of normalizing to operator", () => {
    const opts = { sessionExists: (id: string) => id === "s-1", verifySessionCapability: () => false, requireCapability: true };

    for (const value of ["", "   "]) {
      expect(resolveCallerIdentity({ [TOOL_CALL_HEADER]: value }, opts)).toEqual({ kind: "unidentified-tool" });
      expect(resolveCallerIdentity({ [CALLER_SESSION_HEADER]: value }, opts)).toEqual({ kind: "unidentified-tool" });
    }
  });

  it("array header values normalize first-wins (node duplicate-header shape)", () => {
    expect(
      resolveCallerIdentity({ [CALLER_SESSION_HEADER]: ["s-1", "s-2"], [TOOL_CALL_HEADER]: [TOOL_CALL_HEADER_VALUE] }),
    ).toEqual({ kind: "session", callerId: "s-1" });
  });

  it("the shared refusal text names the missing env var and the fail-closed intent", () => {
    expect(UNIDENTIFIED_TOOL_CALL_ERROR).toMatch(/caller identity unavailable/i);
    expect(UNIDENTIFIED_TOOL_CALL_ERROR).toContain("JINN_SESSION_ID");
    expect(UNIDENTIFIED_TOOL_CALL_ERROR).toContain("JINN_SESSION_CAPABILITY");
  });
});
