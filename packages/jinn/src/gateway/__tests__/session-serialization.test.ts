import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import {
  buildSessionDelegatedActivityIndex,
  serializeSession,
  type ApiContext,
} from "../api.js";

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

function makeContext(
  backgroundActivity?: ApiContext["backgroundActivity"],
  transportByKey: Record<string, "idle" | "queued" | "running" | "error" | "interrupted"> = {},
): ApiContext {
  return {
    backgroundActivity,
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (key: string) => transportByKey[key] ?? "idle",
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

  it("serializes transitive delegated activity without changing the parent's durable status", () => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });
    const manager = makeSession({
      id: "manager",
      sessionKey: "web:manager",
      parentSessionId: "parent",
      employee: "ops-lead",
    });
    const worker = makeSession({
      id: "worker",
      sessionKey: "web:worker",
      parentSessionId: "manager",
      employee: "researcher",
      status: "running",
    });
    const context = makeContext(undefined, { "web:worker": "running" });
    const index = buildSessionDelegatedActivityIndex([parent, manager, worker], context);

    const serialized = serializeSession(parent, context, index);

    expect(serialized.status).toBe("idle");
    expect(serialized.delegatedActivity).toEqual({
      activeSessions: 1,
      employees: ["researcher"],
    });
  });

  it.each([
    {
      label: "queued transport",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer" }),
      context: makeContext(undefined, { "web:child": "queued" }),
    },
    {
      label: "waiting status",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer", status: "waiting" }),
      context: makeContext(),
    },
    {
      label: "post-turn runtime activity",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer" }),
      context: makeContext(new Map([
        ["child", { activeStreams: 1, lastActivityAt: Date.now() }],
      ])),
    },
  ])("treats $label as delegated work still in progress", ({ child, context }) => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });

    expect(buildSessionDelegatedActivityIndex([parent, child], context).get("parent")).toEqual({
      activeSessions: 1,
      employees: ["developer"],
    });
  });

  it("does not keep a parent active for idle or errored descendants", () => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });
    const idle = makeSession({ id: "idle", parentSessionId: "parent", employee: "writer" });
    const errored = makeSession({ id: "errored", parentSessionId: "parent", employee: "researcher", status: "error" });
    const context = makeContext();
    const index = buildSessionDelegatedActivityIndex([parent, idle, errored], context);

    expect(index.has("parent")).toBe(false);
    expect(serializeSession(parent, context, index).delegatedActivity).toBeNull();
  });
});
