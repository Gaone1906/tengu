import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
  listSessionsBySource: vi.fn(() => []),
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

import { notifyManagerVisibility, notifyParentSession, notifyRateLimitResumed } from "../callbacks.js";
import { getSession, listSessionsBySource } from "../registry.js";
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

describe("notifyParentSession", () => {
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

  it("does not dispatch an engine callback into a synthetic workflow-run parent", async () => {
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
    // LLM-facing message: full context + API pointers for following up
    expect(body.message).toContain("replied in child session child-001");
    expect(body.message).toContain("GET /api/sessions/child-001?last=N");
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

  it("non-talk parent keeps byte-identical message format (regression)", async () => {
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
      `To read the full reply: GET /api/sessions/${childId}?last=N · ` +
      `to follow up: POST /api/sessions/${childId}/message`;
    expect(body.message).toBe(expectedMessage);
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
