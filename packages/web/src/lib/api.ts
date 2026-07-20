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

export interface LegacyWorkflowRunLocation {
  workflowId: string
  runId: string
  openPath: string
}

export class LegacyWorkflowSessionError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly legacyWorkflowRun: LegacyWorkflowRunLocation,
  ) {
    super(status, message)
    this.name = "LegacyWorkflowSessionError"
  }
}

/** A Todo revision is authoritative only when it is a positive safe integer. */
export function isPositiveTodoVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export class WorkflowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly runId?: string,
  ) {
    super(message)
    this.name = "WorkflowApiError"
  }
}

async function responseError(res: Response): Promise<ApiError> {
  let message = `API error: ${res.status}`
  let code: string | undefined
  let currentVersion: number | undefined
  let legacyWorkflowRun: LegacyWorkflowRunLocation | undefined
  try {
    const body = await res.json();
    if (body.error) message = String(body.error)
    else if (body.message) message = String(body.message)
    if (typeof body.code === "string" && body.code.trim()) code = body.code
    if (typeof body.currentVersion === "number" && Number.isSafeInteger(body.currentVersion) && body.currentVersion >= 0) {
      currentVersion = body.currentVersion
    }
    const legacy = body.legacyWorkflowRun
    if (
      legacy
      && typeof legacy === "object"
      && typeof legacy.workflowId === "string"
      && typeof legacy.runId === "string"
      && typeof legacy.openPath === "string"
    ) {
      legacyWorkflowRun = {
        workflowId: legacy.workflowId,
        runId: legacy.runId,
        openPath: legacy.openPath,
      }
    }
  } catch {
    // Response wasn't JSON; status remains the typed UI-safe discriminator.
  }
  if (res.status === 410 && legacyWorkflowRun) {
    return new LegacyWorkflowSessionError(res.status, message, legacyWorkflowRun)
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

/* ── Workflow visualization (GRS-009) ───────────────────────────────────────── */

export interface WorkflowGateResult {
  id?: string
  kind: 'artifact' | 'flag' | 'approval'
  description: string
  passed: boolean
  evidence?: string
}
export interface WorkflowStepView {
  id: string
  title: string
  role: string
  who: string
  optional: boolean
  cadence?: string
  gates: WorkflowGateResult[]
  passed: boolean
  isCurrent: boolean
}
export interface WorkflowRunView {
  wave: number
  item: string | null
  fireIso: string | null
  status: 'pending' | 'active' | 'passed' | 'blocked' | 'needs_fix'
  lastWaveState: string | null
  startedAt: string | null
  endedAt: string | null
  steps: WorkflowStepView[]
  runGates: WorkflowGateResult[]
  flagSource: 'live' | 'receipt'
}
export interface WorkflowDefinitionWire {
  id: string
  title: string
  description?: string
  version: number
  status: string
  orchestrator?: string
  trigger: { kind: string; cron?: string; timezone?: string; until?: string; cronJobId?: string }
  loop?: { until?: string; maxRoundsPerRun?: number; stopWhen?: string }
}
export interface DerivedWorkflow {
  definition: WorkflowDefinitionWire
  runs: WorkflowRunView[]
  latest: WorkflowRunView | null
  triggerSummary: string
  evidenceRoot: string
  generatedFrom: { receiptsFound: number; stateJsonPresent: boolean }
}

/* ── Editable workflow definitions (GRS-011a/b schema; GRS-011c Edit view) ─────
 * The DURABLE, EDITABLE definition — a node/edge graph the canvas Edit view
 * mutates. Kept SEPARATE from the read-only DerivedWorkflow run state above, so
 * editing a definition never touches historical run receipts. Mirrors
 * packages/jinn/src/workflows/definition.ts (EditableWorkflowDefinition). */
export interface WorkflowNodePosition { x: number; y: number }
export interface WorkflowActorWire { kind: 'employee' | 'engine'; ref: string }
export interface WorkflowGateWire {
  id?: string
  kind: string
  description?: string
  [k: string]: unknown
}
/** Engine-node execution options (GRS-016b) — mirrors StepNodeOptions in
 * packages/jinn/src/workflows/definition.ts. Step-only; requires an actor. */
export interface StepNodeOptionsWire {
  model?: string
  effort?: string
  /** `none` (GRS-016d) = fire-and-forget: the receipt settles `fired` at spawn,
   * the session is never awaited, and the run never blocks on it. */
  output?: 'handoff' | 'full' | 'none'
  retry?: { maxAttempts: number; on: string[] }
  /** `error-edge` (GRS-016d) routes a terminal failure down the node's
   * lane:'error' out-edge(s) instead of failing the run. */
  onError?: 'fail-run' | 'continue' | 'error-edge'
  timeoutMinutes?: number
  /** Session mode (GRS-016e): where the node's turn runs. Absent = 'fresh' (a new
   * session per invocation). 'workflow' = the run's ONE shared session (follow-up
   * turns, serialized). 'existing' = a follow-up turn into the operator-picked
   * LIVE gateway session named by sessionId — the inspector labels the risk. */
  session?: { mode: 'fresh' | 'workflow' | 'existing'; sessionId?: string }
}
/** One routing condition (GRS-016c) — mirrors WorkflowCondition in
 * packages/jinn/src/workflows/condition.ts. Dot-path over the closed grammar
 * (steps.<id>.status | steps.<id>.outcome.summary|notes|finalMessage|artifacts |
 * steps.<id>.outcome.fields.<key> | run.rounds | run.status | trigger.kind/source/event |
 * trigger.payload.<key>). */
export interface WorkflowConditionWire {
  path: string
  op: string
  value?: string | number | boolean
}
export interface WorkflowNodeWire {
  id: string
  type: 'trigger' | 'step' | 'gate' | 'switch' | 'fail' | 'wait'
  label: string
  position: WorkflowNodePosition
  actor?: WorkflowActorWire
  role?: string
  trigger?: Record<string, unknown>
  gate?: WorkflowGateWire
  gates?: WorkflowGateWire[]
  optional?: boolean
  cadence?: string
  /** Step task text (GRS-014c) — becomes the spawned step prompt's task section. Step-only. */
  instructions?: string
  /** Engine-node execution options (GRS-016b). Step-only; requires an actor. */
  options?: StepNodeOptionsWire
  /** Switch evaluation mode (GRS-016c). Switch-only; absent = firstMatch. */
  switchMode?: 'firstMatch' | 'allMatches'
  /** Authored stop-and-error message (GRS-016c). Required on fail nodes. */
  failMessage?: string
  /** Wait node duration in minutes (GRS-016d, 1..10080). Wait-only; exactly one
   * of waitMinutes/waitUntil is required on a wait node. */
  waitMinutes?: number
  /** Wait node absolute ISO-8601 deadline (GRS-016d). Wait-only. */
  waitUntil?: string
}
export interface WorkflowEdgeWire {
  id: string
  from: string
  to: string
  kind?: 'handoff' | 'sequence' | 'loop'
  label?: string
  /** Routing conditions (GRS-016c) — switch out-edges only; AND within the array;
   * absent = the default/fallback branch of its switch. */
  when?: WorkflowConditionWire[]
  /** Error-output lane (GRS-016d): 'error' marks this edge as the failure route
   * of its onError:'error-edge' source step. */
  lane?: 'error'
}
export interface WorkflowLayoutWire {
  source: 'generated' | 'normalized' | 'manual'
  version: 1
}
export interface WorkflowLayoutDiagnosticsWire {
  source: WorkflowLayoutWire['source']
  version: 1
  normalized: boolean
  reasons: unknown[]
  quality: { valid: boolean; score: number }
  envelopes: unknown[]
  loopRoutes: Record<string, { side: 'below'; lane: number }>
}
export interface EditableWorkflowDefinitionWire {
  schemaVersion: number
  id: string
  title: string
  description?: string
  version: number
  status: 'active' | 'paused' | 'retired'
  orchestrator?: string
  nodes: WorkflowNodeWire[]
  edges: WorkflowEdgeWire[]
  layout?: WorkflowLayoutWire
  runGates?: WorkflowGateWire[]
  loop?: { until?: string; maxRoundsPerRun?: number; stopWhen?: string }
  evidenceRoot?: string
  updatedAt?: string
}
export interface WorkflowDefinitionSummaryWire {
  id: string
  title: string
  status: 'active' | 'paused' | 'retired'
  version: number
  updatedAt?: string
  nodeCount: number
  edgeCount: number
}
/* ── Workflow RUNS (GRS-011d-2c/-ui) ───────────────────────────────────────────
 * A durable record of an actual EXECUTION of an editable definition — the "run"
 * half of the edit→run→evidence loop. SEPARATE from the derived DerivedWorkflow
 * projection above (that is the workflow dogfood's hand-written receipts) and from
 * the editable definition (that is the graph you save). Mirrors
 * packages/jinn/src/workflows/run-store.ts. Served by
 * GET /api/workflow-definitions/:id/runs[/:runId]. */
/** v1 walk statuses (spawned|inline|checkpoint|error) plus the GRS-014b step-machine
 * states (pending|dispatching|running|done|failed|skipped) — reserved in the wire
 * vocabulary now (GRS-014a); the gateway emits them from GRS-014b. */
export type RunStepStatusWire =
  | 'spawned' | 'inline' | 'checkpoint' | 'error'
  | 'pending' | 'dispatching' | 'running' | 'done' | 'failed' | 'skipped'
  | 'routed'
  /** GRS-016d: `fired` = fire-and-forget step settled at spawn (never awaited);
   * `waiting` = a wait node pausing until its persisted readyAt. */
  | 'fired' | 'waiting'
export interface RunStepReceiptWire {
  nodeId: string
  label: string
  /** null for an orchestrator-inline step or a checkpoint node (no spawned actor). */
  actor: { kind: 'employee' | 'engine'; ref: string } | null
  status: RunStepStatusWire
  /** Dispatch counter (GRS-014b): 1 or 2 — respawn-once caps it at 2. */
  attempt?: number
  /** Set once a session exists for this step — the real session on the gateway. */
  sessionId?: string
  detail?: string
  /** When the current attempt's dispatch was minted (before the spawn). */
  dispatchedAt?: string
  /** When the step's session settled or the step otherwise terminally resolved. */
  settledAt?: string
  /** Loop iteration (GRS-014e); absent = round 1. Rounds ≥ 2 repeat the loop
   * segment's nodes with fresh receipts, appended in execution order. */
  round?: number
  /** The step's durable outcome (GRS-014c): declared ```handoff block or capped
   * final-message fallback — the exact material injected into successors' prompts. */
  outcome?: {
    sessionId: string
    summary?: string
    artifacts?: string[]
    notes?: string
    /** Machine-readable scalars the step declared (GRS-016c) — what switch
     * conditions route on (steps.<id>.outcome.fields.<key>). */
    fields?: Record<string, string | number | boolean>
    finalMessage: string
    extractedFrom: 'handoff-block' | 'final-message'
  }
  /** A switch receipt's frozen routing decision (GRS-016c): activated edge ids. */
  route?: string[]
  /** A wait receipt's durable deadline (GRS-016d): the sweep settles the receipt
   * `checkpoint` on the first pass at/after this time. */
  readyAt?: string
  at: string
}
export interface ParkedGateWire {
  scope: 'gateNode' | 'runGate'
  nodeId: string | null
  kind: 'approval'
  evaluator: 'human-approval'
  ref?: string
  description: string
  /** When the run parked (GRS-014b). Parked runs keep endedAt null — not terminal. */
  at?: string
}
/** Honest v2 run statuses (GRS-014a). `passed` is retired — the gateway serves legacy
 * v1 `passed` records as `dispatched` ("walk finished, sessions dispatched, completion
 * unknown") via a read-time mapping; files are never rewritten. `completed` means the
 * work actually finished; `cancelled` is reserved for the run-lifecycle slice. */
export type WorkflowRunStatusWire =
  | 'running' | 'parked' | 'dispatched' | 'completed' | 'failed' | 'cancelled'
/** What started a run (GRS-014d). The gateway wraps legacy bare-string triggers at
 * read time, so the wire always carries the object. Schedule fires from a managed
 * cron job carry cronJobId + fireIso (the per-fire dedupe identity). */
export type WorkflowRunTriggerWire =
  | {
    source: string
    event: string
    payload: Record<string, unknown>
    fireRef?: string
  }
  | {
  kind: 'manual' | 'schedule'
  cronJobId?: string
  fireIso?: string
  }

export type WorkflowReportModeWire = 'resume' | 'silent'

export interface WorkflowRunParametersWire {
  input: Record<string, unknown>
  idempotencyKey?: string
}

export interface WorkflowRunInvocationWire {
  sessionId: string
  reportMode: WorkflowReportModeWire
}

export interface WorkflowRunCancellationWire {
  requestedAt: string
  requestedBy: string
  reason: string | null
}

export interface WorkflowRunWire {
  /** Absent/older on legacy evidence; 3 on current records. */
  schemaVersion?: number
  /** Current records are monotonic from 1; normalized legacy reads expose 0. */
  revision?: number
  runId: string
  workflowId: string
  definitionVersion: number
  title: string
  trigger: WorkflowRunTriggerWire
  parameters?: WorkflowRunParametersWire
  invocation?: WorkflowRunInvocationWire
  cancellation?: WorkflowRunCancellationWire
  status: WorkflowRunStatusWire
  startedAt: string
  endedAt: string | null
  steps: RunStepReceiptWire[]
  /** Present iff status==='parked': the human-approval gate holding the run. */
  parked: ParkedGateWire | null
  /** Caller-specific, read-only projection. It is never persisted in run evidence. */
  approvalCapability?: {
    canDecide: boolean
    target: string | null
    needsYou: boolean
    escalated: boolean
  } | null
  errors?: { code: string; message: string; ref?: string }[]
  /** Drain evidence while live run-owned phase sessions are being stopped. */
  stopping?: {
    to: 'failed' | 'cancelled'
    at: string
    errors: { code: string; message: string; ref?: string }[]
  }
  /** The frozen execution order of the run's nodes (GRS-014b sequential runs);
   * steps[] is materialized 1:1 in this order. */
  order?: string[]
  /** Loop round counter (GRS-014e): present on runs whose definition declares a loop
   * edge; run record shows rounds === maxRoundsPerRun when a gated loop exhausted. */
  rounds?: number
  /** Durable loop-exit marker (GRS-014e). */
  loopExit?: { round: number; at: string; reason: 'gate-passed' | 'max-rounds' }
  /** Run gates an operator approved via the resolve-gate API (GRS-014e). */
  resolvedRunGates?: string[]
  /** The definition content frozen at mint (GRS-014b-fix) — what this run executes,
   * immune to later edits of the definition store. Evidence; the Run view does not
   * currently render it. */
  definitionSnapshot?: EditableWorkflowDefinitionWire
  /** LEGACY (GRS-014a): stamped by the retired declaration-order walk when its edges
   * disagreed. New runs execute in edge order and never carry it; old records render. */
  orderWarning?: { code: 'order-warning'; message: string; impliedOrder?: string[] }
}
export interface WorkflowRunSummaryWire {
  runId: string
  workflowId: string
  status: WorkflowRunStatusWire
  trigger: WorkflowRunTriggerWire
  startedAt: string
  endedAt: string | null
  stepCount: number
  parked: boolean
}

/** A field-level validation error from the 400 `errors[]` contract (GRS-011b). */
export interface WorkflowValidationError { code: string; message: string; path?: string }
/** Discriminated result of a definition save so the caller can render inline
 * validation/conflict errors instead of only a flat message. */
export type SaveDefinitionResult =
  | { ok: true; definition: EditableWorkflowDefinitionWire }
  | { ok: false; status: number; message: string; errors?: WorkflowValidationError[] }

export interface WorkflowPlanWire {
  ok: boolean
  layout: {
    diagnostics: WorkflowLayoutDiagnosticsWire
    normalizedPreview: EditableWorkflowDefinitionWire
  }
}

// ---------------------------------------------------------------------------
// Work items (the Todos ledger) — GRS-021a/b/c shipped the store + routes; the
// Todos surface (GRS-021d) reads them. The gateway is the ONLY write path for
// lifecycle; approval decisions route through manager/COO authority by default,
// with operator/aCEO access only after explicit escalation.
// ---------------------------------------------------------------------------
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

export type WorkflowTriggerBindingKindWire = "webhook" | "poll"
export type WorkflowTriggerActivationWire = "active" | "pending_approval" | "disabled"
export interface WorkflowTriggerFilterWire {
  path: string
  op: "equals" | "notEquals" | "exists" | "matches"
  value?: unknown
}
export interface WorkflowApprovalRouteWire {
  requesterEmployee: string | null
  target: string | null
  targetKind: "employee" | "virtual" | "none"
  entitledEmployees: string[]
  operatorEntitled: boolean
  escalation: { target: "operator"; targetKind: "operator"; at: string } | null
  requestedAt: string
  requestedBy: string
  escalatedAt: string | null
}
export interface PollActivationApprovalWire extends WorkflowApprovalRouteWire {
  state: "pending" | "approved" | "rejected"
  activationContractHash: string
  decidedBy: string | null
  decidedAt: string | null
}
export interface WorkflowTriggerBindingWire {
  schemaVersion?: number
  kind: WorkflowTriggerBindingKindWire
  name: string
  event: string
  targetWorkflowId: string
  source?: "event-webhook" | "poll"
  filter?: WorkflowTriggerFilterWire[]
  activation?: WorkflowTriggerActivationWire
  createdAt?: string
  updatedAt?: string
  createdBy?: string
  secretTokenPreview?: string
  command?: string
  intervalSeconds?: number
  timeoutMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  approval?: PollActivationApprovalWire
  approvalCapability?: {
    canDecide: boolean
    canEscalate: boolean
    needsYou: boolean
    target: string | null
    escalated: boolean
  }
  lastCheckedAt?: string
  lastFiredAt?: string
  lastOutcome?: string
}
export type CreateWorkflowTriggerInputWire =
  | {
      kind: "webhook"
      name: string
      event: string
      targetWorkflowId: string
      secretToken?: string
      filter?: WorkflowTriggerFilterWire[]
    }
  | {
      kind: "poll"
      name: string
      event: string
      targetWorkflowId: string
      command: string
      intervalSeconds: number
      timeoutMs?: number
      stdoutMaxBytes?: number
      stderrMaxBytes?: number
      filter?: WorkflowTriggerFilterWire[]
    }
export interface CreateWorkflowTriggerResultWire {
  trigger: WorkflowTriggerBindingWire
  secretToken?: string
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
  /** GRS-009: one workflow's definition + DERIVED run state (read-only). */
  getWorkflow: (id: string) => get<DerivedWorkflow>(`/api/workflows/${encodeURIComponent(id)}`),
  listWorkflows: () => get<{ workflows: string[]; evidenceConfigured: boolean }>("/api/workflows"),
  /** GRS-011c: list editable workflow definitions (Edit view rail). */
  listWorkflowDefinitions: () =>
    get<{ definitions: WorkflowDefinitionSummaryWire[]; evidenceConfigured: boolean; evidenceReason?: string }>(
      "/api/workflow-definitions",
    ),
  /** GRS-019: create a new editable definition (the list's "+ New Workflow").
   * Same discriminated error contract as updateWorkflowDefinition so the dialog
   * can render 400 validation / 409 duplicate-id inline. */
  createWorkflowDefinition: async (
    def: Partial<EditableWorkflowDefinitionWire>,
  ): Promise<SaveDefinitionResult> => {
    const res = await authFetch("/api/workflow-definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    })
    if (res.ok) return { ok: true, definition: (await res.json()) as EditableWorkflowDefinitionWire }
    let message = `API error: ${res.status}`
    let errors: WorkflowValidationError[] | undefined
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
      else if (body?.message) message = String(body.message)
      if (Array.isArray(body?.errors)) errors = body.errors as WorkflowValidationError[]
    } catch {
      /* non-JSON body — keep the status-code message */
    }
    return { ok: false, status: res.status, message, errors }
  },
  /** GRS-011c: full editable definition (Edit view canvas + inspector). */
  getWorkflowDefinition: (id: string) =>
    get<EditableWorkflowDefinitionWire>(`/api/workflow-definitions/${encodeURIComponent(id)}`),
  /** GRS-011c: save a definition edit (shallow patch, optimistic lock on
   * `expectedVersion`). Returns a discriminated result so the Edit view can
   * render inline 400 `errors[]` / 409 conflicts instead of a flat throw. */
  updateWorkflowDefinition: async (
    id: string,
    patch: Partial<EditableWorkflowDefinitionWire>,
    expectedVersion?: number,
    options?: { layoutIntent: 'manual' },
  ): Promise<SaveDefinitionResult> => {
    const res = await authFetch(`/api/workflow-definitions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...patch,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(options ?? {}),
      }),
    })
    if (res.ok) return { ok: true, definition: (await res.json()) as EditableWorkflowDefinitionWire }
    let message = `API error: ${res.status}`
    let errors: WorkflowValidationError[] | undefined
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
      else if (body?.message) message = String(body.message)
      if (Array.isArray(body?.errors)) errors = body.errors as WorkflowValidationError[]
    } catch {
      /* non-JSON body — keep the status-code message */
    }
    return { ok: false, status: res.status, message, errors }
  },
  /** Ask the gateway's canonical layout authority for a preview. This does not
   * persist or mutate the supplied definition. */
  planWorkflowDefinition: (
    definition: EditableWorkflowDefinitionWire,
    options: { layoutIntent: 'normalize' },
  ) => post<WorkflowPlanWire>("/api/workflow-definitions/plan", { definition, ...options }),
  /** Start one durable run. Reusing idempotencyKey safely retries a transport
   * failure without minting a second execution. */
  startWorkflowRun: (
    id: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<WorkflowRunWire> => authFetch(
    `/api/workflow-definitions/${encodeURIComponent(id)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, idempotencyKey }),
    },
  ).then(async (res) => {
    // A failed execution is durable evidence, not a request failure: the
    // gateway intentionally returns its full run snapshot with HTTP 422.
    if (res.ok || res.status === 422) return (await res.json()) as WorkflowRunWire
    let body: Record<string, unknown> = {}
    try { body = await res.json() as Record<string, unknown> } catch { /* keep status fallback */ }
    const message = typeof body.error === "string" ? body.error : `API error: ${res.status}`
    throw new WorkflowApiError(
      message,
      res.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.runId === "string" ? body.runId : undefined,
    )
  }),
  /** GRS-011d-2c-ui: list a definition's real runs (newest first). Returns
   * `evidenceConfigured:false` (not an error) when the gateway has no evidence root. */
  listWorkflowRuns: (id: string) =>
    get<{ runs: WorkflowRunSummaryWire[]; evidenceConfigured: boolean }>(
      `/api/workflow-definitions/${encodeURIComponent(id)}/runs`,
    ),
  /** GRS-011d-2c-ui: one run record (steps receipts + parked gate). Throws 404 if absent. */
  getWorkflowRun: (id: string, runId: string) =>
    get<WorkflowRunWire>(
      `/api/workflow-definitions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    ),
  cancelWorkflowRun: async (id: string, runId: string, reason?: string): Promise<WorkflowRunWire> => {
    const res = await authFetch(
      `/api/workflow-definitions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { reason } : {}),
      },
    )
    if (res.ok) return (await res.json()) as WorkflowRunWire
    let body: Record<string, unknown> = {}
    try { body = await res.json() as Record<string, unknown> } catch { /* keep status fallback */ }
    throw new WorkflowApiError(
      typeof body.error === "string" ? body.error : `API error: ${res.status}`,
      res.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.runId === "string" ? body.runId : undefined,
    )
  },
  listWorkflowTriggers: () =>
    get<{ triggers: WorkflowTriggerBindingWire[]; evidenceConfigured: boolean }>("/api/workflow-triggers"),
  createWorkflowTrigger: (input: CreateWorkflowTriggerInputWire) =>
    post<CreateWorkflowTriggerResultWire>("/api/workflow-triggers", input),
  deleteWorkflowTrigger: (name: string) =>
    del<{ deleted: boolean; name: string }>(`/api/workflow-triggers/${encodeURIComponent(name)}`),
  decideWorkflowTriggerActivationApproval: (name: string, decision: "approve" | "reject") =>
    post<{ trigger: WorkflowTriggerBindingWire }>(
      `/api/workflow-triggers/${encodeURIComponent(name)}/activation-approval`,
      { decision },
    ),
  escalateWorkflowTriggerActivationApproval: (name: string) =>
    post<{ trigger: WorkflowTriggerBindingWire }>(
      `/api/workflow-triggers/${encodeURIComponent(name)}/activation-approval/escalate`,
      {},
    ),

  /** GRS-014e: resolve a PARKED run's human-approval gate. Returns the updated run,
   * or throws with the gateway's error message (409 when the run is not parked). */
  resolveWorkflowRunGate: async (
    id: string,
    runId: string,
    decision: 'approve' | 'reject',
  ): Promise<WorkflowRunWire> => {
    const res = await authFetch(
      `/api/workflow-definitions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/resolve-gate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    )
    if (res.ok) return (await res.json()) as WorkflowRunWire
    let message = `API error: ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
    } catch {
      /* keep status message */
    }
    throw new Error(message)
  },
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
