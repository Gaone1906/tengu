import type { TalkGraphNodeWire } from '@/routes/talk/protocol'
import { authFetch } from "@/lib/auth"

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  effortLevel?: string;
  cliFlags?: string[];
  alwaysNotify?: boolean;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

/** Editable employee fields accepted by PATCH /api/org/employees/:name.
 *  `name` is immutable and is intentionally omitted. */
export interface EmployeeUpdate {
  displayName?: string;
  department?: string;
  rank?: "executive" | "manager" | "senior" | "employee";
  engine?: string;
  model?: string;
  effortLevel?: string;
  persona?: string;
  reportsTo?: string | string[];
  cliFlags?: string[];
  alwaysNotify?: boolean;
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body.error) return String(body.error);
    if (body.message) return String(body.message);
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await authFetch(path);
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await authFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

/**
 * Background work still running after a session's turn officially ended
 * (subagents / background tasks making API calls). Present on session rows
 * (list + detail) and pushed live via the `session:background` WS event.
 * null/absent = no background work.
 */
export interface BackgroundActivity {
  activeStreams: number
  lastActivityAt: string
}

export interface SessionsResponse {
  /** Top-N most-recent sessions per group (employee / direct / cron). */
  sessions: Record<string, unknown>[]
  /** Total session count per group key, so the UI can show accurate "+N more". */
  counts: Record<string, number>
  /** How many per group the server returned (the load-more threshold). */
  perGroup: number
}

// --- Model + capability registry (GET /api/engines) ---
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  effortLevels: string[];
  contextWindow?: number;
}
export interface EngineRegistryEntry {
  name: string;
  available: boolean;
  defaultModel: string;
  effortMechanism: "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "none";
  models: ModelInfo[];
}
export interface EnginesResponse {
  default: string;
  engines: Record<string, EngineRegistryEntry>;
}

// --- Engine quota/limit snapshots (GET /api/engine-limits) ---
export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitContext {
  usedPercent?: number;
  remainingPercent?: number;
  contextWindowSize?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface EngineLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
  limit?: number;
  used?: number;
  remainingPercent?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitBucket {
  id: string;
  name?: string;
  planType?: string;
  primary?: EngineLimitWindow;
  secondary?: EngineLimitWindow;
  credits?: EngineLimitCredits;
}

export interface EngineLimitEngineSnapshot {
  name: string;
  available: boolean;
  status: "live" | "snapshot" | "static" | "unsupported" | "error";
  source: string;
  refreshedAt: string;
  defaultModel?: string;
  models: ModelInfo[];
  accountPlan?: string;
  windows?: EngineLimitWindow[];
  buckets?: EngineLimitBucket[];
  credits?: EngineLimitCredits;
  context?: EngineLimitContext;
  costUsd?: number;
  unsupportedReason?: string;
  error?: string;
  stale?: boolean;
}

export interface EngineLimitsResponse {
  generatedAt: string;
  default: string;
  engines: Record<string, EngineLimitEngineSnapshot>;
}

// --- Talk: session search + delegate (Mission Control) ---
export interface TalkSearchHit {
  snippet: string
  role: string
  ts: number
}
export interface TalkSearchResult {
  sessionId: string
  title: string | null
  employee: string | null
  source: string
  lastActivity: string
  status: string
  isTalkChild: boolean
  hits: TalkSearchHit[]
}
export interface TalkSearchResponse {
  ok: true
  results: TalkSearchResult[]
}
/** POST /api/talk/delegate body — see talkDelegate() / the server delegate.ts. */
export interface TalkDelegateBody {
  /** The caller's own talk session id (orchestratorId). Required. */
  sessionId: string
  /** "new" to spawn, or a session id to continue / attach / detach. */
  thread: string
  attach?: boolean
  detach?: boolean
  mode?: "observe" | "engage"
  brief?: string
  label?: string
  utterance?: string
}
export type TalkDelegateResult =
  | { ok: true; threadId: string; created: boolean }
  | { ok: true; threadId: string; attached: true; mode: "observe" | "engage" }
  | { ok: true; threadId: string; detached: true }

export const api = {
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  /** Resolved model + capability registry (engines, their models, effort levels). */
  getEngines: () => get<EnginesResponse>("/api/engines"),
  /** Force re-discovery of dynamic (pi) models, returning the rebuilt registry. */
  refreshEngines: () => post<EnginesResponse>("/api/engines/refresh"),
  getEngineLimits: (engine?: string) =>
    get<EngineLimitsResponse>(`/api/engine-limits${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`),
  refreshEngineLimits: (engine?: string) =>
    post<EngineLimitsResponse>(`/api/engine-limits/refresh${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, {}),
  getSessions: () => get<SessionsResponse>("/api/sessions"),
  /** One group's sessions, newest first — used by the sidebar "load more" button. */
  getSessionsForGroup: (group: string, offset: number, limit = 50) =>
    get<Record<string, unknown>[]>(
      `/api/sessions?group=${encodeURIComponent(group)}&offset=${offset}&limit=${limit}`,
    ),
  /** Search across ALL sessions (title / employee / id), newest first. */
  searchSessions: (query: string) =>
    get<Record<string, unknown>[]>(`/api/sessions?q=${encodeURIComponent(query)}`),
  getSession: (id: string, options?: { last?: number; messages?: boolean }) => {
    const params = new URLSearchParams()
    if (options?.last) params.set("last", String(options.last))
    if (options?.messages === false) params.set("messages", "0")
    const query = params.toString()
    return get<Record<string, unknown>>(`/api/sessions/${id}${query ? `?${query}` : ""}`)
  },
  getSessionMessages: (id: string, options: { before?: string; limit?: number }) => {
    const params = new URLSearchParams()
    if (options.before) params.set("before", options.before)
    if (options.limit) params.set("limit", String(options.limit))
    const query = params.toString()
    return get<{ messages: Record<string, unknown>[]; hasOlder: boolean }>(
      `/api/sessions/${id}/messages${query ? `?${query}` : ""}`,
    )
  },
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string; model?: string; effortLevel?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  /** PATCH an employee's editable fields. `name` is immutable and must not be sent.
   *  Returns the updated employee as re-scanned from disk. */
  updateEmployee: (name: string, data: EmployeeUpdate) =>
    patch<{ status: string; employee: Employee | null }>(
      `/api/org/employees/${name}`,
      data,
    ),
  getDepartmentBoard: (name: string) =>
    get<Record<string, unknown>>(`/api/org/departments/${name}/board`),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string; engine?: string; model?: string; effortLevel?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: unknown) =>
    put<Record<string, unknown>>(`/api/org/departments/${name}/board`, data),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await authFetch(`/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  /**
   * Talk (Path 1): bootstrap (or reuse) the voice orchestrator —
   * a real gateway session with source:"talk". Voice turns then go through the
   * normal sendMessage(); the spoken reply streams back as talk:audio over WS.
   */
  talkCreateSession: (fresh = false) =>
    post<{ sessionId: string; reused: boolean }>("/api/talk/session", { fresh }),
  /** Talk: full delegation-tree snapshot under the orchestrator (Mission Control).
   *  Nodes are the wire type (incl. briefExcerpt/attached/mode), not a stripped copy. */
  getTalkGraph: (rootId: string) =>
    get<{ rootId: string; nodes: TalkGraphNodeWire[] }>(
      `/api/talk/graph?root=${encodeURIComponent(rootId)}`,
    ),
  /** Talk: TTS/loop readiness + the active orchestrator engine/model. */
  talkStatus: () =>
    get<{
      ttsAvailable: boolean
      ttsDownloading: boolean
      progress: number
      voice?: string | null
      ready?: boolean
      /** Active orchestrator engine (null when none is installed). */
      engine: string | null
      model: string | null
      /** True when the configured/default engine was unavailable and we fell back. */
      engineFallback: boolean
      /** Installed engines the orchestrator could use, in priority order. */
      enginesAvailable: string[]
    }>("/api/talk/status"),
  /** Talk: kick off the local TTS model download (progress streams via talk:tts:download:* WS events). */
  talkTtsDownload: () =>
    post<{ status: string; model: string }>("/api/talk/tts/download", {}),
  /** Talk: the currently-active orchestrator engine/model + the available set. */
  talkEngineGet: () =>
    get<{
      engine: string | null
      model: string | null
      fallback: boolean
      reason: string | null
      available: string[]
      configured: string | null
      liveSessionEngine: string | null
    }>("/api/talk/engine"),
  /**
   * Talk: switch the orchestrator engine and/or model.
   * - model: applies to the live session on its next turn (no re-bootstrap).
   * - engine: new-chat-only — the caller MUST re-bootstrap the talk session
   *   (talkCreateSession) so the new engine is adopted.
   */
  talkEngineSet: (body: { engine?: string; model?: string }) =>
    post<{
      ok: boolean
      engine: string | null
      model: string | null
      fallback: boolean
      reason: string | null
      available: string[]
    }>("/api/talk/engine", body),
  /**
   * Talk: tell the gateway this talk session is muted (silent/read mode) so the
   * run loop skips server-side Kokoro synthesis it would otherwise discard.
   * Best-effort — the UI mutes regardless; this just saves the wasted synthesis.
   */
  talkSetMuted: (body: { sessionId: string; muted: boolean }) =>
    post<{ ok: boolean; muted: boolean }>("/api/talk/mute", body),
  /**
   * Talk: search sessions by title/metadata + message content (FTS). Returns
   * merged, de-duped results (≤20, ≤3 hits each); snippets carry «» highlight
   * markers. Throws on 4xx with the backend `error` message.
   */
  talkSearch: (q: string, limit?: number) =>
    get<TalkSearchResponse>(
      `/api/talk/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`,
    ),
  /**
   * Talk: server-owned delegate surface — spawn (thread:"new"), continue an
   * owned COO thread (thread:"<id>"), or attach/detach a soft link
   * (attach:true / detach:true, optional mode:"observe"|"engage" + brief).
   * NOTE: a follow-up to an ALREADY-attached engage session does NOT go here
   * (both delegate paths 400 — see the thread drawer's composer, which uses
   * sendMessage instead). Throws on 4xx with the backend `error` message.
   */
  talkDelegate: (body: TalkDelegateBody) =>
    post<TalkDelegateResult>("/api/talk/delegate", body),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File, sessionId?: string): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    // When known, scope the upload to the session so it lands in the date-bucketed uploads dir.
    if (sessionId) form.append('sessionId', sessionId)
    const res = await authFetch("/api/files", { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};
