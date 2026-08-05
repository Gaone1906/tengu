import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (must be declared before importing the module under test) ──────────

// engineAvailable is the guard under test — fully controllable per case.
const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
}));

// Registry side effects — no real DB.
const getSessionMock = vi.fn();
const updateSessionForAttemptMock = vi.fn((_id: string, _token: string, updates: Partial<Session>) => makeSession(updates));
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
}));

const recordClaudeRateLimitMock = vi.fn();
vi.mock("../../shared/usageAwareness.js", () => ({
  recordClaudeRateLimit: (...a: unknown[]) => recordClaudeRateLimitMock(...a),
}));

vi.mock("../../shared/effort.js", () => ({
  resolveEffort: vi.fn(() => "medium"),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// rateLimit math: zero delay; deadline already in the past so the wait-and-retry
// loop (Branch B) exits immediately without sleeping or calling engine.run.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine === "codex" ? "Codex" : "Claude",
}));

import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs } from "../../shared/rateLimit.js";
import type { Session, EngineResult } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: "claude-thread-1",
    source: "web",
    sourceRef: "web:test",
    connector: null,
    sessionKey: "k",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: "opus",
    title: null,
    parentSessionId: null,
    status: "running",
    attemptToken: "attempt-1",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  } as Session;
}

function makeOpts(fallbackRun: ReturnType<typeof vi.fn>): RateLimitHandlerOpts {
  const session = makeSession();
  const fallbackEngine = { run: fallbackRun } as unknown as RateLimitHandlerOpts["engine"];
  const claudeEngine = { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"];
  return {
    session,
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      sessions: { rateLimitStrategy: "fallback", fallbackEngine: "codex" },
      engines: { codex: { bin: "codex", model: "gpt-5.3-codex" } },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([["codex", fallbackEngine]]),
    engine: claudeEngine,
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

describe("handleRateLimit — Codex fallback guard (#40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getSession is consulted inside both branches; return the live session.
    getSessionMock.mockImplementation(() => makeSession());
  });

  it("falls through to wait-and-retry when the fallback engine is NOT installed", async () => {
    engineAvailableMock.mockReturnValue(false);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun));

    // Branch A skipped → no Codex spawn.
    expect(fallbackRun).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("fallback");
    // With a past deadline, Branch B exits straight to timeout.
    expect(outcome.kind).toBe("timeout");
  });

  it("uses the Codex fallback when the fallback engine IS installed", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun));

    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") {
      expect(outcome.result.result).toBe("from-codex");
    }
  });
});

describe("handleRateLimit — wait cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a long wait when the session leaves waiting status", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 10_000, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);

    let status: Session["status"] = "waiting";
    getSessionMock.mockImplementation(() => makeSession({ status }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {
        onWaitingStart: () => {
          setTimeout(() => { status = "idle"; }, 1000);
        },
      },
    } satisfies RateLimitHandlerOpts;

    const outcomePromise = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("cancelled");
    expect(retryEngine.run).not.toHaveBeenCalled();
  });

  it("forwards an explicit platform context refresh to the resumed retry", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const refresh = "## Jinn platform context refresh\n- Active model: opus";
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      platformContextRefresh: refresh,
      hooks: {},
    } as RateLimitHandlerOpts & { platformContextRefresh: string };

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).toBe("resumed");
    expect(retryEngine.run).toHaveBeenCalledWith(expect.objectContaining({ platformContextRefresh: refresh }));
  });

  it("retries a historical Talk session through the generic web runtime", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);
    const historical = makeSession({
      source: "talk",
      sourceRef: "talk:historical-rate-limit",
      status: "waiting",
    });
    getSessionMock.mockImplementation(() => historical);
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      session: historical,
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {},
    } satisfies RateLimitHandlerOpts;

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).toBe("resumed");
    expect(retryEngine.run).toHaveBeenCalledWith(expect.objectContaining({ source: "web" }));
    expect(historical.source).toBe("talk");
  });

  it("labels a Codex limit as Codex without contaminating Claude usage awareness", async () => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() - 1);
    const codexSession = makeSession({
      engine: "codex",
      engineSessionId: "codex-thread-1",
      model: "gpt-5.6-sol",
    });
    getSessionMock.mockImplementation(() => codexSession);

    const outcome = await handleRateLimit({
      ...makeOpts(vi.fn()),
      session: codexSession,
      engineConfig: { bin: "codex", model: "gpt-5.6-sol" },
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { codex: { bin: "codex", model: "gpt-5.6-sol" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"],
      originalResult: { result: "", sessionId: "codex-thread-1" } as EngineResult,
      hooks: {},
    });

    expect(outcome.kind).toBe("timeout");
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith(
      codexSession.id,
      "attempt-1",
      expect.objectContaining({
        status: "waiting",
        lastError: "Codex usage limit — waiting for reset",
      }),
    );
    expect(recordClaudeRateLimitMock).not.toHaveBeenCalled();
  });
});
