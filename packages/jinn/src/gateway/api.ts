import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ChatBlock, ChatBlockEnvelope, CronJob, Employee, Engine, IncomingMessage, JinnConfig, JsonObject, Session, StreamDelta, Target } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import {
  getModelRegistry,
  invalidateModelRegistry,
  effortLevelsForModel,
  refreshAntigravityModels,
  refreshClaudeModels,
  refreshCodexModels,
  refreshGrokModels,
  refreshHermesModels,
  refreshPiModels,
  engineAvailable,
  isKnownEngine,
  engineUnavailableMessage,
} from "../shared/models.js";
import { validateNewSessionSelection, validateSessionPatch } from "../sessions/session-patch.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  listSessions,
  listRecentSessions,
  countSessions,
  listRecentPerGroup,
  listSessionsForGroup,
  getSessionGroupCounts,
  coercePortalEmployee,
  searchSessions,
  searchMessages,
  searchSessionsFiltered,
  getMessageContext,
  getCostReport,
  stripControlChars,
  hasControlBytes,
  MESSAGE_CONTEXT_MAX_RADIUS,
  type MessageSearchFilter,
  type SearchSessionsFilter,
  listChildSessions,
  listSessionsByWorkItem,
  getSession,
  getEngineSessionRef,
  createSession,
  updateSession,
  recordEngineSessionId,
  switchSessionEngine,
  clearEngineSessionRefs,
  UpdateSessionFields,
  deleteSession,
  deleteSessions,
  duplicateSession,
  insertMessage,
  insertPartialMessage,
  updatePartialMessage,
  applyBlockEnvelope,
  deletePartialMessages,
  finalizePartialMessages,
  getMessages,
  getPartialMessages,
  getMessagePage,
  enqueueQueueItem,
  cancelQueueItem,
  markRunningQueueItemsCompletedForSession,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  getFile,
  getSessionBySessionKey,
  initDb,
} from "../sessions/registry.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import { forkEngineSession } from "../sessions/fork.js";
import { removeCodexSessionHome } from "../engines/codex.js";
import {
  deriveRunState,
  resolveWorkflowEvidence,
  resolveWorkflowEvidenceRoot,
  listWorkflowIds,
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  duplicateDefinition,
  retireDefinition,
  resolveExecutionPlan,
  startWorkflowRun,
  startWorkflowRunFromTrigger,
  stepSessionKey,
  listRuns,
  getRun,
  applyWorkflowCronSync,
  fireWorkflowCronJob,
  resolveWorkflowRunGate,
  workflowRunTriggerTodoId,
  artifactGatePasses,
  stateFlagPasses,
  checkWorkflowEventRateLimit,
  createWorkflowTriggerBinding,
  deleteWorkflowTriggerBinding,
  fireWorkflowEvent,
  formatPollActivationApprovalRequest,
  getWorkflowTriggerBinding,
  listPublicWorkflowTriggerBindings,
  sanitizeWorkflowTriggerPayload,
  updateWorkflowTriggerBinding,
  verifyAnyWorkflowTriggerBindingToken,
  withPollActivationContract,
  workflowEventRateLimitKeyFromToken,
  WorkflowStoreError,
  WorkflowRunStoreError,
  WorkflowTriggerStoreError,
  correlateSessionTurn,
  type EditableWorkflowDefinition,
  type FollowUpContext,
  type FollowUpPostResult,
  type RunDriverDeps,
  type SpawnContext,
  type SpawnResult,
} from "../workflows/index.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
} from "../shared/paths.js";
import { saveConfigAtomic } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, resolveLanguages, WHISPER_LANGUAGES } from "../stt/stt.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveEffort } from "../shared/effort.js";
import { selectClaudeModelFallback } from "../shared/model-fallback.js";
import { detectRateLimit } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt } from "../shared/usageAwareness.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { handleRateLimit } from "../sessions/rate-limit-handler.js";
import { cleanupMcpConfigFile } from "../mcp/resolver.js";
import { resolveEngineRunMcp } from "../sessions/engine-run-mcp.js";
import { pickEncoding, compressBuffer, MIN_COMPRESS_BYTES } from "./compress.js";
import { canonicalCronJobId, loadJobs, saveJobs } from "../cron/jobs.js";
import { summarizeCronRun } from "../cron/run-summary.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { validateCronSchedule } from "../cron/validation.js";
import { runCronJob, type WorkflowCronFire } from "../cron/runner.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, handleSessionAttachment, fileIdsToMedia, rehomeAttachmentsToSession, ensureFilesDir } from "./files.js";
import { readJsonBody, readBodyRaw } from "./http-helpers.js";
import { readJsonlTail } from "./jsonl-tail.js";
import { resultAlreadyInStreamedBlocks, shouldPreserveStreamedBlocks } from "./streamed-blocks.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel, notifyAttachedTalkSessions } from "../sessions/callbacks.js";
import { sessionCommGuards, prepareLateralSend, isDescendantOf, resolveCallerIdentity } from "./session-comm-guards.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import {
  createWorkItem,
  getWorkItem,
  getWorkItemBySourceRef,
  getWorkItemSpend,
  linkSession,
  listWorkItemEvents,
  listWorkItems,
  searchWorkItems,
  STICKY_STATUSES,
  type CreateWorkItemInput,
  type SearchWorkItemsFilter,
  type VerifyPolicy,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from "../work-items/store.js";
import { assignWorkItem, transition, TransitionError } from "../work-items/transitions.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { createWorkflowTodoBridge } from "../work-items/workflow-bridge.js";
import { archiveWorkItem, decideWorkItemApproval, escalateApproval, requestApproval } from "../work-items/approvals.js";
import { resolveApprovalDecisionAuthority, resolveApprovalRouteTarget, resolveRootApprovalTarget } from "./approval-authority.js";
import { scanOrg } from "./org.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";
import { searchKnowledge, readKnowledgeFile } from "../knowledge/store.js";
import { planWorkflowAuthoringInput } from "../workflows/authoring.js";
import { loadInstances } from "../cli/instances.js";
import { handleHookPost, isLoopback } from "./hook-endpoint.js";
import {
  authenticateGatewayRequest,
  authCookieHeaders,
  clearAuthCookieHeaders,
  consumePairingCode,
  createAuthSession,
  createAuthState,
  currentAuthDeviceId,
  hasGatewayBearerAuth,
  issuePairingCode,
  isLoopbackHost,
  listAuthSessions,
  revokeAuthSession,
  touchAuthSession,
} from "./auth.js";
import { markTranscriptSyncedThrough, scheduleOnLoadTailSync, transcriptEntryText } from "./external-turns.js";
import { getOrchestratorPersona } from "../talk/orchestrator-persona.js";
import {
  feedTalkText,
  flushTalkSpeech,
  discardTalkSpeech,
  streamTtsSentences,
  ttsStatus,
  validateTtsText,
} from "../talk/tts-stream.js";
import { isTalkMuted } from "../talk/mute-state.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import { onboardingNeeded, applyEngineChoice } from "./onboarding-policy.js";
import { restartDetached } from "./lifecycle.js";

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;
/** Max bytes accepted by public auth helpers. Codes/tokens are tiny. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;
/** Cap for workflow-definition CRUD bodies (GRS-011b). A large graph is still KB-scale. */
const WORKFLOW_DEFINITION_BODY_MAX_BYTES = 512 * 1024;
/** Cap for inbound workflow events. Payloads become prompt context, so keep them small. */
const WORKFLOW_EVENT_BODY_MAX_BYTES = 64 * 1024;
const SESSION_LIST_PER_GROUP = 50;
const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;
const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";
const RESTART_ACK_META_KEY = "restartAcknowledgedAt";

export function compactEmployeeRole(persona?: string): string | undefined {
  const firstLine = persona
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  let role = firstLine
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|\d+\.\s+|>\s*)?/, "")
    .replace(/^you\s+are\s+(?:an?\s+|the\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!role) return undefined;

  role = role.split(/\s+/).slice(0, 12).join(" ");
  if (role.length > 72) {
    const capped = role.slice(0, 72).replace(/\s+\S*$/, "").trim();
    role = capped || role.slice(0, 72).trim();
  }
  role = role.replace(/\.$/, "").trim();
  return role || undefined;
}

function headerValue(req: HttpRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseMessageLimit(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(500, parsed);
}

function scopeBlockEnvelopeForTurn(envelope: ChatBlockEnvelope, turnStartedAt: number): ChatBlockEnvelope {
  const suffix = `t${turnStartedAt.toString(36)}`;
  if (envelope.block.id.endsWith(`:${suffix}`)) return envelope;
  const maxBaseLength = Math.max(1, 96 - suffix.length - 1);
  const baseId = envelope.block.id.slice(0, maxBaseLength);
  return {
    ...envelope,
    block: {
      ...envelope.block,
      id: `${baseId}:${suffix}`,
    },
  };
}

export function normalizeBlockDeltaForTurn(delta: StreamDelta, turnStartedAt: number): { ok: true; delta: StreamDelta } | { ok: false; error: string } {
  if (delta.type !== "block") return { ok: true, delta };
  const initial = validateBlockEnvelope(delta.block);
  if (!initial.ok) return initial;
  const scoped = scopeBlockEnvelopeForTurn(initial.envelope, turnStartedAt);
  const validated = validateBlockEnvelope(scoped);
  if (!validated.ok) return validated;
  return {
    ok: true,
    delta: {
      ...delta,
      content: delta.content || blockFallbackText(validated.envelope.block),
      block: validated.envelope,
    },
  };
}

/**
 * Fold a streamed text/text_snapshot delta into the accumulated partial text.
 *
 * `text` appends the incremental chunk. `text_snapshot` REPLACES the whole
 * accumulation UNCONDITIONALLY — a snapshot is the authoritative current text,
 * so a shorter/rewritten one (e.g. a hermes redaction transform whose final
 * frame is shorter than the streamed increments) must win, not just a longer
 * one. The old length gate here leaked the pre-replace text via a mid-turn
 * GET/refresh until the turn completed. Monotonic snapshot emitters (grok /
 * antigravity, which only ever grow) are unaffected — replace equals their old
 * "if longer" for a non-shrinking sequence.
 */
export function foldPartialText(curText: string, delta: StreamDelta): string {
  if (delta.type === "text_snapshot") return typeof delta.content === "string" ? delta.content : curText;
  if (delta.type === "text") return curText + (typeof delta.content === "string" ? delta.content : "");
  return curText;
}

export function shouldPersistFinalAssistantMessage(options: {
  resultText: string;
  finalBlockCount: number;
  resultAlreadyPersisted: boolean;
  quietPreempted: boolean;
}): boolean {
  if (options.resultAlreadyPersisted || options.quietPreempted) return false;
  return options.resultText.trim().length > 0 || options.finalBlockCount > 0;
}

export function formatEngineErrorAssistantMessage(error: string): string {
  return `⛔ ${error}`;
}

export function finalBlocksForAssistantMessage(blocks: ChatBlock[], preservedBlockIds: Set<string>): ChatBlock[] {
  if (preservedBlockIds.size === 0) return blocks;
  return blocks.filter((block) => !preservedBlockIds.has(block.id));
}

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  /** Re-read config.yaml into memory immediately (same as the file-watcher does,
   *  but synchronous). Call after a handler writes config.yaml so getConfig()
   *  reflects the change without waiting on the debounced watcher (~1s). */
  reloadConfig?: () => void;
  hookRegistry?: import("./hook-registry.js").HookRegistry;
  hookSecret?: string;
  /** PTY-backed Claude engine used by CLI-mode message sends so the user sees the
   *  prompt + response stream into the live xterm. Distinct from the headless
   *  "claude" engine in sessionManager (which chat/cron/connectors use). */
  interactiveClaudeEngine?: import("../engines/claude-interactive.js").InteractiveClaudeEngine;
  /** PTY-capable engines keyed by engine name. Used by CLI-mode web sends. */
  ptyViewEngines?: Record<string, Engine & import("../engines/pty-view-engine.js").PtyViewEngine>;
  /** Synchronously re-scan org/ into the gateway's in-memory employee registry
   *  (and drop warm PTYs). Called after an employee YAML write so the next session
   *  spawn sees the new persona/model immediately, rather than waiting ~800ms for
   *  the chokidar watcher. Wired in server.ts; same body as the watcher's onOrgChange. */
  reloadOrg?: () => void;
  /** In-memory (never persisted) post-settle background activity per session,
   *  maintained in server.ts from the interactive engine's onBackgroundActivity
   *  callback. lastActivityAt is epoch ms; serializeSession converts to ISO. */
  backgroundActivity?: Map<string, { activeStreams: number; lastActivityAt: number }>;
  /** Gateway auth token for seamless browser/CLI access when auth is required. */
  gatewayAuthToken?: string;
  /** Test-injectable Jinn home for auth device storage. Defaults to shared JINN_HOME. */
  jinnHome?: string;
  /** Test-injectable gateway restart primitive. Defaults to lifecycle.restartDetached(). */
  restartGateway?: () => void;
}

function killSessionEngines(context: ApiContext, session: Session, reason: string): void {
  const engines = new Set<Engine>();
  const primary = context.sessionManager.getEngine(session.engine);
  const pty = context.ptyViewEngines?.[session.engine];
  if (primary) engines.add(primary);
  if (pty) engines.add(pty);
  for (const engine of context.sessionManager.getEngines().values()) engines.add(engine);
  for (const engine of Object.values(context.ptyViewEngines ?? {})) engines.add(engine);

  for (const engine of engines) {
    if (isInterruptibleEngine(engine)) engine.kill(session.id, reason);
  }
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  let ceded = 0;
  for (const item of pending) {
    let session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
      continue;
    }
    // Workflow step sessions have exactly ONE recovery owner: the run RECONCILER
    // (GRS-014b-fix, Codex finding 1). Their durable intent lives in the run record,
    // not in this queue row — replaying the row here would resume the interrupted
    // attempt under its OLD sessionKey and defeat the respawn-once accounting
    // (attempt 2 under a new key). Cancel the stale row so it can never replay, and
    // leave the session `interrupted` for the reconciler's startup sweep to re-derive.
    if (session.sourceRef?.startsWith("workflow-run:") || session.sessionKey?.startsWith("workflow-run:")) {
      cancelQueueItem(item.id);
      ceded++;
      continue;
    }
    if (session.source !== "web") continue;
    session = maybeRevertEngineOverride(session);

    const config = context.getConfig();
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: `Engine "${session.engine}" not available` });
      continue;
    }

    // Ensure the session is in a runnable state
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

    dispatchWebSessionRun(session, item.prompt, engine, config, context, { queueItemId: item.id });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
  if (ceded > 0) {
    logger.info(`Ceded ${ceded} workflow step queue item(s) to the run reconciler (single recovery owner)`);
  }
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[] },
): void {
  const run = async () => {
    const sessionKey = session.sessionKey || session.sourceRef;
    try {
      await context.sessionManager.getQueue().enqueue(sessionKey, async () => {
        context.emit("session:started", { sessionId: session.id });
        // Item moved pending → running: refresh the queue panel.
        if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
        await runWebSession(session, prompt, engine, config, context, opts?.attachments);
      }, opts?.queueItemId);
    } finally {
      // Item settled (completed/cancelled/errored): refresh so the "N queued"
      // panel drains. Without this the panel only refreshes on enqueue and the
      // badge sticks at its peak. (queue.ts marks the DB row done in its finally.)
      if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
    }
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      const erroredOnDispatch = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
      // This outer dispatch-error path bypasses notifyParentSession (run() failed
      // before its own completion handling), so wake any attached talk sessions
      // here too — otherwise an attachment wake is silently lost on a hard failure.
      if (erroredOnDispatch) notifyAttachedTalkSessions(erroredOnDispatch, { error: errMsg });
      maybeEmitTalkGraph(session.id, "completed", { getSession, emit: context.emit });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

/**
 * Spawn the real session a workflow-run step maps to (GRS-011d-2c; attempt-keyed and
 * driven by the sequential engine since GRS-014b).
 *
 * This is the gateway-side `spawnStep` the run driver calls for a step with a spawn
 * spec. It maps the plan's actor (employee → its org engine/model, or a bare engine) onto a
 * REAL linked session via the SAME createSession + dispatch path POST /api/sessions uses, so
 * a workflow run genuinely spawns work — no shadow runtime. The session is linked to the run
 * by its sourceRef/sessionKey (`workflow-run:<runId>:<nodeId>:<attempt>` — the deterministic
 * identity the driver's mint-before-spawn probe reads back) and dispatched fire-and-forget;
 * the RUN RECONCILER then observes the session's status to advance the run step-by-step.
 *
 * Exported for the gateway boot wiring (server.ts starts the run reconciler with this
 * as its injected spawner).
 *
 * This spawns on WHICHEVER gateway serves the /run request — a configured evidence root only
 * proves where definition/run files live, not that the target is isolated (see the /run route's
 * honest sandbox note). Point an evidence root only at the isolated instance.
 */
export async function spawnWorkflowStepSession(ctx: SpawnContext, context: ApiContext): Promise<SpawnResult> {
  const config = context.getConfig();
  const { actorKind, actorRef } = ctx.spec;
  let engineName: string;
  let model: string | undefined;
  let employee: string | null = null;
  if (actorKind === "employee") {
    const { scanOrg } = await import("./org.js");
    const emp = scanOrg().get(actorRef);
    if (!emp) throw new Error(`employee "${actorRef}" not found`);
    engineName = emp.engine;
    model = emp.model;
    employee = actorRef;
  } else {
    engineName = actorRef;
  }
  // Per-node overrides (GRS-016b options.model/effort): the model override WINS over
  // an employee's default model; effort becomes the session's effortLevel (the same
  // per-task slot the sessions API uses — the engine resolves it via resolveEffort).
  if (ctx.spec.model) model = ctx.spec.model;
  const effortLevel = ctx.spec.effort;
  // The RESOLVED model/effort is validated against the SAME model registry the
  // sessions and delegations routes use (GRS-016b-fix, Codex finding 2) —
  // spawn-time, not compile-time (model availability is config-dependent, so a
  // spawn-time check is load-bearing). Invalid → throw HERE, before
  // createSession: the driver records an honest, fast `spawn-failed` instead of
  // minting a doomed real session that burns a turn and step-errors (or, worse,
  // gets retried under retry.on:['error'] against a permanently invalid model).
  //
  // GRS-017f: this now validates an employee's CONFIGURED default model too, not
  // just an explicit per-node override — passing the employee slug so an
  // unregistered configured model fails with the SAME clear, employee-named
  // error the sessions/delegations routes emit. v2 validated overrides only and
  // let an employee's own model pass untouched; that silent path was the
  // GRS-017f divergence (delegate 400'd, workflow spawned an unknown model).
  {
    const selection = validateNewSessionSelection(
      config,
      {
        ...(ctx.spec.model !== undefined ? { model: ctx.spec.model } : {}),
        ...(ctx.spec.effort !== undefined ? { effortLevel: ctx.spec.effort } : {}),
      },
      {
        engine: engineName,
        ...(model !== undefined ? { model } : {}),
        ...(employee ? { employee } : {}),
      },
    );
    if (!selection.ok) {
      throw new Error(`step options rejected by the model registry: ${selection.error}`);
    }
  }
  const engine = context.sessionManager.getEngine(engineName);
  if (!engine) throw new Error(`engine "${engineName}" not available`);

  // GRS-016e: the shared-session creation spawn overrides the key
  // (`workflow-run:<runId>:shared`); absent = the ordinary attempt key (v2).
  const sessionKey = ctx.sessionKey ?? stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
  // The driver builds the full step prompt (GRS-014c: instructions + predecessor
  // handoffs + acceptance criteria) from the run's frozen snapshot; the fallback only
  // guards a hand-rolled caller.
  const prompt = ctx.prompt ||
    (`You are executing workflow step "${ctx.label}" (node ${ctx.nodeId}) of workflow ` +
    `"${ctx.workflowId}", run ${ctx.runId}. Perform this step's work and report a concise result.`);
  const session = createSession({
    engine: engineName,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee,
    ...(model ? { model } : {}),
    ...(effortLevel ? { effortLevel } : {}),
    prompt,
    portalName: config.portal?.portalName,
  });
  // DISPATCH-STARTED evidence, BEFORE the insert (GRS-016e-fix4, Codex round-4
  // finding 5) — the same status-before-insert invariant postWorkflowStepFollowUp
  // holds (fix3), applied to session CREATION: createSession persists 'idle', so
  // mark the new session `running` durably FIRST, then insert the anchored row.
  // A process death anywhere from the insert to (and through) the engine turn
  // leaves a dead `running` row that boot's recoverStaleSessions stamps
  // `interrupted`, so recovery RETRIES instead of mis-settling `step-no-output`.
  // Ordering is load-bearing: status BEFORE insert means an anchored row can
  // never exist without the dispatch-started mark — idle+anchored+no-reply is
  // therefore always a turn the ENGINE completed empty (the honest no-output
  // terminal), never a crash artifact. A crash between createSession and the
  // status write leaves an idle row-less session: recovery by row-id absence
  // (re-post the same attempt), unchanged.
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";
  // The shared-session creation spawn inserts the prompt row with the driver's
  // PRE-MINTED anchor id (GRS-016e-fix2) — already persisted on the receipt.
  insertMessage(session.id, "user", prompt, undefined, undefined, ctx.anchorMessageId);
  const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });
  dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId });
  return { sessionId: session.id, detail: `spawned ${actorKind} "${actorRef}" (engine ${engineName})` };
}

/**
 * Post a workflow step's FOLLOW-UP turn into an EXISTING gateway session
 * (GRS-016e session modes 'workflow'/'existing') — the driver's injected
 * `postStepFollowUp`. Mirrors the POST /api/sessions/:id/message core (insert the
 * user message, enqueue, dispatch) with two deliberate differences:
 *
 *   - it NEVER interrupts a running turn (the planner only dispatches into idle
 *     targets, and the per-session queue serializes any race) — a workflow must
 *     not kill an operator's live turn;
 *   - the step's declared actor is ASSERTED against the target session before
 *     anything is posted: an engine actor must match the session's engine, an
 *     employee actor the session's employee. A mismatch throws — an honest
 *     spawn-failure for the step's policy chain — because a silently-ignored
 *     actor declaration is the misplaced-config failure mode.
 *
 * TRUST PATH (vs the GRS-017c lateral-send guards): those guards bound
 * AGENT-initiated sends — an engine choosing targets at runtime, unboundedly.
 * A workflow follow-up is OPERATOR-AUTHORED: the target is frozen in the
 * definition snapshot at run start, every send is one per node dispatch,
 * serialized per target, stamped on a durable receipt, and bounded by the run
 * machinery (maxNodes × retry cap). It is the operator posting through a
 * machine, not a session messaging a session — so it takes the internal-callback
 * path (no caller header), like parent notifications do. The prompt's marker
 * line names the workflow/run/step, so the receiving conversation always shows
 * WHO is speaking.
 *
 * ATOMIC BUSY-RESERVE (GRS-016e-fix, Codex finding 2): the planner's busy probe
 * runs BEFORE the dispatch reaches here, so an operator message can land in
 * between (TOCTOU). The authoritative check is therefore INSIDE this function,
 * and the segment from the busy check through insertMessage is AWAIT-FREE — the
 * single-process event loop cannot interleave another route's insert between our
 * check and our insert (the GRS-017c synchronous-guard invariant; do NOT
 * introduce an await inside this segment). Busy — or became busy — returns a
 * typed DEFER: the driver hands the attempt back and the next sweep retries.
 * The inserted user row's durable id is returned as the settle ANCHOR.
 */
export async function postWorkflowStepFollowUp(ctx: FollowUpContext, context: ApiContext): Promise<FollowUpPostResult> {
  const session = getSession(ctx.sessionId);
  if (!session) throw new Error(`target session "${ctx.sessionId}" not found`);
  // Actor assertion — the declaration must be true of the target, or the author
  // learns immediately (via the step's honest spawn-failure) instead of silently
  // running their step on whatever the session happens to be.
  if (ctx.spec.actorKind === 'engine' && session.engine !== ctx.spec.actorRef) {
    throw new Error(`target session "${ctx.sessionId}" runs engine "${session.engine}", not the declared engine "${ctx.spec.actorRef}"`);
  }
  if (ctx.spec.actorKind === 'employee' && session.employee !== ctx.spec.actorRef) {
    throw new Error(`target session "${ctx.sessionId}" belongs to employee "${session.employee ?? 'none'}", not the declared employee "${ctx.spec.actorRef}"`);
  }
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) throw new Error(`engine "${session.engine}" not available`);
  const config = context.getConfig();

  // ── ATOMIC SEGMENT: busy check → dispatch-started mark → insert. No await
  // between here and insertMessage. A running/waiting status, a live queue lane,
  // or ANY pending queue item (an operator message that landed after the
  // planner's probe) defers the post — the marker row is never inserted into a
  // target that is not verified-idle within this same synchronous segment.
  const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
  const queue = context.sessionManager.getQueue();
  const busy =
    session.status === "running" ||
    session.status === "waiting" ||
    queue.isRunning(queueSessionKey) ||
    queue.getPendingCount(queueSessionKey) > 0;
  if (busy) {
    return { outcome: "deferred", reason: `target session ${session.id} is busy (status ${session.status})` };
  }
  // DISPATCH-STARTED evidence, BEFORE the insert (GRS-016e-fix3, Codex round-3
  // finding 4): mark the target session `running` durably — exactly what
  // spawnWorkflowStepSession does before its own enqueue+dispatch. A process
  // death anywhere from this write to (and through) the engine turn leaves a
  // dead `running` row that boot's recoverStaleSessions stamps `interrupted`,
  // so recovery RETRIES instead of mis-settling `step-no-output`. Ordering is
  // load-bearing: status BEFORE insert means an anchored row can never exist
  // without the dispatch-started mark — idle+anchored+no-reply is therefore
  // always a turn the ENGINE completed empty (the honest no-output terminal),
  // never a crash artifact. A crash between the status write and the insert
  // recovers by row-id absence (re-post the same attempt), unchanged.
  const wasInterrupted = session.status === "interrupted";
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
  session.status = "running";
  insertMessage(session.id, "user", ctx.prompt, undefined, undefined, ctx.anchorMessageId);
  // ── end atomic segment. The row now exists under the driver's PRE-MINTED
  // anchor id (GRS-016e-fix2), already persisted on the receipt.
  if (wasInterrupted) {
    // A restart-interrupted target resumes on the new turn, the message route's rule.
    context.emit("session:resumed", { sessionId: session.id });
  }
  const queueItemId = enqueueQueueItem(session.id, queueSessionKey, ctx.prompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });
  dispatchWebSessionRun(session, ctx.prompt, engine, config, context, { queueItemId });
  return { outcome: "posted", sessionId: session.id, detail: `follow-up turn posted into session ${session.id} (${ctx.turnMarker})` };
}

/**
 * Build the run-driver dependency set (GRS-014b) shared by the POST …/run route and
 * the gateway-boot run reconciler: real definition store, real session probe
 * (registry by deterministic sessionKey), real spawner. Injected — the driver module
 * itself stays gateway-free.
 */
export function workflowRunDriverDeps(root: string, context: ApiContext): RunDriverDeps {
  return {
    root,
    getDefinition,
    probeStepSession: (sessionKey) => {
      const session = getSessionBySessionKey(sessionKey);
      if (!session) return { found: false };
      // For a SETTLED session, also surface the final assistant message — the raw
      // material of the step's outcome (GRS-014c). Fetched only on idle (once per
      // settle, not per sweep tick). An idle session with no assistant output is an
      // honest step failure ("settled with no output"), so null is meaningful.
      let finalAssistantText: string | null | undefined;
      if (session.status === "idle") {
        const messages = getMessages(session.id);
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant" && !messages[i].partial) {
            finalAssistantText = messages[i].content;
            break;
          }
        }
        finalAssistantText ??= null;
      }
      return {
        found: true,
        sessionId: session.id,
        status: session.status,
        ...(finalAssistantText !== undefined ? { finalAssistantText } : {}),
      };
    },
    spawnStep: (ctx) => spawnWorkflowStepSession(ctx, context),
    // ROW-ANCHORED turn probe (GRS-016e-fix, identity-only since fix2): correlation
    // runs through the shared `correlateSessionTurn` — the anchor is the workflow's
    // own inserted USER row, matched ONLY by its persisted pre-minted row id (no
    // content/marker-prefix fallback exists), and the reply is the first non-partial
    // ASSISTANT row strictly AFTER it. Marker TEXT is human attribution only. A
    // session with queued or running work reports busy ('running') even when its
    // status record says idle, closing the settled-turn/queued-turn gap.
    probeSessionTurn: ({ sessionId, marker, anchor }) => {
      const session = getSession(sessionId);
      if (!session) return { found: false };
      const queue = context.sessionManager.getQueue();
      const queueKey = session.sessionKey || session.sourceRef || session.id;
      const busy = queue.isRunning(queueKey) || queue.getPendingCount(queueKey) > 0;
      const status = busy && session.status === "idle" ? "running" : session.status;
      const c = correlateSessionTurn(getMessages(session.id), { marker, ...(anchor ? { anchor } : {}) });
      return {
        found: true,
        status,
        markerPosted: c.markerPosted,
        ...(c.superseded ? { superseded: true } : {}),
        ...(status === "idle" && c.markerPosted ? { replyText: c.replyText } : {}),
      };
    },
    postStepFollowUp: (ctx) => postWorkflowStepFollowUp(ctx, context),
    // Run-START existence check for 'existing' targets. LOCAL REGISTRY ONLY — a
    // sandbox gateway can never see (let alone message) another instance's
    // sessions: there is no cross-gateway path here, the evidence-root isolation
    // argument for mode 'existing' (GRS-016e safety note c).
    sessionExists: (sessionId) => !!getSession(sessionId),
    // The timeout stop (GRS-016b, operator ruling #2 — tokens stop burning): kill
    // the live engine turn, drain the session's queue lane, idle the record — the
    // same sequence POST /api/sessions/:id/stop performs, keyed by the step's
    // deterministic sessionKey. Best-effort by contract: the driver logs a failure
    // and moves on (the receipt's settle is already persisted).
    stopStepSession: async (stop) => {
      const session = getSessionBySessionKey(stop.sessionKey);
      if (!session) return; // already gone — the settle stands, nothing burns
      killSessionEngines(context, session, `Interrupted: workflow step timeout (${stop.reason})`);
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      updateSession(session.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
      context.emit("session:stopped", { sessionId: session.id });
    },
    // Deterministic loop exit-gate evaluation (GRS-014e): the same evidence checks
    // the derive path uses — artifact glob under the evidence root, flag from
    // state.json. Approval never reaches here (the validator refuses it on loop edges).
    evaluateGate: (gate) => {
      if (gate.evaluator === "artifact-glob" && gate.ref) {
        return artifactGatePasses(root, gate.ref, null, 0) !== null;
      }
      if (gate.evaluator === "state-flag" && gate.ref) {
        return stateFlagPasses(root, gate.ref);
      }
      return false;
    },
    // Todos ledger (GRS-021a): the run driver mints the run-level work item,
    // links spawned step sessions, and reflects run terminals. Best-effort by
    // contract inside the bridge — never load-bearing for the run.
    workItems: createWorkflowTodoBridge(),
    log: (level, message) => logger[level](message),
  };
}

/**
 * Re-derive the managed workflow cron jobs from the definition store and reload the
 * scheduler when jobs.json changed (GRS-014d). Called after every definition
 * mutation (create/update/duplicate/retire) and once at gateway boot. BEST-EFFORT
 * from the routes: the definition save already succeeded, so a sync hiccup must not
 * fail the response — drift heals on the next save or boot.
 */
export function syncWorkflowCronJobsForRoot(root: string): void {
  try {
    applyWorkflowCronSync(root, {
      onChanged: (jobs) => reloadScheduler(jobs),
      log: (level, message) => logger[level](message),
    });
  } catch (err) {
    logger.warn(`Workflow cron sync failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The managed-workflow cron fire handler (GRS-014d): what the scheduler's tick (and
 * the manual trigger paths) call for a `managedBy:'workflow'` job. Resolves the
 * evidence root PER FIRE (same guard the workflow routes use — a production-shaped
 * home without one keeps managed jobs inert), starts the typed run, and re-syncs the
 * managed job set when the fire proves the job expired or stale (self-cleaning:
 * expired → disabled, stale → removed).
 */
export function workflowCronFireHandler(context: ApiContext): WorkflowCronFire {
  return async (job, fireIso) => {
    const root = resolveWorkflowEvidenceRoot();
    if (!root) {
      return { ok: false, note: "workflow evidence root is not configured — managed cron job is inert on this gateway" };
    }
    const result = await fireWorkflowCronJob(workflowRunDriverDeps(root, context), job, fireIso);
    if (result.outcome === "expired" || result.outcome === "stale") {
      syncWorkflowCronJobsForRoot(root);
    }
    switch (result.outcome) {
      case "started":
        return { ok: true, note: result.detail, runId: result.run.runId };
      case "duplicate":
        return { ok: true, note: result.detail, runId: result.runId };
      case "expired":
        return { ok: true, note: `${result.detail} — managed job disabled by sync` };
      case "stale":
        return { ok: false, note: `${result.detail} — managed job removed by sync` };
    }
  };
}

/**
 * GET /api/skills description cache, keyed by skill dir name and invalidated
 * by SKILL.md mtime (statSync is far cheaper than re-reading + re-parsing ~70
 * files per request). Mirrors the mtime-cache in talk/orchestrator-persona.ts.
 */
const skillDescriptionCache = new Map<string, { mtimeMs: number; description: string }>();

/** Extract a skill description from YAML frontmatter, ## Trigger section, or first paragraph. */
function parseSkillDescription(content: string): string {
  let description = "";
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }
  if (!description) {
    const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
    if (triggerMatch) {
      description = triggerMatch[1].trim();
    } else {
      // Use first non-heading, non-empty, non-frontmatter line
      const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
      const lines = bodyContent.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
    }
  }
  return description;
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const paths: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}

/** Per-request Accept-Encoding, stashed by handleApiRequest so json() can compress. */
type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const enc =
    body.length >= MIN_COMPRESS_BYTES
      ? pickEncoding((res as ResWithEncoding).__acceptEncoding)
      : null;
  if (enc) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": enc,
      Vary: "Accept-Encoding",
    });
    res.end(compressBuffer(enc, body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

/** Map a WorkflowStoreError (GRS-011b CRUD) to an HTTP status; unknown errors → 500. */
function workflowStoreErrorResponse(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkflowStoreError) {
    switch (err.code) {
      case "not-found":
        return notFound(res);
      case "conflict":
        return json(res, { error: err.message }, 409);
      case "validation":
        return json(res, { error: err.message, errors: err.errors ?? [] }, 400);
      default: // invalid-id | bad-input
        return badRequest(res, err.message);
    }
  }
  logger.error(`workflow-definition route error: ${(err as Error).message}`);
  return serverError(res, "workflow definition operation failed");
}

function workflowTriggerStoreErrorResponse(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkflowTriggerStoreError) {
    switch (err.code) {
      case "not-found":
        return notFound(res);
      case "conflict":
        return json(res, { error: err.message }, 409);
      default:
        return badRequest(res, err.message);
    }
  }
  logger.error(`workflow-trigger route error: ${(err as Error).message}`);
  return serverError(res, "workflow trigger operation failed");
}

function bearerToken(headers: HttpRequest["headers"]): string | undefined {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token || undefined;
}

function workflowEventToken(headers: HttpRequest["headers"]): string | undefined {
  const header = headers["x-jinn-workflow-event-token"];
  const explicit = Array.isArray(header) ? header[0] : header;
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : bearerToken(headers);
}

const REDACTED_SECRET = "***";

export function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized === "authorization"
  );
}

/**
 * Replace any secret-bearing fields with the "***" sentinel before sending
 * config to the UI.
 * deepMerge round-trips the sentinel back to the original value on PUT.
 */
export function sanitizeConfigForApi<T>(value: T, key = ""): T {
  if (isSensitiveConfigKey(key) && value !== undefined && value !== null && value !== "") {
    return REDACTED_SECRET as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForApi(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeConfigForApi(childValue, childKey);
    }
    return out as T;
  }
  return value;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value
    if (isSensitiveConfigKey(key) && sv === REDACTED_SECRET) continue;
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const raw = pathParts[i];
      if (/%2f|%5c/i.test(raw)) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        return null;
      }
      params[patternParts[i].slice(1)] = decoded;
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function sessionHasRuntimeActivity(session: Session, context: ApiContext): boolean {
  const activity = context.backgroundActivity?.get(session.id);
  if (!activity) return false;
  const stale = activity.activeStreams <= 0 && Date.now() - activity.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (stale) {
    context.backgroundActivity?.delete(session.id);
    return false;
  }
  return activity.activeStreams > 0;
}

function getSessionTransportState(session: Session, context: ApiContext): "idle" | "queued" | "running" | "error" | "interrupted" {
  const queue = context.sessionManager.getQueue();
  const base = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  if (sessionHasRuntimeActivity(session, context) && base !== "error" && base !== "interrupted") return "running";
  return base;
}

function blocksEngineSwitch(transportState: Session["transportState"]): boolean {
  return transportState === "running" || transportState === "queued";
}

/** Route-side cap for search query/text params (GRS-020a-fix finding 3). The
 *  MCP tools cap earlier with a friendlier error; this is the substrate
 *  backstop so a hostile curl gets a clean 400, never HTTP-parser noise. */
export const SEARCH_QUERY_ROUTE_CHAR_CAP = 1_024;

/** Read a query param with NUL/control bytes stripped (GRS-020a-fix finding 2)
 *  and whitespace trimmed; empty-after-cleaning collapses to null. */
function readCleanSearchParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const cleaned = stripControlChars(raw).trim();
  return cleaned || null;
}

/** The compact summary shape the GRS-020 reference-layer routes return
 *  (GRS-020a-fix finding 5): exactly the documented fields — never the full
 *  serialized session (sourceRef/replyContext/transportMeta/promptExcerpt/cost
 *  fields stay off the reference surface), never message bodies. */
function compactSessionSummary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title ?? null,
    employee: session.employee ?? null,
    engine: session.engine,
    status: session.status,
    lastActivity: session.lastActivity ?? null,
    parentSessionId: session.parentSessionId ?? null,
  };
}

function cronJobSummary(job: Record<string, unknown>, lastRun: unknown): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled !== false,
    employee: job.employee ?? null,
    engine: job.engine ?? null,
    timezone: job.timezone ?? null,
    lastRun: lastRun ? summarizeCronRun(lastRun) : null,
  };
}

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'escalated', 'cancelled'];
const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ['human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal'];
const AGENT_WORK_ITEM_TARGETS: readonly WorkItemStatus[] = ['in_review', 'blocked', 'escalated', 'done'];
const VERIFY_MODES = ['trust', 'verify', 'thorough'] as const;
const VERIFY_POLICY_KEYS = new Set(['mode', 'verifier', 'maxRounds']);

function compactWorkItem(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee,
    department: item.department,
    source: item.source,
    sourceRef: item.sourceRef,
    approvalState: item.approvalState,
    approvalRequest: item.approvalRequest,
    approvalRef: item.approvalRef,
    approvalTarget: item.approvalTarget,
    approvalEscalatedAt: item.approvalEscalatedAt,
    workflowRun: workflowRunRef(item),
    sessionRef: sessionRef(item),
    updatedAt: item.updatedAt,
  };
}

function workflowRunRef(item: WorkItem): Record<string, string> | null {
  if (item.source !== 'workflow' || !item.sourceRef) return null;
  const m = /^workflow:([^:]+):(.+)$/.exec(item.sourceRef);
  return m ? { workflowId: m[1], runId: m[2] } : null;
}

function sessionRef(item: WorkItem): Record<string, string> | null {
  if (!item.sourceRef) return null;
  const m = /^session:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (m) return m[2] ? { sessionId: m[1], ref: m[2] } : { sessionId: m[1] };
  const delegated = /^delegate:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (delegated) return delegated[2] ? { sessionId: delegated[1], ref: delegated[2] } : { sessionId: delegated[1] };
  return null;
}

function fullWorkItemPayload(item: WorkItem): Record<string, unknown> {
  return {
    workItem: item,
    spendUsd: getWorkItemSpend(item.id),
    workflowRun: workflowRunRef(item),
    events: listWorkItemEvents(item.id),
  };
}

function readWorkItemStatusParam(url: URL): WorkItemStatus | undefined | null {
  const status = readCleanSearchParam(url, 'status');
  if (!status) return undefined;
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) return null;
  return status as WorkItemStatus;
}

function readWorkItemSourceParam(url: URL): WorkItemSource | undefined | null {
  const source = readCleanSearchParam(url, 'source');
  if (!source) return undefined;
  if (!(WORK_ITEM_SOURCES as readonly string[]).includes(source)) return null;
  return source as WorkItemSource;
}

type WorkItemCaller =
  | { kind: 'operator'; session?: undefined; callerId?: undefined }
  | { kind: 'session'; session: Session; callerId: string };

function resolveWorkItemCaller(req: HttpRequest, res: ServerResponse): WorkItemCaller | undefined {
  const identity = resolveScopedWriteCallerIdentity(req.headers);
  if (identity.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  if (identity.kind === "operator") return { kind: 'operator' };
  const session = getSession(identity.callerId);
  if (!session) {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  return { kind: 'session', callerId: identity.callerId, session };
}

function resolveNeedsAttentionTarget(req: HttpRequest, res: ServerResponse, requested: string): string | undefined {
  const identity = resolveScopedWriteCallerIdentity(req.headers);
  if (identity.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  if (identity.kind === "session") {
    const session = getSession(identity.callerId);
    if (!session?.employee) {
      json(res, { error: "needsAttentionFor=me requires a caller session with an employee identity" }, 403);
      return undefined;
    }
    if (requested !== "me" && requested !== session.employee) {
      json(res, { error: "capability-scoped callers can only read their own queue; use needsAttentionFor=me" }, 403);
      return undefined;
    }
    return session.employee;
  }
  if (requested === "me") {
    const root = resolveRootApprovalTarget()?.name;
    if (root) return root;
    json(res, { error: "needsAttentionFor=me could not resolve a COO/root approval target" }, 403);
    return undefined;
  }
  return requested;
}

function resolveScopedWriteCallerIdentity(headers: HttpRequest["headers"]) {
  return resolveCallerIdentity(headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
  });
}

function isPublicIdentifiedCallerRoute(method: string, pathname: string): boolean {
  // Public liveness/bootstrap: safe summary used to discover whether the gateway is up.
  if (method === "GET" && pathname === "/api/status") return true;
  // Public webhook ingress: this route enforces its own gateway-token or binding-token auth.
  if (method === "POST" && pathname === "/api/workflow-events") return true;
  return false;
}

function rejectUnverifiedIdentifiedApiCaller(req: HttpRequest, res: ServerResponse, method: string, pathname: string): boolean {
  if (isPublicIdentifiedCallerRoute(method, pathname)) return false;
  const identity = resolveScopedWriteCallerIdentity(req.headers);
  if (identity.kind !== "unidentified-tool") return false;
  json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
  return true;
}

function operatorOnlyControlPlaneRoute(method: string, pathname: string): string | null {
  if ((method === "PUT" || method === "PATCH") && pathname === "/api/config") return "config update";
  if (method === "POST" && pathname === "/api/onboarding") return "onboarding config update";
  if (method === "POST" && pathname === "/api/auth/pairing-codes") return "auth pairing-code mint";
  if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) return "auth device revoke";
  if (method === "POST" && pathname === "/api/engines/refresh") return "engine registry refresh";
  if (method === "POST" && pathname === "/api/engine-limits/refresh") return "engine limits refresh";
  if (method === "POST" && pathname === "/api/connectors/reload") return "connector reload";
  if (method === "POST" && pathname === "/api/stt/download") return "STT model download/config enable";
  if (method === "PUT" && pathname === "/api/stt/config") return "STT config update";
  if (method === "DELETE" && matchRoute("/api/sessions/:id", pathname)) return "session delete";
  if ((method === "PUT" || method === "PATCH") && matchRoute("/api/sessions/:id", pathname)) return "session metadata/model update";
  if (method === "POST" && matchRoute("/api/sessions/:id/duplicate", pathname)) return "session duplicate";
  if (method === "POST" && matchRoute("/api/sessions/:id/reset", pathname)) return "session reset";
  if (method === "POST" && pathname === "/api/sessions/bulk-delete") return "session bulk delete";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue/:itemId", pathname)) return "session queue item cancel";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue", pathname)) return "session queue clear";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/pause", pathname)) return "session queue pause";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/resume", pathname)) return "session queue resume";
  if (method === "POST" && pathname === "/api/cron") return "cron create";
  if (method === "PUT" && matchRoute("/api/cron/:id", pathname)) return "cron update";
  if (method === "DELETE" && matchRoute("/api/cron/:id", pathname)) return "cron delete";
  if (method === "POST" && matchRoute("/api/cron/:id/trigger", pathname)) return "cron manual trigger";
  if (method === "PATCH" && matchRoute("/api/org/employees/:name", pathname)) return "org employee update";
  if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) return "legacy org board write";
  if (method === "DELETE" && matchRoute("/api/skills/:name", pathname)) return "skill removal";
  return null;
}

function requireOperatorControlPlaneAuthority(req: HttpRequest, res: ServerResponse, action: string): boolean {
  const identity = resolveScopedWriteCallerIdentity(req.headers);
  if (identity.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (identity.kind === "session") {
    json(res, { error: `${action} is operator-only control-plane authority; capability-bound employee sessions cannot mutate gateway configuration, scheduling, org, auth, or settings` }, 403);
    return false;
  }
  return true;
}

function rejectScopedIdentityGrant(req: HttpRequest, res: ServerResponse, action: string): boolean {
  const identity = resolveScopedWriteCallerIdentity(req.headers);
  if (identity.kind === "operator") return false;
  if (identity.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return true;
  }
  json(res, { error: `${action} cannot mint broader browser/operator identity for a capability-bound employee session` }, 403);
  return true;
}

type WorkflowOperation = "create" | "update" | "duplicate" | "retire" | "run" | "bind-trigger";

type WorkflowOperationAuthority =
  | { ok: true; actor: string; employee?: Employee; canSetWorkflowAuthority: boolean }
  | { ok: false; status: 403; error: string };

const WORKFLOW_AUTHORITY_FIELDS = [
  "owner",
  "ownerEmployee",
  "workflowOwner",
  "createdBy",
  "creator",
  "author",
  "department",
  "ownerDepartment",
  "workflowDepartment",
  "critical",
  "cooOwned",
  "requiresCooApproval",
  "classification",
  "authority",
] as const;

function readWorkflowAuthorityString(def: EditableWorkflowDefinition, keys: string[]): string | null {
  const rec = def as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function workflowAuthorityEmployee(principal: string | null, registry: Map<string, Employee>): string | null {
  if (!principal) return null;
  const sessionMatch = /^session:([^:]+)$/.exec(principal);
  if (sessionMatch) {
    const session = getSession(sessionMatch[1]);
    return session?.employee && registry.has(session.employee) ? session.employee : null;
  }
  return registry.has(principal) ? principal : null;
}

function workflowAuthorityCritical(def: EditableWorkflowDefinition): boolean {
  const rec = def as unknown as Record<string, unknown>;
  if (rec.critical === true || rec.cooOwned === true || rec.requiresCooApproval === true) return true;
  const classification = typeof rec.classification === "string" ? rec.classification.toLowerCase() : "";
  const authority = typeof rec.authority === "string" ? rec.authority.toLowerCase() : "";
  return classification === "critical" || authority === "coo" || authority === "operator";
}

function hasDepartmentWorkflowAuthority(employee: Employee, workflowDepartment: string | null): boolean {
  if (!workflowDepartment || employee.department !== workflowDepartment) return false;
  return employee.rank === "manager" || employee.rank === "executive";
}

function authorizeWorkflowOperation(
  headers: HttpRequest["headers"],
  def: EditableWorkflowDefinition | null,
  op: WorkflowOperation,
): WorkflowOperationAuthority {
  const identity = resolveScopedWriteCallerIdentity(headers);
  if (identity.kind === "unidentified-tool") {
    return { ok: false, status: 403, error: UNIDENTIFIED_TOOL_CALL_ERROR };
  }
  if (identity.kind === "operator") {
    return { ok: true, actor: "operator", canSetWorkflowAuthority: true };
  }

  const session = getSession(identity.callerId);
  if (!session?.employee) {
    return { ok: false, status: 403, error: `workflow ${op} requires a session with an employee identity` };
  }
  const registry = scanOrg();
  const employee = registry.get(session.employee);
  if (!employee) {
    return { ok: false, status: 403, error: `employee "${session.employee}" is not in the org roster; workflow ${op} requires workflow authority` };
  }

  const root = resolveRootApprovalTarget();
  if (root?.kind === "employee" && employee.name === root.name) {
    return { ok: true, actor: employee.name, employee, canSetWorkflowAuthority: true };
  }

  if (op === "create") {
    return { ok: true, actor: employee.name, employee, canSetWorkflowAuthority: false };
  }

  if (!def) {
    return { ok: false, status: 403, error: `workflow ${op} requires a persisted workflow authority record` };
  }

  const ownerPrincipal = readWorkflowAuthorityString(def, ["owner", "ownerEmployee", "workflowOwner", "createdBy", "creator", "author"]);
  const owner = workflowAuthorityEmployee(ownerPrincipal, registry);
  const department = readWorkflowAuthorityString(def, ["department", "ownerDepartment", "workflowDepartment"]);
  const critical = workflowAuthorityCritical(def);

  if (!owner && !department) {
    return { ok: false, status: 403, error: `workflow "${def.id}" does not declare owner/department authority; workflow ${op} defaults to COO/operator` };
  }
  if (owner && owner === employee.name) {
    return { ok: true, actor: employee.name, employee, canSetWorkflowAuthority: false };
  }
  if (owner && (critical || owner === root?.name)) {
    return { ok: false, status: 403, error: `employee "${employee.name}" cannot ${op} workflow "${def.id}" owned by "${owner}"` };
  }
  if (hasDepartmentWorkflowAuthority(employee, department)) {
    return { ok: true, actor: employee.name, employee, canSetWorkflowAuthority: false };
  }
  return { ok: false, status: 403, error: `employee "${employee.name}" cannot ${op} workflow "${def.id}"` };
}

function stripWorkflowAuthorityFields(patch: Partial<EditableWorkflowDefinition>): Partial<EditableWorkflowDefinition> {
  const safePatch = { ...patch } as Record<string, unknown>;
  for (const field of WORKFLOW_AUTHORITY_FIELDS) delete safePatch[field];
  return safePatch as Partial<EditableWorkflowDefinition>;
}

function workflowDefinitionAuthorPatch(authority: WorkflowOperationAuthority): Record<string, string> {
  if (!authority.ok) return {};
  if (!authority.employee) return authority.actor === "operator" ? { createdBy: "operator" } : {};
  return { owner: authority.employee.name, department: authority.employee.department, createdBy: authority.employee.name };
}

function workflowDefinitionAuthorityResetPatch(authority: WorkflowOperationAuthority): Partial<EditableWorkflowDefinition> & Record<string, unknown> {
  const reset: Record<string, unknown> = {};
  for (const field of WORKFLOW_AUTHORITY_FIELDS) reset[field] = undefined;
  return { ...reset, ...workflowDefinitionAuthorPatch(authority) } as Partial<EditableWorkflowDefinition> & Record<string, unknown>;
}

function workItemActor(caller: WorkItemCaller): string {
  return caller.kind === 'session' ? `session:${caller.callerId}` : 'operator';
}

function findApprovalKeysDeep(value: unknown, path = 'body', found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^approval/i.test(key)) found.push(childPath);
    findApprovalKeysDeep(child, childPath, found);
  }
  return found;
}

function objectKeys(value: unknown, name: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `${name} must be a JSON object` };
  return { ok: true, value: value as Record<string, unknown> };
}

function validateVerifyPolicy(value: unknown): { ok: true; value: VerifyPolicy | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const rec = objectKeys(value, 'verifyPolicy');
  if (!rec.ok) return rec;
  const extras = Object.keys(rec.value).filter((key) => !VERIFY_POLICY_KEYS.has(key));
  if (extras.length > 0) return { ok: false, error: `verifyPolicy has unknown key(s) ${extras.join(', ')}; only mode, verifier, and maxRounds are allowed` };
  const mode = rec.value.mode;
  if (!(VERIFY_MODES as readonly unknown[]).includes(mode)) {
    return { ok: false, error: `verifyPolicy.mode must be one of ${VERIFY_MODES.join(', ')}` };
  }
  const policy: VerifyPolicy = { mode: mode as VerifyPolicy['mode'] };
  if (rec.value.maxRounds !== undefined) {
    if (typeof rec.value.maxRounds !== 'number' || !Number.isInteger(rec.value.maxRounds) || rec.value.maxRounds < 1 || rec.value.maxRounds > 20) {
      return { ok: false, error: 'verifyPolicy.maxRounds must be an integer from 1 to 20' };
    }
    policy.maxRounds = rec.value.maxRounds;
  }
  if (rec.value.verifier !== undefined) {
    const verifier = objectKeys(rec.value.verifier, 'verifyPolicy.verifier');
    if (!verifier.ok) return verifier;
    const allowed = new Set(['employee', 'engine', 'model']);
    const extraVerifier = Object.keys(verifier.value).filter((key) => !allowed.has(key));
    if (extraVerifier.length > 0) {
      return { ok: false, error: `verifyPolicy.verifier has unknown key(s) ${extraVerifier.join(', ')}; only employee, engine, and model are allowed` };
    }
    const out: NonNullable<VerifyPolicy['verifier']> = {};
    for (const key of ['employee', 'engine', 'model'] as const) {
      if (verifier.value[key] !== undefined) {
        if (typeof verifier.value[key] !== 'string' || !verifier.value[key].trim()) {
          return { ok: false, error: `verifyPolicy.verifier.${key} must be a non-empty string` };
        }
        out[key] = verifier.value[key].trim();
      }
    }
    policy.verifier = out;
  }
  return { ok: true, value: policy };
}

function ownsWorkItem(session: Session, item: WorkItem, linked: Session[]): boolean {
  if (linked.some((s) => s.id === session.id)) return true;
  if (item.assignee && session.employee && item.assignee === session.employee) return true;
  return item.source === 'session' && !!item.sourceRef?.startsWith(`session:${session.id}:`);
}

function authorizeWorkItemOwnerManagerOrRoot(
  caller: WorkItemCaller,
  item: WorkItem,
  action: string,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  const employeeName = caller.session.employee;
  if (!employeeName) {
    return { ok: false, status: 403, error: `session ${caller.callerId} has no employee identity and cannot ${action} Todo ${item.id}` };
  }
  const roster = scanOrg();
  const employee = roster.get(employeeName);
  if (!employee) {
    return { ok: false, status: 403, error: `employee "${employeeName}" is not in the org roster and cannot ${action} Todo ${item.id}` };
  }
  const root = resolveRootApprovalTarget();
  if (root?.kind === 'employee' && root.name === employeeName) return { ok: true };

  const owner = resolveApprovalRouteTarget(item).owner;
  if (owner === employeeName) return { ok: true };
  if (owner && (employee.rank === 'manager' || employee.rank === 'executive')) {
    const hierarchy = resolveOrgHierarchy(roster);
    let ancestor = hierarchy.nodes[owner]?.parentName ?? null;
    while (ancestor) {
      if (ancestor === employeeName) return { ok: true };
      ancestor = hierarchy.nodes[ancestor]?.parentName ?? null;
    }
  }
  return {
    ok: false,
    status: 403,
    error: `employee "${employeeName}" does not own Todo ${item.id} and is not its authorized manager/root; cannot ${action}`,
  };
}

function canReviewWorkItemDone(session: Session, item: WorkItem, linked: Session[]): { ok: true } | { ok: false; error: string } {
  if (item.status !== 'in_review') {
    return { ok: false, error: `marking a Todo done through MCP requires an authorized reviewer and an item already in_review; use the human review surface for ${item.status} → done` };
  }
  if (linked.some((s) => s.id === session.id)) {
    return { ok: false, error: `session ${session.id} executed work item ${item.id} and cannot mark it done — a reviewer does (self-review ban); use the human review surface / a reviewer session to mark done` };
  }
  if (linked.some((s) => s.parentSessionId === session.id)) return { ok: true };
  if (item.sourceRef?.startsWith(`delegate:${session.id}:`)) return { ok: true };
  if (item.source === 'session' && item.sourceRef?.startsWith(`session:${session.id}:`)) return { ok: true };
  return { ok: false, error: `session ${session.id} is not an authorized reviewer for Todo ${item.id}; use the human review surface or the parent reviewer session` };
}

function authorizeAgentWorkItemStatus(caller: WorkItemCaller, item: WorkItem, target: WorkItemStatus): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  const linked = listSessionsByWorkItem(item.id);
  if (target === 'done') {
    const review = canReviewWorkItemDone(caller.session, item, linked);
    return review.ok ? { ok: true } : { ok: false, status: 403, error: review.error };
  }
  if (!ownsWorkItem(caller.session, item, linked)) {
    return {
      ok: false,
      status: 403,
      error: `session ${caller.callerId} does not own Todo ${item.id} and is not its authorized reviewer; agents may update only their own Todos, otherwise use the human surface`,
    };
  }
  return { ok: true };
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

function nearestEmployee(name: string, names: string[]): string | undefined {
  return names
    .map((n) => ({ n, d: levenshtein(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= 4 || x.n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.n.toLowerCase()))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))[0]?.n;
}

export function serializeSession(session: Session, context: ApiContext): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = getSessionTransportState(session, context);
  const bg = context.backgroundActivity?.get(session.id);
  const bgIsStale = bg && bg.activeStreams <= 0 && Date.now() - bg.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (bgIsStale) context.backgroundActivity?.delete(session.id);
  return {
    ...session,
    queueDepth,
    transportState,
    backgroundActivity: bg && !bgIsStale
      ? { activeStreams: bg.activeStreams, lastActivityAt: new Date(bg.lastActivityAt).toISOString() }
      : null,
  };
}

function withTransportMeta(session: Session, updates: JsonObject): JsonObject {
  const base =
    session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
      ? session.transportMeta
      : {};
  return { ...base, ...updates };
}

function supersedeRunningTurn(session: Session): void {
  updateSession(session.id, {
    transportMeta: withTransportMeta(session, {
      [SUPERSEDED_TURN_META_KEY]: new Date().toISOString(),
    }),
  });
}

function clearSupersededTurnMeta(sessionId: string): void {
  const session = getSession(sessionId);
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !(SUPERSEDED_TURN_META_KEY in meta)) return;
  const next = { ...meta };
  delete next[SUPERSEDED_TURN_META_KEY];
  updateSession(sessionId, { transportMeta: next });
}

function isTurnSuperseded(sessionId: string, turnStartedAt: number): boolean {
  const marker = getSession(sessionId)?.transportMeta?.[SUPERSEDED_TURN_META_KEY];
  if (typeof marker !== "string") return false;
  const markedAt = new Date(marker).getTime();
  return Number.isFinite(markedAt) && markedAt >= turnStartedAt;
}

function isSessionLiveRunning(session: Session, context: ApiContext): boolean {
  if (session.status !== "running") return false;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !isInterruptibleEngine(engine)) return true;
  if ("isTurnRunning" in engine) return Boolean((engine as any).isTurnRunning(session.id));
  return engine.isAlive(session.id);
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/status", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";
  // Stash so json() can compress large responses without threading req everywhere.
  (res as ResWithEncoding).__acceptEncoding = req.headers["accept-encoding"];

  try {
    const jinnHome = context.jinnHome ?? JINN_HOME;

    if (rejectUnverifiedIdentifiedApiCaller(req, res, method, pathname)) {
      return;
    }

    const controlPlaneAction = operatorOnlyControlPlaneRoute(method, pathname);
    if (controlPlaneAction && !requireOperatorControlPlaneAuthority(req, res, controlPlaneAction)) {
      return;
    }

    // GET /api/auth/state — safe browser boot metadata. Never includes the token.
    if (method === "GET" && pathname === "/api/auth/state") {
      const state = createAuthState(context.getConfig(), req, context.gatewayAuthToken, jinnHome);
      if (state.authenticated) touchAuthSession(jinnHome, req);
      return json(res, state);
    }

    // POST /api/auth/bootstrap — loopback/local convenience: set the browser cookie
    // from a local browser session so daily local use does not require a login form.
    if (method === "POST" && pathname === "/api/auth/bootstrap") {
      if (!context.gatewayAuthToken) return json(res, { authRequired: false });
      if (rejectScopedIdentityGrant(req, res, "auth bootstrap")) return;
      if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host)) {
        return json(res, { error: "Bootstrap is loopback-only" }, 403);
      }
      const session = createAuthSession(jinnHome, req, { kind: "local" });
      res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id));
      return json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    }

    // POST /api/auth/pairing-codes — local authenticated helper for pairing a
    // second browser. Codes are short-lived, single-use, and only stored hashed.
    if (method === "POST" && pathname === "/api/auth/pairing-codes") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (!context.gatewayAuthToken) return json(res, { error: "Gateway auth token is not configured" }, 503);
      const bearer = hasGatewayBearerAuth(req.headers, context.gatewayAuthToken);
      if (bearer) {
        return json(res, { error: "Pairing codes require an authenticated browser session; bearer tokens cannot mint browser pairing material" }, 403);
      }
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const localBrowser = isLoopback(req.socket.remoteAddress)
        && isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
      if (!localBrowser) return json(res, { error: "Pairing codes can only be created locally" }, 403);
      const issued = issuePairingCode();
      return json(res, {
        status: "ok",
        code: issued.code,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        ttlSeconds: Math.floor((issued.expiresAt - Date.now()) / 1000),
      });
    }

    // POST /api/auth/pair — exchange a one-time pairing code for the HttpOnly
    // browser cookie used by APIs and WebSockets.
    if (method === "POST" && pathname === "/api/auth/pair") {
      if (rejectScopedIdentityGrant(req, res, "auth pair")) return;
      const parsed = await readJsonBody(req, res, { maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      const code = typeof body.code === "string" ? body.code : undefined;
      const ok = consumePairingCode(undefined, code);
      if (!ok || !context.gatewayAuthToken) return json(res, { error: "Invalid or expired pairing code" }, 401);
      const session = createAuthSession(jinnHome, req, { kind: "remote" });
      res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id));
      return json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    }

    // GET /api/auth/devices — authenticated browser list for Settings > Pairing.
    if (method === "GET" && pathname === "/api/auth/devices") {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      touchAuthSession(jinnHome, req);
      return json(res, { devices: listAuthSessions(jinnHome, currentAuthDeviceId(req.headers)) });
    }

    // DELETE /api/auth/devices/:id — shared unpair primitive used by Settings
    // and the CLI. Deleting the current browser also clears its cookies.
    if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const rawDeviceId = pathname.slice("/api/auth/devices/".length);
      let deviceId = "";
      try {
        deviceId = decodeURIComponent(rawDeviceId);
      } catch {
        return badRequest(res, "Invalid paired browser id");
      }
      if (!deviceId) return badRequest(res, "Missing paired browser id");
      const currentDevice = currentAuthDeviceId(req.headers);
      const removed = revokeAuthSession(jinnHome, deviceId);
      if (!removed) return json(res, { error: "Paired browser not found" }, 404);
      const current = Boolean(currentDevice && currentDevice === deviceId);
      if (current) res.setHeader("Set-Cookie", clearAuthCookieHeaders());
      return json(res, { status: "ok", current });
    }

    // POST /api/auth/logout — forget this browser by clearing the auth cookie.
    if (method === "POST" && pathname === "/api/auth/logout") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const currentDevice = currentAuthDeviceId(req.headers);
      if (currentDevice) revokeAuthSession(jinnHome, currentDevice);
      res.setHeader("Set-Cookie", clearAuthCookieHeaders());
      return json(res, { status: "ok" });
    }

    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      // Only running rows can be "live running" (isSessionLiveRunning short-circuits
      // on status!=='running'), so hydrate just those (~handful, idx_sessions_status)
      // instead of materializing + JSON-parsing every session to count them.
      const running = listSessions({ status: "running" }).filter((s) => isSessionLiveRunning(s, context)).length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      return json(res, {
        status: "ok",
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        // Derived from the model registry (single source of truth) so engine
        // availability stays consistent with /api/engines instead of drifting.
        engines: {
          default: config.engines.default,
          ...Object.fromEntries(
            Object.entries(getModelRegistry(config)).map(([name, entry]) => [
              name,
              { model: entry.defaultModel, available: entry.available },
            ]),
          ),
        },
        sessions: { total: countSessions(), running, active: running },
        connectors,
      });
    }

    // POST /api/system/restart — spawn the detached restart helper from the
    // gateway process itself, after the HTTP response has been flushed.
    if (method === "POST" && pathname === "/api/system/restart") {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const requestingSessionId = headerValue(req, "x-jinn-session-id")?.trim();
      if (requestingSessionId) {
        const completed = markRunningQueueItemsCompletedForSession(requestingSessionId);
        if (completed > 0) {
          logger.info(`Completed ${completed} active queue item(s) for restart-requesting session ${requestingSessionId}`);
        }
        const requestingSession = getSession(requestingSessionId);
        const transportMeta = (requestingSession?.transportMeta && typeof requestingSession.transportMeta === "object" && !Array.isArray(requestingSession.transportMeta))
          ? { ...(requestingSession.transportMeta as JsonObject) }
          : {};
        transportMeta[RESTART_ACK_META_KEY] = new Date().toISOString();
        updateSession(requestingSessionId, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
          transportMeta,
        });
      }
      const restartGateway = context.restartGateway ?? restartDetached;
      logger.info("Gateway restart requested via API");
      const timer = setTimeout(() => {
        try {
          restartGateway();
        } catch (err) {
          logger.error(`Failed to spawn gateway restart helper: ${err instanceof Error ? err.stack : err}`);
        }
      }, 50);
      timer.unref?.();
      return json(res, { status: "restarting" });
    }

    // GET /api/instances
    if (method === "GET" && pathname === "/api/instances") {
      const instances = loadInstances();
      const currentPort = context.getConfig().gateway.port || 7777;
      const results = await Promise.all(
        instances.map(async (inst) => ({
          name: inst.name,
          port: inst.port,
          running: inst.port === currentPort ? true : await checkInstanceHealth(inst.port),
          current: inst.port === currentPort,
        }))
      );
      return json(res, results);
    }

    // GET /api/search/messages — GRS-020a company-reference search: FTS5 over
    // user/assistant message bodies (injection-safe — the store sanitizes the
    // query into quoted phrases), AND-composed bound-param filters, newest-first.
    // GRS-020a-fix hardening: control bytes are stripped from every string param
    // (an embedded NUL made FTS5 throw — finding 2) and the query length is
    // capped route-side (finding 3; the MCP tools cap earlier and friendlier).
    if (method === "GET" && pathname === "/api/search/messages") {
      const readParam = (name: string): string | null => readCleanSearchParam(url, name);
      const q = readParam("q");
      if (!q) return badRequest(res, "q is required");
      if (q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
        return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
      }
      const filter: MessageSearchFilter = {};
      const sessionId = readParam("sessionId");
      if (sessionId) filter.sessionId = sessionId;
      const excludeSessionId = readParam("excludeSessionId");
      if (excludeSessionId) filter.excludeSessionId = excludeSessionId;
      const employee = readParam("employee");
      if (employee) filter.employee = employee;
      const engine = readParam("engine");
      if (engine) filter.engine = engine;
      const role = readParam("role");
      if (role) {
        if (role !== "user" && role !== "assistant") {
          return badRequest(res, `role must be "user" or "assistant" (only those rows are indexed), got "${role}"`);
        }
        filter.role = role;
      }
      for (const [param, key] of [["since", "since"], ["until", "until"]] as const) {
        const raw = readParam(param);
        if (raw) {
          const ms = Date.parse(raw);
          if (Number.isNaN(ms)) return badRequest(res, `${param} must be an ISO-8601 timestamp, got "${raw}"`);
          filter[key] = ms;
        }
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 200));
      const results = searchMessages(q, limit, filter);
      return json(res, { query: q, results });
    }

    // GET /api/search/sessions — GRS-020a: deterministic AND-composed session
    // search (escaped-LIKE text over title/prompt_excerpt/id + structured
    // filters). At least one filter required — the unbounded list stays on
    // GET /api/sessions. Returns COMPACT summaries only (GRS-020a-fix finding
    // 5: the reference layer's route contract is summaries, not the full
    // serialized session); string params are control-stripped and the text
    // filter is length-capped (findings 2+3).
    if (method === "GET" && pathname === "/api/search/sessions") {
      const readParam = (name: string): string | null => readCleanSearchParam(url, name);
      const filter: SearchSessionsFilter = {};
      const text = readParam("text");
      if (text) {
        if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
          return badRequest(res, `text is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
        }
        filter.text = text;
      }
      const employee = readParam("employee");
      if (employee) filter.employee = employee;
      const engine = readParam("engine");
      if (engine) filter.engine = engine;
      const status = readParam("status");
      if (status) {
        const valid: Session["status"][] = ["idle", "running", "error", "waiting", "interrupted"];
        if (!valid.includes(status as Session["status"])) {
          return badRequest(res, `status must be one of ${valid.join(", ")}, got "${status}"`);
        }
        filter.status = status as Session["status"];
      }
      const source = readParam("source");
      if (source) filter.source = source;
      const parentSessionId = readParam("parentSessionId");
      if (parentSessionId) filter.parentSessionId = parentSessionId;
      for (const key of ["activeSince", "activeBefore"] as const) {
        const raw = readParam(key);
        if (raw) {
          if (Number.isNaN(Date.parse(raw))) return badRequest(res, `${key} must be an ISO-8601 timestamp, got "${raw}"`);
          filter[key] = new Date(raw).toISOString();
        }
      }
      if (url.searchParams.get("needsAttention") === "true") filter.needsAttention = true;
      if (Object.keys(filter).length === 0) {
        return badRequest(res, "at least one filter is required (text, employee, engine, status, source, parentSessionId, activeSince, activeBefore, needsAttention)");
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 50));
      const sessions = searchSessionsFiltered(filter, limit);
      return json(res, { sessions: sessions.map(compactSessionSummary) });
    }

    // GET /api/cost/report — GRS-020c cost-only read surface. Deterministic
    // aggregate over existing sessions.total_cost/total_turns; no budgets,
    // thresholds, work-item joins, or mutation.
    if (method === "GET" && pathname === "/api/cost/report") {
      const groupBy = readCleanSearchParam(url, "groupBy") || "employee";
      if (groupBy !== "employee" && groupBy !== "day") return badRequest(res, 'groupBy must be "employee" or "day"');
      const parseIso = (name: "since" | "until"): string | undefined => {
        const raw = readCleanSearchParam(url, name);
        if (!raw) return undefined;
        if (Number.isNaN(Date.parse(raw))) return "";
        return new Date(raw).toISOString();
      };
      const since = parseIso("since");
      if (since === "") return badRequest(res, "since must be an ISO-8601 timestamp");
      const until = parseIso("until");
      if (until === "") return badRequest(res, "until must be an ISO-8601 timestamp");
      const employee = readCleanSearchParam(url, "employee") || undefined;
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 100));
      const report = getCostReport({ groupBy, since, until, employee, limit });
      return json(res, {
        ...report,
        hint: "Costs are engine-reported per session; missing/zero rows mean the engine reported none.",
      });
    }

    // GET /api/search/work-items — GRS-021c: deterministic AND-composed Todo
    // search. Text is escaped-LIKE over title+body (%/_/backslash literal) and
    // structured filters are exact. Compact summaries only — body/acceptance
    // dumps stay behind GET /api/work-items/:id.
    if (method === "GET" && pathname === "/api/search/work-items") {
      const text = readCleanSearchParam(url, "text");
      const filter: SearchWorkItemsFilter = {};
      if (text) {
        if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
          return badRequest(res, `text is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
        }
        filter.text = text;
      }
      const status = readWorkItemStatusParam(url);
      if (status === null) return badRequest(res, `status must be one of ${WORK_ITEM_STATUSES.join(", ")}`);
      if (status) filter.status = status;
      const source = readWorkItemSourceParam(url);
      if (source === null) return badRequest(res, `source must be one of ${WORK_ITEM_SOURCES.join(", ")}`);
      if (source) filter.source = source;
      const assignee = readCleanSearchParam(url, "assignee");
      if (assignee) filter.assignee = assignee;
      const department = readCleanSearchParam(url, "department");
      if (department) filter.department = department;
      const needsAttentionFor = readCleanSearchParam(url, "needsAttentionFor");
      if (needsAttentionFor) {
        const target = resolveNeedsAttentionTarget(req, res, needsAttentionFor);
        if (!target) return;
        filter.needsAttentionFor = target;
      }
      if (Object.keys(filter).length === 0) {
        return badRequest(res, "at least one filter is required (text, status, source, assignee, department, needsAttentionFor)");
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 20));
      const workItems = searchWorkItems(filter, limit);
      return json(res, { workItems: workItems.map(compactWorkItem) });
    }

    // GET /api/knowledge/search — GRS-020b: deterministic token-AND search over
    // the two allowlisted knowledge roots (knowledge/ + docs/, .md only).
    // Snippets only, never bodies; query is control-stripped + length-capped
    // (the GRS-020a hardening, reused).
    if (method === "GET" && pathname === "/api/knowledge/search") {
      const q = readCleanSearchParam(url, "q");
      if (!q) return badRequest(res, "q is required");
      if (q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
        return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
      }
      return json(res, { query: q, results: searchKnowledge(q, jinnHome) });
    }

    // GET /api/knowledge/read — GRS-020b: read ONE knowledge/docs file by the
    // RELATIVE path knowledge search returned. SECURITY-CRITICAL (the
    // exfiltration surface): the store enforces the scoped-root invariant —
    // shape gate + realpath containment, so `..`, absolute paths, other roots,
    // and symlink escapes are refused (400/403), never read. This route is
    // deliberately SEPARATE from the operator/UI GET /api/files/read.
    if (method === "GET" && pathname === "/api/knowledge/read") {
      // GRS-020b-fix: REJECT control bytes on the RAW path — never strip. The
      // shared readCleanSearchParam STRIPS control bytes (correct for free-text
      // search queries) which would silently REPAIR a `%00`-tampered path into a
      // valid one and read it (the claimed "%00 -> 400" contract failing). The
      // security-critical read surface rejects on the raw param first; the store
      // primitive mirrors the same reject as defense-in-depth.
      const rawPath = url.searchParams.get("path");
      if (rawPath !== null && hasControlBytes(rawPath)) {
        return badRequest(res, "path contains control bytes — pass the relative path exactly as knowledge search returned it");
      }
      const rel = readCleanSearchParam(url, "path");
      if (!rel) return badRequest(res, 'path is required — a relative path from /api/knowledge/search, e.g. "knowledge/some-file.md"');
      const result = readKnowledgeFile(rel, jinnHome);
      if (!result.ok) {
        if (result.reason === "forbidden") return json(res, { error: result.detail }, 403);
        if (result.reason === "not-found") return json(res, { error: result.detail }, 404);
        return badRequest(res, result.detail);
      }
      const { ok: _ok, ...payload } = result;
      return json(res, payload);
    }

    // GET /api/sessions
    //   ?group=<employee|__direct__|__cron__>&offset=M&limit=N → one group's page (sidebar "load more")
    //   ?limit=0                                              → every session (power-user escape hatch)
    //   (default)                                             → top SESSION_LIST_PER_GROUP recent per group + counts
    if (method === "GET" && pathname === "/api/sessions") {
      const query = url.searchParams.get("q");
      if (query && query.trim()) {
        const matches = searchSessions(query.trim());
        return json(res, matches.map((session) => serializeSession(session, context)));
      }
      const group = url.searchParams.get("group");
      const rawLimit = url.searchParams.get("limit");
      // Portal-slug-tagged rows fold into the direct group (defensive +
      // retroactive backstop to the create-time coercion above).
      const portalSlug = context.getConfig().portal?.portalName;
      if (group) {
        const limit = Math.max(1, parseInt(rawLimit || "50", 10) || 50);
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const page = listSessionsForGroup(group, limit, offset, portalSlug);
        return json(res, page.map((session) => serializeSession(session, context)));
      }
      if (rawLimit === "0") {
        const all = listSessions();
        return json(res, all.map((session) => serializeSession(session, context)));
      }
      const sessions = listRecentPerGroup(SESSION_LIST_PER_GROUP, portalSlug);
      return json(res, {
        sessions: sessions.map((session) => serializeSession(session, context)),
        counts: getSessionGroupCounts(portalSlug),
        perGroup: SESSION_LIST_PER_GROUP,
      });
    }

    // GET /api/sessions/interrupted — list sessions that can be resumed after a restart
    if (method === "GET" && pathname === "/api/sessions/interrupted") {
      const { getInterruptedSessions } = await import("../sessions/registry.js");
      const interrupted = getInterruptedSessions();
      return json(res, interrupted.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/:id/messages?before=<messageId>&limit=N
    // Bounded older-history page for seamless transcript prepending in the web UI.
    let params = matchRoute("/api/sessions/:id/messages", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const limit = parseMessageLimit(url.searchParams.get("limit"), 100);
      const before = url.searchParams.get("before") || undefined;
      const page = getMessagePage(params.id, { before, limit });
      return json(res, page);
    }

    // GET /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const includeMessages = url.searchParams.get("messages") !== "0";
      const lastN = parseMessageLimit(url.searchParams.get("last"), 0);
      const page = includeMessages && lastN > 0
        ? getMessagePage(params.id, { limit: lastN })
        : null;
      const messages = includeMessages
        ? page ? page.messages : getMessages(params.id)
        : [];

      // Backfill from Claude Code's JSONL transcript if our DB has no messages.
      // Run async + transactional so the GET doesn't block on multi-MB JSONL
      // parsing + N individual INSERTs. Subsequent GETs will see the messages
      // once the backfill finishes; this one returns whatever is in DB now.
      const claudeSessionId = getEngineSessionRef(session, "claude").id;
      if (includeMessages && messages.length === 0 && session.engine === "claude" && claudeSessionId) {
        scheduleTranscriptBackfill(params.id, claudeSessionId, context);
      } else if (includeMessages && session.engine === "claude") {
        // On-load safety net for PTY-native (CLI-typed) turns whose unclaimed
        // Stop was missed entirely: fire-and-forget a transcript tail sync.
        // Cheap (one stat() in the common case) and never delays this GET —
        // the frontend refetches on `session:external-turn`.
        scheduleOnLoadTailSync(params.id, context.emit);
      }

      return json(res, {
        ...serializeSession(session, context),
        ...(includeMessages ? { messages } : {}),
        ...(page ? { messagesPage: { hasOlder: page.hasOlder } } : {}),
      });
    }

    // PUT|PATCH /api/sessions/:id — update title and/or mid-chat model/effort
    params = matchRoute("/api/sessions/:id", pathname);
    if ((method === "PUT" || method === "PATCH") && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updates: UpdateSessionFields = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return badRequest(res, "title must be a string");
        const trimmed = body.title.trim();
        if (!trimmed) return badRequest(res, "title must not be empty");
        updates.title = trimmed.slice(0, 200);
      }
      const configForPatch = context.getConfig();
      let requestedEngine: string | undefined;
      if (body.engine !== undefined) {
        if (typeof body.engine !== "string" || !body.engine.trim()) {
          return badRequest(res, "engine must be a non-empty string");
        }
        requestedEngine = body.engine.trim();
      }

      const engineChanging = Boolean(requestedEngine && requestedEngine !== session.engine);
      if (engineChanging) {
        if (blocksEngineSwitch(getSessionTransportState(session, context))) {
          return badRequest(res, "Cannot switch engine while a turn is running, waiting, or queued");
        }
        const savedRef = getEngineSessionRef(session, requestedEngine);
        const selection = validateNewSessionSelection(configForPatch, {
          engine: requestedEngine,
          model: body.model ?? savedRef.model,
          effortLevel: body.effortLevel ?? savedRef.effortLevel,
        });
        if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
        let switched = switchSessionEngine(params.id, selection.engine!, {
          model: selection.model ?? null,
          effortLevel: selection.effortLevel ?? null,
        });
        if (!switched) return notFound(res);
        if (updates.title !== undefined) {
          switched = updateSession(params.id, { title: updates.title }) ?? switched;
        }
        context.emit("session:updated", { sessionId: params.id });
        return json(res, serializeSession(switched, context));
      }

      // Mid-chat model / effort switch (applies from the next turn). Validated
      // against the current engine unless this request intentionally switched
      // engines above.
      if (body.model !== undefined || body.effortLevel !== undefined) {
        const engineConfigForPatch =
          (configForPatch.engines as unknown as Record<string, { model?: string } | undefined>)[session.engine] ?? {};
        const patch = validateSessionPatch(configForPatch, session.engine, session.model, body, {
          engineSessionId: getEngineSessionRef(session, session.engine).id,
          defaultModel: engineConfigForPatch.model,
        });
        if (!patch.ok) return badRequest(res, patch.error || "invalid model/effort");
        if (patch.updates?.model !== undefined) updates.model = patch.updates.model;
        if (patch.updates?.effortLevel !== undefined) updates.effortLevel = patch.updates.effortLevel;
      }
      if (Object.keys(updates).length === 0) return badRequest(res, "no valid fields to update");
      const updated = updateSession(params.id, updates);
      if (!updated) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSession(updated, context));
    }

    // DELETE /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Tear down any live/warm engine processes for this session before deleting it.
      // kill() is safe to call unconditionally — it's a no-op when nothing is running.
      logger.info(`Killing engine process for deleted session ${params.id}`);
      killSessionEngines(context, session, "Interrupted: session deleted");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);

      maybeEmitTalkGraph(params.id, "removed", { getSession, emit: context.emit });
      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      // Remove any per-session Codex CODEX_HOME overlay (holds a session-scoped
      // capability in its config.toml). No-op for non-codex sessions. Idempotent.
      removeCodexSessionHome(params.id);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/stop
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      // GRS-017a — an agent-initiated stop (declared caller identity) is scoped
      // to the caller's OWN DESCENDANTS: cross-tree stops are a lateral
      // authority grab, so peers and ancestors are refused. Operator/UI calls
      // carry neither identity nor tool marker and keep today's full access.
      // A TOOL call that LOST its identity (marker, no caller header) fails
      // CLOSED — it must never fall through to this unrestricted operator path
      // (codex finding 2). Honor-system caveat (design §5): with a shared
      // bearer token the scoping is best-effort — it refuses to TEACH the
      // pattern, it cannot police curl.
      const stopCaller = resolveScopedWriteCallerIdentity(req.headers);
      if (stopCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (stopCaller.kind === "session" && !isDescendantOf(params.id, stopCaller.callerId, getSession)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `session ${params.id} is not a descendant of your session — agents may only stop sessions they spawned (directly or transitively). Ask the operator or the session's parent instead.`,
        }));
        return;
      }
      killSessionEngines(context, session, "Interrupted by user");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      updateSession(params.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
      context.emit("session:stopped", { sessionId: params.id });
      return json(res, { status: "stopped", sessionId: params.id });
    }

    // POST /api/sessions/:id/reset — clear stuck session state (stale engine IDs, errors)
    params = matchRoute("/api/sessions/:id/reset", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      killSessionEngines(context, session, "Interrupted: session reset");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      delete meta["engineSessions"];
      delete meta["engineOverride"];
      clearEngineSessionRefs(params.id);
      updateSession(params.id, {
        status: "idle",
        lastActivity: new Date().toISOString(),
        lastError: null,
        transportMeta: meta as any,
      });
      logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, { status: "reset", sessionId: params.id });
    }

    // POST /api/sessions/:id/duplicate — duplicate a session (snapshot fork)
    params = matchRoute("/api/sessions/:id/duplicate", pathname);
    if (method === "POST" && params) {
      const source = getSession(params.id);
      if (!source) return notFound(res);
      if (!source.engineSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session has no engine session ID — cannot duplicate" }));
        return;
      }

      let newSessionId: string | null = null;
      try {
        // 1. Duplicate session + messages in the registry
        const { session: newSession, messageCount } = duplicateSession(params.id);
        newSessionId = newSession.id;

        // 2. Fork the engine session (Claude/Codex). For Claude, route through
        //    the interactive PTY fork (no `-p`) so the duplicate bills as
        //    cc_entrypoint=cli rather than the de-subsidized Agent-SDK headless
        //    pool. Codex ignores the interactive ctx (it just copies the JSONL).
        const interactive = source.engine === "claude" && context.interactiveClaudeEngine
          ? {
              sourceJinnSessionId: params.id,
              engine: context.interactiveClaudeEngine,
              bin: context.getConfig().engines.claude.bin,
            }
          : undefined;
        const forkResult = await forkEngineSession(source.engine, source.engineSessionId, JINN_HOME, interactive);

        // 3. Store the new engine session ID
        recordEngineSessionId(newSession.id, newSession.engine, forkResult.engineSessionId, {
          model: newSession.model ?? undefined,
          effortLevel: newSession.effortLevel ?? undefined,
        });

        const result = getSession(newSession.id)!;
        logger.info(`Session duplicated: ${params.id} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
        context.emit("session:created", { sessionId: newSession.id });
        return json(res, serializeSession(result, context));
      } catch (err: any) {
        // Clean up orphaned session if the engine fork failed after DB insert
        if (newSessionId) {
          try { deleteSession(newSessionId); } catch { /* best effort */ }
        }
        logger.error(`Failed to duplicate session ${params.id}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Duplicate failed: ${err.message}` }));
        return;
      }
    }

    // DELETE /api/sessions/:id/queue/:itemId — cancel specific item
    const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
    if (method === "DELETE" && queueItemParams) {
      const session = getSession(queueItemParams.id);
      if (!session) return notFound(res);
      const cancelled = cancelQueueItem(queueItemParams.itemId);
      if (!cancelled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found or already running" }));
        return;
      }
      context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
      return json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    }

    // GET /api/sessions/:id/queue
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const items = getQueueItems(session.sessionKey || session.sourceRef || session.id);
      return json(res, items);
    }

    // DELETE /api/sessions/:id/queue — clear all pending
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().clearQueue(sessionKey);
      const cancelled = cancelAllPendingQueueItems(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
      return json(res, { status: "cleared", cancelled });
    }

    // POST /api/sessions/:id/queue/pause
    params = matchRoute("/api/sessions/:id/queue/pause", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
      return json(res, { status: "paused", sessionId: params.id });
    }

    // POST /api/sessions/:id/queue/resume
    params = matchRoute("/api/sessions/:id/queue/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
      return json(res, { status: "resumed", sessionId: params.id });
    }

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const ids: string[] = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, "ids array is required");

      // Tear down any live/warm engine processes before deleting. kill() is safe
      // to call unconditionally — it's a no-op when nothing is running.
      for (const id of ids) {
        const session = getSession(id);
        if (!session) continue;
        killSessionEngines(context, session, "Interrupted: session deleted");
        context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      }

      for (const id of ids) {
        maybeEmitTalkGraph(id, "removed", { getSession, emit: context.emit });
      }
      const count = deleteSessions(ids);
      for (const id of ids) {
        // Remove any per-session Codex CODEX_HOME overlay for each deleted id
        // (session-scoped capability on disk). No-op for non-codex sessions.
        removeCodexSessionHome(id);
        context.emit("session:deleted", { sessionId: id });
      }
      logger.info(`Bulk deleted ${count} sessions`);
      return json(res, { status: "deleted", count });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listChildSessions(params.id);
      return json(res, children.map((child) => serializeSession(child, context)));
    }

    // GET /api/sessions/:id/context?message=<id>&radius=<n> — GRS-020a: the
    // bounded ±radius window around a message anchor (a search hit), so a hit
    // becomes readable in place without a full-transcript read. Content is
    // capped store-side (MESSAGE_CONTEXT_CHAR_CAP + intentional-cap marker);
    // the session field is the COMPACT summary (GRS-020a-fix finding 5).
    params = matchRoute("/api/sessions/:id/context", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const messageId = readCleanSearchParam(url, "message");
      if (!messageId) return badRequest(res, "message (the anchor message id, from a search hit) is required");
      const radius = Math.max(
        1,
        Math.min(parseInt(url.searchParams.get("radius") || "3", 10) || 3, MESSAGE_CONTEXT_MAX_RADIUS),
      );
      const context_ = getMessageContext(params.id, messageId, radius);
      if (!context_) {
        return json(res, { error: `message "${messageId}" not found in session "${params.id}" — anchors come from message-search results` }, 404);
      }
      return json(res, {
        session: compactSessionSummary(session),
        anchorMessageId: context_.anchorMessageId,
        messages: context_.messages,
      });
    }

    // GET /api/work-items — compact Todo list for MCP/web surfaces.
    if (method === "GET" && pathname === "/api/work-items") {
      const filter: SearchWorkItemsFilter = {};
      const status = readWorkItemStatusParam(url);
      if (status === null) return badRequest(res, `status must be one of ${WORK_ITEM_STATUSES.join(", ")}`);
      if (status) filter.status = status;
      const source = readWorkItemSourceParam(url);
      if (source === null) return badRequest(res, `source must be one of ${WORK_ITEM_SOURCES.join(", ")}`);
      if (source) filter.source = source;
      const assignee = readCleanSearchParam(url, "assignee");
      if (assignee) filter.assignee = assignee;
      const department = readCleanSearchParam(url, "department");
      if (department) filter.department = department;
      const needsAttentionFor = readCleanSearchParam(url, "needsAttentionFor");
      if (needsAttentionFor) {
        const target = resolveNeedsAttentionTarget(req, res, needsAttentionFor);
        if (!target) return;
        filter.needsAttentionFor = target;
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 20));
      return json(res, { workItems: listWorkItems({ ...filter, limit }).map(compactWorkItem) });
    }

    // POST /api/work-items — GRS-021c create. Tool callers must carry identity;
    // create structurally cannot attach approvals (anti-bottleneck LAW).
    if (method === "POST" && pathname === "/api/work-items") {
      const caller = resolveWorkItemCaller(req, res);
      if (!caller) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached at Todo creation — approvals are requested/decided through the approval authority surface`);
      }
      if (body.provenance !== undefined) {
        return badRequest(res, "provenance cannot be supplied on public Todo creation — cron/workflow/delegation source records are minted only by their dedicated bridges; normal tool/session creation is source=session");
      }
      const title = typeof body.title === "string" ? stripControlChars(body.title).trim() : "";
      if (!title) return badRequest(res, "title is required");
      const verifyPolicy = validateVerifyPolicy(body.verifyPolicy);
      if (!verifyPolicy.ok) return badRequest(res, verifyPolicy.error);
      const source: WorkItemSource = caller.kind === "session" ? "session" : "human";
      const input: CreateWorkItemInput = {
        title: title.slice(0, 200),
        body: typeof body.body === "string" ? body.body : null,
        acceptance: typeof body.acceptance === "string" ? body.acceptance : null,
        assignee: typeof body.assignee === "string" && body.assignee.trim() ? body.assignee.trim() : null,
        department: typeof body.department === "string" && body.department.trim() ? body.department.trim() : null,
        source,
        sourceRef: source === "session" && caller.kind === "session" ? `session:${caller.callerId}:${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` : null,
        verifyPolicy: verifyPolicy.value,
      };
      try {
        const item = createWorkItem(input);
        return json(res, { workItem: item }, 201);
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/work-items/:id — full Todo detail.
    params = matchRoute("/api/work-items/:id", pathname);
    if (method === "GET" && params) {
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      return json(res, fullWorkItemPayload(item));
    }

    // POST /api/work-items/:id/status — GRS-021c guarded status update. Agents
    // may keep their own work current; self-done and authority-only edges are
    // refused readably.
    params = matchRoute("/api/work-items/:id/status", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res);
      if (!caller) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo status updates — approvals are requested/decided through the approval authority surface`);
      }
      const target = typeof body.status === "string" ? body.status : "";
      if (target === "cancelled") {
        return json(res, { error: "cancelling a Todo is a human surface decision; agents do not have a cancel tool" }, 403);
      }
      if (!(AGENT_WORK_ITEM_TARGETS as readonly string[]).includes(target)) {
        return badRequest(res, `status must be one of ${AGENT_WORK_ITEM_TARGETS.join(", ")} for agent updates; other lifecycle edits use the human surface`);
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if ((target === "blocked" || target === "escalated") && !note) {
        return badRequest(res, `note is required when moving a Todo to ${target}`);
      }
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authorized = authorizeAgentWorkItemStatus(caller, item, target as WorkItemStatus);
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      try {
        const result = transition(params.id, target as WorkItemStatus, workItemActor(caller), {
          callerSessionId: caller.kind === "session" ? caller.callerId : undefined,
          detail: note ? { note } : undefined,
        });
        return json(res, { workItem: result.item, escalated: result.escalated });
      } catch (err) {
        if (err instanceof TransitionError) {
          if (err.code === "not-found") return notFound(res);
          const human = err.code === "self-review-banned"
            ? `${err.message} — use the human review surface / a reviewer session to mark done`
            : `${err.message} — use the human surface for this transition if it is intentional`;
          const statusCode = err.code === "illegal-edge" ? 400 : 403;
          return json(res, { error: human }, statusCode);
        }
        throw err;
      }
    }

    // POST /api/work-items/:id/assign — roster-validated collaborative write.
    params = matchRoute("/api/work-items/:id/assign", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res);
      if (!caller) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo assignment — approvals are requested/decided through the approval authority surface`);
      }
      const assignee = typeof body.assignee === "string"
        ? (body.assignee as string).trim()
        : "";
      if (!assignee) return badRequest(res, "assignee is required");
      const { scanOrg } = await import("./org.js");
      const roster = scanOrg();
      const employee = roster.get(assignee);
      if (!employee) {
        const near = nearestEmployee(assignee, [...roster.keys()]);
        return badRequest(
          res,
          `unknown employee "${assignee}"${near ? `. Did you mean "${near}"?` : ""} Check find_employees or GET /api/org for valid employees`,
        );
      }
      const current = getWorkItem(params.id);
      if (!current) return notFound(res);
      if (STICKY_STATUSES.has(current.status)) {
        return json(res, { error: `cannot assign Todo ${current.id} while it is in terminal state ${current.status}` }, 409);
      }
      const explicitSelfClaim =
        caller.kind === "session" &&
        current.status === "backlog" &&
        current.assignee === null &&
        caller.session.employee === assignee;
      if (!explicitSelfClaim) {
        const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, current, "assign");
        if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      }
      try {
        const item = assignWorkItem(params.id, assignee, employee.department ?? null, workItemActor(caller));
        if (!item) return notFound(res);
        return json(res, { workItem: item });
      } catch (err) {
        if (err instanceof TransitionError) {
          const statusCode = err.code === "conflict" ? 409 : 400;
          return json(res, { error: err.message }, statusCode);
        }
        throw err;
      }
    }

    // POST /api/work-items/:id/archive — non-deleting Todo archive. This preserves
    // the work_items row and event log, using the existing closed `cancelled`
    // terminal internally while presenting the action as archive on tool surfaces.
    params = matchRoute("/api/work-items/:id/archive", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res);
      if (!caller) return;
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return;
      if (parsed.body !== undefined && (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body))) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = (parsed.body ?? {}) as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo archive — approvals are requested/decided through the approval authority surface`);
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, item, "archive");
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      try {
        const archived = archiveWorkItem(params.id, workItemActor(caller), {
          ...(caller.kind === "operator" ? { human: true } : {}),
          ...(caller.kind === "session" ? { callerSessionId: caller.callerId } : {}),
          ...(note ? { note } : {}),
        });
        return json(res, { workItem: archived, archived: true });
      } catch (err) {
        if (err instanceof TransitionError) {
          if (err.code === "not-found") return notFound(res);
          const statusCode = err.code === "illegal-edge" ? 400 : 403;
          return json(res, { error: `${err.message} — archive preserves the Todo; use another lifecycle action first if needed` }, statusCode);
        }
        throw err;
      }
    }

    // GET /api/work-items/:id/sessions — execution attempts linked to a work item.
    // The read-back half of the GRS-002 work-item slice (cron mints+links an item).
    params = matchRoute("/api/work-items/:id/sessions", pathname);
    if (method === "GET" && params) {
      const linked = listSessionsByWorkItem(params.id);
      return json(res, linked.map((s) => serializeSession(s, context)));
    }

    // POST /api/work-items/:id/approval — approval DECISION surface.
    // COO-default: routed manager or root/COO can decide through the same
    // identity/capability seam MCP uses; operator/aCEO HTTP can decide only after
    // explicit escalation persisted on the Todo.
    // {decision:"approve"|"reject", note?}. Native decisions apply the FIXED
    // consequence rules (approve+in_review → done; reject+in_review → bounce/escalate;
    // otherwise the decision is recorded, status untouched). A MIRRORED workflow park
    // routes the decision to the shipped resolve-gate authority.
    params = matchRoute("/api/work-items/:id/approval", pathname);
    if (method === "POST" && params) {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const decision = (parsed.body as { decision?: unknown }).decision;
      if (decision !== "approve" && decision !== "reject") {
        return badRequest(res, 'decision must be "approve" or "reject"');
      }
      const noteRaw = (parsed.body as { note?: unknown }).note;
      const note = typeof noteRaw === "string" ? noteRaw : undefined;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveApprovalDecisionAuthority(req.headers, item, { operatorCanActOnRootTarget: true });
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);

      // The resolve-gate authority is wired only when a workflow evidence root
      // exists; without it a mirrored decision reports evidence-root-missing (503).
      const evidenceRoot = resolveWorkflowEvidenceRoot();
      const result = await decideWorkItemApproval(
        { id: params.id, decision, ...(note !== undefined ? { note } : {}), decidedBy: authority.authority.actor },
        evidenceRoot
          ? {
              resolveWorkflowGate: async (workflowId, runId, d, decidedBy) => {
                const r = await resolveWorkflowRunGate(workflowRunDriverDeps(evidenceRoot, context), workflowId, runId, d, { decidedBy });
                return { outcome: r.outcome, ...(r.outcome !== "not-found" ? { runStatus: r.run.status } : {}) };
              },
            }
          : {},
      );
      if (!result.ok) {
        switch (result.code) {
          case "not-found":
            return notFound(res);
          case "evidence-root-missing":
            return json(res, { error: result.message }, 503);
          case "no-pending":
          case "run-not-found":
            return json(res, { error: result.message }, 409);
          case "run-not-parked":
            return json(res, { error: result.message, ...(result.runStatus ? { status: result.runStatus } : {}) }, 409);
          default:
            return json(res, { error: result.message }, 400);
        }
      }
      return json(res, {
        workItem: result.item,
        escalated: result.escalated,
        mirrored: result.mirrored,
        ...(result.runStatus ? { runStatus: result.runStatus } : {}),
      });
    }

    // POST /api/work-items/:id/approval/escalate — routed approval authority can
    // deliberately expose this pending approval to the operator/aCEO path.
    params = matchRoute("/api/work-items/:id/approval/escalate", pathname);
    if (method === "POST" && params) {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveApprovalDecisionAuthority(req.headers, item, { operatorCanActOnRootTarget: true });
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);
      const body = (parsed.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      try {
        return json(res, { workItem: escalateApproval(params.id, authority.authority.actor, reason) });
      } catch (err) {
        if (err instanceof Error && /no pending approval/i.test(err.message)) {
          return json(res, { error: err.message }, 409);
        }
        throw err;
      }
    }

    // GET /api/workflows — list workflow ids (GRS-009 read-only visualization).
    // Workflow run state is a DERIVED VIEW over shipped primitives (GRS-007 §5);
    // this endpoint reads definition + evidence files under JINN_WORKFLOW_EVIDENCE_ROOT
    // and computes state. It writes nothing.
    if (method === "GET" && pathname === "/api/workflows") {
      const ev = resolveWorkflowEvidence();
      if (!ev.root) return json(res, { workflows: [], evidenceConfigured: false, ...(ev.reason ? { evidenceReason: ev.reason } : {}) });
      return json(res, { workflows: listWorkflowIds(ev.root), evidenceConfigured: true });
    }

    // GET /api/workflows/:id — one workflow's definition + derived run state.
    params = matchRoute("/api/workflows/:id", pathname);
    if (method === "GET" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return notFound(res);
      try {
        return json(res, deriveRunState(root, params.id));
      } catch (err) {
        // Missing/invalid definition → 404, not a 500 (KISS: one hardcoded example today).
        logger.warn(`workflow derive failed for ${params.id}: ${(err as Error).message}`);
        return notFound(res);
      }
    }

    // ── Workflow CUSTOM TRIGGERS (GRS-027 S5/S6) ─────────────────────────────
    // Custom sources persist as bindings outside the workflow definition schema and
    // emit the same uniform trigger envelope into startWorkflowRunFromTrigger.
    if (pathname === "/api/workflow-events" && method === "POST") {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);

      const gatewayAuthorized = hasGatewayBearerAuth(req.headers, context.gatewayAuthToken);
      const token = workflowEventToken(req.headers);
      const bindingAuthorized = !gatewayAuthorized && verifyAnyWorkflowTriggerBindingToken(root, token);
      if (!gatewayAuthorized && !bindingAuthorized) {
        return json(res, { error: "Workflow event authentication required" }, 401);
      }
      const rateKey = gatewayAuthorized
        ? workflowEventRateLimitKeyFromToken("gateway", context.gatewayAuthToken ?? token ?? "gateway")
        : workflowEventRateLimitKeyFromToken("binding", token!);
      const rate = checkWorkflowEventRateLimit(rateKey);
      if (!rate.ok) {
        return json(res, { error: "Workflow event rate limit exceeded", resetAt: rate.resetAt }, 429);
      }

      const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_EVENT_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "Request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      if (typeof body.event !== "string" || !body.event.trim()) return badRequest(res, "event is required");
      let payload: Record<string, unknown>;
      try {
        payload = sanitizeWorkflowTriggerPayload(body.payload);
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : "payload must be a JSON object");
      }
      const fireRef = typeof body.fireRef === "string" && body.fireRef.trim() ? body.fireRef.trim() : undefined;
      const result = await fireWorkflowEvent(
        workflowRunDriverDeps(root, context),
        { event: body.event, payload, ...(fireRef ? { fireRef } : {}) },
        { gatewayAuthorized, ...(bindingAuthorized && token ? { authorizedSecretToken: token } : {}) },
      );
      if (result.rejected === "no-matching-binding") {
        return json(res, { error: "No matching workflow trigger binding", outcomes: [] }, 404);
      }
      if (result.rejected) {
        return badRequest(res, `Workflow event rejected: ${result.rejected}`);
      }
      return json(res, { outcomes: result.outcomes }, 202);
    }

    if (pathname === "/api/workflow-triggers") {
      const ev = resolveWorkflowEvidence();
      const root = ev.root;
      if (method === "GET") {
        if (!root) return json(res, { triggers: [], evidenceConfigured: false, ...(ev.reason ? { evidenceReason: ev.reason } : {}) });
        try {
          return json(res, { triggers: listPublicWorkflowTriggerBindings(root), evidenceConfigured: true });
        } catch (err) {
          return workflowTriggerStoreErrorResponse(res, err);
        }
      }
      if (method === "POST") {
        if (!root) return json(res, { error: ev.reason ?? "Workflow evidence root is not configured" }, 503);
        const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
        if (!parsed.ok) return;
        if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
          return badRequest(res, "Request body must be a JSON object");
        }
        const body = parsed.body as Record<string, unknown>;
        const targetWorkflowId = typeof body.targetWorkflowId === "string" ? body.targetWorkflowId : "";
        const targetWorkflow = targetWorkflowId ? getDefinition(root, targetWorkflowId) : null;
        if (!targetWorkflow) {
          return json(res, { error: "target workflow not found" }, 404);
        }
        const authority = authorizeWorkflowOperation(req.headers, targetWorkflow, "bind-trigger");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        const actor = authority.actor;
        try {
          let approvalPayload: Record<string, unknown> | undefined;
          const input: Record<string, unknown> = { ...body, createdBy: actor };
          const created = createWorkflowTriggerBinding(root, input as unknown as Parameters<typeof createWorkflowTriggerBinding>[1]);
          let bindingName = created.binding.name;
          if (body.kind === "poll") {
            if (created.binding.kind !== "poll") {
              throw new Error("poll trigger creation returned a non-poll binding");
            }
            const triggerName = created.binding.name;
            try {
              const target = resolveRootApprovalTarget();
              const approvalRequest = formatPollActivationApprovalRequest(created.binding);
              const item = createWorkItem({
                title: `Activate poll trigger "${triggerName}"`,
                body: approvalRequest,
                status: "backlog",
                source: "workflow",
                sourceRef: `workflow-trigger:${triggerName}:activation`,
                assignee: target?.name ?? null,
                department: target?.department ?? null,
              });
              const workItem = requestApproval(item.id, {
                request: approvalRequest,
                target: target?.name ?? null,
                actor,
              });
              const updated = updateWorkflowTriggerBinding(root, {
                ...withPollActivationContract(created.binding),
                approvalWorkItemId: workItem.id,
                activation: "pending_approval",
              });
              bindingName = updated.name;
              approvalPayload = { workItem };
            } catch (approvalErr) {
              deleteWorkflowTriggerBinding(root, created.binding.name);
              throw approvalErr;
            }
          }
          return json(
            res,
            {
              trigger: listPublicWorkflowTriggerBindings(root).find((t) => t.name === bindingName) ?? created.binding,
              ...(created.secretToken ? { secretToken: created.secretToken } : {}),
              ...(approvalPayload ? { approval: approvalPayload } : {}),
            },
            201,
          );
        } catch (err) {
          return workflowTriggerStoreErrorResponse(res, err);
        }
      }
    }

    params = matchRoute("/api/workflow-triggers/:name", pathname);
    if (method === "DELETE" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      try {
        const binding = getWorkflowTriggerBinding(root, params.name);
        if (!binding) return notFound(res);
        const targetWorkflow = getDefinition(root, binding.targetWorkflowId);
        if (!targetWorkflow) {
          const authority = authorizeWorkflowOperation(req.headers, null, "bind-trigger");
          if (!authority.ok) {
            return json(res, { error: authority.error }, authority.status);
          }
          const deleted = deleteWorkflowTriggerBinding(root, params.name);
          if (!deleted) return notFound(res);
          return json(res, { deleted: true, name: params.name, orphaned: true });
        }
        const authority = authorizeWorkflowOperation(req.headers, targetWorkflow, "bind-trigger");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        const deleted = deleteWorkflowTriggerBinding(root, params.name);
        if (!deleted) return notFound(res);
        return json(res, { deleted: true, name: params.name });
      } catch (err) {
        return workflowTriggerStoreErrorResponse(res, err);
      }
    }

    // ── Workflow DEFINITION CRUD (GRS-011b) ──────────────────────────────────
    // Editable workflow definitions live at <evidenceRoot>/workflows/<id>.definition.json,
    // a SEPARATE artifact from the read-only run-state surface above (Edit view vs Run
    // view). Every write validates the graph (validateDefinition) and bumps version/
    // updatedAt in the store; editing a definition never mutates historical run receipts.
    // Namespaced under /api/workflow-definitions to avoid colliding with /api/workflows.
    if (method === "POST" && pathname === "/api/workflow-definitions/plan") {
      const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "Request body must be a JSON object");
      }
      try {
        return json(res, planWorkflowAuthoringInput(parsed.body as Record<string, unknown>));
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    if (pathname === "/api/workflow-definitions") {
      const ev = resolveWorkflowEvidence();
      const root = ev.root;
      if (method === "GET") {
        if (!root) return json(res, { definitions: [], evidenceConfigured: false, ...(ev.reason ? { evidenceReason: ev.reason } : {}) });
        return json(res, { definitions: listDefinitions(root), evidenceConfigured: true });
      }
      if (method === "POST") {
        // Resolve the root BEFORE reading the body so an unconfigured gateway 503s
        // without buffering a (capped) request body.
        if (!root) return json(res, { error: ev.reason ?? "Workflow evidence root is not configured" }, 503);
        const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
        if (!parsed.ok) return;
        if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
          return badRequest(res, "Request body must be a JSON object");
        }
        try {
          const body = parsed.body as Record<string, unknown>;
          const authority = authorizeWorkflowOperation(req.headers, null, "create");
          if (!authority.ok) {
            return json(res, { error: authority.error }, authority.status);
          }
          const safeBody = authority.actor === "operator" ? body : stripWorkflowAuthorityFields(body as Partial<EditableWorkflowDefinition>);
          const created = createDefinition(root, { ...safeBody, ...workflowDefinitionAuthorPatch(authority) } as unknown as EditableWorkflowDefinition);
          syncWorkflowCronJobsForRoot(root); // GRS-014d: schedule triggers become managed cron jobs
          return json(res, created, 201);
        } catch (err) {
          return workflowStoreErrorResponse(res, err);
        }
      }
    }

    // POST /api/workflow-definitions/:id/duplicate — copy a definition to a new id.
    params = matchRoute("/api/workflow-definitions/:id/duplicate", pathname);
    if (method === "POST" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = (parsed.body ?? {}) as { newId?: string; title?: string };
      try {
        const existing = getDefinition(root, params.id);
        if (!existing) return notFound(res);
        const authority = authorizeWorkflowOperation(req.headers, existing, "duplicate");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        const dup = duplicateDefinition(root, params.id, {
          newId: body.newId,
          title: body.title,
          definitionPatch: workflowDefinitionAuthorityResetPatch(authority),
        });
        syncWorkflowCronJobsForRoot(root); // a duplicate is a create — its schedule syncs too
        return json(res, dup, 201);
      } catch (err) {
        return workflowStoreErrorResponse(res, err);
      }
    }

    // POST /api/workflow-definitions/:id/retire — soft-delete (status=retired).
    params = matchRoute("/api/workflow-definitions/:id/retire", pathname);
    if (method === "POST" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      try {
        const existing = getDefinition(root, params.id);
        if (!existing) return notFound(res);
        const authority = authorizeWorkflowOperation(req.headers, existing, "retire");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        const retired = retireDefinition(root, params.id);
        syncWorkflowCronJobsForRoot(root); // GRS-014d: retiring removes the managed cron job
        return json(res, retired);
      } catch (err) {
        return workflowStoreErrorResponse(res, err);
      }
    }

    // GET /api/workflow-definitions/:id/plan — DRY-RUN compile (GRS-011d-1). Resolves the
    // editable definition into a concrete execution plan (trigger→cron shape, step→session
    // spawn spec, gate→evaluator kind, approval gate→run-parking) OR structured execution
    // errors, WITHOUT running anything. Read-only + pure: it never spawns a session or mutates
    // a run receipt. This is the dry-run the Edit view calls to surface "this definition cannot
    // execute because…" the same way it surfaces validation errors. (Live roster injection +
    // actually driving a sandbox run from a plan is GRS-011d-2.)
    params = matchRoute("/api/workflow-definitions/:id/plan", pathname);
    if (method === "GET" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return notFound(res);
      try {
        const def = getDefinition(root, params.id);
        if (!def) return notFound(res);
        return json(res, resolveExecutionPlan(def));
      } catch (err) {
        return workflowStoreErrorResponse(res, err);
      }
    }

    // POST /api/workflow-definitions/:id/run — START a run of the definition (GRS-014b).
    // Sequential engine: mint the durable pending-receipts record (edge-implied topo order,
    // declaration tiebreak) BEFORE any spawn, then drive the first advancement — pass-through
    // nodes settle, the FIRST actor step spawns through the SAME createSession+dispatch path
    // the UI uses, mid-graph approval gates PARK the run with downstream steps still pending.
    // Subsequent steps are dispatched by the run reconciler as each session settles; the
    // response is the run's current snapshot (usually status:"running" with one step in
    // flight, or parked/completed/failed). Cyclic graphs are refused (unsupported-cycle)
    // until GRS-014e's bounded loops.
    //
    // HONEST SANDBOX SCOPE: running a workflow spawns REAL sessions on whichever
    // gateway serves this request. The evidence root only says where definition/run
    // files live, not that the target is isolated. Without an explicit
    // JINN_WORKFLOW_EVIDENCE_ROOT this route 503s and is inert.
    // Sessions it spawns are linked/tagged (sourceRef `workflow-run:<runId>:<nodeId>:<attempt>`).
    params = matchRoute("/api/workflow-definitions/:id/run", pathname);
    if (method === "POST" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = (parsed.body ?? {}) as { trigger?: "manual" | "schedule" };
      try {
        const def = getDefinition(root, params.id);
        if (!def) return notFound(res);
        const authority = authorizeWorkflowOperation(req.headers, def, "run");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        // Store invariant: the on-disk file named <id> must carry id===<id> (createDefinition
        // enforces it, update keeps it immutable). Guard against a hand-corrupted file so a run
        // never persists under a different workflowId than the route id (Codex Major 2 sub-point).
        if (def.id !== params.id) {
          return badRequest(res, `definition file "${params.id}" has mismatched id "${def.id}"`);
        }
        const { scanOrg } = await import("./org.js");
        const knownEmployees = [...scanOrg().keys()];
        const knownEngines = [...context.sessionManager.getEngines().keys()];
        const trigger = body.trigger === "schedule"
          ? { source: "schedule" as const, event: "schedule.fire", payload: { workflowId: def.id, requestedBy: "api" } }
          : { source: "manual" as const, event: "workflow.manual_started", payload: { workflowId: def.id, requestedBy: "api" } };
        const run = await startWorkflowRunFromTrigger(workflowRunDriverDeps(root, context), def, trigger, {
          knownEmployees,
          knownEngines,
        });
        return json(res, run, run.status === "failed" ? 422 : 201);
      } catch (err) {
        if (err instanceof WorkflowRunStoreError) {
          return json(res, { error: err.message, code: err.code }, err.code === "not-found" ? 404 : 400);
        }
        return workflowStoreErrorResponse(res, err);
      }
    }

    // POST /api/workflow-definitions/:id/runs/:runId/resolve-gate — resolve a PARKED
    // run's human-approval gate (GRS-014e): {decision:"approve"} unparks and drives the
    // run forward through the same driver path the sweep uses; {decision:"reject"}
    // fails it with an operator-rejection receipt. Parked runs are never swept —
    // this route is the ONLY unpark. 404 unknown run; 409 when the run is not parked.
    params = matchRoute("/api/workflow-definitions/:id/runs/:runId/resolve-gate", pathname);
    if (method === "POST" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const decision = (parsed.body as { decision?: unknown } | null)?.decision;
      if (decision !== "approve" && decision !== "reject") {
        return badRequest(res, 'decision must be "approve" or "reject"');
      }
      const run = getRun(root, params.id, params.runId);
      if (!run) return notFound(res);
      const triggerTodoId = workflowRunTriggerTodoId(run);
      let item = getWorkItemBySourceRef("workflow", `workflow:${params.id}:${params.runId}`)
        ?? (triggerTodoId ? getWorkItem(triggerTodoId) : undefined);
      if (!item && run.status === "parked" && run.parked) {
        createWorkflowTodoBridge().mirrorParkedGate(run, {
          description: run.parked.description,
          ...(run.parked.ref ? { ref: run.parked.ref } : {}),
        });
        item = getWorkItemBySourceRef("workflow", `workflow:${params.id}:${params.runId}`)
          ?? (triggerTodoId ? getWorkItem(triggerTodoId) : undefined);
      }
      if (!item) {
        return json(res, { error: "workflow gate resolution requires the mirrored Todo approval record" }, 409);
      }
      const authority = resolveApprovalDecisionAuthority(req.headers, item);
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);
      try {
        const result = await resolveWorkflowRunGate(workflowRunDriverDeps(root, context), params.id, params.runId, decision, { decidedBy: authority.authority.actor });
        if (result.outcome === "not-found") return notFound(res);
        if (result.outcome === "not-parked") {
          return json(res, { error: `run is ${result.run.status}, not parked`, status: result.run.status }, 409);
        }
        return json(res, result.run);
      } catch (err) {
        if (err instanceof WorkflowRunStoreError) {
          return json(res, { error: err.message, code: err.code }, err.code === "not-found" ? 404 : 400);
        }
        return workflowStoreErrorResponse(res, err);
      }
    }

    // GET /api/workflow-definitions/:id/runs — list runs of a definition (newest first).
    params = matchRoute("/api/workflow-definitions/:id/runs", pathname);
    if (method === "GET" && params) {
      const ev = resolveWorkflowEvidence();
      const root = ev.root;
      if (!root) return json(res, { runs: [], evidenceConfigured: false, ...(ev.reason ? { evidenceReason: ev.reason } : {}) });
      try {
        return json(res, { runs: listRuns(root, params.id), evidenceConfigured: true });
      } catch (err) {
        if (err instanceof WorkflowRunStoreError) return json(res, { error: err.message, code: err.code }, 400);
        return workflowStoreErrorResponse(res, err);
      }
    }

    // GET /api/workflow-definitions/:id/runs/:runId — one run record.
    params = matchRoute("/api/workflow-definitions/:id/runs/:runId", pathname);
    if (method === "GET" && params) {
      const root = resolveWorkflowEvidenceRoot();
      if (!root) return notFound(res);
      try {
        const run = getRun(root, params.id, params.runId);
        if (!run) return notFound(res);
        return json(res, run);
      } catch (err) {
        if (err instanceof WorkflowRunStoreError) return json(res, { error: err.message, code: err.code }, 400);
        return workflowStoreErrorResponse(res, err);
      }
    }

    // GET /api/workflow-definitions/:id — full editable definition.
    // PUT /api/workflow-definitions/:id — update (shallow patch; version bump; optimistic lock).
    params = matchRoute("/api/workflow-definitions/:id", pathname);
    if (params && (method === "GET" || method === "PUT")) {
      const root = resolveWorkflowEvidenceRoot();
      if (method === "GET") {
        if (!root) return notFound(res);
        try {
          const def = getDefinition(root, params.id);
          if (!def) return notFound(res);
          return json(res, def);
        } catch (err) {
          return workflowStoreErrorResponse(res, err);
        }
      }
      // PUT
      if (!root) return json(res, { error: "Workflow evidence root is not configured" }, 503);
      const parsed = await readJsonBody(req, res, { maxBytes: WORKFLOW_DEFINITION_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (parsed.body !== null && (typeof parsed.body !== "object" || Array.isArray(parsed.body))) {
        return badRequest(res, "Request body must be a JSON object");
      }
      const body = (parsed.body ?? {}) as Partial<EditableWorkflowDefinition> & {
        expectedVersion?: number;
      };
      const { expectedVersion, ...patch } = body;
      try {
        const existing = getDefinition(root, params.id);
        if (!existing) return notFound(res);
        const authority = authorizeWorkflowOperation(req.headers, existing, "update");
        if (!authority.ok) {
          return json(res, { error: authority.error }, authority.status);
        }
        const safePatch = authority.canSetWorkflowAuthority ? patch : stripWorkflowAuthorityFields(patch);
        const updated = updateDefinition(root, params.id, safePatch, { expectedVersion });
        syncWorkflowCronJobsForRoot(root); // GRS-014d: schedule/status edits re-derive the managed cron job
        return json(res, updated);
      } catch (err) {
        return workflowStoreErrorResponse(res, err);
      }
    }

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const claudeSessionId = getEngineSessionRef(session, "claude").id;
      if (!claudeSessionId) return json(res, []);
      const entries = loadRawTranscript(claudeSessionId);
      return json(res, entries);
    }

    // POST /api/delegations — the delegation transaction (GRS-017d, design §4).
    // ONE atomic in-process handler: mint the work item (the durable record of
    // INTENT), spawn the delegate session, link the two, derive the item's live
    // status — all before responding. It lives HERE, where the store functions
    // live, because composing mint→spawn→link as three HTTP calls from a client
    // (the MCP tool) would re-create exactly the partial-failure windows
    // GRS-003b-2b spent a wave closing (crash after spawn, before link → orphan).
    //
    // MINT-BEFORE-SPAWN, LINK-BEFORE-DISPATCH (the cron bridge's proven
    // ordering, tightened per the 017d codex review): the work item (intent) is
    // minted first; the session ROW is created and LINKED before the engine
    // turn is dispatched. So a crash at any point leaves either a recoverable
    // `open` item with zero sessions, or a linked reconciler-derivable pair —
    // never a running-but-unlinked orphan. Status is `open` at mint, never
    // hardcoded `active`: reconcileWorkItem DERIVES the live status from the
    // linked session (the GRS-003a single-source-of-truth rule).
    //
    // Unlike the cron bridge (where the item is best-effort dogfood around a
    // job that must run regardless), here the work item IS the deliverable — a
    // delegation is "tracked work" by definition — so a mint failure aborts the
    // whole transaction with nothing spawned.
    if (method === "POST" && pathname === "/api/delegations") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;

      // Fail-closed tool identity (GRS-017 codex finding 2), same rule as spawn:
      // a delegation always acts on behalf of a session, so a tool call whose
      // identity got lost must never fall through to the operator path. Headers
      // only — the identity gate outranks body validation.
      const delegationCaller = resolveScopedWriteCallerIdentity(req.headers);
      if (delegationCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }

      // Body shape guard (017d codex review finding 2): `null`, arrays, and
      // scalars are valid JSON but not a delegation — a structured 400, not a
      // property-access 500 TypeError.
      if (!_parsed.body || typeof _parsed.body !== "object" || Array.isArray(_parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Validation — ALL of it before the mint, so a 400 never litters the
      // work-item table with garbage intent records.
      const task = typeof body.task === "string" && body.task.trim() ? (body.task as string) : undefined;
      if (!task) return badRequest(res, "task is required — the full brief for the delegate");
      const employeeName = typeof body.employee === "string" && body.employee.trim() ? (body.employee as string).trim() : undefined;
      const engineParam = typeof body.engine === "string" && body.engine.trim() ? (body.engine as string).trim() : undefined;
      if (!employeeName && !engineParam) {
        return badRequest(res, "employee or engine is required — delegate to a named employee (GET /api/org lists them) or to a bare engine");
      }
      const config = context.getConfig();
      let delegateEmployee: import("../shared/types.js").Employee | undefined;
      if (employeeName) {
        const { scanOrg } = await import("./org.js");
        delegateEmployee = scanOrg().get(employeeName);
        if (!delegateEmployee) {
          return badRequest(res, `unknown employee "${employeeName}" — GET /api/org lists valid employees`);
        }
      }
      const employeeDefaults = delegateEmployee
        ? {
            engine: delegateEmployee.engine,
            model: delegateEmployee.model,
            // GRS-017f: name the employee so an unregistered configured model
            // fails with an actionable, employee-named error, not a bare engine
            // string — the same clear signal spawn now surfaces.
            employee: employeeName,
            ...(delegateEmployee.effortLevel ? { effortLevel: delegateEmployee.effortLevel } : {}),
          }
        : undefined;
      const selection = validateNewSessionSelection(config, {
        engine: body.engine,
        model: body.model,
        effortLevel: body.effortLevel,
      }, employeeDefaults);
      if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
      const engineName = selection.engine || config.engines.default;

      // Parent resolution — the GRS-017a identity seam, spawn-route semantics:
      // explicit body.parentSessionId wins (internal callers); else the declared
      // caller identity, best-effort (unknown id → warn + parentless).
      let parentSessionId: string | undefined =
        typeof body.parentSessionId === "string" ? (body.parentSessionId as string) : undefined;
      if (delegationCaller.kind === "session" && body.parentSessionId === undefined) {
        if (getSession(delegationCaller.callerId)) {
          parentSessionId = delegationCaller.callerId;
        } else {
          logger.warn(`Ignoring unknown x-jinn-caller-session "${delegationCaller.callerId}" on delegation`);
        }
      }

      const title = (
        typeof body.title === "string" && body.title.trim() ? (body.title as string).trim() : task.split("\n")[0].trim()
      ).slice(0, 200);

      // 1. MINT — before any spawn step, including the engine lookup. The
      //    sourceRef mirrors the cron bridge's shape (`delegate:<caller>:<nonce>`);
      //    the nonce makes every delegation a distinct intent (there is no
      //    natural idempotency key for "delegate this again"). Provenance is
      //    first-class `delegation` since the GRS-021a vocabulary rebuild
      //    (pre-rebuild rows carried source 'session' + this ref shape and were
      //    remapped by the migration).
      const callerRef = delegationCaller.kind === "session" ? delegationCaller.callerId : "operator";
      let workItem;
      try {
        workItem = createWorkItem({
          title,
          body: task,
          status: "backlog",
          source: "delegation",
          sourceRef: `delegate:${callerRef}:${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          assignee: employeeName ?? null,
          department: delegateEmployee?.department ?? null,
        });
      } catch (mintErr) {
        logger.warn(`Delegation work-item mint failed: ${mintErr instanceof Error ? mintErr.message : mintErr}`);
        return json(res, { error: "delegation failed before any work started — the work item could not be minted; nothing was spawned" }, 500);
      }

      // 2. SPAWN — the irreversible step. A failure here PRESERVES the minted
      //    `backlog` item (durable intent, recoverable) and reports its id.
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        return json(res, {
          error: `engine "${engineName}" not available`,
          workItemId: workItem.id,
          hint: "the work item was minted before the spawn and is preserved as backlog — the delegation intent is durable, not lost",
        }, 502);
      }
      const sessionKey = `delegation:${workItem.id}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: employeeName ?? null,
        parentSessionId,
        model: selection.model,
        effortLevel: selection.effortLevel,
        prompt: task,
        title,
        portalName: config.portal?.portalName,
      });
      insertMessage(session.id, "user", task);

      // 3. LINK — BEFORE any dispatch step (017d codex review finding 1). The
      //    whole point of the in-process transaction is that the work item ↔
      //    session link is DURABLE before the worker can run: a crash from here
      //    on leaves a linked, reconciler-derivable pair, never a running-but-
      //    unlinked orphan next to a backlog item with zero sessions. The link is
      //    transactional and both rows were just created in-process, so a
      //    failure is a genuine anomaly — and because NOTHING has been
      //    dispatched yet, the honest response is to HALT: report both
      //    preserved ids (backlog item + idle, undispatched, re-linkable session)
      //    instead of dispatching an untracked turn.
      try {
        linkSession(workItem.id, session.id);
      } catch (linkErr) {
        logger.warn(`Delegation ${workItem.id} link failed before dispatch: ${linkErr instanceof Error ? linkErr.message : linkErr}`);
        return json(res, {
          error: "delegation halted before dispatch — linking the work item to the spawned session failed",
          workItemId: workItem.id,
          sessionId: session.id,
          hint: "nothing was dispatched: the backlog work item and the idle session row are both preserved and re-linkable",
        }, 500);
      }

      // 4. DERIVE + DISPATCH — mark the attempt running, let the reconciler
      //    derive the item's live status (`open`→`active`, the GRS-003a
      //    single-source-of-truth rule; best-effort — a derive hiccup never
      //    undoes a correctly linked delegation), then start the turn.
      updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
      session.status = "running";
      try {
        reconcileWorkItem(workItem.id);
      } catch (reconcileErr) {
        logger.warn(`Delegation ${workItem.id} reconcile failed: ${reconcileErr instanceof Error ? reconcileErr.message : reconcileErr}`);
      }
      logger.info(`Delegation ${workItem.id}: session ${session.id} linked + dispatching for ${employeeName ?? engineName}`);
      const delegationQueueKey = session.sessionKey || session.sourceRef || session.id;
      const delegationQueueItemId = enqueueQueueItem(session.id, delegationQueueKey, task);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: delegationQueueKey });
      dispatchWebSessionRun(session, task, engine, config, context, { queueItemId: delegationQueueItemId });
      maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });

      return json(res, {
        workItemId: workItem.id,
        sessionId: session.id,
        employee: employeeName ?? null,
        engine: engineName,
        model: selection.model ?? null,
        effortLevel: selection.effortLevel ?? null,
        status: session.status,
        title,
      }, 201);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      // GRS-017a identity seam: a spawn carrying x-jinn-caller-session (the jinn
      // MCP server run by another session) is auto-linked as that session's
      // child — the agent cannot forget the linkage and the child-completion
      // callback protocol works without it knowing the mechanic. An explicit
      // body.parentSessionId always wins (internal callers). Best-effort: an
      // unknown caller id is ignored with a warning, never a refusal.
      // A TOOL spawn that LOST its identity fails CLOSED (codex finding 2):
      // silently inheriting the operator's parentless spawn would orphan the
      // child and break the callback protocol without anyone noticing.
      const spawnCaller = resolveScopedWriteCallerIdentity(req.headers);
      if (spawnCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (spawnCaller.kind === "session" && body.parentSessionId === undefined) {
        if (getSession(spawnCaller.callerId)) {
          body.parentSessionId = spawnCaller.callerId;
        } else {
          logger.warn(`Ignoring unknown x-jinn-caller-session "${spawnCaller.callerId}" on session spawn`);
        }
      }
      const config = context.getConfig();
      const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
      let employeeDefaults: { engine: string; model: string; effortLevel?: string; employee?: string } | undefined;
      if (employeeName) {
        const { scanOrg } = await import("./org.js");
        const emp = scanOrg().get(employeeName);
        if (emp) {
          // GRS-017f: carry the employee slug so an unregistered configured
          // model produces the same actionable, employee-named error the
          // delegation route surfaces (not a cryptic bare-engine string).
          employeeDefaults = { engine: emp.engine, model: emp.model, employee: employeeName };
          if (emp.effortLevel) employeeDefaults.effortLevel = emp.effortLevel;
        }
      }
      const selection = validateNewSessionSelection(config, {
        engine: body.engine,
        model: body.model,
        effortLevel: body.effortLevel,
      }, employeeDefaults);
      if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
      const engineName = selection.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      // Opt-in SSO identity capture: when an auth proxy fronts the gateway and
      // `gateway.userHeader` is configured, persist the forwarded identity on the
      // session. Unset config → undefined → stored as NULL (single-user no-op).
      const userId = resolveUserHeader(req.headers, config.gateway.userHeader);
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        userId,
        // A session tagged with the portal name is a direct/COO session, not a
        // pseudo-employee (there is no org employee by the portal's name).
        // Coerce it to null so it buckets into the direct group rather than
        // spawning a phantom group that renders with the portal's own title.
        employee: employeeName,
        parentSessionId: body.parentSessionId,
        effortLevel: selection.effortLevel,
        // Honor body.model so API clients can pin per-employee models
        // (e.g. MCP servers that look up org/<employee>.yaml and pass the
        // employee's configured model). Without this, runWebSession falls
        // back to config.engines.claude.model, breaking per-employee routing.
        // Fixes #38.
        model: selection.model,
        prompt,
        // Optional excerpt override (talk delegation passes the operator's
        // verbatim ask so list UIs don't show the scaffolded prompt).
        promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : undefined,
        portalName: config.portal?.portalName,
      });
      logger.info(`Web session created: ${session.id} (model=${selection.model || "default"})`);
      // Voice mode: when the hands-free orchestrator (source:"talk") spawns a COO
      // child, tell the Talk UI which channel to animate to. Auto-derived here so
      // the orchestrator persona carries zero focus-signalling burden.
      if (session.parentSessionId) {
        const talkParent = getSession(session.parentSessionId);
        if (talkParent?.source === "talk") {
          const label = String(body.employee || prompt || "task").replace(/\s+/g, " ").trim().slice(0, 48);
          context.emit("talk:focus", { cooId: session.id, label, parentId: talkParent.id });
        }
      }
      maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });
      // First-message attachments were uploaded before the session existed (FILES_DIR).
      // Re-home them under uploads/<date>/<sessionId>/ now that we have an id, then persist
      // the media on the user message so the bubble renders chips/thumbnails on reload.
      rehomeAttachmentsToSession(body.attachments, session.id);
      const newSessionMedia = fileIdsToMedia(body.attachments);
      insertMessage(session.id, "user", prompt, newSessionMedia.length > 0 ? newSessionMedia : undefined);

      // Run engine asynchronously — respond immediately, push result via WebSocket.
      // CLI-mode session creation uses the engine's PTY view when one exists
      // (Claude, Antigravity). Engines without a PTY view fall back to normal chat.
      const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[engineName] : undefined;
      const engine = ptyEngine ?? context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // GRS-017a — agent-initiated (lateral / child follow-up) sends carry the
      // caller's session identity in x-jinn-caller-session (the jinn MCP server).
      // The substrate guards live HERE, route-side, so curl is equally guarded:
      // no self-messages, a per-sender rate cap, and a relay hop budget. A
      // guarded send is rewritten into a sender-tagged notification (wakes the
      // target; queues if mid-turn — the callbacks mechanic, generalized).
      // Internal parent callbacks (sessions/callbacks.ts) send no headers and
      // are untouched. A TOOL send that LOST its identity fails CLOSED (codex
      // finding 2): without a caller it would bypass every guard and land as an
      // unprefixed operator-grade user message.
      const msgCaller = resolveScopedWriteCallerIdentity(req.headers);
      if (msgCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (msgCaller.kind === "session") {
        const msgCallerId = msgCaller.callerId;
        const rawMessage = body.message || body.prompt;
        if (!rawMessage) return badRequest(res, "message is required");
        const caller = getSession(msgCallerId);
        if (!caller) {
          return badRequest(res, `unknown caller session "${msgCallerId}" — agent-initiated sends need a live caller session`);
        }
        const plan = prepareLateralSend({
          caller,
          targetSessionId: params.id,
          message: String(rawMessage),
          guards: sessionCommGuards,
        });
        if (!plan.ok) {
          res.writeHead(plan.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: plan.error }));
          return;
        }
        body.role = "notification";
        body.message = plan.prompt;
        body.displayMessage = plan.displayMessage;
        // Conservative on later failure (e.g. engine unavailable): the hop tag
        // may be recorded for an undelivered message, which only ever tightens
        // the budget, never loosens it.
        sessionCommGuards.recordDelivery(params.id, plan.hops);
      } else if (body.role !== "notification") {
        // A genuine user/operator message resets the target's relay-hop chain —
        // an operator instruction is a fresh start, not hop N of a relay.
        sessionCommGuards.clearInboundHop(params.id);
      }

      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");

      // Voice mode: when the orchestrator CONTINUES an existing COO child (a
      // thread switch/reuse), re-signal focus so the Talk UI relights that
      // satellite + morphs the main orb to its channel — mirroring the
      // talk:focus emitted on new-session spawn in POST /api/sessions.
      if (session.parentSessionId) {
        const talkParent = getSession(session.parentSessionId);
        if (talkParent?.source === "talk") {
          context.emit("talk:focus", { cooId: session.id, label: session.title || "", parentId: talkParent.id });
        }
      }
      maybeEmitTalkGraph(session.id, "status", { getSession, emit: context.emit });

      // Allow internal callers (e.g. child session callbacks) to specify a non-user role
      const messageRole: string = body.role === "notification" ? "notification" : "user";
      const isNotification = messageRole === "notification";
      // Dual audience: the engine (e.g. the COO) runs on the full `prompt`, while the
      // web UI persists + shows a clean `displayMessage` banner. Falls back to `prompt`.
      const displayMessage: string =
        typeof body.displayMessage === "string" && body.displayMessage.trim()
          ? body.displayMessage
          : prompt;

      const config = context.getConfig();
      // CLI-mode sends route to the engine's PTY view when one exists so the
      // prompt/response are visible in xterm. Engines without a PTY view fall back.
      const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[session.engine] : undefined;
      const engine = ptyEngine ?? context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Only interrupt if a turn is actually in flight. With warm PTYs, isAlive is
      // also true for an idle-but-warm engine — isTurnRunning distinguishes them.
      // Headless engines lack isTurnRunning; their isAlive ≈ "turn running".
      const turnRunning = session.status === "running" && isInterruptibleEngine(engine)
        && ("isTurnRunning" in engine ? (engine as any).isTurnRunning(session.id) : engine.isAlive(session.id));
      const shouldInterruptRunningTurn =
        !isNotification &&
        (config.sessions?.interruptOnNewMessage ?? true) &&
        turnRunning;
      if (shouldInterruptRunningTurn) supersedeRunningTurn(session);

      // Persist the message immediately. For notifications, store the clean
      // human-facing `displayMessage` (what the UI banner renders) — the engine
      // still runs on the full `prompt` via the dispatch below.
      // For user messages, attach media (file IDs → descriptors) so the bubble
      // shows chips/thumbnails on reload — never the raw injected path text.
      const userMedia = isNotification ? [] : fileIdsToMedia(body.attachments);
      // Re-home any attachments uploaded without a sessionId (defensive; usually a no-op
      // since the web client now scopes uploads to the session).
      if (!isNotification) rehomeAttachmentsToSession(body.attachments, session.id);
      insertMessage(
        session.id,
        messageRole,
        isNotification ? displayMessage : prompt,
        userMedia.length > 0 ? userMedia : undefined,
      );
      // Push the banner live to any connected web client viewing the parent.
      if (isNotification) {
        context.emit("session:notification", { sessionId: session.id, message: displayMessage });
      }
      // Note: notification-role messages (e.g. child session callbacks) fall
      // through to enqueue + dispatch so the engine (e.g. the COO) actually
      // processes the notification and can respond — they do not return early.

      if (!isNotification && session.status === "waiting") {
        const expectedResetAt = getClaudeExpectedResetAt();
        const resumeText = expectedResetAt
          ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;
        const queuedText =
          `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
        insertMessage(session.id, "notification", queuedText);
        context.emit("session:notification", { sessionId: session.id, message: queuedText });
      }

      // If a turn is already running, check whether we should interrupt or queue.
      // Notifications (child completion callbacks) should never interrupt — just queue.
      if (session.status === "running") {
        if (shouldInterruptRunningTurn) {
          logger.info(`Interrupting running session ${session.id} for new message`);
          engine.kill(session.id, "Interrupted: new message received");
          // SessionQueue serializes per-session; the new turn enqueued below will
          // wait for the killed run()'s promise to settle before starting.
          context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
        } else if (!isNotification) {
          context.emit("session:queued", { sessionId: session.id, message: prompt });
        }
      }

      // If session was interrupted by a restart, clear the error and resume
      if (session.status === "interrupted") {
        logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
        updateSession(session.id, {
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: session.id });
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      // Internal notification-role messages (child-completion callbacks) are
      // serialized via the in-memory queue but must NOT appear in the user's
      // queue panel — they already surface as banners. Only real user messages
      // get a visible queue item.
      let queueItemId: string | undefined;
      if (!isNotification) {
        queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
        context.emit("queue:updated", { sessionId: session.id, sessionKey });
      }

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, { status: "queued", sessionId: session.id });
    }

    // POST /api/sessions/:id/attachments — running agent pushes a file/image into the chat.
    // Accepts multipart (file + optional text/caption) OR JSON ({path|content|url, filename?, text?}).
    // The file is stored under ~/.jinn/uploads/<date>/<sessionId>/ and surfaced as an assistant
    // message with rendered media (image/audio/file). Only the path/URL reaches the UI — never raw bytes in the prompt.
    params = matchRoute("/api/sessions/:id/attachments", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      await handleSessionAttachment(req, res, params.id, context);
      return;
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      const jobs = loadJobs();
      // Enrich with last run status — tail-read only the newest entry, the
      // run logs are append-only JSONL that grows forever.
      const enriched = await Promise.all(jobs.map(async (job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        const { entries } = await readJsonlTail(runFile, 1);
        return cronJobSummary(job as unknown as Record<string, unknown>, entries[0] ?? null);
      }));
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs?limit=N — newest first (the UI shows "Recent Runs").
    // Run history is append-only JSONL that grows forever, so only the file's
    // tail is read; corrupt lines (crash mid-write) are skipped, not 500'd.
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || 50));
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      const { entries: runs, skipped } = await readJsonlTail(runFile, limit);
      if (skipped) logger.warn(`GET /api/cron/${params.id}/runs: skipped ${skipped} corrupt line(s)`);
      return json(res, runs.map(summarizeCronRun));
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // GRS-014d: managed workflow jobs are normally CREATED BY THE SYNC, but a
      // hand-authored one must at least be well-formed (managed ⇒ workflowId) —
      // note the sync owns every managedBy:'workflow' job and will reconcile it
      // against the definition store on the next definition save or boot.
      if (body.managedBy === "workflow" && !(typeof body.workflowId === "string" && body.workflowId.trim())) {
        return badRequest(res, "managed workflow cron jobs require workflowId");
      }
      const jobs = loadJobs();
      // Job ids are identity (run-log files, sync ownership, PUT/DELETE routing) —
      // a duplicate would double-schedule one id and collide two run histories in
      // one jsonl (Codex GRS-014d finding 2). Identity is CANONICAL (trim+lowercase,
      // GRS-014d-fix2): run-log files `<id>.jsonl` collide case-insensitively on the
      // default macOS volume, so "Workflow:wf-a" and "workflow:wf-a" are the same
      // job history. Stored ids stay as authored; only the collision check (and a
      // padded-id rejection — whitespace ids break addressing) canonicalizes.
      if (typeof body.id === "string" && body.id !== body.id.trim()) {
        return badRequest(res, "cron job id must not have leading/trailing whitespace");
      }
      if (body.id && jobs.some((j) => canonicalCronJobId(j.id) === canonicalCronJobId(body.id))) {
        return badRequest(res, `a cron job with id "${body.id}" already exists`);
      }
      const newJob: CronJob = {
        id: body.id || crypto.randomUUID(),
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
        ...(body.managedBy === "workflow" ? { managedBy: "workflow" as const, workflowId: body.workflowId } : {}),
      };
      const scheduleErrors = validateCronSchedule({ schedule: newJob.schedule, ...(newJob.timezone !== undefined ? { timezone: newJob.timezone } : {}) });
      if (scheduleErrors.length > 0) return badRequest(res, scheduleErrors.map((entry) => entry.message).join("; "));
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const merged = { ...jobs[idx], ...body, id: params.id } as CronJob;
      // GRS-014d: a job cannot end up managed without a workflow to fire. (Edits to a
      // managed job persist but are re-synced away on the next definition save/boot —
      // the definition is the source of truth.)
      if (merged.managedBy === "workflow" && !(typeof merged.workflowId === "string" && merged.workflowId.trim())) {
        return badRequest(res, "managed workflow cron jobs require workflowId");
      }
      const scheduleErrors = validateCronSchedule({ schedule: merged.schedule, ...(merged.timezone !== undefined ? { timezone: merged.timezone } : {}) });
      if (scheduleErrors.length > 0) return badRequest(res, scheduleErrors.map((entry) => entry.message).join("; "));
      jobs[idx] = merged;
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // POST /api/cron/:id/trigger — manually run a cron job now
    params = matchRoute("/api/cron/:id/trigger", pathname);
    if (method === "POST" && params) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === params!.id);
      if (!job) return notFound(res);

      logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

      // Fire and forget — respond immediately, run in background. A managed workflow
      // job triggered manually starts a fresh workflow run (fresh fireIso — never
      // deduped, same manual semantics as prompt jobs).
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors, {
        workflowFire: workflowCronFireHandler(context),
      }).catch(
        (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
      );

      return json(res, {
        triggered: true,
        jobId: job.id,
        name: job.name,
        employee: job.employee,
        message: `Cron job "${job.name}" triggered manually`,
      });
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const hierarchy = resolveOrgHierarchy(orgRegistry);

      const employees = hierarchy.sorted.map((name) => {
        const node = hierarchy.nodes[name];
        const emp = node.employee;
        const { persona, ...rest } = emp;
        const role = compactEmployeeRole(persona);
        return {
          ...rest,
          ...(role ? { role } : {}),
          parentName: node.parentName,
          directReports: node.directReports,
          depth: node.depth,
          chain: node.chain,
        };
      });

      return json(res, {
        departments,
        employees,
        hierarchy: {
          root: hierarchy.root,
          sorted: hierarchy.sorted,
          warnings: hierarchy.warnings,
        },
      });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const emp = orgRegistry.get(params.name);
      if (!emp) return notFound(res);

      const hierarchy = resolveOrgHierarchy(orgRegistry);
      const node = hierarchy.nodes[params.name];

      return json(res, {
        ...emp,
        parentName: node?.parentName ?? null,
        directReports: node?.directReports ?? [],
        depth: node?.depth ?? 0,
        chain: node?.chain ?? [params.name],
      });
    }

    // PATCH /api/org/employees/:name — update employee fields (whitelisted, validated)
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "PATCH" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "update body must be a JSON object");
      }
      const { scanOrg, updateEmployeeYaml, validateEmployeeUpdate } = await import("./org.js");
      const current = scanOrg().get(params.name);
      if (!current) return notFound(res);

      const result = validateEmployeeUpdate(context.getConfig(), current, body);
      if (!result.ok) return badRequest(res, result.error || "invalid update");

      const wrote = updateEmployeeYaml(params.name, result.updates!);
      if (!wrote) return notFound(res);

      // G1: synchronously refresh the in-memory registry (and drop warm PTYs) so an
      // immediate session spawn sees the new persona/model — don't wait for the watcher.
      context.reloadOrg?.();
      context.emit("org:updated", { employee: params.name });

      const updated = scanOrg().get(params.name);
      return json(res, { status: "ok", employee: updated ?? null });
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      let board: unknown;
      try { board = JSON.parse(fs.readFileSync(boardPath, "utf-8")); }
      catch (err) {
        logger.warn(`GET /api/org/departments/${params.name}/board: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
        return serverError(res, "board.json is corrupt");
      }
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => {
        const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
        const st = fs.statSync(skillMdPath, { throwIfNoEntry: false });
        if (!st) {
          skillDescriptionCache.delete(e.name);
          return { name: e.name, description: "" };
        }
        const hit = skillDescriptionCache.get(e.name);
        if (hit && hit.mtimeMs === st.mtimeMs) return { name: e.name, description: hit.description };
        const description = parseSkillDescription(fs.readFileSync(skillMdPath, "utf-8"));
        skillDescriptionCache.set(e.name, { mtimeMs: st.mtimeMs, description });
        return { name: e.name, description };
      });
      return json(res, skills);
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // DELETE /api/skills/:name — remove a skill
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/engines — resolved model + capability registry (single source of truth
    // for the UI model/effort selectors). Synthesized from engines.<name>.model
    // when no `models:` block is configured.
    if (method === "GET" && pathname === "/api/engines") {
      const config = context.getConfig();
      const registry = getModelRegistry(config);
      return json(res, { default: config.engines.default, engines: registry });
    }

    // POST /api/engines/refresh — re-run dynamic model discovery and return the
    // rebuilt registry. Lets the UI pick up models added to dynamic CLIs without
    // restarting the gateway.
    if (method === "POST" && pathname === "/api/engines/refresh") {
      const config = context.getConfig();
      await Promise.all([
        refreshClaudeModels(config),
        refreshCodexModels(config),
        refreshAntigravityModels(config),
        refreshPiModels(config),
        refreshGrokModels(config),
        refreshHermesModels(config),
      ]);
      context.emit("engines:updated", {});
      return json(res, { default: config.engines.default, engines: getModelRegistry(config) });
    }

    // GET /api/engine-limits — live/snapshot quota windows and static capability
    // metadata for each engine. Some CLIs expose full quota buckets (Codex), some
    // only expose session snapshots (Claude), and some expose no aggregate quota.
    if (method === "GET" && pathname === "/api/engine-limits") {
      const engine = url.searchParams.get("engine") || undefined;
      return json(res, await collectEngineLimits(context.getConfig(), { engine }));
    }

    // POST /api/engine-limits/refresh — currently identical to GET for live
    // sources. Kept as a command-shaped endpoint so the UI/CLI can request a
    // deliberate refresh without changing the public contract later.
    if (method === "POST" && pathname === "/api/engine-limits/refresh") {
      const engine = url.searchParams.get("engine") || undefined;
      return json(res, await collectEngineLimits(context.getConfig(), { engine }));
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      return json(res, sanitizeConfigForApi(config));
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // Basic validation: must be a plain object
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // Validate known top-level keys
      // Keep this aligned with `JinnConfig` in src/shared/types.ts
      const KNOWN_KEYS = [
        "jinn",
        "gateway",
        "engines",
        "models",
        "connectors",
        "logging",
        "mcp",
        "sessions",
        "cron",
        "notifications",
        "portal",
        "context",
        "stt",
        "talk",
        "skills",
        "remotes",
      ];
      const unknownKeys = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Validate critical field types
      if (body.gateway !== undefined) {
        if (typeof body.gateway !== "object" || Array.isArray(body.gateway)) {
          return badRequest(res, "gateway must be an object");
        }
        if (body.gateway.port !== undefined && typeof body.gateway.port !== "number") {
          return badRequest(res, "gateway.port must be a number");
        }
      }
      if (body.engines !== undefined && (typeof body.engines !== "object" || Array.isArray(body.engines))) {
        return badRequest(res, "engines must be an object");
      }
      // Deep-merge incoming config with existing config to preserve
      // fields not included in the update (e.g. connector tokens).
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, body);
      saveConfigAtomic(merged);
      context.reloadConfig?.(); // refresh in-memory config now (don't wait on the watcher)
      invalidateModelRegistry(); // models/engines may have changed — rebuild on next read
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      // Read only the last 64KB to avoid loading the entire file into memory
      const MAX_BYTES = 64 * 1024;
      const stat = fs.statSync(logFile);
      const readSize = Math.min(stat.size, MAX_BYTES);
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const allLines = redactText(buf.toString("utf-8")).split("\n").filter(Boolean);
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/reload — stop all instance connectors and restart from config
    if (method === "POST" && pathname === "/api/connectors/reload") {
      if (!context.reloadConnectorInstances) {
        return json(res, { error: "Connector reload not available" }, 501);
      }
      try {
        const result = await context.reloadConnectorInstances();
        context.emit("connectors:reloaded", result);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:id/incoming — receive proxied Discord messages from primary instance
    // Supports both the legacy /api/connectors/discord/incoming and named instance ids
    params = matchRoute("/api/connectors/:id/incoming", pathname);
    if (method === "POST" && params && params.id) {
      // Try the exact instance id first, then fall back to "discord" for the legacy path
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);
      if (!("deliverMessage" in connector)) {
        return json(res, { error: "Discord connector is not in remote mode" }, 400);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Download attachments from Discord CDN URLs to local temp
      const { downloadAttachment } = await import("../connectors/discord/format.js");
      const attachments = await Promise.all(
        (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
          if (att.url) {
            try {
              const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
              return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
            } catch {
              return { name: att.name, url: att.url, mimeType: att.mimeType };
            }
          }
          return att;
        }),
      );

      const incomingMsg: IncomingMessage = {
        connector: params.id,
        source: "discord",
        sessionKey: body.sessionKey,
        channel: body.channel,
        thread: body.thread,
        user: body.user,
        userId: body.userId,
        text: body.text,
        messageId: body.messageId,
        attachments,
        replyContext: body.replyContext || {},
        transportMeta: body.transportMeta,
        raw: body,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connector as any).deliverMessage(incomingMsg);
      return json(res, { status: "delivered" });
    }

    // POST /api/connectors/:id/proxy — proxy connector operations from remote instances
    // Supports both the legacy /api/connectors/discord/proxy and named instance ids
    params = matchRoute("/api/connectors/:id/proxy", pathname);
    if (method === "POST" && params && params.id) {
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const action = body.action as string;
      const target = body.target as Target | undefined;
      let messageId: string | undefined;

      switch (action) {
        case "sendMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.sendMessage(target, redactText(String(body.text)))) as string | undefined;
          break;
        case "replyMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.replyMessage(target, redactText(String(body.text)))) as string | undefined;
          break;
        case "editMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          await connector.editMessage(target, redactText(String(body.text)));
          break;
        case "addReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.addReaction(target, body.emoji);
          break;
        case "removeReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.removeReaction(target, body.emoji);
          break;
        case "setTypingStatus":
          if (connector.setTypingStatus) {
            await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
          }
          break;
        default:
          return badRequest(res, `Unknown proxy action: ${action}`);
      }

      return json(res, { status: "ok", messageId });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        redactText(String(body.text)),
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/whatsapp/qr — return current QR code as PNG data URL
    if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
      const waConnector = context.connectors.get("whatsapp");
      if (!waConnector) return notFound(res);
      const qrString = (waConnector as WhatsAppConnector).getQrCode();
      if (!qrString) return json(res, { qr: null });
      const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
      return json(res, { qr: dataUrl });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
        name: connector.name,
        instanceId,
        employee: connector.getEmployee?.() ?? undefined,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      // We return the 30 newest activity events, and event ts == last_activity
      // (sessions are ordered DESC), so we only need the recent tail. But some
      // statuses emit no event (e.g. interrupted), so a single fixed window can
      // starve the result when the newest sessions are all non-emitting. Page the
      // newest-first window (re-deriving the real emitting predicate per row) until
      // we have 30 events or hit a hard row cap — still O(bounded), never a full
      // ~2.5k-session hydrate every poll.
      const TARGET_EVENTS = 30;
      const PAGE = 100;
      const HARD_ROW_CAP = 1000;
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (let offset = 0; events.length < TARGET_EVENTS && offset < HARD_ROW_CAP; offset += PAGE) {
        const page = listRecentSessions(PAGE, offset);
        for (const s of page) {
          const ts = new Date(s.lastActivity || s.createdAt).getTime();
          const transportState = getSessionTransportState(s, context);
          if (transportState === "running") {
            events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
          } else if (transportState === "queued") {
            events.push({ event: "session:queued", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
          } else if (transportState === "idle") {
            events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
          } else if (transportState === "error") {
            events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError, connector: s.connector }, ts });
          }
        }
        if (page.length < PAGE) break; // exhausted — no more rows
      }
      // Newest first. Pages are already last_activity DESC, so any collected
      // event is newer than every un-fetched one; the top 30 are the true newest.
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, TARGET_EVENTS));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      // Only the count is surfaced — use a pure COUNT(*) instead of hydrating +
      // JSON-parsing every session row on this polled endpoint.
      const sessionsCount = countSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      const onboarded = config.portal?.onboarded === true;
      const setupComplete = config.portal?.setupComplete === true || onboarded;
      return json(res, {
        needed: onboardingNeeded(onboarded),
        onboarded,
        setupComplete,
        conversationNeeded: !setupComplete,
        sessionsCount,
        hasEmployees,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const { portalName, operatorName, language, engine, model, effortLevel } = body;

      // Read current config and merge engine choice + portal settings
      const config = context.getConfig();
      const updated = {
        ...applyEngineChoice(config, { engine, model, effortLevel }),
        portal: {
          ...config.portal,
          onboarded: true,
          setupComplete: true,
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config, then refresh the in-memory copy synchronously so
      // GET /api/onboarding reflects onboarded:true immediately (not after the
      // debounced file-watcher fires ~1s later).
      saveConfigAtomic(updated, { lineWidth: -1 });
      context.reloadConfig?.();
      logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = portalName || "Jinn";
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Personalize the operating manual with the chosen COO name + language.
      // The shipped identity line is bold, e.g.
      //   "You are **Jinn**, a personal AI assistant and COO of an AI organization."
      // (The previous CLAUDE.md regex expected unbolded "...the COO of the user's
      // AI organization." and never matched, so the rename silently no-op'd.)
      const personalizeManual = (filePath: string) => {
        let md = fs.readFileSync(filePath, "utf-8");
        // Replace just the bold name token; `[^*]+` supports multi-word names.
        md = md.replace(/^You are \*\*[^*]+\*\*/m, `You are **${effectiveName}**`);
        // Reset any prior language section, then append the new one if needed.
        md = md.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) md = md.trimEnd() + languageSection + "\n";
        fs.writeFileSync(filePath, md);
      };

      // CLAUDE.md is canonical. AGENTS.md is normally a symlink → CLAUDE.md, so we
      // edit CLAUDE.md directly and skip the symlink (avoids double-processing the
      // same file). Only the rare non-symlink fallback copy is personalized too.
      const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) personalizeManual(claudeMdPath);

      const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
      if (fs.existsSync(agentsMdPath) && !fs.lstatSync(agentsMdPath).isSymbolicLink()) {
        personalizeManual(agentsMdPath);
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const languages = resolveLanguages(config.stt);
      const status = getSttStatus(config.stt?.model, languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        // Update config to mark STT as enabled
        try {
          const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
          const sttCfg = cfg.stt as Record<string, unknown>;
          sttCfg.enabled = true;
          sttCfg.model = model;
          if (!sttCfg.languages) sttCfg.languages = ["en"];
          saveConfigAtomic(cfg, { lineWidth: -1 });
        } catch (err) {
          logger.error(`Failed to update config after STT download: ${err}`);
        }
        context.emit("stt:download:complete", { model });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT download failed: ${msg}`);
        context.emit("stt:download:error", { error: msg });
      });

      return json(res, { status: "downloading", model });
    }

    if (method === "POST" && pathname === "/api/stt/transcribe") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";
      const languages = resolveLanguages(config.stt);
      // Accept language from query param, fall back to first configured language
      const requestedLang = url.searchParams.get("language");
      const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

      const audioBuffer = await readBodyRaw(req);
      if (audioBuffer.length === 0) return badRequest(res, "No audio data");
      if (audioBuffer.length > 100 * 1024 * 1024) return badRequest(res, "Audio too large (100MB max)");

      const contentType = req.headers["content-type"] || "audio/webm";
      const ext = contentType.includes("wav") ? ".wav"
        : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
        : contentType.includes("ogg") ? ".ogg"
        : ".webm";

      const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, audioBuffer);

      try {
        const text = await sttTranscribe(tmpFile, model, language);
        return json(res, { text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT transcription failed: ${msg}`);
        return serverError(res, `Transcription failed: ${msg}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }

    if (method === "PUT" && pathname === "/api/stt/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const langs = body.languages;

      if (!Array.isArray(langs) || langs.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }

      const invalid = langs.filter((l) => typeof l !== "string" || !WHISPER_LANGUAGES[l]);
      if (invalid.length > 0) {
        return badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      }

      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.languages = langs;
        // Remove deprecated language field if present
        delete sttCfg.language;
        saveConfigAtomic(cfg, { lineWidth: -1 });
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // ── TTS (per-message read-aloud) ──────────────────────────
    // GET /api/tts — engine readiness so the client can pick Kokoro vs the
    // browser Web Speech fallback WITHOUT a failed POST. Reuses the shared Kokoro
    // engine (also driving the /talk voice loop); gated on weights + venv present.
    if (method === "GET" && pathname === "/api/tts") {
      const { available, voice } = ttsStatus(context.getConfig().talk?.kokoro);
      return json(res, { available, voice });
    }

    // POST /api/tts {text} — STREAM one length-prefixed WAV frame per sentence as
    // each is synthesized, so the client plays sentence 1 while 2..N are still
    // synthesizing (time-to-first-audio ≈ one sentence, not the whole message).
    // Frame = 4-byte big-endian length + WAV bytes. 503 {available:false} when
    // Kokoro can't run (client then falls back to browser Web Speech).
    if (method === "POST" && pathname === "/api/tts") {
      const kokoroOpts = context.getConfig().talk?.kokoro;
      if (!ttsStatus(kokoroOpts).available) {
        return json(res, { available: false }, 503);
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const valid = validateTtsText((parsed.body as { text?: unknown } | null)?.text);
      if (!valid.ok) return badRequest(res, valid.error);

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
      });
      // A client abort (pause / navigate) closes the request → stop synthesizing
      // the rest of the message instead of wasting Kokoro on audio nobody hears.
      let cancelled = false;
      req.on("close", () => {
        cancelled = true;
      });
      try {
        await streamTtsSentences(
          valid.text,
          kokoroOpts,
          (wav) => {
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(wav.length, 0);
            res.write(header);
            res.write(wav);
          },
          () => cancelled || res.writableEnded,
        );
      } catch (err) {
        logger.warn(`TTS stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.writableEnded) res.end();
      return;
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    // POST /api/internal/hook — receive Claude Code turn hooks from the relay script
    if (method === "POST" && pathname === "/api/internal/hook") {
      if (!context.hookRegistry || !context.hookSecret) {
        return json(res, { error: "Interactive mode not active" }, 503);
      }
      // Loopback check FIRST — before reading the body — so a non-loopback
      // caller can't force unbounded body buffering by sending a huge POST.
      const remote = req.socket.remoteAddress;
      if (!isLoopback(remote)) {
        return json(res, { message: "forbidden" }, 403);
      }
      // Reject oversized bodies up front via Content-Length, then enforce
      // the cap mid-stream too in case the header was missing or lies.
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > HOOK_BODY_MAX_BYTES) {
        return json(res, { error: "Payload too large" }, 413);
      }
      const _parsed = await readJsonBody(req, res, { maxBytes: HOOK_BODY_MAX_BYTES });
      if (!_parsed.ok) return;
      const hookBody = _parsed.body as { jinnSessionId?: string; hook?: import("./hook-registry.js").HookPayload };
      const result = handleHookPost(
        { reg: context.hookRegistry, secret: context.hookSecret, remoteAddress: remote },
        req.headers["x-jinn-hook-secret"] as string | undefined,
        hookBody,
      );
      // Central engineSessionId capture: persist claude's OWN session id the moment
      // it reports one (SessionStart, or Stop as backup), independent of turn state.
      // Without this, an interrupted turn or an idle CLI-view spawn never persisted
      // the id, so the next cold respawn ran `claude` with resume:none → a fresh
      // conversation (the convo-wipe bug). Write-once guarded so it's not chatty.
      if (
        result.status === 200 &&
        hookBody.jinnSessionId &&
        (hookBody.hook?.hook_event_name === "SessionStart" || hookBody.hook?.hook_event_name === "Stop") &&
        typeof hookBody.hook?.session_id === "string" &&
        hookBody.hook.session_id
      ) {
        const existing = getSession(hookBody.jinnSessionId);
        if (existing && getEngineSessionRef(existing, "claude").id !== hookBody.hook.session_id) {
          recordEngineSessionId(hookBody.jinnSessionId, "claude", hookBody.hook.session_id);
        }
      }
      return json(res, { message: result.body }, result.status);
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

function loadRawTranscript(engineSessionId: string): TranscriptEntry[] {
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const entries: TranscriptEntry[] = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        const rawContent = msg.content;
        const blocks: TranscriptContentBlock[] = [];

        if (typeof rawContent === "string") {
          if (rawContent.trim()) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            const blockType = String(b.type || "");
            if (blockType === "text") {
              blocks.push({ type: "text", text: String(b.text || "") });
            } else if (blockType === "tool_use") {
              blocks.push({
                type: "tool_use",
                name: String(b.name || ""),
                input: (b.input as Record<string, unknown>) || {},
              });
            } else if (blockType === "tool_result") {
              const resultContent = b.content;
              let resultText: string;
              if (typeof resultContent === "string") {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = (resultContent as Record<string, unknown>[])
                  .filter((rc) => rc.type === "text")
                  .map((rc) => String(rc.text || ""))
                  .join("");
              } else {
                resultText = "";
              }
              blocks.push({ type: "tool_result", text: resultText });
            } else if (blockType === "thinking") {
              blocks.push({ type: "thinking", text: String(b.thinking || b.text || "") });
            }
          }
        }

        if (blocks.length > 0) {
          entries.push({ role: type as "user" | "assistant", content: blocks });
        }
      } catch {
        continue;
      }
    }
    return entries;
  }
  return [];
}

/**
 * Track which sessions currently have an in-flight transcript backfill so
 * concurrent GETs don't kick off duplicate (expensive) parses. Once a backfill
 * finishes and inserts rows, subsequent GETs see messages.length > 0 and skip
 * scheduling entirely.
 */
const backfillInProgress = new Set<string>();

function scheduleTranscriptBackfill(sessionId: string, engineSessionId: string, context: ApiContext): void {
  if (backfillInProgress.has(sessionId)) return;
  backfillInProgress.add(sessionId);
  // Defer off the request-handling tick so the GET returns immediately.
  setImmediate(() => {
    try {
      // Re-check inside the deferred task: another concurrent GET may have
      // backfilled this session already (extremely unlikely given the Set
      // guard, but cheap insurance).
      const existing = getMessages(sessionId);
      if (existing.length > 0) return;
      const transcriptMessages = loadTranscriptMessages(engineSessionId);
      if (transcriptMessages.length === 0) return;
      // One transaction for the whole backfill — better-sqlite3 executes the
      // inner inserts synchronously inside a single BEGIN/COMMIT, which is
      // dramatically faster than autocommitting per row.
      const db = initDb();
      const txn = db.transaction((items: Array<{ role: string; content: string }>) => {
        for (const tm of items) {
          insertMessage(sessionId, tm.role, tm.content);
        }
      });
      txn(transcriptMessages);
      logger.info(`Backfilled ${transcriptMessages.length} transcript message(s) for session ${sessionId}`);
      // Notify subscribers (web client) so they re-fetch and display the
      // newly backfilled messages instead of waiting for another event.
      context.emit("session:updated", { sessionId });
    } catch (err) {
      logger.warn(`Transcript backfill failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      backfillInProgress.delete(sessionId);
    }
  });
}

function loadTranscriptMessages(engineSessionId: string): Array<{ role: string; content: string }> {
  // Claude Code stores transcripts in ~/.claude/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  // Search all project dirs for the transcript
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const messages: Array<{ role: string; content: string }> = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const text = transcriptEntryText(obj);
        if (text) messages.push(text);
      } catch {
        continue;
      }
    }
    return messages;
  }
  return [];
}

/**
 * Sources that are NOT backed by an external chat connector. Anything else
 * (slack, telegram, discord, whatsapp, …) is connector-sourced and its turn
 * results must be relayed back to the originating channel.
 */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);

/**
 * Resolve the forwarded SSO identity from request headers, given the configured
 * `gateway.userHeader` (a single header name or a priority-ordered list). Node
 * lowercases incoming header keys, so we look up case-insensitively. Returns the
 * first present, non-empty, trimmed value; `undefined` when the config is unset
 * or no configured header is present. Unset config = single-user no-op: the
 * header is never read and the caller falls back to "web-user".
 */
export function resolveUserHeader(
  headers: Record<string, string | string[] | undefined>,
  userHeaderConfig: string | string[] | undefined,
): string | undefined {
  if (!userHeaderConfig) return undefined;
  const names = Array.isArray(userHeaderConfig) ? userHeaderConfig : [userHeaderConfig];
  for (const name of names) {
    if (!name) continue;
    const raw = headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply via `manager.route`,
 * but turns completed through `runWebSession` (parent callbacks, cron
 * follow-ups, rate-limit resumes) otherwise never reach the channel. No-ops for
 * web/talk/cron sources, empty text, or a missing connector/replyContext; errors
 * are logged and swallowed so delivery failure never breaks completion.
 */
export async function deliverConnectorReply(
  session: Pick<Session, "source" | "connector" | "replyContext"> & { id?: string },
  text: string,
  connectors: Map<string, import("../shared/types.js").Connector>,
): Promise<void> {
  if (!text || NON_CONNECTOR_SOURCES.has(session.source)) return;
  if (!session.connector || !session.replyContext) return;
  const connector = connectors.get(session.connector);
  if (!connector) return;
  try {
    const target = connector.reconstructTarget(session.replyContext);
    await connector.replyMessage(target, text);
  } catch (err) {
    logger.warn(
      `Connector reply delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  attachments?: string[],
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  const engineAtTurnStart = currentSession.engine;
  const resumeRefAtTurnStart = getEngineSessionRef(currentSession, engineAtTurnStart);
  config = context.getConfig();
  const preferredPtyView = context.ptyViewEngines?.[session.engine] === engine;
  const runtimeEngine =
    (preferredPtyView ? context.ptyViewEngines?.[currentSession.engine] : undefined)
    ?? context.sessionManager.getEngine(currentSession.engine);
  if (!runtimeEngine) {
    const errMsg = `Engine "${currentSession.engine}" not available`;
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    if (erroredSession) notifyParentSession(erroredSession, { error: errMsg });
    return;
  }
  engine = runtimeEngine;
  logger.info(`Web session ${currentSession.id} running engine "${engineAtTurnStart}" (model: ${currentSession.model || "default"})`);

  // Ensure status is "running" (may already be set by the POST handler)
  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }

  // If this session has an assigned employee, load their persona
  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    const { findEmployee } = await import("./org.js");
    const { scanOrg } = await import("./org.js");
    const registry = scanOrg();
    employee = findEmployee(currentSession.employee, registry);
  }

  // Pre-flight: fail fast with an actionable error if the engine's CLI binary
  // isn't installed. Otherwise the (interactive PTY) engine spawns a missing
  // command, exits silently, and the turn produces no output and no error.
  // We surface it the way runWebSession reports errors and return normally
  // (throwing here would escape the queue task as an unhandled rejection).
  if (isKnownEngine(currentSession.engine) && !engineAvailable(config, currentSession.engine)) {
    const errMsg = engineUnavailableMessage(config, currentSession.engine);
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    // Wake the parent COO if this was a delegated child session (parity with
    // the normal error path; no-op for top-level sessions).
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    return;
  }

  const { scanOrg: scanOrgForHierarchy } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const orgHierarchy = resolveOrgHierarchy(scanOrgForHierarchy());

  // Declared in the function scope so the OUTER finally can clean up the Claude MCP
  // temp file only AFTER the full turn lifecycle — including any rate-limit
  // retry/fallback that reuses mcpConfigPath (parity with manager.ts runSession).
  let mcpConfigPath: string | undefined;
  let runHeartbeat: ReturnType<typeof setInterval> | undefined;

  try {

    let resolvedMcp: import("../shared/types.js").ResolvedMcpConfig | undefined;
    ({ mcpConfigPath, resolvedMcp } = resolveEngineRunMcp({
      config,
      employee,
      engine: currentSession.engine,
      sessionId: currentSession.id,
    }));

    const systemPrompt = buildContext({
      source: currentSession.source,
      channel: currentSession.sourceRef,
      user: currentSession.userId ?? "web-user",
      employee,
      engine: currentSession.engine,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
      hierarchy: orgHierarchy,
      // The diet keys off the built-in jinn server specifically — custom MCP
      // servers don't carry the company tools (same rule as manager.ts).
      jinnMcpAttached: Boolean(resolvedMcp?.mcpServers?.["jinn"]),
      // Hands-free voice orchestrator: layer the AURA persona on top of the
      // base identity so it behaves as the thin voice layer above the COO.
      voicePersona: currentSession.source === "talk" ? getOrchestratorPersona() : undefined,
      talkThreads:
        currentSession.source === "talk"
          ? listChildSessions(currentSession.id).slice(0, 12).map((c) => ({
              id: c.id,
              label: c.title || "(untitled)",
              status: c.status,
              lastActivity: c.lastActivity,
            }))
          : undefined,
    });

    // Per-engine config is keyed by engine name; unconfigured optional engines
    // (antigravity/pi) resolve to {} so the engine falls back to dynamic bin/model
    // resolution. Adding an engine needs no change here.
    const engineConfig =
      (config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } | undefined>)[
        currentSession.engine
      ] ?? {};
    const effortLevel = resolveEffort(
      engineConfig,
      currentSession,
      employee,
      effortLevelsForModel(config, currentSession.engine, currentSession.model ?? undefined),
    );

    let lastHeartbeatAt = 0;
    runHeartbeat = setInterval(() => {
      // If the session was deleted mid-turn, stop heartbeating immediately —
      // the engine.run promise may still take minutes to resolve, and we don't
      // want to keep writing status:"running" rows for a session the user
      // already removed (and risk re-creating registry state in some paths).
      if (!getSession(currentSession.id)) {
        if (runHeartbeat) clearInterval(runHeartbeat);
        runHeartbeat = undefined;
        return;
      }
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    // Mid-turn persistence: mirror the live stream into `partial` DB rows so a
    // refresh restores in-progress blocks. Coalesced — text grows ONE row
    // (debounced, never per-token, so SQLite isn't hammered); each tool call is
    // its own row. All wiped + replaced by the single final message at turn end
    // (deletePartialMessages below). Only the primary engine stream is mirrored;
    // the rate-limit fallback stream stays WS-only (rare path).
    let partialSeq = 0;
    let curTextId: string | null = null; // the growing text-block row, null between blocks
    let curText = "";
    let lastToolId: string | null = null; // last tool row, for the tool_result → "Used" update
    let lastToolName: string | null = null;
    let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPartialText = () => {
      partialFlushTimer = null;
      if (!curText.trim()) return;
      if (curTextId) updatePartialMessage(curTextId, curText);
      else curTextId = insertPartialMessage(currentSession.id, "assistant", curText, partialSeq++);
    };
    const persistPartialDelta = (delta: StreamDelta) => {
      if (delta.type === "text" || delta.type === "text_snapshot") {
        if (typeof delta.content !== "string") return;
        curText = foldPartialText(curText, delta);
        if (delta.type === "text_snapshot") {
          // A snapshot is authoritative and typically terminal (e.g. a hermes
          // final/redaction frame). Flush the replacement to the partial row NOW
          // — don't leave the pre-replace text readable via a mid-turn GET while
          // the debounce is pending.
          if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
          flushPartialText();
        } else if (!partialFlushTimer) {
          partialFlushTimer = setTimeout(flushPartialText, 600);
        }
      } else if (delta.type === "tool_use") {
        flushPartialText(); // finalize the text block before the tool
        if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
        const tool = delta.toolName || String(delta.content ?? "");
        lastToolName = tool;
        lastToolId = insertPartialMessage(currentSession.id, "assistant", `Using ${tool}`, partialSeq++, tool);
        curTextId = null; curText = ""; // a fresh text block begins after the tool
      } else if (delta.type === "tool_result") {
        const tool = delta.toolName || lastToolName || String(delta.content ?? "");
        if (lastToolId) updatePartialMessage(lastToolId, `Used ${tool}`);
      } else if (delta.type === "block" && delta.block) {
        flushPartialText();
        if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
        applyBlockEnvelope(currentSession.id, delta.block, delta.content, {
          partial: true,
          seq: partialSeq++,
        });
        curTextId = null; curText = "";
      }
    };

    const syncMeta = (currentSession.transportMeta || {}) as Record<string, unknown>;
    const switchSyncTarget = typeof syncMeta.engineSyncTarget === "string" ? syncMeta.engineSyncTarget : null;
    const switchSyncSinceIso = typeof syncMeta.engineSyncSince === "string" ? syncMeta.engineSyncSince : null;
    const switchSyncSinceMs = switchSyncSinceIso ? new Date(switchSyncSinceIso).getTime() : NaN;
    const engineSyncRequested =
      switchSyncTarget === engineAtTurnStart &&
      typeof switchSyncSinceIso === "string" &&
      Number.isFinite(switchSyncSinceMs);
    const claudeSyncSinceIso = typeof syncMeta.claudeSyncSince === "string" ? syncMeta.claudeSyncSince : null;
    const claudeSyncSinceMs = claudeSyncSinceIso ? new Date(claudeSyncSinceIso).getTime() : NaN;
    const claudeSyncRequested =
      engineAtTurnStart === "claude" &&
      typeof claudeSyncSinceIso === "string" &&
      Number.isFinite(claudeSyncSinceMs);
    const syncRequested = engineSyncRequested || claudeSyncRequested;
    const promptToRun = syncRequested
      ? (() => {
        const sinceMs = engineSyncRequested ? switchSyncSinceMs : claudeSyncSinceMs;
        const recentMessages = getMessages(currentSession.id).filter((m) => m.timestamp >= sinceMs);
        const sinceMessages = recentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        const latestMessage = recentMessages.at(-1);
        const currentPromptWasIncluded =
          latestMessage &&
          (latestMessage.role === "user" || latestMessage.role === "assistant") &&
          latestMessage.content === prompt;
        const currentPrompt = currentPromptWasIncluded || !prompt.trim()
          ? ""
          : `CURRENT MESSAGE:\n${prompt}`;
        const intro = engineSyncRequested
          ? `We switched engines in this Jinn session. Sync your context with this transcript (most recent last), then respond to the current message.`
          : `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the current message.`;
        return [intro, transcript, currentPrompt].filter(Boolean).join("\n\n");
      })()
      : prompt;

    const turnStartedAt = Date.now();
    let modelForTurn = currentSession.model ?? engineConfig.model;
    const runAttempt = (modelForAttempt: string | undefined) => engine.run({
      prompt: promptToRun,
      resumeSessionId: resumeRefAtTurnStart.id ?? undefined,
      systemPrompt,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: modelForAttempt,
      effortLevel,
      cliFlags: employee?.cliFlags,
      mcpConfigPath,
      resolvedMcp,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: currentSession.id,
      source: currentSession.source,
      onStream: (delta) => {
        // Same guard as runHeartbeat: a delta may arrive after the user
        // deleted the session; don't resurrect registry state for it.
        if (!getSession(currentSession.id)) return;
        const normalized = normalizeBlockDeltaForTurn(delta, turnStartedAt);
        if (!normalized.ok) {
          logger.warn(`Dropped invalid block delta for session ${currentSession.id}: ${normalized.error}`);
          return;
        }
        const outgoingDelta = normalized.delta;
        // Live context-meter: message_start.usage arrives as a `context` delta
        // (once per assistant message — infrequent). Persist it immediately so the
        // meter ticks during the turn, not just at completion. The delta also flows
        // to the FE below for an instant in-pane update.
        if (outgoingDelta.type === "context") {
          // Only the MAIN agent's stream reaches here (the proxy suppresses
          // sub-agent/auxiliary streams), so its usage drives the session meter.
          const ctx = Number(outgoingDelta.content);
          if (Number.isFinite(ctx) && ctx > 0) {
            updateSession(currentSession.id, { lastContextTokens: ctx });
          }
        }
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: outgoingDelta.type,
            content: outgoingDelta.content,
            toolName: outgoingDelta.toolName,
            toolId: outgoingDelta.toolId,
            input: outgoingDelta.input,
            block: outgoingDelta.block,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        // Mirror the block into a persisted partial row (refresh survival). Guarded
        // so a DB hiccup never breaks the live stream above.
        try {
          persistPartialDelta(outgoingDelta);
        } catch (err) {
          logger.warn(`Failed to persist partial block for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        // Voice mode: stream the orchestrator's spoken text — complete sentences
        // synthesize immediately (per-sentence streaming); the flush at completion
        // speaks the remainder. Only `text` deltas are spoken; tool_use/context
        // are not. Skip entirely when the client is muted (silent/read mode) —
        // there's no point buffering or synthesizing audio the browser will discard.
        if (
          currentSession.source === "talk" &&
          !isTalkMuted(currentSession.id) &&
          outgoingDelta.type === "text" &&
          typeof outgoingDelta.content === "string"
        ) {
          feedTalkText(currentSession.id, outgoingDelta.content, config.talk?.kokoro, context.emit);
        }
      },
      // A turn that settled as failed but whose CLI later finished delivers the
      // recovered text here. Append it and restore a clean idle status — unless
      // the session is gone or a NEW turn owns it (status back to "running").
      onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
        const live = getSession(currentSession.id);
        if (!live || live.status === "running" || live.engine !== engineAtTurnStart) return;
        insertMessage(currentSession.id, "assistant", lateText);
        if (engineSid.trim()) {
          recordEngineSessionId(currentSession.id, engineAtTurnStart, engineSid, {
            model: modelForAttempt,
            effortLevel,
            lastSyncedAt: new Date().toISOString(),
          });
        }
        const recovered = updateSession(currentSession.id, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        // The parent/channel already saw this turn fail — label the late answer
        // so it reads as a supersede, not a fresh unprompted turn.
        const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${lateText}`;
        if (recovered) {
          notifyParentSession(recovered, { result: labelled, error: null }, { alwaysNotify: employee?.alwaysNotify });
          void deliverConnectorReply(recovered, labelled, context.connectors);
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          employee: currentSession.employee || config.portal?.portalName || "Jinn",
          title: currentSession.title,
          result: lateText,
          error: null,
        });
        logger.info(`Web session ${currentSession.id} recovered by late Stop after a failed turn`);
      },
    }).finally(() => {
      // Stop any pending debounced text flush so it can't re-insert a partial row
      // after the turn-end cleanup below deletes them.
      if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
      flushPartialText();
    });
    let result = await runAttempt(modelForTurn);

    if (currentSession.engine === "claude" && result.error && !result.result.trim()) {
      await refreshClaudeModels(config);
      const refreshedRegistry = getModelRegistry(context.getConfig());
      const fallbackModel = selectClaudeModelFallback({
        engine: currentSession.engine,
        requestedModel: modelForTurn,
        error: result.error,
        models: refreshedRegistry.claude?.models ?? [],
      });
      if (fallbackModel) {
        logger.warn(`Claude model "${modelForTurn}" failed availability check; retrying session ${currentSession.id} with "${fallbackModel}"`);
        deletePartialMessages(currentSession.id);
        if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
        modelForTurn = fallbackModel;
        updateSession(currentSession.id, { model: fallbackModel, lastError: null });
        result = await runAttempt(modelForTurn);
      }
    }

    if (runHeartbeat) {
      clearInterval(runHeartbeat);
      runHeartbeat = undefined;
    }

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const liveAfterRun = getSession(currentSession.id);
    if (liveAfterRun?.engine !== engineAtTurnStart) {
      deletePartialMessages(currentSession.id);
      clearSupersededTurnMeta(currentSession.id);
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      logger.info(
        `Dropping stale ${engineAtTurnStart} result for session ${currentSession.id}; session now uses ${liveAfterRun?.engine ?? "unknown"}`,
      );
      return;
    }

    const wasInterrupted = result.error?.startsWith("Interrupted");
    const wasSuperseded = !wasInterrupted && isTurnSuperseded(currentSession.id, turnStartedAt);
    const quietPreempted = wasInterrupted || wasSuperseded;

    // Turn settled. Mid-turn rows are refresh-only, including tool rows: durable
    // chat history collapses to the final assistant message. If the turn was
    // preempted by a newer user message, drop stale partials/results so the old
    // assistant answer cannot land after the new user bubble.
    const streamedBlocks = getPartialMessages(currentSession.id);
    const finalBlocksById = new Map<string, ChatBlock>();
    for (const message of streamedBlocks) {
      for (const block of message.blocks ?? []) {
        finalBlocksById.set(block.id, block);
      }
    }
    const allStreamedBlocks = [...finalBlocksById.values()];
    const preserveStreamedBlocks = shouldPreserveStreamedBlocks({ quietPreempted, streamedBlocks });
    const preservedBlockIds = new Set<string>(
      preserveStreamedBlocks
        ? streamedBlocks
          .flatMap((message) => (message.blocks ?? []).map((block) => block.id))
        : [],
    );
    const finalBlocks = finalBlocksForAssistantMessage(allStreamedBlocks, preservedBlockIds);
    const resultAlreadyPersisted = preserveStreamedBlocks && resultAlreadyInStreamedBlocks(result.result, streamedBlocks);
    if (preserveStreamedBlocks) finalizePartialMessages(currentSession.id);
    else deletePartialMessages(currentSession.id);

    const rateLimit = !quietPreempted ? detectRateLimit(result) : { limited: false as const };

    if (rateLimit.limited) {
      // Drop any buffered voice text — we won't speak a rate-limited turn.
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      const emitDelta = (delta: StreamDelta) => {
        const normalized = normalizeBlockDeltaForTurn(delta, turnStartedAt);
        if (!normalized.ok) {
          logger.warn(`Dropped invalid rate-limit block delta for session ${currentSession.id}: ${normalized.error}`);
          return;
        }
        const outgoingDelta = normalized.delta;
        context.emit("session:delta", {
          sessionId: currentSession.id,
          type: outgoingDelta.type,
          content: outgoingDelta.content,
          toolName: outgoingDelta.toolName,
          toolId: outgoingDelta.toolId,
          block: outgoingDelta.block,
        });
      };

      const outcome = await handleRateLimit({
        session: currentSession,
        prompt,
        systemPrompt,
        engineConfig,
        effortLevel,
        cliFlags: employee?.cliFlags,
        // Carry the resolved MCP set into the rate-limit retry/fallback turn so a
        // web session that hits a usage limit keeps its MCP tools on recovery —
        // parity with the connector path (manager.ts runSession → handleRateLimit).
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        config,
        engines: context.sessionManager.getEngines(),
        employee,
        engine,
        rateLimit,
        originalResult: result,
        hooks: {
          onFallbackStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;
            const notificationText =
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`;
            insertMessage(currentSession.id, "notification", notificationText);

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to GPT.`,
            );

            // Switching away from Claude — drop any warm Claude PTY AND its armed
            // late-recovery listener so the abandoned claude turn can't double-answer
            // after the GPT fallback delivers.
            const claudeEngine = context.sessionManager.getEngines().get("claude");
            if (claudeEngine && isInterruptibleEngine(claudeEngine)) {
              claudeEngine.kill(currentSession.id, "Interrupted: engine switched");
            }
          },
          onFallbackStream: emitDelta,
          onFallbackComplete: (fallbackResult) => {
            if (fallbackResult.result) {
              insertMessage(currentSession.id, "assistant", fallbackResult.result);
            }

            const fallbackCompletedAt = new Date().toISOString();
            if (fallbackResult.sessionId?.trim()) {
              const fallbackEngineName = getSession(currentSession.id)?.engine ?? currentSession.engine;
              recordEngineSessionId(currentSession.id, fallbackEngineName, fallbackResult.sessionId, {
                model: modelForTurn,
                effortLevel,
                lastSyncedAt: fallbackCompletedAt,
              });
            }
            const completedFallback = updateSession(currentSession.id, {
              status: fallbackResult.error ? "error" : "idle",
              lastActivity: fallbackCompletedAt,
              lastError: fallbackResult.error ?? null,
            });
            if (completedFallback) {
              notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              // Relay the fallback turn to the originating connector channel (#51).
              if (fallbackResult.result) void deliverConnectorReply(completedFallback, fallbackResult.result, context.connectors);
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Jinn",
              title: currentSession.title,
              result: fallbackResult.result,
              error: fallbackResult.error || null,
              cost: fallbackResult.cost,
              durationMs: fallbackResult.durationMs,
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
          onWaitingStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            // Send hardcoded Discord notification — does not depend on the LLM
            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
            );

            const notificationText =
              `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
            insertMessage(currentSession.id, "notification", notificationText);

            // Notify parent session about rate limit (fire-and-forget)
            const waitingSession = getSession(currentSession.id);
            notifyRateLimited(
              (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
              resumeAt
                ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                : undefined,
            );

            context.emit("session:rate-limited", {
              sessionId: currentSession.id,
              employee: currentSession.employee,
              error: result.error,
              resetsAt: rateLimit.resetsAt ?? null,
            });
          },
          onRetryStream: emitDelta,
          onRetrySuccess: (retryResult) => {
            // Usage limit cleared — handle result
            if (retryResult.result) {
              insertMessage(currentSession.id, "assistant", retryResult.result);
            }

            const retryCompletedAt = new Date().toISOString();
            if (retryResult.sessionId?.trim()) {
              recordEngineSessionId(currentSession.id, engineAtTurnStart, retryResult.sessionId, {
                model: modelForTurn,
                effortLevel,
                lastSyncedAt: retryCompletedAt,
              });
            }
            const completedAfterRetry = updateSession(currentSession.id, {
              status: retryResult.error ? "error" : "idle",
              lastActivity: retryCompletedAt,
              lastError: retryResult.error ?? null,
            });

            if (completedAfterRetry) {
              notifyRateLimitResumed(completedAfterRetry);
              notifyDiscordChannel(
                `✅ Claude usage limit cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
              );
              notifyParentSession(completedAfterRetry, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              // Relay the resumed (rate-limit-cleared) turn to the originating connector channel (#51).
              if (retryResult.result) void deliverConnectorReply(completedAfterRetry, retryResult.result, context.connectors);
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Jinn",
              title: currentSession.title,
              result: retryResult.result,
              error: retryResult.error || null,
              cost: retryResult.cost,
              durationMs: retryResult.durationMs,
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
          onTimeout: () => {
            notifyDiscordChannel(
              `❌ Claude usage limit did not clear in time. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
            );
            const erroredSession = updateSession(currentSession.id, {
              status: "error",
              lastActivity: new Date().toISOString(),
              lastError: "Claude usage limit did not clear in time",
            });
            if (erroredSession) {
              notifyParentSession(erroredSession, { error: "Claude usage limit did not clear in time" }, { alwaysNotify: employee?.alwaysNotify });
            }
            context.emit("session:completed", {
              sessionId: currentSession.id,
              result: null,
              error: "Claude usage limit did not clear in time",
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
        },
      });

      void outcome; // outcome handled entirely via hooks
      return;
    }

    // Persist the assistant response
    if (shouldPersistFinalAssistantMessage({
      resultText: result.result,
      finalBlockCount: finalBlocks.length,
      resultAlreadyPersisted,
      quietPreempted,
    })) {
      insertMessage(currentSession.id, "assistant", result.result, undefined, finalBlocks.length > 0 ? finalBlocks : undefined);
    } else if (!quietPreempted && result.error && !result.result.trim()) {
      insertMessage(currentSession.id, "assistant", formatEngineErrorAssistantMessage(result.error));
    }

    // Voice mode: flush the remainder of the turn's spoken text (final chunk,
    // carries last:true). Fire-and-forget so completion isn't blocked on audio.
    // Discard (don't synthesize) on a half-finished interrupt OR when the client
    // is muted — the browser plays nothing in silent mode.
    if (currentSession.source === "talk") {
      if (quietPreempted || isTalkMuted(currentSession.id)) discardTalkSpeech(currentSession.id);
      else void flushTalkSpeech(currentSession.id, config.talk?.kokoro, context.emit);
    }

    const completedAt = new Date().toISOString();
    if (result.sessionId?.trim()) {
      recordEngineSessionId(currentSession.id, engineAtTurnStart, result.sessionId, {
        model: modelForTurn,
        effortLevel,
        lastSyncedAt: completedAt,
      });
    }
    const completedSession = updateSession(currentSession.id, {
      ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      // An interrupt (new message arrived / user stopped) is NOT an error — land idle
      // with no lastError, mirroring the connector path (manager.ts). Otherwise the
      // session would stick in "error" with a misleading "Interrupted" message and
      // fire a false parent-callback failure when the interrupt is the last action.
      status: quietPreempted ? "idle" : (result.error ? "error" : "idle"),
      lastActivity: completedAt,
      lastError: quietPreempted ? null : (result.error ?? null),
    });
    if (!quietPreempted && engineAtTurnStart === "claude") {
      markTranscriptSyncedThrough(currentSession.id, result.sessionId);
    }
    if (syncRequested && !rateLimit.limited && !quietPreempted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        delete nextMeta["engineSyncTarget"];
        delete nextMeta["engineSyncSince"];
        updateSession(currentSession.id, { transportMeta: nextMeta as any });
      }
    }
    clearSupersededTurnMeta(currentSession.id);
    const reportedError = quietPreempted ? null : (result.error ?? null);
    if (completedSession && !quietPreempted) {
      notifyParentSession(completedSession, { result: result.result, error: reportedError, cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
    }

    // Relay the turn back to the originating connector channel (#51). Only
    // connector-sourced sessions reaching this path (parent callbacks, cron
    // follow-ups) deliver; web/talk/cron + interrupted turns no-op.
    if (completedSession && !quietPreempted && result.result) {
      await deliverConnectorReply(completedSession, result.result, context.connectors);
    }

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Jinn",
      title: currentSession.title,
      result: quietPreempted ? null : result.result,
      error: reportedError,
      cost: result.cost,
      durationMs: result.durationMs,
    });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const live = getSession(currentSession.id);
    if (!live) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    if (live.engine !== engineAtTurnStart) {
      if (runHeartbeat) {
        clearInterval(runHeartbeat);
        runHeartbeat = undefined;
      }
      deletePartialMessages(currentSession.id);
      clearSupersededTurnMeta(currentSession.id);
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      logger.info(
        `Dropping stale ${engineAtTurnStart} error for session ${currentSession.id}; session now uses ${live.engine}`,
      );
      return;
    }
    // The run threw — drop any orphaned mid-turn partial blocks.
    deletePartialMessages(currentSession.id);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  } finally {
    if (runHeartbeat) {
      clearInterval(runHeartbeat);
      runHeartbeat = undefined;
    }
    // Clean up the per-session Claude MCP temp file AFTER the full turn lifecycle
    // (including any rate-limit retry/fallback that reused mcpConfigPath). Mirrors
    // the connector path's outer-finally cleanup (manager.ts runSession). Idempotent
    // and a no-op for engines that never wrote one.
    if (mcpConfigPath) cleanupMcpConfigFile(currentSession.id);
  }
}
