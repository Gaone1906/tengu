import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callbackDeliveryMockState = vi.hoisted(() => {
  const state = {
    deliveries: new Map<string, any>(),
    nextId: 1,
  };
  const get = vi.fn((id: string) =>
    [...state.deliveries.values()].find((delivery) => delivery.id === id),
  );
  const claim = vi.fn((input: any) => {
    Object.assign(input, {
      targetSessionId: input.targetSessionId ?? input.parentSessionId,
      sourceKind: input.sourceKind ?? "session",
      sourceId: input.sourceId ?? input.childSessionId,
      sourceAttempt: input.sourceAttempt ?? input.attemptToken,
      sourceOutcome: input.sourceOutcome ?? input.terminalOutcome,
      sourceVersion: input.sourceVersion ?? input.terminalVersion,
      deliveryKind: input.deliveryKind ?? input.callbackKind,
    });
    Object.assign(input, {
      parentSessionId: input.targetSessionId,
      childSessionId: input.sourceId,
      attemptToken: input.sourceAttempt,
      terminalOutcome: input.sourceOutcome,
      terminalVersion: input.sourceVersion,
      callbackKind: input.deliveryKind,
    });
    const key = [
      input.targetSessionId,
      input.sourceKind,
      input.sourceId,
      input.sourceAttempt,
      input.sourceOutcome,
      input.sourceVersion,
      input.deliveryKind,
    ].join("|");
    const existing = state.deliveries.get(key);
    if (existing) return { delivery: existing, claimed: false };
    const delivery = {
      id: `callback-delivery-${state.nextId++}`,
      ...input,
      status: "pending",
      messageId: null,
      queueItemId: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date().toISOString(),
      acceptedAt: null,
    };
    state.deliveries.set(key, delivery);
    return { delivery, claimed: true };
  });
  const claimAttempt = vi.fn((id: string, now: number, leaseMs: number) => {
    const delivery = [...state.deliveries.values()].find((candidate) => candidate.id === id);
    if (!delivery || delivery.status !== "pending" || (delivery.nextAttemptAt !== null && delivery.nextAttemptAt > now)) {
      return undefined;
    }
    delivery.attemptCount++;
    delivery.lastAttemptAt = now;
    delivery.nextAttemptAt = now + leaseMs;
    delivery.lastError = null;
    return delivery;
  });
  const recordFailure = vi.fn((id: string, error: string, options: { now: number; nextAttemptAt: number; maxAttempts: number }) => {
    const delivery = [...state.deliveries.values()].find((candidate) => candidate.id === id);
    if (!delivery || delivery.status !== "pending") return delivery;
    delivery.lastError = error;
    if (delivery.attemptCount >= options.maxAttempts) {
      delivery.status = "dead_letter";
      delivery.nextAttemptAt = null;
      delivery.deadLetteredAt = options.now;
    } else {
      delivery.nextAttemptAt = options.nextAttemptAt;
    }
    return delivery;
  });
  const listPending = vi.fn(() =>
    [...state.deliveries.values()].filter((delivery) => delivery.status === "pending"),
  );
  return Object.assign(state, { get, claim, claimAttempt, recordFailure, listPending });
});

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
  isLegacyWorkflowRunSession: vi.fn((session: Session) => session.workflowProvenance?.kind === "run"),
  getSessionDelivery: callbackDeliveryMockState.get,
  getCallbackDelivery: callbackDeliveryMockState.get,
  listSessionsBySource: vi.fn(() => []),
  updateSession: vi.fn((id: string, updates: Partial<Session>) => ({ ...makeSession({ id }), ...updates })),
  claimDelegationCompletionNudge: vi.fn((id: string, workItemId: string) => makeSession({
    id,
    workItemId,
    transportMeta: { delegationCompletionContract: { workItemId, state: "nudged" } },
  })),
  markDelegationCompletionSurfaced: vi.fn((id: string, workItemId: string) => makeSession({
    id,
    workItemId,
    transportMeta: { delegationCompletionContract: { workItemId, state: "surfaced" } },
  })),
  releaseDelegationCompletionNudge: vi.fn(),
  clearDelegationCompletionGuard: vi.fn(),
  listDelegationCompletionNudgedSessions: vi.fn(() => []),
  claimSessionDelivery: callbackDeliveryMockState.claim,
  claimCallbackDelivery: callbackDeliveryMockState.claim,
  claimSessionDeliveryAttempt: callbackDeliveryMockState.claimAttempt,
  claimCallbackDeliveryAttempt: callbackDeliveryMockState.claimAttempt,
  recordSessionDeliveryFailure: callbackDeliveryMockState.recordFailure,
  recordCallbackDeliveryFailure: callbackDeliveryMockState.recordFailure,
  listPendingSessionDeliveries: callbackDeliveryMockState.listPending,
  listPendingCallbackDeliveries: callbackDeliveryMockState.listPending,
  ensureCallbackAttemptToken: vi.fn(() => "legacy-attempt-token"),
}));

vi.mock("../../work-items/store.js", () => ({
  getWorkItem: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777 } })),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { __resetCallbackRetrySweepForTest, notifyManagerVisibility, notifyParentSession, notifyRateLimitResumed, recoverOrphanedDelegationCompletionClaims, recoverPendingCallbackDeliveries } from "../callbacks.js";
import { claimCallbackDelivery, getSession, listSessionsBySource, listDelegationCompletionNudgedSessions, markDelegationCompletionSurfaced } from "../registry.js";
import { getWorkItem } from "../../work-items/store.js";
import { attach, __resetAttachmentsForTest } from "../../talk/attachments.js";
import type { Session } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-001",
    engine: "claude",
    engineSessionId: null,
    source: "api",
    sourceRef: "api:test",
    connector: null,
    sessionKey: "test-key",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "test-employee",
    model: "opus",
    title: null,
    parentSessionId: "parent-001",
    status: "idle",
    attemptOutcome: "succeeded",
    attemptToken: "attempt-001",
    attemptTerminalVersion: 1,
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  } as Session;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  callbackDeliveryMockState.deliveries.clear();
  callbackDeliveryMockState.nextId = 1;
  vi.mocked(claimCallbackDelivery).mockClear();
});

afterEach(() => {
  __resetCallbackRetrySweepForTest();
});

describe("notifyManagerVisibility", () => {
  it("posts one structured notification through the durable session-message route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    notifyManagerVisibility("manager-session", {
      manager: "team-lead",
      managerDisplay: "Team Lead",
      delegator: "org-root",
      delegatorDisplay: "Org Root",
      employee: "worker",
      employeeDisplay: "Worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility",
      title: "Inspect a bounded incident",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/manager-session/message");
    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("Org Root delegated directly to Worker");
    expect(body.message).toContain("Inspect a bounded incident");
    expect(body.message).toContain("wi_visibility");
    expect(body.displayMessage).toContain("Skip-level visibility");
    expect(body.meta).toEqual({
      kind: "manager-visibility",
      manager: "team-lead",
      delegator: "org-root",
      employee: "worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility",
    });

    globalThis.fetch = originalFetch;
  });

  it("uses one stable durable receipt when the same visibility input is replayed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const details = {
      manager: "team-lead",
      managerDisplay: "Team Lead",
      delegator: "org-root",
      delegatorDisplay: "Org Root",
      employee: "worker",
      employeeDisplay: "Worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility_replay",
      title: "Inspect one replayed incident",
    };

    for (let index = 0; index < 6; index++) {
      notifyManagerVisibility("manager-session", details);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(claimCallbackDelivery).toHaveBeenCalledTimes(6);
    expect(vi.mocked(claimCallbackDelivery).mock.calls[0][0]).toMatchObject({
      parentSessionId: "manager-session",
      childSessionId: "worker-child",
      attemptToken: "manager-visibility:wi_visibility_replay",
      terminalOutcome: "manager-visibility",
      terminalVersion: 1,
      callbackKind: "manager-visibility",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      callbackDeliveryId: "callback-delivery-1",
      meta: { kind: "manager-visibility", workItemId: "wi_visibility_replay" },
    });

    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession — no parent", () => {
  it("does nothing if child has no parentSessionId", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    const child = makeSession({ parentSessionId: null });
    notifyParentSession(child, { result: "done" });

    await new Promise((r) => setTimeout(r, 150));
    expect(spy).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});

describe("delegation completion startup recovery", () => {
  it("surfaces an orphaned nudged claim to its parent before marking it surfaced", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const child = makeSession({
      workItemId: "wi-orphan",
      transportMeta: {
        delegationCompletionTracked: true,
        delegationCompletionContract: { workItemId: "wi-orphan", state: "nudged" },
      },
    });
    vi.mocked(listDelegationCompletionNudgedSessions).mockReturnValue([child]);
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", parentSessionId: null }));

    await expect(recoverOrphanedDelegationCompletionClaims()).resolves.toBe(1);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).message).toContain("restart");
    expect(markDelegationCompletionSurfaced).toHaveBeenCalledWith("child-001", "wi-orphan");
    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callbackDeliveryMockState.deliveries.clear();
    callbackDeliveryMockState.nextId = 1;
    vi.mocked(claimCallbackDelivery).mockClear();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
    vi.mocked(getWorkItem).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("never uses a legacy Workflow run projection as a callback destination", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({
        id: "parent-001",
        parentSessionId: null,
        engine: "workflow",
        workflowProvenance: {
          kind: "run",
          workflowId: "wf-release",
          workflowName: "release-check",
          runId: "run-1",
          triggerSource: "manual",
        },
      }),
    );

    notifyParentSession(makeSession(), { result: "phase complete" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \n\t "],
    ["zero-width space", "\u200B"],
    ["zero-width non-joiner", "\u200C"],
    ["zero-width joiner", "\u200D"],
    ["word joiner", "\u2060"],
    ["zero-width no-break space", "\uFEFF"],
    ["mixed invisible content", " \u200B\u200C\u200D\u2060\uFEFF\n"],
  ])("does not create a child-reply callback for a %s assistant result", async (_label, result) => {
    notifyParentSession(makeSession(), { result });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(claimCallbackDelivery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes a qualifying progress-only child back to itself and suppresses the parent callback", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });

    notifyParentSession(child, {
      result: "Progress update: the implementation is still in progress. I will continue with the test run.",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/child-001/message");
    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("Continue the existing task now");
  });

  it("enforces the completion contract even when ordinary parent replies are suppressed", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });

    notifyParentSession(
      child,
      { result: "Progress update: I will continue with the remaining implementation." },
      { alwaysNotify: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/child-001/message");
  });

  it("retries a completion-contract nudge under one durable receipt after response loss", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });
    fetchSpy.mockRejectedValueOnce(new Error("accepted response lost")).mockResolvedValue({ ok: true });

    notifyParentSession(child, {
      result: "Progress update: I will continue with the remaining implementation.",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    notifyParentSession(child, {
      result: "Progress update: I will continue with the remaining implementation.",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    const nudgeClaims = vi.mocked(claimCallbackDelivery).mock.calls
      .map(([input]) => input)
      .filter((input) => input.callbackKind === "delegation-completion-nudge");
    expect(nudgeClaims).toHaveLength(2);
    expect(nudgeClaims[0]).toMatchObject({
      parentSessionId: "child-001",
      childSessionId: "child-001",
      attemptToken: "attempt-001",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
    });
    const childPosts = fetchSpy.mock.calls
      .filter(([url]) => url === "http://127.0.0.1:7777/api/sessions/child-001/message")
      .map(([, opts]) => JSON.parse(opts.body));
    expect(childPosts).toHaveLength(1);
    expect(new Set(childPosts.map((body) => body.callbackDeliveryId))).toEqual(
      new Set([expect.any(String)]),
    );
  });

  it("sends a full LLM message plus a clean display banner on success", async () => {
    const child = makeSession({
      workItemId: "wi_123",
      transportMeta: { delegationEmployeeDisplay: "Test Employee" },
    });

    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");

    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    // LLM-facing message: full context + MCP-native pointers for following up.
    expect(body.message).toContain("replied in child session child-001");
    expect(body.message).toContain('read_session { sessionId: "child-001", last: N }');
    expect(body.message).toContain('send_to_session { sessionId: "child-001"');
    expect(body.message).not.toContain("/api/sessions");
    expect(body.message).toContain("Some result");
    // Human-facing banner: clean, no API noise
    expect(body.displayMessage).toContain("test-employee replied");
    expect(body.displayMessage).toContain("Some result");
    expect(body.displayMessage).not.toContain("GET /api/sessions");
    expect(body.meta).toMatchObject({
      kind: "child-reply",
      employee: "test-employee",
      employeeDisplay: "Test Employee",
      childSessionId: "child-001",
      fullMessage: "Some result",
    });
    expect(body.block).toMatchObject({
      op: "patch",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        status: "done",
      },
    });
    expect(typeof body.block.block.payload.repliedAt).toBe("number");
  });

  it("caps the LLM preview at 500 chars and keeps the display preview shorter", async () => {
    const longResult = "x".repeat(600);
    const child = makeSession();

    notifyParentSession(child, { result: longResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // LLM preview: 500 chars + ellipsis, never the 501st
    expect(body.message).toContain("x".repeat(500) + "…");
    expect(body.message).not.toContain("x".repeat(501));
    // Display banner is a tighter, truncated version
    expect(body.displayMessage.length).toBeLessThan(body.message.length);
    expect(body.displayMessage).toContain("…");
  });

  it("caps durable full callback messages at 16k without changing the 220-char display preview", async () => {
    const longResult = "x".repeat(17_000);
    const child = makeSession();

    notifyParentSession(child, { result: longResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.meta.fullMessage).toBe("x".repeat(16_000));
    expect(body.meta.fullMessage).toHaveLength(16_000);
    expect(body.displayMessage).toBe(`📩 test-employee replied\n${"x".repeat(220)}…`);
  });

  it("includes full preview for short results", async () => {
    const shortResult = "Task done successfully";
    const child = makeSession();

    notifyParentSession(child, { result: shortResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(shortResult);
    expect(body.message).not.toContain("...");
  });

  it("error notifications contain the error message", async () => {
    const child = makeSession({ workItemId: "wi_123" });

    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("Something broke");
    expect(body.message).toContain("⚠️");
    expect(body.displayMessage).toBe("⚠️ test-employee couldn't finish\nSomething broke");
    expect(body.meta).toMatchObject({ kind: "child-error", childSessionId: "child-001" });
    expect(body.block).toMatchObject({
      op: "patch",
      block: { id: "dg-wi_123", type: "delegation", status: "error" },
    });
  });

  it('sends with "notification" role', async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.role).toBe("notification");
  });

  it("claims one durable identity for six duplicate completion callbacks before posting", async () => {
    const child = makeSession();

    for (let index = 0; index < 6; index++) {
      notifyParentSession(child, { result: "same terminal result" });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(claimCallbackDelivery).toHaveBeenCalledTimes(6);
    expect(vi.mocked(claimCallbackDelivery).mock.calls[0][0]).toMatchObject({
      parentSessionId: "parent-001",
      childSessionId: "child-001",
      attemptToken: "attempt-001",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new Set(fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body).callbackDeliveryId)))
      .toEqual(new Set(["callback-delivery-1"]));
    expect(vi.mocked(claimCallbackDelivery).mock.invocationCallOrder[0])
      .toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
  });

  it("does not post an already accepted callback receipt", async () => {
    const child = makeSession();
    const claimed = vi.mocked(claimCallbackDelivery).getMockImplementation()!({
      parentSessionId: "parent-001",
      childSessionId: "child-001",
      attemptToken: "attempt-001",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: { message: "stored", displayMessage: "stored" },
    } as never);
    claimed.delivery.status = "accepted";

    notifyParentSession(child, { result: "same terminal result" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors persisted backoff when the callback is re-emitted after response loss", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ ok: true });
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    notifyParentSession(child, { result: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect([...callbackDeliveryMockState.deliveries.values()][0]).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "response lost",
    });
  });

  it("uses a new receipt for a resumed attempt generation", async () => {
    notifyParentSession(makeSession(), { result: "first completion" });
    notifyParentSession(makeSession({ attemptToken: "attempt-002" }), { result: "resumed completion" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Set(fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body).callbackDeliveryId)).size).toBe(2);
  });
});

describe("callback outbox startup recovery", () => {
  beforeEach(() => {
    callbackDeliveryMockState.deliveries.clear();
    callbackDeliveryMockState.nextId = 1;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("reposts a claimed-but-unaccepted delivery after restart", async () => {
    vi.mocked(claimCallbackDelivery).getMockImplementation()!({
      parentSessionId: "parent-001",
      childSessionId: "child-001",
      attemptToken: "attempt-001",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
      callbackKind: "parent-completion",
      payload: { message: "stored engine prompt", displayMessage: "stored display" },
    } as never);

    await expect(recoverPendingCallbackDeliveries()).resolves.toBe(1);

    const fetchSpy = vi.mocked(globalThis.fetch);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({
      callbackDeliveryId: "callback-delivery-1",
    });
  });
});

describe("notifyParentSession — talk parent (voice-friendly message)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Parent session has source: "talk"
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "talk" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("uses the child title as the thread label when title is set", async () => {
    const child = makeSession({ title: "Research task" });
    notifyParentSession(child, { result: "Analysis complete" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"Research task"');
    expect(body.message).toContain("Analysis complete");
    expect(body.message).not.toContain("child-001");
    expect(body.message).not.toContain("GET /api/sessions");
    expect(body.message).toContain("Narrate the outcome aloud");
    expect(body.message).toContain("/api/talk/delegate");
  });

  it("falls back to employee name when title is null", async () => {
    const child = makeSession({ title: null, employee: "research-bot" });
    notifyParentSession(child, { result: "Done" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"research-bot"');
    expect(body.message).not.toContain("child-001");
    expect(body.message).not.toContain("GET /api/sessions");
    expect(body.message).toContain("Narrate the outcome aloud");
  });

  it('falls back to "a thread" when title and employee are both absent', async () => {
    const child = makeSession({ title: null, employee: null });
    notifyParentSession(child, { result: "Done" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"a thread"');
    expect(body.message).not.toContain("child-001");
    expect(body.message).not.toContain("GET /api/sessions");
  });

  it("talk displayMessage uses label and clean preview, no API noise", async () => {
    const child = makeSession({ title: "My task" });
    notifyParentSession(child, { result: "Result here" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.displayMessage).toContain('"My task"');
    expect(body.displayMessage).toContain("Result here");
    expect(body.displayMessage).not.toContain("GET /api/sessions");
  });

  it("message matches the exact talk template shape", async () => {
    const child = makeSession({ title: "Deploy fix" });
    const preview = "Deployed successfully to production.";
    notifyParentSession(child, { result: preview });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const expected =
      `📩 Thread "Deploy fix" reported back.\n\n` +
      `Reply preview:\n${preview}\n\n` +
      `Narrate the outcome aloud in 1–2 short sentences — no IDs, no URLs, no markdown. ` +
      `If there is a link or detail worth seeing, push a card. ` +
      `To follow up, delegate to this thread via /api/talk/delegate (its id is in your roster).`;
    expect(body.message).toBe(expected);
  });

  it("non-talk parent receives MCP-native read and follow-up guidance", async () => {
    // Override to a non-talk parent
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ title: "My task", employee: "test-employee" });
    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const childId = "child-001";
    const employeeName = "test-employee";
    const raw = "Some result";
    const expectedMessage =
      `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
      `Reply preview:\n${raw}\n\n` +
      `To read the full reply: read_session { sessionId: "${childId}", last: N } · ` +
      `to follow up: send_to_session { sessionId: "${childId}", message: "<message>" }`;
    expect(body.message).toBe(expectedMessage);
    expect(body.message).not.toContain("/api/sessions");
  });

  // --- error path tests for talk parents ---

  it("talk parent + error → label-based error message, no UUID", async () => {
    const child = makeSession({ title: "Research task" });
    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"Research task"');
    expect(body.message).toContain("Something broke");
    expect(body.message).toContain("⚠️");
    expect(body.message).not.toContain("child-001");
    expect(body.message).not.toContain("/api/sessions");
  });

  it("talk parent error falls back to employee name when title is null", async () => {
    const child = makeSession({ title: null, employee: "research-bot" });
    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"research-bot"');
    expect(body.message).not.toContain("child-001");
  });

  it('talk parent error falls back to "a thread" when title and employee are both absent', async () => {
    const child = makeSession({ title: null, employee: null });
    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"a thread"');
    expect(body.message).not.toContain("child-001");
  });

  it("talk parent error message matches exact template shape", async () => {
    const child = makeSession({ title: "Deploy fix" });
    const errorText = "Rate limit exceeded";
    notifyParentSession(child, { error: errorText });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const expected =
      `⚠️ Thread "Deploy fix" hit an error.\n\n` +
      `${errorText}\n\n` +
      `Tell the operator plainly in one short sentence — no IDs, no URLs — and offer a next step.`;
    expect(body.message).toBe(expected);
  });

  it("talk parent error displayMessage: label + clean preview, no API noise", async () => {
    const child = makeSession({ title: "Deploy fix" });
    const errorText = "Rate limit exceeded";
    notifyParentSession(child, { error: errorText });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.displayMessage).toBe(`⚠️ Thread "Deploy fix" hit an error\n${errorText}`);
    expect(body.displayMessage).not.toContain("GET /api/sessions");
  });

  it("non-talk parent error keeps byte-identical message format (regression)", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ employee: "test-employee" });
    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const expectedMessage = `⚠️ Employee "test-employee" (child session child-001) hit an error and could not finish: Something broke`;
    expect(body.message).toBe(expectedMessage);
    expect(body.displayMessage).toBe(`⚠️ test-employee couldn't finish\nSomething broke`);
  });
});

describe("notifyRateLimitResumed — talk parent (no UUID leak)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("talk parent + title → label in message, child id absent", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "talk" }),
    );
    const child = makeSession({ title: "Research task" });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"Research task"');
    expect(body.message).not.toContain("child-001");
  });

  it("talk parent + title null → falls back to employee name, no child id", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "talk" }),
    );
    const child = makeSession({ title: null, employee: "research-bot" });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"research-bot"');
    expect(body.message).not.toContain("child-001");
  });

  it('talk parent + no title/employee → "a thread", no child id', async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "talk" }),
    );
    const child = makeSession({ title: null, employee: null });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('"a thread"');
    expect(body.message).not.toContain("child-001");
  });

  it("talk parent → exact message shape (Thread label, no parenthetical)", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "talk" }),
    );
    const child = makeSession({ title: "Deploy fix" });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe(
      `🔄 Thread "Deploy fix" has resumed after rate limit cleared.`,
    );
  });

  it("non-talk parent keeps byte-identical format (regression)", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ employee: "test-employee" });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe(
      `🔄 Employee "test-employee" (session child-001) has resumed after rate limit cleared.`,
    );
  });
});

describe("notifyParentSession — attached talk-session wakes", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetAttachmentsForTest();
    callbackDeliveryMockState.deliveries.clear();
    callbackDeliveryMockState.nextId = 1;
    vi.mocked(claimCallbackDelivery).mockClear();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.mocked(listSessionsBySource).mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetAttachmentsForTest();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  const talkSession = makeSession({
    id: "talk-1",
    parentSessionId: null,
    status: "idle",
    source: "talk",
  });

  it("wakes an attaching talk session when an attached session completes (parent elsewhere)", async () => {
    // Seed an attachment in the (real) attachments module.
    attach("talk-1", "child-001", "observe", {
      getSession: () => talkSession,
      updateSessionMeta: () => {},
    });
    // Parent ('elsewhere') resolves to nothing; only talk-1 is a live talk session.
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "talk-1" ? talkSession : undefined,
    );

    const child = makeSession({ id: "child-001", parentSessionId: "elsewhere", title: "Audit job" });
    notifyParentSession(child, { result: "All clear" });
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one fetch — the attachment wake to talk-1 (parent 'elsewhere' had no session).
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/talk-1/message");
    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    expect(body.message).toContain('📩 Thread "Audit job" reported back');
    expect(body.message).toContain("All clear");
    expect(body.message).not.toContain("child-001");
  });

  it("routes six duplicate attached-talk completions through one durable receipt", async () => {
    attach("talk-1", "child-001", "observe", {
      getSession: () => talkSession,
      updateSessionMeta: () => {},
    });
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "talk-1" ? talkSession : undefined,
    );
    const child = makeSession({ id: "child-001", parentSessionId: "elsewhere", title: "Audit job" });

    for (let index = 0; index < 6; index++) notifyParentSession(child, { result: "All clear" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const talkClaims = vi.mocked(claimCallbackDelivery).mock.calls
      .map(([input]) => input)
      .filter((input) => input.callbackKind === "talk-attachment");
    expect(talkClaims).toHaveLength(6);
    expect(talkClaims[0]).toMatchObject({
      parentSessionId: "talk-1",
      childSessionId: "child-001",
      attemptToken: "attempt-001",
      terminalOutcome: "succeeded",
      terminalVersion: 1,
    });
    const bodies = fetchSpy.mock.calls.map(([, opts]) => JSON.parse(opts.body));
    expect(bodies).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.callbackDeliveryId)).size).toBe(1);
    expect(bodies[0].callbackDeliveryId).toEqual(expect.any(String));
  });

  it("claims every attached Talk target before isolated fan-out delivery", async () => {
    const talks = ["talk-1", "talk-2", "talk-3"].map((id) => makeSession({
      id,
      parentSessionId: null,
      status: "idle",
      source: "talk",
    }));
    for (const talk of talks) {
      attach(talk.id, "child-001", "observe", {
        getSession: () => talk,
        updateSessionMeta: () => {},
      });
    }
    vi.mocked(getSession).mockImplementation((id: string) => talks.find((talk) => talk.id === id));
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/talk-1/") || url.includes("/talk-2/")) throw new Error(`isolated failure ${url}`);
      return { ok: true };
    });

    notifyParentSession(
      makeSession({ id: "child-001", parentSessionId: "elsewhere", title: "Fan-out work" }),
      { result: "All targets should receive receipts" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const claims = vi.mocked(claimCallbackDelivery).mock.calls
      .map(([input]) => input)
      .filter((input) => input.callbackKind === "talk-attachment");
    expect(claims.map((claim) => claim.parentSessionId).sort()).toEqual(["talk-1", "talk-2", "talk-3"]);
    expect(vi.mocked(claimCallbackDelivery).mock.invocationCallOrder[2])
      .toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/talk-1/message"),
      expect.stringContaining("/talk-2/message"),
      expect.stringContaining("/talk-3/message"),
    ]);
  });

  it("does NOT double-wake an owned child (parent IS the talk session)", async () => {
    attach("talk-1", "child-001", "observe", {
      getSession: () => talkSession,
      updateSessionMeta: () => {},
    });
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "talk-1" ? talkSession : undefined,
    );

    // parentSessionId === the talk session → the parent-callback path notifies it.
    const child = makeSession({ id: "child-001", parentSessionId: "talk-1", title: "Owned" });
    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    // Only ONE fetch (the parent callback). The attachment path skips talk-1.
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/talk-1/message");
  });

  it("restart-survival: finds the attachment via global hydration of persisted meta", async () => {
    // Simulate a fresh process: nothing attached in-memory, but a talk session's
    // persisted meta carries the attachment. The global scan must hydrate it.
    const talkWithMeta = makeSession({
      id: "talk-1",
      parentSessionId: null,
      status: "idle",
      source: "talk",
      transportMeta: {
        talkAttachments: [{ targetId: "child-001", mode: "observe", since: 1 }],
      } as unknown as Session["transportMeta"],
    });
    vi.mocked(listSessionsBySource).mockReturnValue([talkWithMeta]);
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "talk-1" ? talkWithMeta : undefined,
    );

    const child = makeSession({ id: "child-001", parentSessionId: "elsewhere", title: "Audit job" });
    notifyParentSession(child, { result: "All clear" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/talk-1/message");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain('📩 Thread "Audit job" reported back');
  });
});

describe("notifyParentSession — alwaysNotify suppression", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("skips notification when alwaysNotify is false (success)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips notification when alwaysNotify is false (error)", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends notification when alwaysNotify is true", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sends notification when options is undefined (backward compat)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
