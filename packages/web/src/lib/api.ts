import { authFetch } from "@/lib/auth"
import type {
  CreateNoteInput,
  NoteDocumentResponse,
  NotesListResponse,
  UpdateNoteInput,
} from "@/routes/notes/types"
import type { ExperimentResponse, ExperimentsResponse } from "@/routes/experiments/types"
import type { StaleChatPolicy } from "@/lib/stale-chat"

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
  system?: boolean;
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
  /** Operator-actionable guidance from the server, when the failure is one the
   *  operator can fix locally (e.g. a missing OS privilege). Shown verbatim. */
  readonly remedy?: string

  constructor(status: number, message: string, code?: string, currentVersion?: number, remedy?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.currentVersion = currentVersion
    this.remedy = remedy
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
  let remedy: string | undefined
  try {
    const body = await res.json();
    if (body.error) message = String(body.error)
    else if (body.message) message = String(body.message)
    if (typeof body.code === "string" && body.code.trim()) code = body.code
    if (typeof body.currentVersion === "number" && Number.isSafeInteger(body.currentVersion) && body.currentVersion >= 0) {
      currentVersion = body.currentVersion
    }
    if (typeof body.remedy === "string" && body.remedy.trim()) remedy = body.remedy.trim()
  } catch {
    // Response wasn't JSON; status remains the typed UI-safe discriminator.
  }
  return new ApiError(res.status, message, code, currentVersion, remedy)
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

/** Workflow writes keep the server's structured validation issues intact. */
async function workflowWrite<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();
  let payload: Record<string, unknown> = {};
  try { payload = await res.json() } catch { /* non-JSON error body */ }
  const message = typeof payload.message === "string" ? payload.message : `API error: ${res.status}`;
  const code = typeof payload.code === "string" ? payload.code : undefined;
  if (Array.isArray(payload.issues)) {
    throw new WorkflowValidationApiError(res.status, message, code, payload.issues as WorkflowIssueV2Wire[]);
  }
  throw new ApiError(res.status, message, code);
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
 * (agent API calls or tracked Bash monitors). Present on session rows (list +
 * detail) and pushed live via the `session:background` WS event.
 * null/absent = no background work.
 */
export interface BackgroundActivity {
  activeStreams: number
  activeAgents?: number
  activeMonitors?: number
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

export interface ChatPin {
  key: string
  kind: 'session' | 'employee'
  pinnedAt: string
}

export interface PinsResponse {
  pins: ChatPin[]
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
  supportsPty?: boolean; // interactive PTY/CLI view (`/ws/pty`)
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

/** One server validation verdict — the client renders these, never re-derives them. */
export interface WorkflowIssueV2Wire {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
  path?: string
}

/** A 422 from the workflow API carrying structured validation issues. */
export class WorkflowValidationApiError extends ApiError {
  readonly issues: WorkflowIssueV2Wire[]

  constructor(status: number, message: string, code: string | undefined, issues: WorkflowIssueV2Wire[]) {
    super(status, message, code)
    this.name = "WorkflowValidationApiError"
    this.issues = issues
  }
}

/* ── Workflow runs (v2) ───────────────────────────────────────────────────── */

export type WorkflowRunStatusV2 = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled"
export type WorkflowNodeRunStatusV2 =
  | "pending" | "ready" | "dispatching" | "running" | "waiting"
  | "completed" | "failed" | "skipped" | "cancelled"
export type WorkflowAttemptStatusV2 = "dispatching" | "running" | "completed" | "failed" | "timed-out" | "cancelled"
export type WorkflowTriggerKindV2 = "manual" | "schedule" | "event" | "todo-status" | "workflow-call"

export interface WorkflowRunErrorV2Wire {
  code: string
  message: string
  retryable: boolean
  nodeId?: string
  attempt?: number
}

export interface WorkflowNodeOutputV2Wire {
  text: string
  fields: Record<string, unknown>
  employeeId?: string
  engine?: string
  model?: string
  sessionId?: string
}

export interface WorkflowRunSummaryV2Wire {
  id: string
  workflowId: string
  workflowTitle: string
  definitionRevision: number
  status: WorkflowRunStatusV2
  trigger: { nodeId: string; kind: WorkflowTriggerKindV2 }
  startedAt: string
  endedAt: string | null
  currentOrFailingNode: {
    nodeId: string
    label: string
    employeeId: string | null
    state: "current" | "failing"
  } | null
}

export interface WorkflowNodeRunV2Wire {
  runId: string
  nodeId: string
  nodeType: WorkflowDefinitionV2Wire["nodes"][number]["type"]
  status: WorkflowNodeRunStatusV2
  activated: boolean
  /** What the node was handed: the single activated upstream output, or the run
   *  input when the node fans in from several. The attempts do not repeat it. */
  input?: unknown
  output?: WorkflowNodeOutputV2Wire
  error?: WorkflowRunErrorV2Wire
  resumeAt?: string
  startedAt?: string
  endedAt?: string
}

export interface WorkflowAttemptV2Wire {
  runId: string
  nodeId: string
  attempt: number
  sessionId?: string
  status: WorkflowAttemptStatusV2
  resolvedConfig?: {
    employeeId: string
    engine: string
    model?: string
    effort?: "low" | "medium" | "high" | "xhigh"
  }
  /** The final composed prompt handed to the session (interpolated + contract
   *  block). Only `?view=full` carries it. */
  promptText?: string
  output?: WorkflowNodeOutputV2Wire
  error?: WorkflowRunErrorV2Wire
  startedAt: string
  endedAt?: string
  remindersSent: number
  nextReminderAt?: string
  extensions: number
  lastExtensionReason?: string
  pendingOutputError?: string
}

export interface WorkflowApprovalV2Wire {
  runId: string
  nodeId: string
  status: "pending" | "approved" | "rejected"
  requestedAt: string
  approverRef?: string
  decidedAt?: string
  decidedBy?: string
  decision?: "approve" | "reject"
  reason?: string
}

export interface WorkflowRunDetailV2Wire {
  id: string
  workflowId: string
  workflowTitle: string
  definitionRevision: number
  /** Definition snapshot at start time — the server sends the full stored
   *  definition, including saved canvas positions when the workflow had them. */
  definition: Pick<WorkflowDefinitionV2Wire, "nodes" | "edges"> & { ui?: WorkflowDefinitionV2Wire["ui"] }
  status: WorkflowRunStatusV2
  revision: number
  spendUsd: number
  trigger: { nodeId: string; kind: WorkflowTriggerKindV2 }
  startedAt: string
  endedAt?: string
  error?: WorkflowRunErrorV2Wire
  nodeRuns: WorkflowNodeRunV2Wire[]
  attempts: WorkflowAttemptV2Wire[]
  approvals: WorkflowApprovalV2Wire[]
}

/** What the run route returns without `?view=full`: everything needed to judge
 *  run state, minus the definition snapshot and the attempt prompts. Both of
 *  those are immutable once written, so the run page polls this and carries the
 *  fat halves forward from the one snapshot it fetched. */
export type WorkflowRunLeanV2Wire = Omit<WorkflowRunDetailV2Wire, "definition">

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
/** One label (Todos v2 slice 3). `department` null = company-wide. */
export interface WorkItemLabelWire {
  id: string
  name: string
  color: string | null
  department: string | null
  createdAt: string
}

export type WorkItemRelationKindWire = "blocks" | "relates" | "duplicates"

/** One relation as seen from a Todo: the other endpoint resolved to a compact
 *  ref. `relates` is symmetric and always reads as direction "out". */
export interface WorkItemRelationWire {
  kind: WorkItemRelationKindWire
  direction: "out" | "in"
  other: { id: string; title: string; status: WorkItemStatusWire }
  createdBy: string
  createdAt: string
}

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
  /** Offered variants when the pending gate asks for a PICK (older gateways omit). */
  approvalOptions?: string[] | null
  approvalChoice?: string | null
  /** The gate is reserved for the operator: no employee may decide it, not the
   *  COO and not through escalation (older gateways omit). */
  approvalOperatorOnly?: boolean
  approvalTarget: string | null
  approvalEscalatedAt: string | null
  sessionRef?: WorkItemSessionRefWire | null
  /** Todos v2 (optional: older gateways omit them). */
  createdBy?: string
  parentId?: string | null
  rootId?: string
  depth?: number
  dueAt?: string | null
  /** Todos v2 slice 3 board wire data (optional: older gateways omit them). */
  labels?: WorkItemLabelWire[]
  /** True while an incoming `blocks` relation originates from an open Todo. */
  blocked?: boolean
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
  /** Todos v2 slice 4 (optional: older gateways reject unknown fields). */
  acceptance?: string | null
  dueAt?: string | null
  /** Todos v2 slice 6 — the rail's verify picker (operator-only; null clears
   *  to the provenance default). Older gateways reject the field. */
  verifyPolicy?: VerifyPolicyWire | null
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

export type WorkItemCommentAuthorKindWire = "operator" | "employee" | "system"

/** One comment row (Todos v2 slice 2). A tombstoned comment keeps its row with
 *  an empty body and a `deletedAt` stamp so the thread shape survives. */
export interface WorkItemCommentWire {
  id: string
  workItemId: string
  parentCommentId: string | null
  authorKind: WorkItemCommentAuthorKindWire
  author: string
  body: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
}

/** A chronological comment page; `total` is the exact per-item count. */
export interface WorkItemCommentPageWire {
  comments: WorkItemCommentWire[]
  total: number
  limit?: number
  offset?: number
}

/** One approval history row (Todos v2 slice 4). The legacy approval* fields on
 *  the work item mirror the CURRENT row (pending, else latest decided). */
export interface WorkItemApprovalWire {
  id: string
  workItemId: string
  state: ApprovalStateWire
  request: string
  ref: string | null
  /** Offered variants when this gate asks for a PICK, not a plain yes/no. */
  options: string[] | null
  /** The picked option, once approved. */
  choice: string | null
  target: string | null
  targetKind: string | null
  requestedBy: string
  requestedAt: string
  escalatedAt: string | null
  decidedBy: string | null
  decidedAt: string | null
  note: string | null
}

/** One node of GET /api/work-items/:id/tree — a full row plus nested children
 *  (rank-then-id ordered, depth-capped server-side). */
export interface WorkItemTreeNodeWire extends WorkItemFullWire {
  children: WorkItemTreeNodeWire[]
}

/** The tree payload: subtree + per-status totals + derived subtree spend. */
export interface WorkItemTreeWire {
  root: WorkItemTreeNodeWire
  totals: Partial<Record<WorkItemStatusWire, number>>
  spendUsd: number
}

/** One attachment row (Todos v2 slice 5) — content-addressed; `commentId`
 *  null = attached to the Todo, set = attached to that comment. */
export interface WorkItemAttachmentWire {
  id: string
  workItemId: string
  commentId: string | null
  filename: string
  mime: string
  bytes: number
  sha256: string
  storagePath: string
  uploadedBy: string
  createdAt: string
}

/** One department row from GET /api/departments (Todos v2 slice 5). */
export interface DepartmentSummaryWire {
  slug: string
  prefix: string
  createdAt: string
  todoCount: number
}

/** The GET /api/work-items/:id payload: full row + live-derived spend + audit. */
export interface WorkItemDetailWire {
  workItem: WorkItemFullWire
  spendUsd: number
  events: WorkItemEventWire[]
  /** Last-10 comments tail + total (optional: older gateways omit it). */
  comments?: WorkItemCommentPageWire
  /** Both-direction relations (optional: older gateways omit it). */
  relations?: WorkItemRelationWire[]
  /** The Todo's labels, ordered by name (optional: older gateways omit it). */
  labels?: WorkItemLabelWire[]
  /** Approval history, oldest first (optional: older gateways omit it). */
  approvals?: WorkItemApprovalWire[]
}

/** Lightweight batch enrichment used by board/attention rows. */
export type WorkItemOpenDetailWire = Pick<WorkItemDetailWire, "workItem" | "events">

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
  employee?: string | null
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
  listExperiments: (status?: "running" | "concluded") =>
    get<ExperimentsResponse>(`/api/experiments${status ? `?status=${status}` : ""}`),
  getExperiment: (id: string) =>
    get<ExperimentResponse>(`/api/experiments/${encodeURIComponent(id)}`),
  getFeatures: () => get<{ notesEnabled: boolean; staleChat: StaleChatPolicy }>("/api/features"),
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  listWorkflowDefinitionsV2: () =>
    get<{ items: WorkflowDefinitionSummaryV2Wire[]; nextCursor: string | null }>("/api/workflows"),
  getWorkflowDefinitionV2: (id: string) =>
    get<WorkflowDefinitionV2Wire>(`/api/workflows/${encodeURIComponent(id)}`),
  listWorkflowRunsV2: (id: string, limit = 50) =>
    get<{ items: WorkflowRunSummaryV2Wire[]; nextCursor: string | null }>(
      `/api/workflows/${encodeURIComponent(id)}/runs?limit=${limit}`,
    ),
  /** The polled shape: no definition snapshot, no attempt prompts. */
  getWorkflowRunV2: (id: string, runId: string) =>
    get<WorkflowRunLeanV2Wire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    ),
  /** The snapshot the run canvas needs to draw the graph at the revision the run
   *  started on, plus the prompts the inspector shows. Fetched once per run, and
   *  again only when a node is opened whose prompt the snapshot predates. */
  getWorkflowRunFullV2: (id: string, runId: string) =>
    get<WorkflowRunDetailV2Wire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}?view=full`,
    ),
  createWorkflowV2: (input: { id: string; title: string; description?: string }) =>
    workflowWrite<WorkflowDefinitionV2Wire>("/api/workflows", "POST", input),
  saveWorkflowDefinitionV2: (id: string, definition: WorkflowDefinitionV2Wire, expectedRevision: number) =>
    workflowWrite<WorkflowDefinitionV2Wire>(
      `/api/workflows/${encodeURIComponent(id)}`, "PUT", { definition, expectedRevision },
    ),
  setWorkflowEnabledV2: (id: string, enabled: boolean, expectedRevision: number) =>
    workflowWrite<WorkflowDefinitionV2Wire>(
      `/api/workflows/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, "POST", { expectedRevision },
    ),
  startWorkflowRunV2: (id: string) =>
    post<WorkflowRunDetailV2Wire>(`/api/workflows/${encodeURIComponent(id)}/runs`, { input: {} }),
  decideWorkflowApprovalV2: (
    id: string,
    runId: string,
    nodeId: string,
    body: { decision: "approve" | "reject"; expectedRevision: number; reason?: string },
  ) =>
    post<WorkflowRunDetailV2Wire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
      body,
    ),
  /** Resolved model + capability registry (engines, their models, effort levels). */
  getEngines: () => get<EnginesResponse>("/api/engines"),
  /** Force re-discovery of dynamic (pi) models, returning the rebuilt registry. */
  refreshEngines: () => post<EnginesResponse>("/api/engines/refresh"),
  getEngineLimits: (engine?: string, init?: RequestInit) =>
    get<EngineLimitsResponse>(`/api/engine-limits${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, init),
  refreshEngineLimits: (engine?: string) =>
    post<EngineLimitsResponse>(`/api/engine-limits/refresh${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, {}),
  getSessions: () => get<SessionsResponse>("/api/sessions"),
  getPinnedSessions: async () => {
    const payload = await get<unknown>("/api/sessions?pinned=1")
    if (Array.isArray(payload)) return payload as Record<string, unknown>[]
    if (payload && typeof payload === "object" && Array.isArray((payload as SessionsResponse).sessions)) {
      return (payload as SessionsResponse).sessions
    }
    return []
  },
  getPins: () => get<PinsResponse>("/api/pins"),
  pinChat: (key: string) => post<{ status: string }>("/api/pins", { key }),
  unpinChat: (key: string) => del<{ status: string }>(`/api/pins/${encodeURIComponent(key)}`),
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
    /** Todos v2 slice 6 board scopes (server-side since slice 1/3). */
    createdBy?: string
    rootsOnly?: boolean
    label?: string
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
    if (params?.createdBy) q.set("createdBy", params.createdBy)
    if (params?.rootsOnly) q.set("rootsOnly", "true")
    if (params?.label) q.set("label", params.label)
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
  createWorkItem: (input: {
    title: string
    body?: string
    /** Todos v2 slice 6: quick-adds carry the board scope / parent. */
    parentId?: string
    department?: string
    assignee?: string
    priority?: number
    dueAt?: string
    acceptance?: string
    labels?: string[]
  }) =>
    post<{ workItem: WorkItemFullWire }>("/api/work-items", input),
  /** Todos v2 slice 6: roster-validated assignment (backlog → assigned). */
  assignWorkItem: (id: string, assignee: string) =>
    post<{ workItem: WorkItemFullWire }>(`/api/work-items/${encodeURIComponent(id)}/assign`, { assignee }),
  /** Todos v2 slice 6: the board's lazy tree expansion (roll-ups + spend). */
  getWorkItemTree: (id: string, signal?: AbortSignal) =>
    get<{ tree: WorkItemTreeWire }>(`/api/work-items/${encodeURIComponent(id)}/tree`, signal ? { signal } : undefined),
  /** ICI-648: all visible board trees in one request. */
  getWorkItemTrees: (ids: string[], signal?: AbortSignal) => {
    const q = new URLSearchParams({ ids: ids.join(",") })
    return get<{ trees: Record<string, WorkItemTreeWire> }>(
      `/api/work-items/trees?${q.toString()}`,
      signal ? { signal } : undefined,
    )
  },
  /** Todos v2 slice 6: the switcher's department boards. */
  getDepartments: () => get<{ departments: DepartmentSummaryWire[] }>("/api/departments"),
  /** GRS-021a: full Todo detail (property stack + live spend + audit). */
  getWorkItem: (id: string, signal?: AbortSignal) =>
    get<WorkItemDetailWire>(`/api/work-items/${encodeURIComponent(id)}`, signal ? { signal } : undefined),
  /** ICI-648: lightweight open-detail enrichment through the existing list route. */
  getWorkItems: (ids: string[], signal?: AbortSignal) => {
    const q = new URLSearchParams({ ids: ids.join(",") })
    return get<{ workItems: WorkItemOpenDetailWire[] }>(
      `/api/work-items?${q.toString()}`,
      signal ? { signal } : undefined,
    )
  },
  /** GRS-021b: the operator's approval DECISION. Human-only server-side; a
   *  tool-marked caller is refused 403. Send-back is `reject` (+ optional note). */
  decideWorkItemApproval: (id: string, decision: "approve" | "reject", note?: string, choice?: string) =>
    post<ApprovalDecisionResultWire>(`/api/work-items/${encodeURIComponent(id)}/approval`, {
      decision,
      ...(note !== undefined && note !== "" ? { note } : {}),
      ...(choice !== undefined ? { choice } : {}),
    }),
  escalateWorkItemApproval: (id: string) =>
    post<ApprovalEscalationResultWire>(`/api/work-items/${encodeURIComponent(id)}/approval/escalate`, {}),
  /** GRS-002: execution attempts linked to a Todo (the sheet's session link). */
  listWorkItemSessions: (id: string) =>
    get<LinkedSessionWire[]>(`/api/work-items/${encodeURIComponent(id)}/sessions`),
  dispatchTodo: (id: string) =>
    post<{ workItemId: string; sessionId: string; status: string; reused: boolean }>(
      `/api/work-items/${encodeURIComponent(id)}/dispatch`,
      {},
    ),
  /** Todos v2 slice 2: the comment thread, chronological with limit/offset. */
  listWorkItemComments: (id: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset))
    const query = params.toString()
    return get<WorkItemCommentPageWire>(`/api/work-items/${encodeURIComponent(id)}/comments${query ? `?${query}` : ""}`)
  },
  /** Add a comment (or a single-level reply via parentCommentId). Author
   *  identity is stamped server-side from the operator surface. */
  addWorkItemComment: (id: string, body: string, parentCommentId?: string) =>
    post<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments`,
      parentCommentId ? { body, parentCommentId } : { body },
    ),
  editWorkItemComment: (id: string, commentId: string, body: string) =>
    patch<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      { body },
    ),
  /** Tombstone: the row survives with an empty body; the UI renders [deleted]. */
  deleteWorkItemComment: (id: string, commentId: string) =>
    del<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
    ),
  /** Todos v2 slice 3: the shared label registry (existing labels only). */
  listLabels: () => get<{ labels: WorkItemLabelWire[] }>("/api/labels"),
  /** Todos v2 slice 5: attachment rows (item-level and per-comment). */
  listWorkItemAttachments: (id: string) =>
    get<{ attachments: WorkItemAttachmentWire[] }>(`/api/work-items/${encodeURIComponent(id)}/attachments`),
  /** Multipart upload; `commentId` attaches to that comment instead of the item. */
  uploadWorkItemAttachment: async (id: string, file: File, commentId?: string): Promise<WorkItemAttachmentWire> => {
    const form = new FormData()
    form.append("file", file)
    if (commentId) form.append("commentId", commentId)
    const res = await authFetch(`/api/work-items/${encodeURIComponent(id)}/attachments`, { method: "POST", body: form })
    if (!res.ok) throw await responseError(res)
    return (await res.json()).attachment as WorkItemAttachmentWire
  },
  deleteWorkItemAttachment: (id: string, attachmentId: string) =>
    del<{ removed: boolean }>(`/api/work-items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
  /** Integrity-checked download path (cookie-authenticated, usable as img src). */
  workItemAttachmentUrl: (id: string, attachmentId: string): string =>
    `/api/work-items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
  /** Todos v2 slice 3: relations (blocks is cycle-checked server-side). */
  addWorkItemRelation: (id: string, kind: WorkItemRelationKindWire, dstId: string) =>
    post<{ relation: unknown }>(`/api/work-items/${encodeURIComponent(id)}/relations`, { kind, dstId }),
  removeWorkItemRelation: async (id: string, kind: WorkItemRelationKindWire, dstId: string): Promise<{ removed: boolean }> => {
    const res = await authFetch(`/api/work-items/${encodeURIComponent(id)}/relations`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, dstId }),
    })
    if (!res.ok) throw await responseError(res)
    return res.json()
  },
  /** Replace a Todo's label set (ids or names; nothing created implicitly). */
  setWorkItemLabels: (id: string, labels: string[]) =>
    put<{ labels: WorkItemLabelWire[] }>(`/api/work-items/${encodeURIComponent(id)}/labels`, { labels }),
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
