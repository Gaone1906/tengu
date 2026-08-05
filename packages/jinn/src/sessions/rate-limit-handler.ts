/**
 * Shared rate-limit / fallback / wait-and-retry handler.
 *
 * Both the connector path (sessions/manager.ts → runSession) and the web path
 * (gateway/api.ts → runWebSession) need to:
 *   1. Detect an engine usage-limit response.
 *   2. For Claude only, optionally fall back to a different engine (default: Codex).
 *   3. Otherwise enter a "waiting" loop: sleep until the reset window, retry on the same engine,
 *      keep the session's lastActivity heartbeat fresh, and loop again if still limited.
 *   4. Bail out when the deadline passes without recovery.
 *
 * The state machine, engine invocations, retry math, heartbeat cadence, deadline
 * computation, and `transportMeta.engineOverride` bookkeeping are identical between
 * the two call sites — only the transport-side UI/notification details differ.
 * This module owns the common bits; per-transport behavior is injected via hooks.
 *
 * Behavior is intentionally preserved verbatim from the original inlined
 * implementations — do not "improve" the wait math, the per-step state writes,
 * or the order of side effects without auditing both call sites.
 */

import type { Employee, Engine, EngineResult, JinnConfig, ResolvedMcpConfig, Session, StreamDelta } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel, engineAvailable, type EngineName } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, rateLimitEngineLabel } from "../shared/rateLimit.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { getSession, getMessages, updateSessionForAttempt } from "./registry.js";
import { runtimeSessionSource } from "./context.js";

const WAIT_CANCEL_POLL_MS = 5000;

/** What detectRateLimit returned for the original turn. */
export interface RateLimitInfo {
  /** Unix timestamp (seconds) when the limit is expected to reset, if known. */
  resetsAt?: number;
}

/** Outcome categories returned by handleRateLimit so callers can drive transport-side completion. */
export type RateLimitOutcome =
  | { kind: "fallback"; result: EngineResult }
  | { kind: "resumed"; result: EngineResult }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface RateLimitHandlerHooks {
  /**
   * Called once, immediately after detection, before any state changes. Used to
   * Record engine-specific usage awareness. The default implementation records
   * Claude limits only; other engines currently have no global awareness store.
   *
   * The default path calls `recordClaudeRateLimit(rateLimit.resetsAt)` only
   * when the limited session actually uses Claude. Override only if you need
   * additional engine-specific bookkeeping.
   */
  onDetected?: (rateLimit: RateLimitInfo) => void;

  /**
   * Called when entering the Codex fallback branch (before the fallback engine runs).
   * Use this to: notify the user we're switching engines (UI message, Discord, etc.).
   */
  onFallbackStart?: (info: { resumeAt: Date | null; until: Date }) => void | Promise<void>;

  /**
   * Optional stream callback for the fallback engine's run (web emits deltas here).
   */
  onFallbackStream?: (delta: StreamDelta) => void;

  /**
   * Called after the fallback engine finishes, before the handler returns.
   * The persistence of the assistant message and any "completed" event emission
   * is done here (caller-specific).
   */
  onFallbackComplete?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called once when entering the wait-and-retry loop. Use this to: switch UI
   * to "waiting", post a "I'll continue automatically" message, notify Discord, etc.
   */
  onWaitingStart?: (info: { resumeAt: Date | null; rateLimit: RateLimitInfo }) => void | Promise<void>;

  /**
   * Called each retry iteration BEFORE the retry engine.run — switch UI back
   * to "thinking" state.
   */
  onRetryAttempt?: (info: { attempt: number }) => void | Promise<void>;

  /**
   * Called each iteration when the retry was STILL rate-limited — switch UI
   * back to "waiting" state, log, etc.
   */
  onStillLimited?: (info: { attempt: number; resumeAt: Date | null }) => void | Promise<void>;

  /**
   * Optional stream callback for the retry engine's run (web emits deltas).
   */
  onRetryStream?: (delta: StreamDelta) => void;

  /**
   * Called when a retry succeeds (or fails with a non-rate-limit error).
   * Persist the assistant message + emit completion event here.
   */
  onRetrySuccess?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called when the deadline expires before the limit clears. Notify the user,
   * mark session errored, emit completion event with the timeout error.
   */
  onTimeout?: () => void | Promise<void>;

  /**
   * Called when the session was deleted/cancelled while waiting. The handler
   * has already returned — this is just a hook to log or emit cleanup.
   */
  onCancelled?: () => void | Promise<void>;
}

export interface RateLimitHandlerOpts {
  session: Session;
  /** Generation token minted when this turn entered running state. */
  attemptToken: string;
  /** The original prompt that hit the rate limit — used unchanged for retries. */
  prompt: string;
  systemPrompt?: string;
  /** Explicit refresh for retries on the same resumed native transcript. Never
   *  forwarded to a different fallback engine. */
  platformContextRefresh?: string;
  /** Engine config used by the original turn (bin + model + …). */
  engineConfig: { bin?: string; model?: string };
  effortLevel?: string;
  /** Optional employee-level CLI flag overrides (passed to retry engine.run calls). */
  cliFlags?: string[];
  /** Path to MCP config JSON file, if applicable to the original turn. */
  mcpConfigPath?: string;
  /** In-memory resolved MCP server set from the original turn (preserved on retry
   *  and fallback so the payload is not silently dropped). */
  resolvedMcp?: ResolvedMcpConfig;
  /** Optional attachment file paths from the original turn (preserved on retry). */
  attachments?: string[];
  /** The current jinn config (used to look up rateLimitStrategy + fallbackEngine + fallback engineConfig). */
  config: JinnConfig;
  /** Map of available engines (for fallback lookup). */
  engines: Map<string, Engine>;
  /** Optional employee record (for fallback effort + cliFlags). */
  employee?: Employee;
  /** The engine used for retries — the engine that returned the rate-limited result. */
  engine: Engine;
  /** Result of detectRateLimit() on the original turn. */
  rateLimit: RateLimitInfo;
  /** The original failed result — used for its sessionId field when updating engineSessionId. */
  originalResult: EngineResult;
  hooks: RateLimitHandlerHooks;
}

/**
 * Drive the rate-limit recovery state machine. Returns once the situation
 * resolves (success, fallback completion, timeout, or cancellation).
 *
 * The caller has ALREADY detected the rate limit and confirmed it should be
 * handled (i.e. not a dead session, not an interrupted turn).
 */
export async function handleRateLimit(opts: RateLimitHandlerOpts): Promise<RateLimitOutcome> {
  const {
    session, attemptToken, prompt, systemPrompt, platformContextRefresh, engineConfig, effortLevel, cliFlags,
    mcpConfigPath, resolvedMcp, attachments, config, engines, employee, engine,
    rateLimit, originalResult, hooks,
  } = opts;

  const engineLabel = rateLimitEngineLabel(session.engine);

  if (hooks.onDetected) {
    hooks.onDetected(rateLimit);
  } else if (session.engine === "claude") {
    recordClaudeRateLimit(rateLimit.resetsAt);
  }

  const strategy = config.sessions?.rateLimitStrategy ?? "wait";

  // ── Branch A: Codex fallback ───────────────────────────────────────────────
  if (session.engine === "claude" && strategy === "fallback") {
    const fallbackName = config.sessions?.fallbackEngine ?? "codex";
    const fallbackEngine = engines.get(fallbackName);
    if (fallbackEngine && engineAvailable(config, fallbackName as EngineName)) {
      const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
      const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
      const syncSince = new Date().toISOString();

      await hooks.onFallbackStart?.({ resumeAt: resumeAt ?? null, until });

      const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      const engineSessionsRaw = nextMeta.engineSessions;
      const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
        ? { ...(engineSessionsRaw as Record<string, unknown>) }
        : {};
      if (session.engineSessionId) {
        engineSessions.claude = session.engineSessionId;
      }
      nextMeta.engineSessions = engineSessions;
      nextMeta.engineOverride = {
        originalEngine: "claude",
        originalEngineSessionId: session.engineSessionId,
        until: until.toISOString(),
        syncSince,
      };

      const fallbackStarted = updateSessionForAttempt(session.id, attemptToken, {
        engine: fallbackName,
        // Keep Claude engine_session_id intact for later restore; Codex will return its own thread id.
        transportMeta: nextMeta as any,
        status: "running",
        lastActivity: new Date().toISOString(),
        lastError: resumeAt
          ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
          : "Claude usage limit — using GPT temporarily",
      });
      if (!fallbackStarted) {
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      const fallbackConfig = config.engines.codex;
      const fallbackEffort = resolveEffort(
        fallbackConfig,
        session,
        employee,
        effortLevelsForModel(config, fallbackName, fallbackConfig.model),
      );
      const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
      const history = getMessages(session.id)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
      const historyText = history.slice(-12).join("\n\n");
      const fallbackPrompt = codexResume
        ? prompt
        : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;

      const fallbackResult = await fallbackEngine.run({
        prompt: fallbackPrompt,
        resumeSessionId: codexResume,
        systemPrompt,
        cwd: JINN_HOME,
        bin: fallbackConfig.bin,
        model: session.model ?? fallbackConfig.model,
        effortLevel: fallbackEffort,
        cliFlags: employee?.cliFlags ?? cliFlags,
        // The fallback engine is codex (MCP-capable, Tier 1); the resolved server
        // set is engine-agnostic (same employee) so it is valid to carry over.
        // Claude's `mcpConfigPath` temp file is intentionally NOT passed here.
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        ...(hooks.onFallbackStream ? { onStream: hooks.onFallbackStream } : {}),
      });

      // Persist Codex thread id so future fallbacks can resume it.
      const nextEngineSessions = { ...engineSessions };
      if (fallbackResult.sessionId) {
        nextEngineSessions.codex = fallbackResult.sessionId;
      }
      const liveMeta = (getSession(session.id)?.transportMeta || nextMeta) as Record<string, unknown>;
      const metaAfter = { ...liveMeta } as Record<string, unknown>;
      metaAfter.engineSessions = nextEngineSessions;
      updateSessionForAttempt(session.id, attemptToken, { transportMeta: metaAfter as any });

      await hooks.onFallbackComplete?.(fallbackResult);

      return { kind: "fallback", result: fallbackResult };
    }
    // No fallback engine available — fall through to wait-and-retry.
  }

  // ── Branch B: wait-and-retry on the original engine ────────────────────────
  const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );

  logger.info(
    `Session ${session.id} hit ${engineLabel} usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
  );

  const enteredWaiting = updateSessionForAttempt(session.id, attemptToken, {
    ...(originalResult.sessionId?.trim() ? { engineSessionId: originalResult.sessionId } : {}),
    status: "waiting",
    lastActivity: new Date().toISOString(),
    lastError: resumeAt
      ? `${engineLabel} usage limit — resumes ${resumeAt.toISOString()}`
      : `${engineLabel} usage limit — waiting for reset`,
  });
  if (!enteredWaiting) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit });

  // Keep lastActivity fresh while waiting (UI / status endpoints).
  const heartbeat = setInterval(() => {
    if (getSession(session.id)?.status === "waiting") {
      updateSessionForAttempt(session.id, attemptToken, { status: "waiting", lastActivity: new Date().toISOString() }, ["waiting"]);
    }
  }, 60_000);

  try {
    let attempt = 0;
    let nextDelayMs = delayMs;

    while (Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, nextDelayMs);
      if (!stillWaiting) {
        const currentSession = getSession(session.id);
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }
      attempt++;

      // Check if session was stopped while waiting. We set status:"waiting"
      // before entering this loop, so any other status (idle from a user
      // POST /stop, error from a crash, etc.) means the user/system pulled
      // us out of the waiting state and we should NOT retry. Previously this
      // only caught "error", so user-initiated stop ("idle") leaked through
      // and the retry fired against a session the user thought was stopped.
      const currentSession = getSession(session.id);
      if (!currentSession || currentSession.status !== "waiting") {
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      await hooks.onRetryAttempt?.({ attempt });
      logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);

      const retryStarted = updateSessionForAttempt(session.id, attemptToken, {
        status: "running",
        lastActivity: new Date().toISOString(),
      }, ["waiting"]);
      if (!retryStarted) {
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      const retryResult = await engine.run({
        prompt,
        resumeSessionId: currentSession.engineSessionId ?? undefined,
        systemPrompt,
        platformContextRefresh,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: currentSession.model ?? engineConfig.model,
        effortLevel,
        cliFlags,
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        source: runtimeSessionSource(session.source),
        ...(hooks.onRetryStream ? { onStream: hooks.onRetryStream } : {}),
      });

      const retryInterrupted = retryResult.error?.startsWith("Interrupted");
      const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

      if (retryRateLimit.limited) {
        if (session.engine === "claude") {
          recordClaudeRateLimit(retryRateLimit.resetsAt);
        }
        logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

        const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
        nextDelayMs = next.delayMs;

        const waitingAgain = updateSessionForAttempt(session.id, attemptToken, {
          ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: next.resumeAt
            ? `${engineLabel} usage limit — resumes ${next.resumeAt.toISOString()}`
            : `${engineLabel} usage limit — waiting for reset`,
        });
        if (!waitingAgain) {
          await hooks.onCancelled?.();
          return { kind: "cancelled" };
        }

        await hooks.onStillLimited?.({ attempt, resumeAt: next.resumeAt ?? null });
        continue;
      }

      // Success (or non-rate-limit error) — hand off to caller for persistence + transport.
      await hooks.onRetrySuccess?.(retryResult);
      logger.info(`Session ${session.id} resumed after usage reset`);
      return { kind: "resumed", result: retryResult };
    }

    // Deadline exhausted without recovery.
    await hooks.onTimeout?.();
    logger.warn(`Session ${session.id} exhausted usage limit retries`);
    return { kind: "timeout" };
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitWhileSessionWaiting(sessionId: string, delayMs: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, delayMs);
  while (Date.now() < end) {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.status !== "waiting") return false;
    const sleepMs = Math.min(WAIT_CANCEL_POLL_MS, end - Date.now());
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
  const currentSession = getSession(sessionId);
  return !!currentSession && currentSession.status === "waiting";
}
