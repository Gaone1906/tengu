import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import { serializeSession, type ApiContext } from "../api.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:sess-1",
    connector: "web",
    sessionKey: "web:sess-1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    lastActivity: "2026-06-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function makeContext(backgroundActivity?: ApiContext["backgroundActivity"]): ApiContext {
  return {
    backgroundActivity,
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: () => "idle",
      }),
    },
  } as unknown as ApiContext;
}

describe("serializeSession", () => {
  it("reports runtime activity as running transport state while keeping stored status idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const session = makeSession({ status: "idle" });
    const context = makeContext(new Map([
      ["sess-1", { activeStreams: 1, lastActivityAt: Date.now() }],
    ]));

    const serialized = serializeSession(session, context);

    expect(serialized.status).toBe("idle");
    expect(serialized.transportState).toBe("running");
    expect(serialized.backgroundActivity?.activeStreams).toBe(1);
    vi.useRealTimers();
  });

  it("keeps long active runtime work visible instead of staling it out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:10:00.000Z"));
    const session = makeSession({ status: "idle" });
    const context = makeContext(new Map([
      ["sess-1", { activeStreams: 1, lastActivityAt: new Date("2026-06-01T00:00:00.000Z").getTime() }],
    ]));

    const serialized = serializeSession(session, context);

    expect(serialized.transportState).toBe("running");
    expect(serialized.backgroundActivity?.activeStreams).toBe(1);
    vi.useRealTimers();
  });
});
