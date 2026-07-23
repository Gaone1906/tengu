import { authFetch } from "@/lib/auth"
import type {
  CreateNoteInput,
  NoteDocumentResponse,
  NotesListResponse,
  UpdateNoteInput,
} from "@/routes/notes/types"

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

export interface InstanceMigration {
  required: boolean
  fromVersion: string
  toVersion: string
  versions: string[]
  changedFiles: Array<{ path: string; operation: 'add' | 'modify' | 'remove' }>
  prompt: string | null
  migrationKey: string | null
}

export interface OpenInstanceMigrationResult {
  sessionId: string
  reused: boolean
  migrationKey: string
}

export interface WorkspaceInfo {
  id: string
  name: string
  displayName: string
  port: number
  running: boolean
  current: boolean
  switchUrl: string
  warning?: string
}

export interface CreateWorkspaceResult {
  instance: WorkspaceInfo
  launchUrl: string
  warning?: string
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

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly currentVersion?: number

  constructor(status: number, message: string, code?: string, currentVersion?: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.currentVersion = currentVersion
  }
}

/** Structured conditional-edit failure for the Todos surface. */
export class TodoApiError extends ApiError {
  constructor(status: number, message: string, code?: string, currentVersion?: number) {
    super(status, message, code, currentVersion)
    this.name = "TodoApiError"
  }
}

/** A Todo revision is authoritative only when it is a positive safe integer. */
export function isPositiveTodoVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

async function responseError(res: Response): Promise<ApiError> {
  let message = `API error: ${res.status}`
  let code: string | undefined
  let currentVersion: number | undefined
  try {
    const body = await res.json();
    if (body.error) message = String(body.error)
    else if (body.message) message = String(body.message)
    if (typeof body.code === "string" && body.code.trim()) code = body.code
    if (typeof body.currentVersion === "number" && Number.isSafeInteger(body.currentVersion) && body.currentVersion >= 0) {
      currentVersion = body.currentVersion
    }
  } catch {
    // Response wasn't JSON; status remains the typed UI-safe discriminator.
  }
  return new ApiError(res.status, message, code, currentVersion)
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await authFetch(path, { method: "DELETE" });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res);
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

/** Active employee sessions anywhere below a parent session. Derived by the
 * gateway at read time; it is never part of the durable session status. */
export interface DelegatedActivity {
  activeSessions: number
  employees: string[]
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
  /** Model is in the engine's featured set — shown by default in the picker. */
  featured?: boolean;
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
  // `unavailable` = engine CLI not installed (temporary); `unsupported` = CLI
  // installed but no local quota endpoint.
  status: "live" | "snapshot" | "static" | "unavailable" | "unsupported" | "error";
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

/* ── Read-only Workflow definitions ───────────────────────────────────────── */

export interface WorkflowDefinitionSummaryV2Wire {
  id: string
  title: string
  description: string | null
  revision: number
  enabled: boolean
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowDefinitionV2Wire {
  schemaVersion: 1
  id: string
  title: string
  description?: string
  revision: number
  enabled: boolean
  retiredAt?: string
  createdAt: string
  updatedAt: string
  inputs?: Array<Record<string, unknown>>
  nodes: Array<{
    id: string
    type: "trigger" | "employee" | "condition" | "merge" | "approval" | "wait" | "end"
    name: string
    config: Record<string, unknown>
  }>
  edges: Array<{
    id: string
    from: { nodeId: string; port: string }
    to: { nodeId: string; port: "input" }
  }>
  ui: { positions: Record<string, { x: number; y: number }> }
}

export type WorkItemStatusWire =
  | "backlog" | "assigned" | "executing" | "in_review" | "done" | "blocked" | "escalated" | "cancelled"
export type WorkItemSourceWire =
  | "human" | "delegation" | "cron" | "workflow" | "session" | "connector" | "goal"
export type ApprovalStateWire = "pending" | "approved" | "rejected"
export type VerifyModeWire = "trust" | "verify" | "thorough"

/** The compact row's session provenance (gateway `sessionRef()`): the session
 *  id parsed from a `session:`/`delegate:` sourceRef, plus the optional
 *  human-readable ref suffix. */
export interface WorkItemSessionRefWire {
  sessionId: string
  ref?: string | null
}

/** The compact row GET /api/work-items returns (list/board/people). */
export interface WorkItemCompactWire {
  id: string
  /** Positive monotonic whole-row revision on CAS-capable gateways. */
  version?: number
  title: string
  status: WorkItemStatusWire
  assignee: string | null
  department: string | null
  source: WorkItemSourceWire
  sourceRef: string | null
  approvalState: ApprovalStateWire | null
  approvalRequest: string | null
  approvalRef: string | null
  approvalTarget: string | null
  approvalEscalatedAt: string | null
  sessionRef?: WorkItemSessionRefWire | null
  /** Todos v2 (optional: older gateways omit them). */
  createdBy?: string
  parentId?: string | null
  rootId?: string
  depth?: number
  dueAt?: string | null
  updatedAt: string
  /** Manual sort rank (design-todos §7.3). Null until the operator reorders. */
  rank?: number | null
}

/** GET /api/work-items and /api/search/work-items page payload
 *  (`workItemPagePayload`): one page of rows plus the TRUE match counts for
 *  the whole filtered set and the offset to fetch next (null = exhausted). */
export interface WorkItemListWire {
  workItems: WorkItemCompactWire[]
  total?: number
  totals?: Partial<Record<WorkItemStatusWire, number>>
  limit?: number
  offset?: number
  nextOffset?: number | null
}

export interface VerifyPolicyWire {
  mode: VerifyModeWire
  verifier?: { employee?: string; engine?: string; model?: string }
  maxRounds?: number
}

/** The full row GET /api/work-items/:id returns under `workItem`. */
export interface WorkItemFullWire {
  id: string
  /** Positive monotonic whole-row revision on CAS-capable gateways. */
  version?: number
  title: string
  body: string | null
  status: WorkItemStatusWire
  department: string | null
  assignee: string | null
  priority: number
  /** Manual order is part of the whole-row CAS response and detail baseline. */
  rank: number | null
  source: WorkItemSourceWire
  sourceRef: string | null
  acceptance: string | null
  verifyPolicy: VerifyPolicyWire | null
  rounds: number
  budgetUsd: number | null
  approvalState: ApprovalStateWire | null
  approvalRequest: string | null
  approvalRef: string | null
  approvalTarget: string | null
  approvalEscalatedAt: string | null
  approvalDecidedBy: string | null
  approvalDecidedAt: string | null
  /** Todos v2 (optional: older gateways omit them). */
  createdBy?: string
  parentId?: string | null
  rootId?: string
  depth?: number
  dueAt?: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface WorkItemEditPatch {
  title?: string
  body?: string
  assignee?: string | null
  department?: string | null
  priority?: number
  rank?: number
}

export interface WorkItemEditRequest {
  patch: WorkItemEditPatch
  expectedVersion: number
  idempotencyKey: string
}

export interface VersionedWorkItemFullWire extends WorkItemFullWire {
  version: number
}

export interface WorkItemEditResultWire {
  workItem: VersionedWorkItemFullWire
  replayed: boolean
}

function requireWorkItemEditResult(value: unknown): WorkItemEditResultWire {
  if (
    typeof value !== "object"
    || value === null
    || !("workItem" in value)
    || typeof value.workItem !== "object"
    || value.workItem === null
    || !("version" in value.workItem)
    || !isPositiveTodoVersion(value.workItem.version)
  ) {
    throw new Error("Todo edit response has an invalid authoritative version")
  }
  if (!("replayed" in value) || typeof value.replayed !== "boolean") {
    throw new Error("Todo edit response has invalid replay metadata")
  }
  return value as WorkItemEditResultWire
}

export interface WorkItemEventWire {
  id: string
  workItemId: string
  kind: string
  fromStatus: WorkItemStatusWire | null
  toStatus: WorkItemStatusWire | null
  actor: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

/** The GET /api/work-items/:id payload: full row + live-derived spend + audit. */
export interface WorkItemDetailWire {
  workItem: WorkItemFullWire
  spendUsd: number
  events: WorkItemEventWire[]
}

export interface ApprovalDecisionResultWire {
  workItem: WorkItemFullWire
  escalated: boolean
}

export interface ApprovalEscalationResultWire {
  workItem: WorkItemFullWire
}

/** A serialized session linked to a Todo (the sheet's "Executing session" link
 *  only needs the id + a status glance; the rest is passthrough). */
export interface LinkedSessionWire {
  id: string
  status?: string
  title?: string | null
  lastActivity?: string | null
  [key: string]: unknown
}

export const api = {
  listWorkspaces: () => get<WorkspaceInfo[]>('/api/instances'),
  createWorkspace: (input: { name: string }) => post<CreateWorkspaceResult>('/api/instances', input),
  startWorkspace: (id: string) => post<WorkspaceInfo>(`/api/instances/${encodeURIComponent(id)}/start`),
  getInstanceMigration: () => get<InstanceMigration>('/api/instance-migration'),
  openInstanceMigration: (migrationKey: string) =>
    post<OpenInstanceMigrationResult>('/api/instance-migration/open', { migrationKey }),
  listNotes: (query?: string) => {
    const params = new URLSearchParams()
    if (query?.trim()) params.set("q", query.trim())
    const suffix = params.toString()
    return get<NotesListResponse>(`/api/notes${suffix ? `?${suffix}` : ""}`)
  },
  readNote: (path: string) =>
    get<NoteDocumentResponse>(`/api/notes/read?path=${encodeURIComponent(path)}`),
  createNote: (input: CreateNoteInput) =>
    post<NoteDocumentResponse>("/api/notes", input),
  updateNote: (input: UpdateNoteInput) =>
    put<NoteDocumentResponse>("/api/notes", input),
  getFeatures: () => get<{ notesEnabled: boolean }>("/api/features"),
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  listWorkflowDefinitionsV2: () =>
    get<{ items: WorkflowDefinitionSummaryV2Wire[]; nextCursor: string | null }>("/api/workflows"),
  getWorkflowDefinitionV2: (id: string) =>
    get<WorkflowDefinitionV2Wire>(`/api/workflows/${encodeURIComponent(id)}`),
  /** Resolved model + capability registry (engines, their models, effort levels). */
  getEngines: () => get<EnginesResponse>("/api/engines"),
  /** Force re-discovery of dynamic (pi) models, returning the rebuilt registry. */
  refreshEngines: () => post<EnginesResponse>("/api/engines/refresh"),
  getEngineLimits: (engine?: string, init?: RequestInit) =>
    get<EngineLimitsResponse>(`/api/engine-limits${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, init),
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
  getSession: (id: string, options?: { last?: number; messages?: boolean; signal?: AbortSignal }) => {
    const params = new URLSearchParams()
    if (options?.last) params.set("last", String(options.last))
    if (options?.messages === false) params.set("messages", "0")
    const query = params.toString()
    return get<Record<string, unknown>>(
      `/api/sessions/${id}${query ? `?${query}` : ""}`,
      options?.signal ? { signal: options.signal } : undefined,
    )
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
  updateSession: (id: string, data: { title?: string; engine?: string; model?: string; effortLevel?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  archiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/archive`, {}),
  unarchiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/unarchive`, {}),
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
  getSkills: () => get<{ name: string; description?: string }[]>("/api/skills"),
  getSkill: (name: string) =>
    get<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}`),
  updateSkill: (name: string, content: string) =>
    put<{ status: string }>(`/api/skills/${encodeURIComponent(name)}`, { content }),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; companyName: string | null; companyPrefix: string | null; todoPrefix: string | null; todoPrefixFrozen: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { companyName?: string; companyPrefix?: string | null; portalName?: string; operatorName?: string; language?: string; engine?: string; model?: string; effortLevel?: string }) =>
    post<{ status: string; portal: { companyName?: string; companyPrefix?: string; portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
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

  // ── Work items (Todos) ──────────────────────────────────────────────────
  /** GRS-021c: compact Todo list, optionally filtered by status. The gateway
   *  caps `limit` at 20, so the board fetches one call per display status.
   *  `source`, `since`/`until`, `q`, and `offset` follow design-todos §7.1–2;
   *  older gateways ignore them (the view applies a defensive client pass). */
  listWorkItems: (params?: {
    status?: WorkItemStatusWire
    assignee?: string
    department?: string
    source?: WorkItemSourceWire
    needsAttentionFor?: string
    since?: string
    until?: string
    q?: string
    offset?: number
    limit?: number
  }, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    if (params?.status) q.set("status", params.status)
    if (params?.assignee) q.set("assignee", params.assignee)
    if (params?.department) q.set("department", params.department)
    if (params?.source) q.set("source", params.source)
    if (params?.needsAttentionFor) q.set("needsAttentionFor", params.needsAttentionFor)
    if (params?.since) q.set("since", params.since)
    if (params?.until) q.set("until", params.until)
    if (params?.q) q.set("q", params.q)
    if (params?.offset) q.set("offset", String(params.offset))
    q.set("limit", String(params?.limit ?? 20))
    return get<WorkItemListWire>(`/api/work-items?${q.toString()}`, signal ? { signal } : undefined)
  },
  /** GRS-021c: deterministic AND-composed Todo search (escaped-LIKE text over
   *  title + body). Same page params/payload as the list endpoint — the filter
   *  bar's search must carry the date window and page like any other query. */
  searchWorkItems: (params: {
    text: string
    status?: WorkItemStatusWire
    assignee?: string
    department?: string
    source?: WorkItemSourceWire
    since?: string
    until?: string
    offset?: number
    limit?: number
  }) => {
    const q = new URLSearchParams()
    q.set("text", params.text)
    if (params.status) q.set("status", params.status)
    if (params.assignee) q.set("assignee", params.assignee)
    if (params.department) q.set("department", params.department)
    if (params.source) q.set("source", params.source)
    if (params.since) q.set("since", params.since)
    if (params.until) q.set("until", params.until)
    if (params.offset) q.set("offset", String(params.offset))
    q.set("limit", String(params.limit ?? 20))
    return get<WorkItemListWire>(`/api/search/work-items?${q.toString()}`)
  },
  /** The operator's pen (design-todos §7.3–4): PATCH title/body/assignee/
   *  department/priority/rank. 404s on gateways that predate the endpoint —
   *  callers surface the failure quietly and keep the read view intact. */
  updateWorkItem: async (
    id: string,
    input: WorkItemEditRequest,
  ): Promise<WorkItemEditResultWire> => {
    if (!isPositiveTodoVersion(input.expectedVersion)) {
      throw new TypeError("Todo expectedVersion must be a positive safe integer")
    }
    try {
      const result = await patch<unknown>(`/api/work-items/${encodeURIComponent(id)}`, {
        ...input.patch,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      })
      return requireWorkItemEditResult(result)
    } catch (error) {
      if (error instanceof ApiError) {
        throw new TodoApiError(error.status, error.message, error.code, error.currentVersion)
      }
      throw error
    }
  },
  /** Guarded status transition (legal edges only — the gateway owns legality). */
  setWorkItemStatus: (id: string, status: WorkItemStatusWire, note?: string) =>
    put<{ workItem: WorkItemFullWire; escalated: boolean }>(
      `/api/work-items/${encodeURIComponent(id)}/status`,
      note ? { status, note } : { status },
    ),
  /** GRS-021c: create a Todo (the "+ New Todo" affordance). The operator caller
   *  mints a `human`-source item; approvals structurally cannot be attached here. */
  createWorkItem: (input: { title: string; body?: string }) =>
    post<{ workItem: WorkItemFullWire }>("/api/work-items", input),
  /** GRS-021a: full Todo detail (property stack + live spend + audit). */
  getWorkItem: (id: string, signal?: AbortSignal) =>
    get<WorkItemDetailWire>(`/api/work-items/${encodeURIComponent(id)}`, signal ? { signal } : undefined),
  /** GRS-021b: the operator's approval DECISION. Human-only server-side; a
   *  tool-marked caller is refused 403. Send-back is `reject` (+ optional note). */
  decideWorkItemApproval: (id: string, decision: "approve" | "reject", note?: string) =>
    post<ApprovalDecisionResultWire>(
      `/api/work-items/${encodeURIComponent(id)}/approval`,
      note !== undefined && note !== "" ? { decision, note } : { decision },
    ),
  escalateWorkItemApproval: (id: string) =>
    post<ApprovalEscalationResultWire>(`/api/work-items/${encodeURIComponent(id)}/approval/escalate`, {}),
  /** GRS-002: execution attempts linked to a Todo (the sheet's session link). */
  listWorkItemSessions: (id: string) =>
    get<LinkedSessionWire[]>(`/api/work-items/${encodeURIComponent(id)}/sessions`),
  uploadFile: async (file: File, sessionId?: string): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    // When known, scope the upload to the session so it lands in the date-bucketed uploads dir.
    if (sessionId) form.append('sessionId', sessionId)
    const res = await authFetch("/api/files", { method: 'POST', body: form })
    if (!res.ok) throw await responseError(res)
    return res.json()
  },
};
