import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OrderWarning } from './order.js';
import type { EditableWorkflowDefinition } from './definition.js';
import type { StepOutcome } from './handoff.js';
import type { WorkflowGateApprovalRecord } from './approval-authority.js';
import {
  canonicalWorkflowRunJson,
  type WorkflowRunInvocationClaim,
} from './run-idempotency.js';

/**
 * File-backed store for workflow RUNS (GRS-011d-2c).
 *
 * This is the durable record of an actual execution of an editable workflow definition —
 * the "run" half of the edit→run→evidence loop. It is deliberately SEPARATE from:
 *   - the definition store (`definition-store.ts`, the editable graph the user saves);
 *   - the read-only derive path (`derive.ts`, which projects the Sample Autonomy's hardcoded
 *     per-wave receipts). A workflow RUN is what the run executor produces when a saved
 *     definition is actually run; a `WaveReceipt` is the workflow dogfood's own hand-written
 *     progress file. They are different artifacts on purpose.
 *
 * Storage contract mirrors the definition store (GRS-011a decision): file-backed JSON, one
 * file per run, git-as-history, no DB. Runs live at:
 *
 *     <evidenceRoot>/reports/runs/<workflowId>/<runId>.json
 *
 * The module is pure fs (no gateway/env coupling) with an injectable clock so it is
 * deterministically testable and reusable by the executor + gateway routes. It never
 * mutates definitions or historical wave receipts.
 */

/* ── Run record shapes ──────────────────────────────────────────────────────── */

/**
 * Run-record schema version (GRS-014a). v1 records (no `schemaVersion` field) used the
 * dishonest run-level `passed` (= "the walk finished", while spawned sessions were still
 * running — the KISS-audit honesty gap). v2 retired `passed`; v3 separates immutable
 * run parameters from the verified invoking-Session relation and adds monotonic revision.
 * Compatibility normalization is READ-TIME ONLY; legacy evidence is never rewritten.
 */
export const WORKFLOW_RUN_SCHEMA_VERSION = 3;

/**
 * Step states. The GRS-014b sequential step machine drives
 * `pending → dispatching → running → done | failed | skipped` for actor steps
 * (`attempt` counts dispatches; the respawn-once policy allows at most 2), with
 * `inline` (actorless pass-through) and `checkpoint` (auto-evaluated gate node) as
 * walk-through terminals. `routed` (GRS-016c) is a switch node's terminal: the
 * routing decision taken, the activated edge ids stamped durably on `route`.
 * `fired` (GRS-016d) is a fire-and-forget step's terminal: the session was spawned
 * (output:'none'), is never awaited, and the run does not block on it — the
 * deliberate receipt-level reuse of the retired run-level `dispatched` vocabulary,
 * where it now tells the truth because the author declared it. `waiting`
 * (GRS-016d) is a wait node's NON-terminal pause: `readyAt` is stamped durably and
 * the sweep settles it to `checkpoint` at/after the deadline — no session exists,
 * so it is neither settled nor in flight. `spawned`/`error` are v1-walk legacy
 * values — still served from old records, no longer written.
 */
export type RunStepStatus =
  | 'spawned'
  | 'inline'
  | 'checkpoint'
  | 'routed'
  | 'fired'
  | 'waiting'
  | 'error'
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/** Step states that need no further driving (the run can move past them). */
export const SETTLED_STEP_STATUSES: ReadonlySet<RunStepStatus> = new Set([
  'done',
  'skipped',
  'inline',
  'checkpoint',
  'routed',
  'fired',
]);

/** Step states with a real session (possibly) in flight — the states the drain
 * (GRS-016a `stopping`) waits on and the parked probe-only sweep keeps truthful. */
export const IN_FLIGHT_STEP_STATUSES: ReadonlySet<RunStepStatus> = new Set([
  'dispatching',
  'running',
]);

/** True when any receipt has a session (possibly) in flight. */
export function hasInFlightSteps(run: Pick<WorkflowRun, 'steps'>): boolean {
  return Array.isArray(run.steps) && run.steps.some((s) => IN_FLIGHT_STEP_STATUSES.has(s.status));
}

/** One record of what a single node did when the run walked it. */
export interface RunStepReceipt {
  nodeId: string;
  label: string;
  /** The actor the plan mapped this step to, or null for an orchestrator-inline / gate node. */
  actor: { kind: 'employee' | 'engine'; ref: string } | null;
  status: RunStepStatus;
  /**
   * Dispatch counter (GRS-014b): 0 until first dispatch, then 1, 2. The respawn-once
   * policy (operator decision 2026-07-04) caps it at 2 — an interrupted attempt 2 fails
   * the step. Part of the deterministic sessionKey `workflow-run:<runId>:<nodeId>:<attempt>`.
   */
  attempt?: number;
  /**
   * Loop iteration this receipt belongs to (GRS-014e). Absent = round 1 (all
   * pre-loop records stay byte-identical). Round ≥ 2 receipts are appended IN PLACE
   * after the previous round's segment, so array order remains execution order, and
   * their sessions key as `workflow-run:<runId>:<nodeId>:r<round>:<attempt>` (round 1
   * keeps the 014b key shape). One receipt per (nodeId, round) — per-iteration
   * history stays honest.
   */
  round?: number;
  /** Set when a session exists for this step — the real session on the gateway. */
  sessionId?: string;
  /** Human note: error message, gate description, or "inline (no actor)". */
  detail?: string;
  /** When the current attempt's dispatch was minted (BEFORE the spawn — the intent record). */
  dispatchedAt?: string;
  /** When the step's session settled (idle) or the step otherwise terminally resolved. */
  settledAt?: string;
  /**
   * The step's durable outcome (GRS-014c), persisted at settle time: the declared
   * ```handoff block (summary/artifacts/notes/fields) or the tail-capped final
   * assistant message. Frozen evidence — and the exact material injected into every
   * successor's prompt.
   */
  outcome?: StepOutcome;
  /**
   * A switch receipt's FROZEN routing decision (GRS-016c): the out-edge ids it
   * activated, stamped when the receipt settles `routed`. Empty = no rule matched
   * and no default edge — every branch was skipped. Later evidence drift can never
   * re-route: edge activity is derived from THIS stamp, never re-evaluated.
   */
  route?: string[];
  /**
   * A wait receipt's durable deadline (GRS-016d): stamped when the receipt enters
   * `waiting` (now + waitMinutes, or the authored waitUntil verbatim). The sweep
   * settles the receipt `checkpoint` on the first pass at/after this time — and
   * because it is persisted, a gateway restart re-derives the same deadline (no
   * timer state exists outside this field).
   */
  readyAt?: string;
  /**
   * The per-dispatch turn marker (GRS-016e) of a follow-up-mode dispatch (session
   * mode 'workflow'/'existing'): a deterministic token embedded in the posted
   * message for HUMAN ATTRIBUTION in the receiving conversation, persisted at
   * mint. It plays no part in settle correlation (GRS-016e-fix2) — that is
   * `turnAnchor`, the row id below.
   */
  turnMarker?: string;
  /**
   * The durable message id of the USER row the workflow inserts for this
   * dispatch (GRS-016e-fix, Codex finding 1) — the settle ANCHOR. Correlation is
   * purely ROW-POSITIONAL: the step's reply is the first non-partial assistant
   * row strictly AFTER this row, so an assistant echoing the marker string can
   * never break correlation. PRE-MINTED and persisted in the SAME write as the
   * dispatching mark (GRS-016e-fix2, Codex round-2 finding 3) — the poster
   * inserts the row WITH this id, so no crash window can lose the anchor and NO
   * content-based fallback exists: an anchor-less legacy receipt is ambiguous
   * and re-posts (retryable), never content-guesses.
   */
  turnAnchor?: string;
  /** Last transition time. */
  at: string;
}

/**
 * The gate a parked run is waiting on. This is the product's accountability beat —
 * a run halted on a human-approval gate, visibly awaiting a person. `scope` says where
 * the gate lives (a step's inline gate, a standalone gate node, or a workflow run gate).
 */
export interface ParkedGate {
  /** Where the parking gate lives. A run parks only at standalone gate NODES or workflow run
   * gates — never a step's inline gate (those are post-hoc receipts; Codex GRS-011d-2c Major 1). */
  scope: 'gateNode' | 'runGate';
  /** Node id for gateNode scope; null for a workflow-level runGate. */
  nodeId: string | null;
  kind: 'approval';
  evaluator: 'human-approval';
  ref?: string;
  description: string;
  /** When the run parked (GRS-014b). A parked run keeps endedAt null — parking is not
   * terminal; resume lands with the GRS-014e resolve-gate API. */
  at?: string;
  /** Frozen native approval route for this parked episode. */
  approval?: WorkflowGateApprovalRecord;
}

export interface WorkflowGateDecision {
  gateKey: string;
  decision: 'approve' | 'reject';
  actor: string;
  at: string;
  /** Complete frozen route and decision evidence for this approval episode. */
  approval: WorkflowGateApprovalRecord;
}

export interface WorkflowApprovalAdoptionRecord {
  legacySchemaVersion: number;
  definitionSource: 'snapshot' | 'missing-fallback';
  adoptedAt: string;
  gateKey: string;
  /** Frozen pre-adoption gate evidence; never includes a native approval. */
  priorParked: ParkedGate;
  /** The fresh pending authority created by this adoption. */
  approval: WorkflowGateApprovalRecord;
}

export type WorkflowTriggerSource = 'manual' | 'schedule' | 'todo-status-change' | 'event-webhook' | 'check-poll' | (string & {});

/**
 * Uniform workflow trigger runtime contract (GRS-026 S1). Every predefined source
 * and future custom source enters the run engine as the same envelope; source-specific
 * details live under payload, and idempotent sources set fireRef.
 */
export interface WorkflowTriggerEvent {
  source: WorkflowTriggerSource;
  event: string;
  payload: Record<string, unknown>;
  fireRef?: string;
}

/** Legacy run trigger persisted before the uniform envelope. Kept readable and
 * writable for byte-compat evidence; new trigger emitters should write
 * WorkflowTriggerEvent. */
export interface LegacyWorkflowRunTrigger {
  kind: 'manual' | 'schedule' | 'todo-status-change';
  /** The managed cron job (`workflow:<workflowId>`) that fired this run, when scheduled. */
  cronJobId?: string;
  /** The scheduler-captured fire identity: at most one run exists per (workflowId, fireIso). */
  fireIso?: string;
  /** The immutable Todo audit-event id that fired a todo-status-change run. */
  fireRef?: string;
}

export type WorkflowRunTrigger = WorkflowTriggerEvent | LegacyWorkflowRunTrigger;

/** Read the uniform trigger source from both current and legacy run records. */
export function workflowTriggerSource(trigger: WorkflowRunTrigger): string {
  return 'source' in trigger ? trigger.source : trigger.kind;
}

/**
 * Frozen caller-supplied context for one invocation of a reusable workflow. Input is
 * persisted separately from trigger metadata so every phase receives the same
 * structured data without promoting it to workflow instructions. The optional key is
 * also copied to the manual trigger's fireRef by the run route for file-enforced
 * idempotency.
 */
export interface WorkflowRunParameters {
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

export type WorkflowReportMode = 'resume' | 'silent';

/** The verified Session that invoked this run and its sole reporting policy. */
export interface WorkflowRunInvocation {
  sessionId: string;
  reportMode: WorkflowReportMode;
}

/** Frozen authority and operator intent for one native cancellation request. */
export interface WorkflowRunCancellation {
  requestedAt: string;
  requestedBy: string;
  reason: string | null;
}

export const MAX_WORKFLOW_RUN_CANCELLATION_REASON_CHARS = 2_000;

export interface WorkflowRunReportEpisode {
  sequence: number;
  token: string;
  kind: 'parked' | 'terminal';
  outcome: 'parked' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  summary: string;
}

/** A run-local replacement for one step's authored task text. This is deliberately
 * separate from both immutable run parameters and the frozen definition snapshot:
 * the definition remains honest evidence while the effective pending-phase prompt
 * can be tailored for this run. */
export interface WorkflowStepPromptOverride {
  prompt: string;
}

/** Prompt text becomes an engine user turn; cap it below the gateway run-body cap
 * so one override cannot crowd out trigger/input/audit metadata. */
export const MAX_WORKFLOW_STEP_PROMPT_CHARS = 32_000;

/** Append-only evidence for an on-the-go edit to a phase that had not started. */
export interface WorkflowStepPromptEdit {
  revision: number;
  nodeId: string;
  actor: string;
  at: string;
  before: string;
  after: string;
}

/**
 * Honest v2 run statuses (GRS-014a, design D5):
 *   - `running`    — steps pending/in-flight; the run is genuinely working.
 *   - `parked`     — halted on a human-approval gate.
 *   - `dispatched` — the v1-style walk finished and ≥1 session was spawned
 *                    fire-and-forget: completion UNKNOWN. Transitional: written by the
 *                    interim executor until GRS-014b's advancement replaces it; also the
 *                    read-time mapping of a legacy v1 `passed` record.
 *   - `completed`  — every step's work actually finished (until 014b that means every
 *                    step ran inline/checkpoint — no unconfirmed session in flight) and
 *                    no blocking runGate held it.
 *   - `failed`     — compile failure, a step errored, or (later) a rejected gate.
 *   - `cancelled`  — explicit run cancellation after live step sessions drain.
 * v1's run-level `passed` is retired — it read as "the workflow succeeded" while sessions
 * were still running (KISS-audit SIMPLIFY #3).
 */
export type WorkflowRunStatus =
  | 'running'
  | 'parked'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowRun {
  /** Absent on legacy v1 files; WORKFLOW_RUN_SCHEMA_VERSION on records written since GRS-014a. */
  schemaVersion?: number;
  /** Monotonic persisted mutation revision. Legacy v1/v2 reads normalize to 0. */
  revision?: number;
  runId: string;
  workflowId: string;
  /** The definition version this run executed (so a later edit doesn't rewrite history). */
  definitionVersion: number;
  title: string;
  trigger: WorkflowRunTrigger;
  /** Frozen structured parameters supplied for this particular run. */
  parameters?: WorkflowRunParameters;
  /** Verified invoking Session relation. Absent for browser/CLI/system and legacy runs. */
  invocation?: WorkflowRunInvocation;
  /** Durable cancellation authority. Once present, changed intent is rejected. */
  cancellation?: WorkflowRunCancellation;
  /** Monotonic append-only report episode identity. */
  reportSequence?: number;
  /** Stable parked/re-entry/terminal episodes claimed through Session delivery. */
  reportEpisodes?: WorkflowRunReportEpisode[];
  /** Current effective per-step prompt replacements for this run. Initial values
   * are frozen at start; later changes are admitted only for pending phases and
   * every such change is recorded in `stepPromptEdits`. */
  stepOverrides?: Record<string, WorkflowStepPromptOverride>;
  /** Monotonic revision of the run-local prompt layer. Absent means no live edit. */
  stepPromptRevision?: number;
  /** Append-only audit trail for edits made after the run started. */
  stepPromptEdits?: WorkflowStepPromptEdit[];
  /** Legacy field: new todo-status runs carry this as trigger.payload.todoId. */
  triggerTodoId?: string;
  status: WorkflowRunStatus;
  startedAt: string;
  endedAt: string | null;
  steps: RunStepReceipt[];
  /** Present iff status==='parked': the human-approval gate holding the run. */
  parked: ParkedGate | null;
  /** Present iff status==='failed': execution-mapping errors from the compiler. */
  errors?: { code: string; message: string; ref?: string }[];
  /**
   * The frozen execution order of this run's non-trigger nodes (GRS-014b): the
   * edge-implied topological order (declaration tiebreak) computed at run start —
   * `steps[]` is materialized 1:1 in this order. Its presence is also the marker of a
   * v2 SEQUENTIAL run the reconciler may drive; records without it (v1 walks, 014a-era
   * stubs) are never advanced.
   */
  order?: string[];
  /**
   * Loop round counter (GRS-014e): present only on runs whose definition declares a
   * loop edge; starts at 1 and increments each time the loop segment is re-entered.
   * Bounded by `loop.maxRoundsPerRun` from the frozen definition — the acceptance
   * evidence "rounds === maxRoundsPerRun when the exit gate never passed".
   */
  rounds?: number;
  /**
   * Durable loop-exit marker (GRS-014e): stamped when the loop stops repeating —
   * either its exit gate passed at the end of `round`, or a gate-less loop finished
   * its declared round count. Once present the loop is never re-entered, even if the
   * evidence behind an artifact/flag gate later disappears (decisions are frozen,
   * not re-derived from mutable evidence).
   */
  loopExit?: { round: number; at: string; reason: 'gate-passed' | 'max-rounds' };
  /**
   * Workflow-level run gates an operator APPROVED via the resolve-gate API
   * (GRS-014e), keyed by the gate's ref (fallback: description). The terminal check
   * skips these — without the record, re-advancing an approved run would re-park on
   * the same gate forever.
   */
  resolvedRunGates?: string[];
  /** Append-only native gate decision evidence. */
  gateDecisions?: WorkflowGateDecision[];
  /** Append-only evidence for explicit adoption of a legacy parked episode. */
  approvalAdoptions?: WorkflowApprovalAdoptionRecord[];
  /**
   * Honest drain (GRS-016a): set when a required step fails while OTHER receipts are
   * still in flight (only possible under concurrency > 1). While present: status stays
   * `running` (the UI renders "stopping"), dispatch is suppressed entirely, in-flight
   * receipts keep being probed and settle truthfully, and the terminal (`stopping.to`,
   * with `stopping.errors` folded into `errors`) is written only when nothing is in
   * flight — a terminal record never freezes live receipts at `running`. The field
   * stays on the terminal record as frozen evidence of when draining began. `to:
   * 'cancelled'` records an explicit cancellation request while sessions drain.
   */
  stopping?: { to: 'failed' | 'cancelled'; at: string; errors: { code: string; message: string; ref?: string }[] };
  /**
   * The run's ONE shared engine session (GRS-016e, session mode 'workflow'):
   * created lazily by the first workflow-mode node to dispatch (under sessionKey
   * `workflow-run:<runId>:shared`) and persisted here; every later workflow-mode
   * node posts a marker-correlated follow-up turn into it, strictly serialized.
   * Additive: v2 records never carry it.
   */
  sharedSessionId?: string;
  /**
   * The definition CONTENT this run executes, frozen at mint (GRS-014b-fix, Codex
   * finding 2): every subsequent advance/sweep compiles from THIS snapshot, never the
   * mutable store — a mid-run definition edit (or retire/delete) cannot change what a
   * running run does, so the run's `definitionVersion` claim stays true. Frozen
   * evidence, same instinct as the receipt files.
   */
  definitionSnapshot?: EditableWorkflowDefinition;
  /**
   * The GRS-014a interim branching guard, stamped by the retired v1 declaration-order
   * walk. LEGACY READ-SIDE ONLY since GRS-014b: new runs execute in edge order and
   * never carry it; the field + UI rendering stay so old stamped records still show it.
   */
  orderWarning?: OrderWarning;
}

/** Compact list-view row. */
export interface WorkflowRunSummary {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  trigger: WorkflowRunTrigger;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
  parked: boolean;
  /** True when any receipt is dispatching/running (GRS-016a) — the sweep uses this to
   * probe parked runs whose sibling sessions are still settling (probe-only mode). */
  inFlight: boolean;
}

/* ── id safety (matches definition-store) ───────────────────────────────────── */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class WorkflowRunStoreError extends Error {
  readonly code: 'invalid-id' | 'not-found' | 'bad-input';
  constructor(code: 'invalid-id' | 'not-found' | 'bad-input', message: string) {
    super(message);
    this.name = 'WorkflowRunStoreError';
    this.code = code;
  }
}

function assertSafeId(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new WorkflowRunStoreError('invalid-id', `${what} is required`);
  }
  if (id.length > 128) {
    throw new WorkflowRunStoreError('invalid-id', `${what} is too long (max 128)`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0') || id.includes('..') || id === '.' || id === '..') {
    throw new WorkflowRunStoreError('invalid-id', `unsafe ${what} "${id}"`);
  }
  if (!SAFE_ID.test(id)) {
    throw new WorkflowRunStoreError('invalid-id', `${what} must match ${SAFE_ID.source}`);
  }
}

function runsDir(root: string, workflowId: string): string {
  assertSafeId(workflowId, 'workflow id');
  return path.join(root, 'reports', 'runs', workflowId);
}

function runFile(root: string, workflowId: string, runId: string): string {
  assertSafeId(runId, 'run id');
  return path.join(runsDir(root, workflowId), `${runId}.json`);
}

function invocationClaimFile(root: string, workflowId: string, principal: string, idempotencyKey: string): string {
  const namespace = canonicalWorkflowRunJson({ workflowId, principal, idempotencyKey });
  const digest = createHash('sha256').update(namespace).digest('hex');
  return path.join(root, 'reports', 'run-idempotency', `${digest}.json`);
}

function isInvocationClaim(value: unknown): value is WorkflowRunInvocationClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Partial<WorkflowRunInvocationClaim>;
  return claim.schemaVersion === 1
    && typeof claim.workflowId === 'string'
    && typeof claim.principal === 'string'
    && typeof claim.idempotencyKey === 'string'
    && typeof claim.runId === 'string'
    && typeof claim.fingerprint === 'string'
    && !!claim.request && typeof claim.request === 'object'
    && typeof claim.createdAt === 'string';
}

export function getWorkflowRunInvocationClaim(
  root: string,
  workflowId: string,
  principal: string,
  idempotencyKey: string,
): WorkflowRunInvocationClaim | null {
  const file = invocationClaimFile(root, workflowId, principal, idempotencyKey);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isInvocationClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function findWorkflowRunInvocationClaimByRunId(
  root: string,
  workflowId: string,
  runId: string,
): WorkflowRunInvocationClaim | null {
  const dir = path.join(root, 'reports', 'run-idempotency');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (isInvocationClaim(parsed) && parsed.workflowId === workflowId && parsed.runId === runId) return parsed;
    } catch {
      // Corrupt claims do not prove that a legacy run has an intent binding.
    }
  }
  return null;
}

export type WorkflowRunInvocationClaimResult =
  | { outcome: 'claimed' | 'replay'; claim: WorkflowRunInvocationClaim }
  | { outcome: 'conflict'; claim: WorkflowRunInvocationClaim | null };

/** Exclusively bind an idempotency namespace before the corresponding run is minted. */
export function claimWorkflowRunInvocation(
  root: string,
  claim: WorkflowRunInvocationClaim,
): WorkflowRunInvocationClaimResult {
  const file = invocationClaimFile(root, claim.workflowId, claim.principal, claim.idempotencyKey);
  const directory = path.dirname(file);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(directory, { recursive: true });
  let descriptor: number | undefined;
  try {
    // Publish only a complete, fsynced inode. A direct `open(wx)` on the final
    // path exposes an empty/partial file to concurrent readers and would require
    // a synchronous event-loop wait. `link` is the exclusive atomic claim step.
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(claim, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = getWorkflowRunInvocationClaim(root, claim.workflowId, claim.principal, claim.idempotencyKey);
      if (existing
        && existing.fingerprint === claim.fingerprint
        && canonicalWorkflowRunJson(existing.request) === canonicalWorkflowRunJson(claim.request)) {
        return { outcome: 'replay', claim: existing };
      }
      return { outcome: 'conflict', claim: existing };
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  // Persist the final link and temporary-name removal where supported.
  try {
    const directoryDescriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch {
    /* directory fsync is not portable */
  }
  return { outcome: 'claimed', claim };
}

/** Atomic overwrite (unique temp + rename); a reader never sees a torn file. */
function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function isPlainPayload(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function copyPayload(v: unknown): Record<string, unknown> {
  if (!isPlainPayload(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) out[key] = value;
  return out;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function isWorkflowTriggerEvent(trigger: unknown): trigger is WorkflowTriggerEvent {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const record = trigger as Record<string, unknown>;
  return (
    typeof record.source === 'string' &&
    record.source !== '' &&
    typeof record.event === 'string' &&
    record.event !== '' &&
    isPlainPayload(record.payload) &&
    (record.fireRef === undefined || typeof record.fireRef === 'string')
  );
}

export function normalizeWorkflowTrigger(trigger: unknown, legacyTriggerTodoId?: string): WorkflowTriggerEvent {
  if (isWorkflowTriggerEvent(trigger)) {
    const payload = copyPayload(trigger.payload);
    if (legacyTriggerTodoId && payload.todoId === undefined) payload.todoId = legacyTriggerTodoId;
    return {
      source: trigger.source,
      event: trigger.event,
      payload,
      ...(trigger.fireRef ? { fireRef: trigger.fireRef } : {}),
    };
  }

  if (typeof trigger === 'string') {
    const source = trigger === 'schedule' ? 'schedule' : trigger === 'todo-status-change' ? 'todo-status-change' : 'manual';
    return source === 'schedule'
      ? { source, event: 'schedule.fire', payload: {} }
      : source === 'todo-status-change'
        ? { source, event: 'todo.status_changed', payload: legacyTriggerTodoId ? { todoId: legacyTriggerTodoId } : {} }
        : { source: 'manual', event: 'workflow.manual_started', payload: legacyTriggerTodoId ? { todoId: legacyTriggerTodoId } : {} };
  }

  const record = trigger && typeof trigger === 'object' && !Array.isArray(trigger)
    ? trigger as Record<string, unknown>
    : {};
  const kind = record.kind === 'schedule'
    ? 'schedule'
    : record.kind === 'todo-status-change'
      ? 'todo-status-change'
      : 'manual';

  if (kind === 'schedule') {
    const payload: Record<string, unknown> = {};
    const cronJobId = stringField(record, 'cronJobId');
    const fireIso = stringField(record, 'fireIso');
    if (cronJobId) payload.cronJobId = cronJobId;
    if (fireIso) payload.fireIso = fireIso;
    const fireRef = stringField(record, 'fireRef') ?? fireIso;
    return { source: 'schedule', event: 'schedule.fire', payload, ...(fireRef ? { fireRef } : {}) };
  }

  if (kind === 'todo-status-change') {
    const payload: Record<string, unknown> = {};
    if (legacyTriggerTodoId) payload.todoId = legacyTriggerTodoId;
    const fireRef = stringField(record, 'fireRef');
    return { source: 'todo-status-change', event: 'todo.status_changed', payload, ...(fireRef ? { fireRef } : {}) };
  }

  return { source: 'manual', event: 'workflow.manual_started', payload: legacyTriggerTodoId ? { todoId: legacyTriggerTodoId } : {} };
}

/* ── Public API ─────────────────────────────────────────────────────────────── */

/** Generate a run id (sortable-ish: time-prefixed random). Injectable in tests. */
export function newRunId(now: () => string = () => new Date().toISOString()): string {
  const stamp = now().replace(/[-:.TZ]/g, '').slice(0, 14); // yyyymmddhhmmss
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

function currentRunForWrite(run: WorkflowRun): WorkflowRun {
  return run.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION && run.revision === undefined
    ? { ...run, revision: 1 }
    : run;
}

/** Persist a run record (create or overwrite the same runId). */
export function saveRun(root: string, run: WorkflowRun): WorkflowRun {
  assertSafeId(run.workflowId, 'workflow id');
  assertSafeId(run.runId, 'run id');
  const persisted = currentRunForWrite(run);
  writeAtomic(runFile(root, persisted.workflowId, persisted.runId), JSON.stringify(persisted, null, 2) + '\n');
  // Keep the active-run index in lockstep so the reconciler sweep and the Todo
  // trigger read O(active) instead of O(all-lifetime-runs). Best-effort: a failed
  // update is corrected by rebuild-on-miss and the boot-time rebuild, so it must
  // never fail the save.
  try {
    updateActiveRunIndexForRun(root, persisted);
  } catch {
    /* index self-heals (rebuild-on-miss + startup rebuild) */
  }
  return persisted;
}

export type InitialWorkflowRunPublication =
  | { outcome: 'published'; run: WorkflowRun }
  | { outcome: 'existing'; run: WorkflowRun };

/**
 * Publish the immutable initial run snapshot exactly once across processes.
 * The complete, fsynced temp inode is hard-linked into its final name, so losers
 * can never observe a partially-written winner and can never replace it.
 */
export function publishInitialWorkflowRun(root: string, run: WorkflowRun): InitialWorkflowRunPublication {
  const persisted = currentRunForWrite(run);
  assertSafeId(persisted.workflowId, 'workflow id');
  assertSafeId(persisted.runId, 'run id');
  const directory = runsDir(root, persisted.workflowId);
  const target = runFile(root, persisted.workflowId, persisted.runId);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${persisted.runId}.initial-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = getRun(root, persisted.workflowId, persisted.runId);
      if (!existing) {
        throw new WorkflowRunStoreError('bad-input', `initial run "${persisted.runId}" exists but could not be read`);
      }
      return { outcome: 'existing', run: existing };
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temp); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // The linked final name and temp cleanup are one durable directory state.
  try {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch {
    /* directory fsync is not portable */
  }
  try {
    updateActiveRunIndexForRun(root, persisted);
  } catch {
    /* index self-heals (rebuild-on-miss + startup rebuild) */
  }
  return { outcome: 'published', run: persisted };
}

/* ── Active-run index (GRS perf batch) ─────────────────────────────────────────
 * A run is TERMINAL once completed/failed/cancelled; everything else
 * (running/parked/dispatched) is still "active" and may need advancing or
 * dedup-checking. Reading every lifetime run file every 15s (sweep) and on every
 * Todo status change scaled O(total runs). Instead we persist a tiny index of
 * active run refs, maintained on save, and rebuildable from a full scan whenever
 * it is missing/corrupt (crash-safe by construction — a stale entry is a harmless
 * re-read; a missed entry is corrected at the next boot rebuild). */

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** True once a run reaches a terminal status (no further advancing/dedup needed). */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export interface ActiveRunRef {
  workflowId: string;
  runId: string;
}

function activeIndexFile(root: string): string {
  return path.join(root, 'reports', 'runs', '_active-index.json');
}

/** Read the index; null if missing or unreadable/corrupt (→ caller rebuilds). */
function readActiveRunIndex(root: string): ActiveRunRef[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(activeIndexFile(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: ActiveRunRef[] = [];
    for (const entry of parsed) {
      const wf = entry?.workflowId;
      const rn = entry?.runId;
      if (typeof wf === 'string' && typeof rn === 'string' && SAFE_ID.test(wf) && SAFE_ID.test(rn)) {
        out.push({ workflowId: wf, runId: rn });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function writeActiveRunIndex(root: string, refs: ActiveRunRef[]): void {
  writeAtomic(activeIndexFile(root), JSON.stringify(refs) + '\n');
}

/** Full scan → rewrite the index. Boot recovery + rebuild-on-miss. */
export function rebuildActiveRunIndex(root: string): ActiveRunRef[] {
  const refs: ActiveRunRef[] = [];
  for (const workflowId of listRunWorkflowIds(root)) {
    for (const summary of listRuns(root, workflowId)) {
      if (!isTerminalRunStatus(summary.status)) refs.push({ workflowId, runId: summary.runId });
    }
  }
  writeActiveRunIndex(root, refs);
  return refs;
}

/** Active (non-terminal) run refs. Rebuilds from a full scan if the index is
 * missing/corrupt, so a fresh install or a crash-truncated index self-heals. */
export function listActiveRunRefs(root: string): ActiveRunRef[] {
  return readActiveRunIndex(root) ?? rebuildActiveRunIndex(root);
}

function updateActiveRunIndexForRun(root: string, run: WorkflowRun): void {
  const idx = readActiveRunIndex(root);
  if (!idx) {
    // Missing/corrupt → a full rebuild reads the just-saved file and includes it.
    rebuildActiveRunIndex(root);
    return;
  }
  const present = idx.findIndex((r) => r.workflowId === run.workflowId && r.runId === run.runId);
  const active = !isTerminalRunStatus(run.status);
  if (active && present === -1) {
    idx.push({ workflowId: run.workflowId, runId: run.runId });
    writeActiveRunIndex(root, idx);
  } else if (!active && present !== -1) {
    idx.splice(present, 1);
    writeActiveRunIndex(root, idx);
  }
}

/**
 * READ-TIME legacy mapping (GRS-014a + GRS-014d). In-memory only: the on-disk file is
 * frozen evidence and is NEVER rewritten.
 *   - status: a v1 record (no schemaVersion) with the retired run-level `passed` is
 *     served as `dispatched` — the honest name for what v1 proved ("the walk finished;
 *     sessions were dispatched; completion unknown"). v1 `running`/`parked`/`failed`
 *     pass through unchanged — their meanings were already honest.
 *   - trigger: records written before GRS-014d (v1 AND early-v2) carry a bare
 *     `'manual'|'schedule'` string; it is wrapped into the `WorkflowRunTrigger` object
 *     (`{kind}` — no cronJobId/fireIso existed to lose) so every consumer sees ONE shape.
 */
function isWorkflowRunParameters(value: unknown): value is WorkflowRunParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isPlainPayload(record.input)
    && (record.idempotencyKey === undefined || typeof record.idempotencyKey === 'string');
}

function isWorkflowRunInvocation(value: unknown): value is WorkflowRunInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2
    && keys[0] === 'reportMode'
    && keys[1] === 'sessionId'
    && typeof record.sessionId === 'string'
    && record.sessionId.trim() !== ''
    && (record.reportMode === 'resume' || record.reportMode === 'silent');
}

function normalizeRun(run: WorkflowRun): WorkflowRun {
  let out = run;
  const schemaVersion = typeof out.schemaVersion === 'number' ? out.schemaVersion : 1;
  if (schemaVersion < WORKFLOW_RUN_SCHEMA_VERSION && (out.status as string) === 'passed') {
    out = { ...out, status: 'dispatched' };
  }
  if (typeof (out.trigger as unknown) === 'string') {
    const kind = (out.trigger as unknown as string) === 'schedule' ? 'schedule' : 'manual';
    out = { ...out, trigger: { kind } };
  }
  if (schemaVersion < WORKFLOW_RUN_SCHEMA_VERSION) {
    const legacyInvocation = (out as unknown as Record<string, unknown>).invocation;
    const { invocation: _legacyInvocation, ...legacy } = out as WorkflowRun & { invocation?: unknown };
    out = {
      ...legacy,
      revision: 0,
      ...(isWorkflowRunParameters(legacyInvocation) ? { parameters: legacyInvocation } : {}),
    } as WorkflowRun;
  } else {
    if (!Number.isSafeInteger(out.revision) || (out.revision ?? 0) < 1) {
      throw new WorkflowRunStoreError('bad-input', `run "${out.runId}" has an invalid v3 revision`);
    }
    if (out.parameters !== undefined && !isWorkflowRunParameters(out.parameters)) {
      throw new WorkflowRunStoreError('bad-input', `run "${out.runId}" has invalid v3 parameters`);
    }
    if (out.invocation !== undefined && !isWorkflowRunInvocation(out.invocation)) {
      throw new WorkflowRunStoreError('bad-input', `run "${out.runId}" has an invalid v3 invocation relation`);
    }
  }
  return out;
}

/** Read one run (legacy-normalized, see normalizeRun), or null if it does not exist. */
export function getRun(root: string, workflowId: string, runId: string): WorkflowRun | null {
  let raw: string;
  try {
    raw = fs.readFileSync(runFile(root, workflowId, runId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return normalizeRun(JSON.parse(raw) as WorkflowRun);
  } catch (e) {
    if (e instanceof WorkflowRunStoreError) throw e;
    throw new WorkflowRunStoreError('bad-input', `run "${runId}" on disk is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Workflow ids that have at least one run dir on disk (GRS-014b — lets the run
 * reconciler sweep every workflow's runs without a definition scan). Tolerant of a
 * missing runs dir; skips unsafe/non-directory entries.
 */
export function listRunWorkflowIds(root: string): string[] {
  const dir = path.join(root, 'reports', 'runs');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    try {
      if (!fs.statSync(path.join(dir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(name);
  }
  return out.sort();
}

/**
 * List run summaries for a workflow, NEWEST FIRST (by startedAt desc, runId tiebreak).
 * Tolerant: a single corrupt run file is skipped, not fatal.
 */
export function listRuns(root: string, workflowId: string): WorkflowRunSummary[] {
  // Validate the id OUTSIDE the try so an invalid/unsafe workflow id surfaces as a store error
  // (→ 400 at the route), instead of being swallowed as "no runs" (Codex GRS-011d-2c Minor 4).
  const dir = runsDir(root, workflowId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // missing dir (never run) → empty, not an error
  }
  const out: WorkflowRunSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -'.json'.length);
    let run: WorkflowRun | null;
    try {
      run = getRun(root, workflowId, runId);
    } catch {
      continue; // skip corrupt file
    }
    if (!run) continue;
    out.push({
      runId: run.runId,
      workflowId: run.workflowId,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      stepCount: Array.isArray(run.steps) ? run.steps.length : 0,
      parked: run.status === 'parked',
      inFlight: hasInFlightSteps(run),
    });
  }
  return out.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
    return a.runId < b.runId ? 1 : -1;
  });
}

/**
 * The run already claiming a schedule fire, or null (GRS-014d). This scan of the
 * workflow's run dir is the FILE-ENFORCED one-run-per-(workflowId, fireIso) dedupe —
 * the run store is the registry, same shape as the cron runner's `hasRunLogEntry`
 * terminal guard. Fail-open by construction: `listRuns` skips a corrupt run file, so
 * a hiccup can double-run a workflow but never permanently skip a fire (the lesser
 * harm, mirroring the cron guard's stated stance).
 */
export function findRunByTriggerFireRef(
  root: string,
  workflowId: string,
  source: string,
  event: string,
  fireRef: string,
): WorkflowRunSummary | null {
  if (!fireRef) return null;
  for (const summary of listRuns(root, workflowId)) {
    const trigger = normalizeWorkflowTrigger(summary.trigger);
    if (trigger.source === source && trigger.event === event && trigger.fireRef === fireRef) return summary;
  }
  return null;
}

export function findRunByFire(root: string, workflowId: string, fireRef: string): WorkflowRunSummary | null {
  if (!fireRef) return null;
  for (const summary of listRuns(root, workflowId)) {
    const trigger = normalizeWorkflowTrigger(summary.trigger);
    if (trigger.fireRef !== fireRef) continue;
    if (trigger.source === 'schedule' && trigger.event === 'schedule.fire') return summary;
    if (trigger.source === 'todo-status-change' && trigger.event === 'todo.status_changed') return summary;
  }
  return null;
}
