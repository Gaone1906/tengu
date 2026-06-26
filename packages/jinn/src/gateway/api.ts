import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ChatBlock, ChatBlockEnvelope, CronJob, Engine, IncomingMessage, JinnConfig, JsonObject, Session, StreamDelta, Target } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { getModelRegistry, invalidateModelRegistry, effortLevelsForModel, refreshGrokModels, refreshPiModels, refreshHermesModels, engineAvailable, isKnownEngine, engineUnavailableMessage } from "../shared/models.js";
import { validateNewSessionSelection, validateSessionPatch } from "../sessions/session-patch.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  listSessions,
  listRecentPerGroup,
  listSessionsForGroup,
  getSessionGroupCounts,
  coercePortalEmployee,
  searchSessions,
  listChildSessions,
  getSession,
  createSession,
  updateSession,
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
  enqueueQueueItem,
  cancelQueueItem,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  getFile,
  initDb,
} from "../sessions/registry.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import { forkEngineSession } from "../sessions/fork.js";
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
import { detectRateLimit } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt } from "../shared/usageAwareness.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { handleRateLimit } from "../sessions/rate-limit-handler.js";
import { pickEncoding, compressBuffer, MIN_COMPRESS_BYTES } from "./compress.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { runCronJob } from "../cron/runner.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, handleSessionAttachment, fileIdsToMedia, rehomeAttachmentsToSession, ensureFilesDir } from "./files.js";
import { readJsonBody, readBodyRaw } from "./http-helpers.js";
import { readJsonlTail } from "./jsonl-tail.js";
import { resultAlreadyInStreamedBlocks, shouldPreserveStreamedBlocks } from "./streamed-blocks.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel, notifyAttachedTalkSessions } from "../sessions/callbacks.js";
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
  matchesGatewayAuthToken,
  revokeAuthSession,
  touchAuthSession,
} from "./auth.js";
import { markTranscriptSyncedThrough, scheduleOnLoadTailSync, transcriptEntryText } from "./external-turns.js";
import { handleTalkApi } from "../talk/routes.js";
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

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;
/** Max bytes accepted by public auth helpers. Codes/tokens are tiny. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;
const SESSION_LIST_PER_GROUP = 50;
const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;
const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";

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

export function shouldPersistFinalAssistantMessage(options: {
  resultText: string;
  finalBlockCount: number;
  resultAlreadyPersisted: boolean;
  quietPreempted: boolean;
}): boolean {
  if (options.resultAlreadyPersisted || options.quietPreempted) return false;
  return options.resultText.trim().length > 0 || options.finalBlockCount > 0;
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
}

function killSessionEngines(context: ApiContext, session: Session, reason: string): void {
  const engines = new Set<Engine>();
  const primary = context.sessionManager.getEngine(session.engine);
  const pty = context.ptyViewEngines?.[session.engine];
  if (primary) engines.add(primary);
  if (pty) engines.add(pty);

  for (const engine of engines) {
    if (isInterruptibleEngine(engine)) engine.kill(session.id, reason);
  }
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    let session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
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
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const bearer = hasGatewayBearerAuth(req.headers, context.gatewayAuthToken);
      const localBrowser = isLoopback(req.socket.remoteAddress)
        && isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
      if (!bearer && !localBrowser) return json(res, { error: "Pairing codes can only be created locally" }, 403);
      const issued = issuePairingCode();
      return json(res, {
        status: "ok",
        code: issued.code,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        ttlSeconds: Math.floor((issued.expiresAt - Date.now()) / 1000),
      });
    }

    // POST /api/auth/pair — exchange a one-time pairing code (or advanced token
    // fallback) for the HttpOnly browser cookie used by APIs and WebSockets.
    if (method === "POST" && pathname === "/api/auth/pair") {
      const parsed = await readJsonBody(req, res, { maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      const code = typeof body.code === "string" ? body.code : undefined;
      const token = typeof body.token === "string" ? body.token : undefined;
      const pairedWithToken = matchesGatewayAuthToken(token, context.gatewayAuthToken);
      const ok = consumePairingCode(undefined, code) || pairedWithToken;
      if (!ok || !context.gatewayAuthToken) return json(res, { error: "Invalid or expired pairing code" }, 401);
      const session = createAuthSession(jinnHome, req, { kind: pairedWithToken ? "token" : "remote" });
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
      const sessions = listSessions();
      const running = sessions.filter((s) => isSessionLiveRunning(s, context)).length;
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
        sessions: { total: sessions.length, running, active: running },
        connectors,
      });
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

    // GET /api/sessions/:id
    let params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      let messages = getMessages(params.id);

      // Backfill from Claude Code's JSONL transcript if our DB has no messages.
      // Run async + transactional so the GET doesn't block on multi-MB JSONL
      // parsing + N individual INSERTs. Subsequent GETs will see the messages
      // once the backfill finishes; this one returns whatever is in DB now.
      if (messages.length === 0 && session.engineSessionId) {
        scheduleTranscriptBackfill(params.id, session.engineSessionId, context);
      } else if (session.engine === "claude") {
        // On-load safety net for PTY-native (CLI-typed) turns whose unclaimed
        // Stop was missed entirely: fire-and-forget a transcript tail sync.
        // Cheap (one stat() in the common case) and never delays this GET —
        // the frontend refetches on `session:external-turn`.
        scheduleOnLoadTailSync(params.id, context.emit);
      }

      // Support ?last=N to return only the N most recent messages
      const lastN = parseInt(url.searchParams.get("last") || "0", 10);
      if (lastN > 0 && messages.length > lastN) {
        messages = messages.slice(-lastN);
      }

      return json(res, { ...serializeSession(session, context), messages });
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
      // Mid-chat model / effort switch (applies from the next turn). Engine is
      // new-chat-only, so it's not mutable here. Validated against the registry.
      if (body.model !== undefined || body.effortLevel !== undefined) {
        const configForPatch = context.getConfig();
        const engineConfigForPatch =
          (configForPatch.engines as unknown as Record<string, { model?: string } | undefined>)[session.engine] ?? {};
        const patch = validateSessionPatch(configForPatch, session.engine, session.model, body, {
          engineSessionId: session.engineSessionId,
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
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/stop
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
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
      updateSession(params.id, {
        status: "idle",
        engineSessionId: null,
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
        updateSession(newSession.id, { engineSessionId: forkResult.engineSessionId });

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

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      if (!session.engineSessionId) return json(res, []);
      const entries = loadRawTranscript(session.engineSessionId);
      return json(res, entries);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      const config = context.getConfig();
      const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
      let employeeDefaults: { engine: string; model: string; effortLevel?: string } | undefined;
      if (employeeName) {
        const { scanOrg } = await import("./org.js");
        const emp = scanOrg().get(employeeName);
        if (emp) {
          employeeDefaults = { engine: emp.engine, model: emp.model };
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
        return { ...job, lastRun: entries[0] ?? null };
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
      return json(res, runs);
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const jobs = loadJobs();
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
      };
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
      jobs[idx] = { ...jobs[idx], ...body, id: params.id };
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

      // Fire and forget — respond immediately, run in background
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors).catch(
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
        return {
          ...rest,
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
      await refreshPiModels(config);
      await refreshGrokModels(config);
      await refreshHermesModels(config);
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
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
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
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, 30));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      const sessions = listSessions();
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
        sessionsCount: sessions.length,
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

    // ── Talk (/talk voice loop) ───────────────────────────────
    if (pathname.startsWith("/api/talk/")) {
      const handled = await handleTalkApi(req, res, context);
      if (handled) return;
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
        if (existing && existing.engineSessionId !== hookBody.hook.session_id) {
          updateSession(hookBody.jinnSessionId, { engineSessionId: hookBody.hook.session_id });
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
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

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

  try {

    const systemPrompt = buildContext({
      source: currentSession.source,
      channel: currentSession.sourceRef,
      user: currentSession.userId ?? "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
      hierarchy: orgHierarchy,
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
    const runHeartbeat = setInterval(() => {
      // If the session was deleted mid-turn, stop heartbeating immediately —
      // the engine.run promise may still take minutes to resolve, and we don't
      // want to keep writing status:"running" rows for a session the user
      // already removed (and risk re-creating registry state in some paths).
      if (!getSession(currentSession.id)) {
        clearInterval(runHeartbeat);
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
        if (delta.type === "text_snapshot") {
          if (delta.content.length > curText.length) curText = delta.content;
        } else {
          curText += delta.content;
        }
        if (!partialFlushTimer) partialFlushTimer = setTimeout(flushPartialText, 600);
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

    const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
    const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
    const syncRequested = currentSession.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
    const promptToRun = syncRequested
      ? (() => {
        const sinceMessages = getMessages(currentSession.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        return `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      })()
      : prompt;

    const turnStartedAt = Date.now();
    const result = await engine.run({
      prompt: promptToRun,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: currentSession.model ?? engineConfig.model,
      effortLevel,
      cliFlags: employee?.cliFlags,
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
        if (!live || live.status === "running") return;
        insertMessage(currentSession.id, "assistant", lateText);
        const recovered = updateSession(currentSession.id, {
          ...(engineSid.trim() ? { engineSessionId: engineSid } : {}),
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
      clearInterval(runHeartbeat);
      // Stop any pending debounced text flush so it can't re-insert a partial row
      // after the turn-end cleanup below deletes them.
      if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
      flushPartialText();
    });

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const wasInterrupted = result.error?.startsWith("Interrupted");
    const wasSuperseded = !wasInterrupted && isTurnSuperseded(currentSession.id, turnStartedAt);
    const quietPreempted = wasInterrupted || wasSuperseded;

    // Turn settled. Mid-turn rows are refresh-only, including tool rows: durable
    // chat history collapses to the final assistant message. If the turn was
    // preempted by a newer user message, drop stale partials/results so the old
    // assistant answer cannot land after the new user bubble.
    const streamedBlocks = getMessages(currentSession.id).filter((m) => m.partial);
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

            const completedFallback = updateSession(currentSession.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
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

            const completedAfterRetry = updateSession(currentSession.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: retryResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
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
    }

    // Voice mode: flush the remainder of the turn's spoken text (final chunk,
    // carries last:true). Fire-and-forget so completion isn't blocked on audio.
    // Discard (don't synthesize) on a half-finished interrupt OR when the client
    // is muted — the browser plays nothing in silent mode.
    if (currentSession.source === "talk") {
      if (quietPreempted || isTalkMuted(currentSession.id)) discardTalkSpeech(currentSession.id);
      else void flushTalkSpeech(currentSession.id, config.talk?.kokoro, context.emit);
    }

    const completedSession = updateSession(currentSession.id, {
      ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
      ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      // An interrupt (new message arrived / user stopped) is NOT an error — land idle
      // with no lastError, mirroring the connector path (manager.ts). Otherwise the
      // session would stick in "error" with a misleading "Interrupted" message and
      // fire a false parent-callback failure when the interrupt is the last action.
      status: quietPreempted ? "idle" : (result.error ? "error" : "idle"),
      lastActivity: new Date().toISOString(),
      lastError: quietPreempted ? null : (result.error ?? null),
    });
    if (!quietPreempted && currentSession.engine === "claude") {
      markTranscriptSyncedThrough(currentSession.id, result.sessionId);
    }
    if (syncRequested && !rateLimit.limited && !quietPreempted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
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
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
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
  }
}
