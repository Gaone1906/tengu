import type {
  WorkflowDefinition as LinearWorkflowDefinition,
  WorkflowGate,
  WorkflowLoop,
  WorkflowTrigger,
} from './derive.js';
import type { WorkItemStatus } from '../work-items/store.js';
import { validateCronSchedule } from '../cron/validation.js';
import {
  MAX_EDGE_CONDITIONS,
  parseConditionPath,
  validateConditionShape,
  type WorkflowCondition,
} from './condition.js';

/**
 * Editable workflow definition primitive (GRS-011a).
 *
 * This is the DURABLE, EDITABLE definition schema — a first-class node/edge graph
 * that an n8n-style canvas can render AND mutate. It is deliberately SEPARATE from
 * the read-only run-state path in `derive.ts`:
 *
 *   - `derive.ts`  reads the legacy linear `*.workflow.yaml` + frozen receipts and
 *                  computes what HAPPENED (Run view). It is never edited by a user.
 *   - `definition.ts` (this file) is what SHOULD happen next (Edit view). Editing a
 *                  definition must never mutate historical run receipts — the two are
 *                  distinct artifacts on disk (`<id>.definition.json` vs `<id>.workflow.yaml`).
 *
 * Storage contract (see reports/implementation/GRS-011a-schema-design.md):
 *   file-backed JSON, one file per definition, single-file + integer `version`,
 *   history via git. No DB, no run/attempt store. CRUD wiring is GRS-011b; this
 *   slice ships the schema, a pure validator, a migration adapter from the linear
 *   YAML, and a JSON (de)serialize round-trip. Nothing here touches the gateway.
 *
 * The module is pure (no fs, no env, no gateway coupling) so it is trivially
 * testable and reusable by both the CRUD API (011b) and the canvas (011c).
 */

/* ── Schema ─────────────────────────────────────────────────────────────────── */

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;

/** Public workflow names are agent-facing command identifiers, matching skill names. */
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_WORKFLOW_NAME_LENGTH = 128;

/** Upper bound for `concurrency` (GRS-016a): engine sessions are heavyweight —
 * a run keeping more than this in flight is a runaway, not a workflow. */
export const MAX_WORKFLOW_CONCURRENCY = 8;

/* ── Engine-node execution options (GRS-016b) ───────────────────────────────── */

/** Effort levels the effort override accepts (engine-interpreted; the closed set the
 * inspector's picker offers — a typo like "ultra" must fail at authoring time). */
export const STEP_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type StepEffortLevel = (typeof STEP_EFFORT_LEVELS)[number];

/** Failure causes a per-node retry policy may cover. `interrupted` also covers a
 * VANISHED session (registry lost it) — the two are indistinguishable to the run and
 * have always shared the respawn path. `timeout` is deliberately its OWN cause, not
 * folded into `interrupted`: the default policy retries interruptions (v2's
 * respawn-once), and folding timeouts in would make every option-less node silently
 * re-burn its whole wall-clock/token budget after a timeout — against the operator
 * ruling that a timeout STOPS the spend. Retrying a timeout is an explicit opt-in. */
export const STEP_RETRY_CAUSES = ['error', 'no-output', 'interrupted', 'timeout'] as const;
export type StepRetryCause = (typeof STEP_RETRY_CAUSES)[number];

/** Hard ceiling on retry.maxAttempts (design §2.1): attempts are engine sessions —
 * a node needing more than this is a broken step, not a flaky one. */
export const MAX_STEP_RETRY_ATTEMPTS = 5;

/** Wall-clock budget cap: one week, the same bound the wait node uses. */
export const MAX_STEP_TIMEOUT_MINUTES = 10080;

/** Cap on a wait node's pause (GRS-016d, design §2.6): one week. A `waitUntil`
 * deadline is bounded at ACTIVATION against the same cap (an absolute time cannot
 * be bounded at authoring — the clock moves under the definition). */
export const MAX_WAIT_MINUTES = 10080;

/** Output modes. `none` (GRS-016d) is fire-and-forget: the receipt settles `fired`
 * at spawn, the session is never awaited, and the run never blocks on it. */
export const STEP_OUTPUT_MODES = ['handoff', 'full', 'none'] as const;
export type StepOutputMode = (typeof STEP_OUTPUT_MODES)[number];

/** onError modes. `error-edge` (GRS-016d) routes a terminal step failure down the
 * node's error-lane out-edge(s) instead of failing the run — the lane⇔mode pairing
 * is validator-enforced in both directions. */
export const STEP_ON_ERROR_MODES = ['fail-run', 'continue', 'error-edge'] as const;
export type StepOnErrorMode = (typeof STEP_ON_ERROR_MODES)[number];

/** Session modes (GRS-016e, design §2.1). `fresh` (the default when absent) = v2:
 * a new session per node invocation under the deterministic attempt sessionKey.
 * `workflow` = the run owns ONE shared engine session (created lazily by the first
 * workflow-mode node under `workflow-run:<runId>:shared`, id persisted on the run);
 * subsequent workflow-mode nodes post marker-correlated FOLLOW-UP turns into it,
 * strictly serialized. `existing` = the node posts its turn into an operator-picked
 * LIVE gateway session (same marker correlation) — the riskiest brick; the inspector
 * labels it and the target is validated at run start. */
export const STEP_SESSION_MODES = ['fresh', 'workflow', 'existing'] as const;
export type StepSessionMode = (typeof STEP_SESSION_MODES)[number];

export const WORK_ITEM_STATUSES = ['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'escalated', 'cancelled'] as const;
export type WorkflowTodoTransitionStatus = (typeof WORK_ITEM_STATUSES)[number];
const WORK_ITEM_STATUS_SET = new Set<string>(WORK_ITEM_STATUSES);
const WORK_ITEM_SOURCES = ['human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal'] as const;
const WORK_ITEM_SOURCE_SET = new Set<string>(WORK_ITEM_SOURCES);

/** The `options.session` block. `sessionId` is REQUIRED for mode 'existing' and
 * refused on the other modes (a target on a mode that never uses one would be
 * silently-inert configuration). */
export interface StepSessionSpec {
  mode: StepSessionMode;
  sessionId?: string;
}

export interface StepRetryPolicy {
  /** Total attempts (1 = never retry). 1..MAX_STEP_RETRY_ATTEMPTS. */
  maxAttempts: number;
  /** Which failure causes consume attempts. Non-empty, unique, known causes only. */
  on: StepRetryCause[];
}

/**
 * Engine-node execution options (GRS-016b, design §2.1) — the n8n-style per-node
 * options panel. ALL optional and step-only; an absent block executes byte-identically
 * to the v2 engine (the compat cornerstone, pinned by the parallel-compat goldens):
 * no retry declared = respawn-once on interrupted, onError fail-run, output handoff,
 * no timeout, session mode fresh. Every member of the design's §2.1 panel now has
 * its slice shipped (016b options, 016d none/error-edge, 016e session modes);
 * unknown keys stay refused loudly — never silently ignored.
 */
export interface StepNodeOptions {
  /** Model override passed to the spawn (e.g. "opus", "gpt-5.5"). Engine-interpreted;
   * an unknown model fails the spawn honestly (the spawner is the authority). */
  model?: string;
  /** Effort override (STEP_EFFORT_LEVELS). Engine-interpreted. */
  effort?: string;
  /** What flows to successors: declared-handoff extraction (default) or the raw
   * tail-capped final message (`full`). `none` lands with GRS-016d. */
  output?: StepOutputMode;
  /** Retry policy. Absent = v2's respawn-once: { maxAttempts: 2, on: ['interrupted'] }. */
  retry?: StepRetryPolicy;
  /** What a terminal step failure does to the run. Absent = 'fail-run' (v2).
   * 'error-edge' routing lands with GRS-016d and is refused until then. */
  onError?: StepOnErrorMode;
  /** Wall-clock budget PER ATTEMPT, sweep-enforced (15s granularity); on breach the
   * session is STOPPED (tokens stop burning) and retry/optional/onError apply.
   * Absent = unbounded (v2). */
  timeoutMinutes?: number;
  /** SESSION MODE (GRS-016e) — where this node's turn runs. Absent = 'fresh' (v2).
   * Follow-up modes (workflow/existing) refuse output:'none', timeoutMinutes, and
   * model/effort overrides — see validateStepOptions for each argument. */
  session?: StepSessionSpec;
}

/** Node kinds the v1 editor understands. Keep this closed set small (KISS).
 * `switch` (N-way deterministic router) and `fail` (authored stop-and-error) are
 * GRS-016c; `wait` (sweep-clocked pause) is GRS-016d. All three are ACTORLESS —
 * they spawn nothing. */
export const NODE_TYPES = ['trigger', 'step', 'gate', 'switch', 'fail', 'wait'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Switch evaluation modes (GRS-016c, design §2.3). `firstMatch` (the default when
 * absent): conditioned out-edges are evaluated in declaration order and the first
 * passing one wins; an edge with no `when` is the default/fallback (taken only when
 * no conditioned edge passed, regardless of where it is declared). `allMatches`:
 * every passing conditioned edge activates; no-`when` edges activate only if nothing
 * else did. */
export const SWITCH_MODES = ['firstMatch', 'allMatches'] as const;
export type SwitchMode = (typeof SWITCH_MODES)[number];

/** Cap on a fail node's authored message (it becomes a receipt detail + run error). */
export const MAX_FAIL_MESSAGE_CHARS = 500;

/** Who performs a step: a Jinn employee or a raw engine. */
export const ACTOR_KINDS = ['employee', 'engine'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface WorkflowActor {
  kind: ActorKind;
  /** Employee name (e.g. "jimbo", "fable-guide") or engine id (e.g. "codex", "claude"). */
  ref: string;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  /** Canvas coordinates. Editing position must never change semantics. */
  position: NodePosition;
  /** Present on `step` nodes; who runs it. Absent on `trigger`/`gate`. */
  actor?: WorkflowActor;
  /** Free-form role tag carried from the linear model (orchestrate/implement/verify/…). */
  role?: string;
  /** Present on `trigger` nodes: the schedule/manual trigger spec. */
  trigger?: WorkflowTrigger;
  /** Present on `gate` nodes: the single gate this node represents. */
  gate?: WorkflowGate;
  /** Inline gates a `step` node owns (a step can have 0..n receipts, e.g. verify has 2). */
  gates?: WorkflowGate[];
  /** True for a step that may be skipped without failing the run (e.g. adversary when all engines down). */
  optional?: boolean;
  /** Human note (e.g. "once daily"). */
  cadence?: string;
  /**
   * The step's actual TASK TEXT (GRS-014c) — what the spawned session is asked to do.
   * Optional and step-only; without it the run engine falls back to a generic
   * "perform this step's work" prompt. Additive: schemaVersion stays 1.
   */
  instructions?: string;
  /**
   * Engine-node execution options (GRS-016b). Step-only, and only on steps WITH an
   * actor (an inline step spawns nothing, so options there would be silently dropped
   * — refused instead, the misplaced-* precedent). Additive: schemaVersion stays 1.
   */
  options?: StepNodeOptions;
  /** Optional Todo progression to apply through guarded transitions when this step settles. */
  todoTransition?: WorkItemStatus;
  /**
   * Switch evaluation mode (GRS-016c). Switch-only; absent = 'firstMatch'.
   */
  switchMode?: SwitchMode;
  /**
   * The authored stop-and-error message (GRS-016c). REQUIRED on `fail` nodes
   * (refused elsewhere): when an active run reaches the node, its receipt settles
   * `failed` with this detail and the run fails (`authored-fail`) through the
   * honest-drain semantics. On a branch not taken it settles `skipped` like anything
   * else.
   */
  failMessage?: string;
  /**
   * Wait node duration in minutes (GRS-016d, 1..MAX_WAIT_MINUTES). Wait-only;
   * exactly one of `waitMinutes` / `waitUntil` is required on a wait node. The 15s
   * sweep IS the clock: the receipt enters `waiting` with a persisted `readyAt`
   * and settles `checkpoint` on the first sweep at/after the deadline.
   */
  waitMinutes?: number;
  /**
   * Wait node absolute deadline (GRS-016d): a parseable ISO-8601 time. A deadline
   * already in the past settles immediately; a deadline more than MAX_WAIT_MINUTES
   * away at activation fails the run honestly (`wait-too-long`) rather than
   * silently clamping.
   */
  waitUntil?: string;
}

export const EDGE_KINDS = ['handoff', 'sequence', 'loop'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** `handoff` = explicit declared handoff; `sequence` = implicit next-in-chain;
   * `loop` (GRS-014e) = a BACK-edge closing a bounded loop — execution order is
   * computed over non-loop edges, and when the run reaches `from` it repeats the
   * segment from `to` while rounds < def.loop.maxRoundsPerRun and the optional
   * exit `gate` below has not passed. */
  kind?: EdgeKind;
  label?: string;
  /**
   * Loop EXIT gate (GRS-014e, loop edges only): when it passes at the end of a
   * round, the loop exits early. Legacy artifact/flag gates remain supported; a
   * loop may instead use `when` below to read frozen run/handoff evidence.
   */
  gate?: WorkflowGate;
  /**
   * Deterministic conditions (GRS-016c): on a switch out-edge these select a branch;
   * on a loop edge they are the early-exit criterion evaluated at the round boundary.
   * AND within the array, over the frozen run record (condition.ts). A loop edge may
   * declare `gate` OR `when`, never both.
   */
  when?: WorkflowCondition[];
  /**
   * Error-output lane (GRS-016d, design §2.4): `'error'` marks this edge as the
   * failure route of its source node. Legal ONLY on a non-loop edge whose source
   * is a step with `options.onError:'error-edge'` (and such a step must have at
   * least one error-lane out-edge — the pairing is enforced in both directions).
   * At run time the lane activates exactly when the source settles `failed`
   * terminally; the source's normal out-edges then deactivate.
   */
  lane?: 'error';
}

/** Server-owned provenance for persisted canvas coordinates. Incoming metadata is
 * never used to choose write policy; callers pass an explicit layout intent. */
export type WorkflowLayoutSource = 'generated' | 'normalized' | 'manual';

export interface WorkflowLayoutMetadata {
  source: WorkflowLayoutSource;
  version: 1;
}

export interface EditableWorkflowDefinition {
  /** Schema version of THIS document shape (not the workflow's edit version). */
  schemaVersion: number;
  id: string;
  /** Stable, globally unique agent-facing name. Legacy records fall back to `id`. */
  name?: string;
  title: string;
  description?: string;
  /** Monotonic edit version; bumped on each save. */
  version: number;
  status: 'active' | 'paused' | 'retired';
  orchestrator?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Provenance stamped by the server after applying the layout write policy. */
  layout?: WorkflowLayoutMetadata;
  /** Workflow-level gates every run must satisfy (mirrors linear runGates). */
  runGates?: WorkflowGate[];
  /** Bounded-loop metadata (until / maxRoundsPerRun / stopWhen), carried from the linear def. */
  loop?: WorkflowLoop;
  /**
   * Max engine sessions this workflow's runs keep in flight at once (GRS-016a).
   * ABSENT = 1 = the sequential v2 engine, byte-identical — the compat cornerstone.
   * The editor writes an explicit value on new definitions (operator ruling: 4);
   * parallelism on an existing definition is always a deliberate edit.
   */
  concurrency?: number;
  /** Where run evidence lives (carried through from the linear def; not edited on the canvas). */
  evidenceRoot?: string;
  /** ISO string set by the CRUD layer on save (GRS-011b); optional here. */
  updatedAt?: string;
}

/* ── Validation ─────────────────────────────────────────────────────────────── */

export type ValidationCode =
  | 'bad-schema-version'
  | 'missing-id'
  | 'bad-name'
  | 'missing-title'
  | 'bad-version'
  | 'bad-status'
  | 'missing-trigger'
  | 'multiple-triggers'
  | 'nodes-not-array'
  | 'edges-not-array'
  | 'rungates-not-array'
  | 'gates-not-array'
  | 'invalid-node'
  | 'invalid-edge'
  | 'unsupported-edge-field'
  | 'invalid-gate'
  | 'empty-node-id'
  | 'duplicate-node-id'
  | 'missing-node-label'
  | 'missing-node-position'
  | 'unknown-node-type'
  | 'unknown-actor-kind'
  | 'empty-actor-ref'
  | 'trigger-node-missing-spec'
  | 'bad-trigger-kind'
  | 'trigger-schedule-missing-cron'
  | 'trigger-schedule-bad-cron'
  | 'trigger-schedule-bad-timezone'
  | 'trigger-schedule-bad-until'
  | 'trigger-todo-missing-status'
  | 'trigger-todo-bad-status'
  | 'trigger-todo-bad-filter'
  | 'misplaced-todo-transition'
  | 'bad-todo-transition'
  | 'gate-node-missing-gate'
  | 'misplaced-gate-field'
  | 'misplaced-gates-field'
  | 'bad-instructions'
  | 'misplaced-instructions'
  | 'bad-step-options'
  | 'misplaced-options'
  | 'workflow-shared-actor-mismatch'
  | 'bad-gate-kind'
  | 'gate-missing-field'
  | 'bad-switch-mode'
  | 'misplaced-switch-mode'
  | 'fail-node-missing-message'
  | 'bad-fail-message'
  | 'misplaced-fail-message'
  | 'misplaced-actor'
  | 'misplaced-edge-when'
  | 'bad-edge-condition'
  | 'unsupported-switch-loop'
  | 'bad-edge-lane'
  | 'misplaced-edge-lane'
  | 'error-edge-missing-lane'
  | 'none-output-dependency'
  | 'wait-node-missing-duration'
  | 'bad-wait-duration'
  | 'misplaced-wait-field'
  | 'duplicate-rungate-ref'
  | 'empty-edge-id'
  | 'duplicate-edge-id'
  | 'bad-edge-kind'
  | 'misplaced-edge-gate'
  | 'bad-loop-gate-kind'
  | 'bad-concurrency'
  | 'bad-layout'
  | 'unsafe-node-id'
  | 'unsafe-edge-id'
  | 'dangling-edge'
  | 'self-loop'
  | 'unreachable-node';

export interface ValidationError {
  code: ValidationCode;
  message: string;
  /** Node/edge id this error anchors to, when applicable. */
  ref?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const GATE_KINDS = new Set<WorkflowGate['kind']>(['artifact', 'flag', 'approval']);
const TRIGGER_KINDS = new Set<WorkflowTrigger['kind']>(['schedule', 'manual', 'todo-status-change']);
const EDGE_KIND_SET = new Set<EdgeKind>(EDGE_KINDS);
const EDGE_KEYS = new Set<string>(['id', 'from', 'to', 'kind', 'label', 'gate', 'when', 'lane']);
const EFFORT_SET = new Set<string>(STEP_EFFORT_LEVELS);
const RETRY_CAUSE_SET = new Set<string>(STEP_RETRY_CAUSES);
const STEP_OPTION_KEYS = new Set<string>(['model', 'effort', 'output', 'retry', 'onError', 'timeoutMinutes', 'session']);
const SESSION_MODE_SET = new Set<string>(STEP_SESSION_MODES);
const SESSION_SPEC_KEYS = new Set<string>(['mode', 'sessionId']);

type PushError = (code: ValidationCode, message: string, ref?: string) => void;

/**
 * Node/edge id charset (GRS-016c-fix, Codex finding 2). Authored ids key engine
 * data structures and are embedded in deterministic sessionKeys
 * (`workflow-run:<runId>:<nodeId>:<attempt>`), so they must be plain identifiers:
 * no whitespace, no colons (sessionKey delimiter), no slashes, no leading dot.
 * Leading underscore stays legal — `fromLinearDefinition` mints `__trigger`.
 * Prototype-shaped names are additionally denied outright: they can never be
 * authored, so no engine structure ever has to defend against a `__proto__` key
 * arriving from a definition (the plan compiler's null-prototype maps are the
 * belt-and-braces behind this).
 *
 * A TRAILING dot is refused (GRS-016d carryover, 016c round-2 residual): the
 * condition-path grammar rejects a nodeId ending in '.' (`steps.a..status` never
 * parses), so an id like "a." would validate yet be unaddressable by any switch
 * condition. Interior dots stay legal ("a.b"); max length stays 128.
 */
const SAFE_GRAPH_ID = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const RESERVED_GRAPH_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeGraphId(id: string): boolean {
  return !SAFE_GRAPH_ID.test(id) || RESERVED_GRAPH_IDS.has(id);
}

/**
 * True if `v` is NOT a non-empty string. Used everywhere a string field is required so
 * a non-string JSON value (e.g. `title: 123`) is a validation error, never a thrown
 * `.trim()` TypeError that would surface as a 500 instead of a 400.
 */
function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

/**
 * Validate one gate: its kind must be known AND the kind-specific field it needs to
 * be checkable must be present (a flag gate without `flag`, an artifact gate without
 * `glob`, or an approval gate without `approvalRef` is an "impossible gate"). Shared
 * by node gates and workflow-level runGates.
 */
function validateGate(gate: WorkflowGate, ref: string, where: string, err: PushError): void {
  if (!gate || typeof gate !== 'object') {
    err('invalid-gate', `${where} gate must be an object`, ref);
    return;
  }
  if (!GATE_KINDS.has(gate.kind)) {
    err('bad-gate-kind', `${where} gate.kind "${gate.kind}" is invalid`, ref);
    return; // kind-specific checks are meaningless once the kind is unknown
  }
  if (gate.kind === 'flag' && isBlank(gate.flag)) {
    err('gate-missing-field', `${where} flag gate needs a "flag"`, ref);
  }
  if (gate.kind === 'artifact' && isBlank(gate.glob)) {
    err('gate-missing-field', `${where} artifact gate needs a "glob"`, ref);
  }
  if (gate.kind === 'approval' && isBlank(gate.approvalRef)) {
    err('gate-missing-field', `${where} approval gate needs an "approvalRef"`, ref);
  }
  if (isBlank(gate.description)) {
    err('gate-missing-field', `${where} gate needs a description`, ref);
  }
}

/**
 * Validate a step node's `options` block (GRS-016b). STRICT: every field is
 * type/range-checked and unknown keys are refused — a typo'd option must fail at
 * authoring time, never silently degrade to the default behavior.
 *
 * Cross-field rules (GRS-016d):
 *   - `output:'none'` refuses `retry` and `timeoutMinutes` — a fire-and-forget
 *     session is never awaited, so neither could ever fire (silently-inert
 *     configuration is the misplaced-* failure mode).
 *   - `onError:'error-edge'` refuses `optional` on the node — the policy chain
 *     absorbs failures at `optional` BEFORE onError is consulted, so the declared
 *     error lane could never activate (a structurally dead branch).
 *
 * Cross-field rules (GRS-016e) — follow-up session modes (workflow/existing) refuse:
 *   - `output:'none'` — an unawaited follow-up turn would occupy the shared/live
 *     session with no marker settle, breaking the one-outstanding-turn serialization;
 *   - `timeoutMinutes` — the timeout stop kills the WHOLE session, which the
 *     workflow does not own (per-turn stops are a later slice, named in the report);
 *   - `model`/`effort` — the target session's engine/model are already fixed
 *     (existing), or which node creates the shared session is routing-dependent
 *     (workflow), so the override's application would be silent or non-deterministic.
 */
function validateStepOptions(options: unknown, nodeId: string, optional: boolean, err: PushError): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    err('bad-step-options', `node "${nodeId}" options must be an object`, nodeId);
    return;
  }
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!STEP_OPTION_KEYS.has(key)) {
      err('bad-step-options', `node "${nodeId}" options has unknown key "${key}"`, nodeId);
    }
  }
  if (o.model !== undefined && isBlank(o.model)) {
    err('bad-step-options', `node "${nodeId}" options.model must be a non-empty string when present`, nodeId);
  }
  if (o.effort !== undefined && (typeof o.effort !== 'string' || !EFFORT_SET.has(o.effort))) {
    err('bad-step-options', `node "${nodeId}" options.effort must be one of ${STEP_EFFORT_LEVELS.join(' | ')}`, nodeId);
  }
  if (o.output !== undefined && !(STEP_OUTPUT_MODES as readonly string[]).includes(o.output as string)) {
    err('bad-step-options', `node "${nodeId}" options.output must be ${STEP_OUTPUT_MODES.join(' | ')}`, nodeId);
  }
  if (o.output === 'none') {
    if (o.retry !== undefined) {
      err('bad-step-options', `node "${nodeId}" options.retry cannot combine with output "none" — a fire-and-forget session is never awaited, so no retry cause can ever fire`, nodeId);
    }
    if (o.timeoutMinutes !== undefined) {
      err('bad-step-options', `node "${nodeId}" options.timeoutMinutes cannot combine with output "none" — a fire-and-forget session is never probed`, nodeId);
    }
  }
  if (o.onError !== undefined && !(STEP_ON_ERROR_MODES as readonly string[]).includes(o.onError as string)) {
    err('bad-step-options', `node "${nodeId}" options.onError must be ${STEP_ON_ERROR_MODES.join(' | ')}`, nodeId);
  }
  if (o.onError === 'error-edge' && optional) {
    err('bad-step-options', `node "${nodeId}" cannot be optional AND onError "error-edge" — optional absorbs failures before onError is consulted, so the error lane could never activate`, nodeId);
  }
  if (o.retry !== undefined) {
    const r = o.retry as StepRetryPolicy;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      err('bad-step-options', `node "${nodeId}" options.retry must be an object { maxAttempts, on }`, nodeId);
    } else {
      if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > MAX_STEP_RETRY_ATTEMPTS) {
        err('bad-step-options', `node "${nodeId}" options.retry.maxAttempts must be an integer between 1 and ${MAX_STEP_RETRY_ATTEMPTS}`, nodeId);
      }
      if (!Array.isArray(r.on) || r.on.length === 0) {
        err('bad-step-options', `node "${nodeId}" options.retry.on must be a non-empty array of causes`, nodeId);
      } else {
        const seen = new Set<string>();
        for (const cause of r.on) {
          if (typeof cause !== 'string' || !RETRY_CAUSE_SET.has(cause)) {
            err('bad-step-options', `node "${nodeId}" options.retry.on has unknown cause "${cause}" (valid: ${STEP_RETRY_CAUSES.join(' | ')})`, nodeId);
          } else if (seen.has(cause)) {
            err('bad-step-options', `node "${nodeId}" options.retry.on repeats cause "${cause}"`, nodeId);
          }
          if (typeof cause === 'string') seen.add(cause);
        }
      }
    }
  }
  if (o.timeoutMinutes !== undefined) {
    if (!Number.isInteger(o.timeoutMinutes) || (o.timeoutMinutes as number) < 1 || (o.timeoutMinutes as number) > MAX_STEP_TIMEOUT_MINUTES) {
      err('bad-step-options', `node "${nodeId}" options.timeoutMinutes must be an integer between 1 and ${MAX_STEP_TIMEOUT_MINUTES}`, nodeId);
    }
  }
  // SESSION MODES (GRS-016e). Shape first, then the follow-up-mode cross-field
  // refusals — each names WHY the combination can never be honored, so the author
  // learns the rule instead of hitting silently-inert config at run time.
  if (o.session !== undefined) {
    const s = o.session as StepSessionSpec;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      err('bad-step-options', `node "${nodeId}" options.session must be an object { mode, sessionId? }`, nodeId);
      return;
    }
    for (const key of Object.keys(s)) {
      if (!SESSION_SPEC_KEYS.has(key)) {
        err('bad-step-options', `node "${nodeId}" options.session has unknown key "${key}"`, nodeId);
      }
    }
    if (typeof s.mode !== 'string' || !SESSION_MODE_SET.has(s.mode)) {
      err('bad-step-options', `node "${nodeId}" options.session.mode must be one of ${STEP_SESSION_MODES.join(' | ')}`, nodeId);
      return; // the mode-conditional rules below are meaningless without a mode
    }
    if (s.mode === 'existing') {
      if (typeof s.sessionId !== 'string' || s.sessionId.trim() === '' || s.sessionId.length > 128) {
        err('bad-step-options', `node "${nodeId}" options.session mode "existing" requires a non-empty sessionId (max 128 chars) — the live gateway session this step posts into`, nodeId);
      }
    } else if (s.sessionId !== undefined) {
      err('bad-step-options', `node "${nodeId}" options.session.sessionId is only valid with mode "existing" — mode "${s.mode}" never uses a target id`, nodeId);
    }
    if (s.mode === 'workflow' || s.mode === 'existing') {
      // The follow-up turn runs inside a session the workflow does NOT exclusively
      // own. Every refusal below is the silently-inert / unsafe-config failure mode:
      if (o.output === 'none') {
        err('bad-step-options', `node "${nodeId}" options.output "none" cannot combine with session mode "${s.mode}" — an unawaited follow-up turn would occupy the session outside the one-outstanding-marker serialization`, nodeId);
      }
      if (o.timeoutMinutes !== undefined) {
        err('bad-step-options', `node "${nodeId}" options.timeoutMinutes cannot combine with session mode "${s.mode}" — the timeout stop kills the WHOLE session, which this workflow does not own`, nodeId);
      }
      if (o.model !== undefined || o.effort !== undefined) {
        err('bad-step-options', `node "${nodeId}" options.model/effort cannot combine with session mode "${s.mode}" — the target session's engine and model are already fixed, so the override would be silently ignored`, nodeId);
      }
    }
  }
}

/**
 * Validate an editable definition. Pure; returns ALL errors (not fail-fast) so the
 * canvas can surface every problem at once. `ok` is true iff `errors` is empty.
 */
export function validateDefinition(def: EditableWorkflowDefinition): ValidationResult {
  const errors: ValidationError[] = [];
  const err: PushError = (code, message, ref) => errors.push({ code, message, ref });

  if (def.schemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION) {
    err('bad-schema-version', `schemaVersion must be ${WORKFLOW_DEFINITION_SCHEMA_VERSION}`);
  }
  if (isBlank(def.id)) err('missing-id', 'definition id is required');
  if (
    def.name !== undefined &&
    (isBlank(def.name) ||
      def.name.length > MAX_WORKFLOW_NAME_LENGTH ||
      !WORKFLOW_NAME_PATTERN.test(def.name))
  ) {
    err(
      'bad-name',
      `name must be kebab-case, match ${WORKFLOW_NAME_PATTERN.source}, and be at most ${MAX_WORKFLOW_NAME_LENGTH} characters`,
    );
  }
  if (isBlank(def.title)) err('missing-title', 'definition title is required');
  if (!Number.isInteger(def.version) || def.version < 1) {
    err('bad-version', 'version must be a positive integer');
  }
  if (def.status !== 'active' && def.status !== 'paused' && def.status !== 'retired') {
    err('bad-status', 'status must be active | paused | retired');
  }
  // `concurrency` (GRS-016a) is optional; when present it must be an integer in
  // [1, MAX_WORKFLOW_CONCURRENCY]. Absence means 1 (sequential v2) — a bad value must
  // never silently degrade to either extreme.
  if (def.concurrency !== undefined) {
    if (!Number.isInteger(def.concurrency) || def.concurrency < 1 || def.concurrency > MAX_WORKFLOW_CONCURRENCY) {
      err('bad-concurrency', `concurrency must be an integer between 1 and ${MAX_WORKFLOW_CONCURRENCY} when present`);
    }
  }

  // `nodes` and `edges` are REQUIRED arrays (schema). Non-arrays are a structural
  // error, not a silent empty — otherwise a body with no `edges` key would persist.
  if (!Array.isArray(def.nodes)) err('nodes-not-array', 'nodes must be an array');
  if (!Array.isArray(def.edges)) err('edges-not-array', 'edges must be an array');
  const nodes = Array.isArray(def.nodes) ? def.nodes : [];
  const edges = Array.isArray(def.edges) ? def.edges : [];

  // Nodes
  const nodeIds = new Set<string>();
  let triggerCount = 0;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') {
      err('invalid-node', 'node must be an object');
      continue; // never dereference a non-object entry (guards nodes:[null])
    }
    if (isBlank(n.id)) {
      err('empty-node-id', 'node id must be a non-empty string');
      continue; // can't key anything else off a blank id
    }
    if (isUnsafeGraphId(n.id)) {
      err('unsafe-node-id', `node id "${n.id}" must match ${SAFE_GRAPH_ID.source} and not be a reserved name (__proto__/constructor/prototype)`, n.id);
    }
    if (nodeIds.has(n.id)) err('duplicate-node-id', `duplicate node id "${n.id}"`, n.id);
    nodeIds.add(n.id);

    if (!(NODE_TYPES as readonly string[]).includes(n.type)) {
      err('unknown-node-type', `node "${n.id}" has unknown type "${n.type}"`, n.id);
    }
    if (isBlank(n.label)) {
      err('missing-node-label', `node "${n.id}" needs a label`, n.id);
    }
    if (
      !n.position ||
      typeof n.position !== 'object' ||
      !Number.isFinite(n.position.x) ||
      !Number.isFinite(n.position.y)
    ) {
      err('missing-node-position', `node "${n.id}" needs a numeric position {x,y}`, n.id);
    }
    if (n.type === 'trigger') {
      triggerCount++;
      if (!n.trigger || !n.trigger.kind) {
        err('trigger-node-missing-spec', `trigger node "${n.id}" needs a trigger spec`, n.id);
      } else {
        if (!TRIGGER_KINDS.has(n.trigger.kind)) {
          err('bad-trigger-kind', `trigger node "${n.id}" kind "${n.trigger.kind}" is invalid`, n.id);
        } else if (n.trigger.kind === 'schedule') {
          if (n.trigger.cron === undefined || (typeof n.trigger.cron === 'string' && n.trigger.cron.trim() === '')) {
            err('trigger-schedule-missing-cron', `schedule trigger "${n.id}" needs a cron`, n.id);
          } else {
            for (const scheduleError of validateCronSchedule({
              schedule: n.trigger.cron,
              // Optional schedule fields are validated exactly as supplied.
              // Omitting a malformed non-string value here would allow it to
              // persist and fail later during scheduler reload.
              ...(n.trigger.timezone !== undefined ? { timezone: n.trigger.timezone } : {}),
              ...(n.trigger.until !== undefined ? { until: n.trigger.until } : {}),
            })) {
              const code = scheduleError.field === 'schedule'
                ? 'trigger-schedule-bad-cron'
                : scheduleError.field === 'timezone'
                  ? 'trigger-schedule-bad-timezone'
                  : 'trigger-schedule-bad-until';
              err(code, `schedule trigger "${n.id}" ${scheduleError.message}`, n.id);
            }
          }
        } else if (n.trigger.kind === 'todo-status-change') {
          const target = n.trigger.toStatus ?? n.trigger.status;
          if (isBlank(target)) {
            err('trigger-todo-missing-status', `todo-status-change trigger "${n.id}" needs "toStatus"`, n.id);
          } else if (!WORK_ITEM_STATUS_SET.has(target as string)) {
            err('trigger-todo-bad-status', `todo-status-change trigger "${n.id}" has invalid toStatus "${target}"`, n.id);
          }
          if (n.trigger.fromStatus !== undefined && !WORK_ITEM_STATUS_SET.has(n.trigger.fromStatus)) {
            err('trigger-todo-bad-status', `todo-status-change trigger "${n.id}" has invalid fromStatus "${n.trigger.fromStatus}"`, n.id);
          }
          if (n.trigger.filter !== undefined) {
            const f = n.trigger.filter;
            if (!f || typeof f !== 'object' || Array.isArray(f)) {
              err('trigger-todo-bad-filter', `todo-status-change trigger "${n.id}" filter must be an object`, n.id);
            } else {
              const allowedFilterKeys = new Set(['source', 'department', 'assignee']);
              const badKey = Reflect.ownKeys(f).find((key) => typeof key !== 'string' || !allowedFilterKeys.has(key));
              if (badKey !== undefined) {
                err('trigger-todo-bad-filter', `todo-status-change trigger "${n.id}" filter has unsupported key "${String(badKey)}"`, n.id);
              }
              const source = (f as { source?: unknown }).source;
              const department = (f as { department?: unknown }).department;
              const assignee = (f as { assignee?: unknown }).assignee;
              if (source !== undefined && (typeof source !== 'string' || !WORK_ITEM_SOURCE_SET.has(source))) {
                err('trigger-todo-bad-filter', `todo-status-change trigger "${n.id}" filter.source is invalid`, n.id);
              }
              if (department !== undefined && (typeof department !== 'string' || department.trim() === '')) {
                err('trigger-todo-bad-filter', `todo-status-change trigger "${n.id}" filter.department must be a non-empty string`, n.id);
              }
              if (assignee !== undefined && (typeof assignee !== 'string' || assignee.trim() === '')) {
                err('trigger-todo-bad-filter', `todo-status-change trigger "${n.id}" filter.assignee must be a non-empty string`, n.id);
              }
            }
          }
        }
      }
    }
    if (n.type === 'gate' && !n.gate) {
      err('gate-node-missing-gate', `gate node "${n.id}" needs a gate spec`, n.id);
    }
    // Gate FIELDS must live where their node type expects them, so a downstream consumer
    // (e.g. the execution-plan compiler) can rely on step⇒`gates`, gate-node⇒`gate` and never
    // silently drop a gate placed on the wrong field. The singular `gate` is only for gate
    // nodes; the `gates[]` array is only for step nodes. (Codex GRS-011d-1 round-2 Major.)
    if (n.gate && n.type !== 'gate') {
      err('misplaced-gate-field', `node "${n.id}" of type "${n.type}" must not carry a singular "gate" (only gate nodes do; steps use "gates")`, n.id);
    }
    if (n.gates !== undefined && n.type !== 'step') {
      err('misplaced-gates-field', `node "${n.id}" of type "${n.type}" must not carry "gates" (only step nodes do; a gate node uses "gate")`, n.id);
    }
    // `instructions` (GRS-014c) is step-only task text; when present it must be a
    // non-empty string (a non-string would silently degrade to the generic prompt).
    if (n.instructions !== undefined) {
      if (n.type !== 'step') {
        err('misplaced-instructions', `node "${n.id}" of type "${n.type}" must not carry "instructions" (step-only)`, n.id);
      } else if (isBlank(n.instructions)) {
        err('bad-instructions', `node "${n.id}" instructions must be a non-empty string when present`, n.id);
      }
    }
    // `options` (GRS-016b) is execution configuration for a SPAWNED step: step-only,
    // and only on steps with an actor — an inline (actorless) step spawns nothing, so
    // options there would be silently dropped; refused instead (misplaced-* precedent).
    if (n.options !== undefined) {
      if (n.type !== 'step') {
        err('misplaced-options', `node "${n.id}" of type "${n.type}" must not carry "options" (step-only)`, n.id);
      } else if (!n.actor) {
        err('misplaced-options', `node "${n.id}" has "options" but no actor — an inline step spawns nothing, so execution options cannot apply`, n.id);
      } else {
        validateStepOptions(n.options, n.id, n.optional === true, err);
      }
    }
    if (n.todoTransition !== undefined) {
      if (n.type !== 'step') {
        err('misplaced-todo-transition', `node "${n.id}" of type "${n.type}" must not carry "todoTransition" (step-only)`, n.id);
      } else if (!WORK_ITEM_STATUS_SET.has(n.todoTransition)) {
        err('bad-todo-transition', `node "${n.id}" todoTransition "${n.todoTransition}" is invalid`, n.id);
      }
    }
    // GRS-016c: `switchMode` is switch-only; `failMessage` is fail-only + required
    // there; switch/fail nodes are ACTORLESS by construction (they spawn nothing —
    // an actor on one would be silently inert, the misplaced-* failure mode).
    if (n.switchMode !== undefined) {
      if (n.type !== 'switch') {
        err('misplaced-switch-mode', `node "${n.id}" of type "${n.type}" must not carry "switchMode" (switch-only)`, n.id);
      } else if (!(SWITCH_MODES as readonly string[]).includes(n.switchMode)) {
        err('bad-switch-mode', `node "${n.id}" switchMode must be ${SWITCH_MODES.join(' | ')}`, n.id);
      }
    }
    if (n.type === 'fail') {
      if (isBlank(n.failMessage)) {
        err('fail-node-missing-message', `fail node "${n.id}" needs a non-empty "failMessage"`, n.id);
      } else if ((n.failMessage as string).length > MAX_FAIL_MESSAGE_CHARS) {
        err('bad-fail-message', `fail node "${n.id}" failMessage exceeds ${MAX_FAIL_MESSAGE_CHARS} chars`, n.id);
      }
    } else if (n.failMessage !== undefined) {
      err('misplaced-fail-message', `node "${n.id}" of type "${n.type}" must not carry "failMessage" (fail-only)`, n.id);
    }
    // Wait node (GRS-016d): exactly ONE of waitMinutes / waitUntil, bounds-checked.
    // The fields are wait-only — anywhere else they would be silently inert.
    if (n.type === 'wait') {
      const hasMinutes = n.waitMinutes !== undefined;
      const hasUntil = n.waitUntil !== undefined;
      if (!hasMinutes && !hasUntil) {
        err('wait-node-missing-duration', `wait node "${n.id}" needs "waitMinutes" or "waitUntil"`, n.id);
      } else if (hasMinutes && hasUntil) {
        err('bad-wait-duration', `wait node "${n.id}" must declare either "waitMinutes" or "waitUntil", not both`, n.id);
      }
      if (hasMinutes && (!Number.isInteger(n.waitMinutes) || (n.waitMinutes as number) < 1 || (n.waitMinutes as number) > MAX_WAIT_MINUTES)) {
        err('bad-wait-duration', `wait node "${n.id}" waitMinutes must be an integer between 1 and ${MAX_WAIT_MINUTES}`, n.id);
      }
      if (hasUntil && (isBlank(n.waitUntil) || (n.waitUntil as string).length > 64 || !Number.isFinite(Date.parse(n.waitUntil as string)))) {
        err('bad-wait-duration', `wait node "${n.id}" waitUntil must be a parseable ISO-8601 time`, n.id);
      }
    } else if (n.waitMinutes !== undefined || n.waitUntil !== undefined) {
      err('misplaced-wait-field', `node "${n.id}" of type "${n.type}" must not carry "waitMinutes"/"waitUntil" (wait-only)`, n.id);
    }
    if (n.actor && (n.type === 'switch' || n.type === 'fail' || n.type === 'wait')) {
      err('misplaced-actor', `node "${n.id}" of type "${n.type}" must not carry an actor (switch/fail/wait nodes spawn nothing)`, n.id);
    }
    // Validate the single gate (gate nodes) and any inline gates (step nodes).
    if (n.gate) validateGate(n.gate, n.id, `node "${n.id}"`, err);
    if (n.gates !== undefined && !Array.isArray(n.gates)) {
      err('gates-not-array', `node "${n.id}" gates must be an array when present`, n.id);
    }
    for (const g of Array.isArray(n.gates) ? n.gates : []) validateGate(g, n.id, `node "${n.id}"`, err);
    if (n.actor) {
      if (!(ACTOR_KINDS as readonly string[]).includes(n.actor.kind)) {
        err('unknown-actor-kind', `node "${n.id}" actor.kind "${n.actor.kind}" is invalid`, n.id);
      }
      if (isBlank(n.actor.ref)) {
        err('empty-actor-ref', `node "${n.id}" actor.ref is required`, n.id);
      }
    }
  }
  if (triggerCount === 0) err('missing-trigger', 'workflow needs exactly one trigger node');
  if (triggerCount > 1) err('multiple-triggers', 'workflow must have exactly one trigger node');

  // Edges
  const nodeById = new Map(nodes.filter((n) => n && typeof n === 'object' && n.id).map((n) => [n.id, n]));
  // Fire-and-forget nodes (GRS-016d): their output is never captured, so nothing
  // downstream may DECLARE a dependency on it — a `kind:'handoff'` edge or a
  // condition on `steps.<id>.outcome.*` would silently never deliver/never match.
  // `steps.<id>.status` stays addressable (the `fired` terminal IS captured).
  const noneOutputIds = new Set(
    nodes
      .filter((n) => n && typeof n === 'object' && n.type === 'step' && n.options?.output === 'none')
      .map((n) => n.id),
  );
  const edgeIds = new Set<string>();
  const adjacency = new Map<string, string[]>(); // from → [to] over VALID (both-endpoints-real) edges
  for (const e of edges) {
    if (!e || typeof e !== 'object') {
      err('invalid-edge', 'edge must be an object');
      continue; // never dereference a non-object entry (guards edges:[null])
    }
    for (const key of Object.keys(e)) {
      if (!EDGE_KEYS.has(key)) {
        err(
          'unsupported-edge-field',
          `edge "${e.id}" has unsupported field "${key}"; use options.onError:'error-edge' on the source and lane:'error' on its failure edge`,
          e.id,
        );
      }
    }
    if (isBlank(e.id)) {
      err('empty-edge-id', 'edge id must be a non-empty string');
    } else {
      if (isUnsafeGraphId(e.id)) {
        err('unsafe-edge-id', `edge id "${e.id}" must match ${SAFE_GRAPH_ID.source} and not be a reserved name (__proto__/constructor/prototype)`, e.id);
      }
      if (edgeIds.has(e.id)) err('duplicate-edge-id', `duplicate edge id "${e.id}"`, e.id);
      edgeIds.add(e.id);
    }
    if (e.kind !== undefined && !EDGE_KIND_SET.has(e.kind)) {
      err('bad-edge-kind', `edge "${e.id}" kind "${e.kind}" is invalid`, e.id);
    }
    if (e.gate !== undefined) {
      // An exit gate only means something on a loop edge (GRS-014e).
      if (e.kind !== 'loop') {
        err('misplaced-edge-gate', `edge "${e.id}" has a gate but is not a loop edge`, e.id);
      } else {
        validateGate(e.gate, e.id, `loop edge "${e.id}"`, err);
        if (e.gate && typeof e.gate === 'object' && e.gate.kind === 'approval') {
          // Loop continuation is DETERMINISTIC — it never waits on a human mid-loop.
          err('bad-loop-gate-kind', `loop edge "${e.id}" exit gate must be artifact or flag, not approval`, e.id);
        }
      }
    }
    // Deterministic conditions (GRS-016c): `when` belongs on either a switch
    // out-edge (branch selection) or a loop edge (round-boundary early exit).
    // Each condition is shape-checked strictly (grammar,
    // op, value kinds — condition.ts), and a stepPath must reference a node that
    // exists: a typo'd node id would evaluate to `absent` forever, which is a
    // dead branch the author meant to be live. Never silently ignored.
    if (e.when !== undefined) {
      const source = nodeById.get(e.from);
      if (e.kind === 'loop' && e.gate !== undefined) {
        err('bad-edge-condition', `loop edge "${e.id}" cannot declare both gate and when; choose one exit criterion`, e.id);
      } else if (e.kind !== 'loop' && source && source.type !== 'switch') {
        err('misplaced-edge-when', `edge "${e.id}" has "when" but its source "${e.from}" is a ${source.type} node — conditions live only on switch out-edges`, e.id);
      }
      if (!Array.isArray(e.when) || e.when.length === 0) {
        err('bad-edge-condition', `edge "${e.id}" when must be a non-empty array of conditions`, e.id);
      } else if (e.when.length > MAX_EDGE_CONDITIONS) {
        err('bad-edge-condition', `edge "${e.id}" when has ${e.when.length} conditions (max ${MAX_EDGE_CONDITIONS})`, e.id);
      } else {
        e.when.forEach((cond, i) => {
          const reasons = validateConditionShape(cond);
          for (const reason of reasons) {
            err('bad-edge-condition', `edge "${e.id}" when[${i}]: ${reason}`, e.id);
          }
          // Node-existence check only on a shape-VALID condition: shape validity
          // guarantees a plain data object (GRS-016c-fix), so this read is safe —
          // a hostile accessor never gets a second chance to fire here.
          if (reasons.length === 0) {
            const parsed = parseConditionPath((cond as WorkflowCondition).path);
            if (parsed && parsed.root === 'steps' && !nodeById.has(parsed.nodeId)) {
              err('bad-edge-condition', `edge "${e.id}" when[${i}]: path references unknown node "${parsed.nodeId}"`, e.id);
            }
            // A condition on a none-output node's OUTCOME can never match (the
            // output is never captured) — a dead branch the author meant live.
            if (parsed && parsed.root === 'steps' && parsed.field.startsWith('outcome') && noneOutputIds.has(parsed.nodeId)) {
              err('none-output-dependency', `edge "${e.id}" when[${i}]: path reads outcome of node "${parsed.nodeId}", whose output is "none" (never captured) — route on its status instead`, e.id);
            }
          }
        });
      }
    }
    // Error-output lane (GRS-016d): `lane:'error'` belongs ONLY on a non-loop edge
    // whose source is a step with onError:'error-edge' — anywhere else the lane
    // would be silently inert (misplaced-* precedent). Value is a closed set.
    if (e.lane !== undefined) {
      if (e.lane !== 'error') {
        err('bad-edge-lane', `edge "${e.id}" lane "${e.lane}" is invalid (only "error")`, e.id);
      } else if (e.kind === 'loop') {
        err('misplaced-edge-lane', `edge "${e.id}" is a loop edge and cannot be an error lane (the loop machinery owns cross-round decisions)`, e.id);
      } else {
        const source = nodeById.get(e.from);
        if (source && !(source.type === 'step' && source.options?.onError === 'error-edge')) {
          err('misplaced-edge-lane', `edge "${e.id}" has lane "error" but its source "${e.from}" does not declare onError "error-edge" — the lane would never activate`, e.id);
        }
      }
    }
    // A declared handoff FROM a fire-and-forget node can never deliver (GRS-016d).
    if (e.kind === 'handoff' && noneOutputIds.has(e.from)) {
      err('none-output-dependency', `edge "${e.id}" declares a handoff from node "${e.from}", whose output is "none" (never captured) — use a sequence edge for ordering only`, e.id);
    }
    // A loop edge from a switch would mix two decision owners on one node (the
    // route and the round splice); refused until a consumer argues the semantics.
    if (e.kind === 'loop' && nodeById.get(e.from)?.type === 'switch') {
      err('unsupported-switch-loop', `loop edge "${e.id}" originates at switch node "${e.from}"; a switch cannot be a loop boundary`, e.id);
    }
    const fromOk = nodeIds.has(e.from);
    const toOk = nodeIds.has(e.to);
    if (!fromOk || !toOk) {
      err(
        'dangling-edge',
        `edge "${e.id}" references missing node(s) ${!fromOk ? `from="${e.from}" ` : ''}${!toOk ? `to="${e.to}"` : ''}`.trim(),
        e.id,
      );
    }
    if (e.from && e.from === e.to) {
      err('self-loop', `edge "${e.id}" is a self-loop on "${e.from}"`, e.id);
    }
    if (fromOk && toOk) {
      const list = adjacency.get(e.from) ?? [];
      list.push(e.to);
      adjacency.set(e.from, list);
    }
  }

  // The pairing's other direction (GRS-016d): a step that declares
  // onError:'error-edge' MUST have at least one error-lane out-edge — a failure
  // routed "down the error lane" with no lane to take would silently become a
  // dead-end skip of every successor.
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || n.type !== 'step' || n.options?.onError !== 'error-edge') continue;
    const hasLane = edges.some(
      (ed) => ed && typeof ed === 'object' && ed.from === n.id && ed.kind !== 'loop' && ed.lane === 'error',
    );
    if (!hasLane) {
      err('error-edge-missing-lane', `node "${n.id}" declares onError "error-edge" but has no out-edge with lane "error"`, n.id);
    }
  }

  // ONE actor per shared session (GRS-016e): every session mode 'workflow' step in
  // a definition must declare the SAME actor. The shared session is created by
  // whichever workflow-mode node dispatches FIRST (routing-dependent), and every
  // later workflow-mode node merely posts a follow-up into it — a differing actor
  // on those nodes would be silently ignored, the misplaced-* failure mode.
  let sharedActorOwner: { nodeId: string; kind: string; ref: string } | null = null;
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || n.type !== 'step' || n.options?.session?.mode !== 'workflow') continue;
    const a = n.actor;
    if (!a || typeof a !== 'object') continue; // actorless is already misplaced-options
    if (!sharedActorOwner) {
      sharedActorOwner = { nodeId: n.id, kind: a.kind, ref: a.ref };
    } else if (a.kind !== sharedActorOwner.kind || a.ref !== sharedActorOwner.ref) {
      err(
        'workflow-shared-actor-mismatch',
        `node "${n.id}" (${a.kind} "${a.ref}") and node "${sharedActorOwner.nodeId}" (${sharedActorOwner.kind} "${sharedActorOwner.ref}") both use session mode "workflow" but declare different actors — the run's ONE shared session can only run one actor`,
        n.id,
      );
    }
  }

  // Reachability: BFS from the sole trigger over valid edges. Every non-trigger node
  // must be VISITED — a mere incoming edge is not enough (a disconnected island whose
  // nodes point at each other has incoming edges yet is never reached from the trigger).
  // Reachable cycles are allowed (a bounded loop is a legal workflow shape).
  const triggerNode = nodes.find((n) => n && n.id && n.type === 'trigger');
  if (triggerNode) {
    const visited = new Set<string>([triggerNode.id]);
    const queue = [triggerNode.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    for (const n of nodes) {
      if (!n || !n.id || n.type === 'trigger') continue;
      if (!visited.has(n.id)) {
        err('unreachable-node', `node "${n.id}" is not reachable from the trigger`, n.id);
      }
    }
  }

  // Workflow-level gates. `runGates` is optional but, if present, must be an array
  // (a non-array must not throw inside forEach — it's a validation error → 400).
  if (def.runGates !== undefined && !Array.isArray(def.runGates)) {
    err('rungates-not-array', 'runGates must be an array when present');
  }
  (Array.isArray(def.runGates) ? def.runGates : []).forEach((g, i) =>
    validateGate(g, `runGates[${i}]`, 'runGate', err),
  );

  // An approval runGate's approvalRef IS its resolve identity (GRS-014e: `runGateKey`
  // → `resolvedRunGates`): two run gates sharing one ref would collapse into a single
  // approval — one operator decision silently satisfying both (Codex GRS-014e
  // finding 2). Refuse the ambiguity at authoring time; runtime disambiguation (index
  // identity) would keep a definition whose two parks the OPERATOR cannot tell apart
  // either. Non-approval gates never park/resolve, so their refs may repeat.
  const approvalRefAt = new Map<string, number>();
  (Array.isArray(def.runGates) ? def.runGates : []).forEach((g, i) => {
    if (!g || typeof g !== 'object' || g.kind !== 'approval' || isBlank(g.approvalRef)) return;
    const ref = g.approvalRef as string;
    const first = approvalRefAt.get(ref);
    if (first !== undefined) {
      err(
        'duplicate-rungate-ref',
        `runGates[${i}] approval gate reuses approvalRef "${ref}" (already used by runGates[${first}]); each approval run gate needs its own ref`,
        ref,
      );
    } else {
      approvalRefAt.set(ref, i);
    }
  });

  return { ok: errors.length === 0, errors };
}

/* ── (De)serialization ──────────────────────────────────────────────────────── */

/** Serialize to stable, pretty JSON (the on-disk `<id>.definition.json` form). */
export function serializeDefinition(def: EditableWorkflowDefinition): string {
  return JSON.stringify(def, null, 2) + '\n';
}

/**
 * Parse an on-disk definition. Throws on malformed JSON or a schema-invalid graph
 * so a corrupt definition can never silently drive the editor/execution.
 */
export function parseDefinition(json: string): EditableWorkflowDefinition {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(`workflow definition is not valid JSON: ${(e as Error).message}`);
  }
  const def = obj as EditableWorkflowDefinition;
  const result = validateDefinition(def);
  if (!result.ok) {
    const summary = result.errors.map((e) => e.code).join(', ');
    throw new Error(`workflow definition failed validation: ${summary}`);
  }
  return def;
}

/* ── Migration: linear YAML definition → editable node/edge graph ───────────── */

const CHAIN_X = 240;
const CHAIN_DY = 140;

/**
 * Convert a legacy linear `*.workflow.yaml` definition (steps[] + handoffTo[]) into
 * the editable node/edge graph. This proves the schema can express the sample
 * Sprint AND is the migration path for GRS-011b's CRUD import.
 *
 * Rules:
 *   - one `trigger` node from `linear.trigger`, positioned at the top of the chain;
 *   - one `step` node per linear step (actor = employee || engine), laid out as a
 *     vertical chain so it renders as a graph immediately;
 *   - inline step gates become a `gate` field on the step node (the canvas renders
 *     them on the node; a later slice may split them into standalone gate nodes);
 *   - edges: trigger → first step; then each step's `handoffTo` targets become
 *     `handoff` edges; every step also gets a `sequence` edge to the next step in
 *     declaration order UNLESS an identical handoff edge already exists (so the
 *     implicit chain is explicit and connected, with no duplicate handoff/sequence pair).
 *
 * The result is guaranteed to pass `validateDefinition` for a well-formed linear def.
 */
export function fromLinearDefinition(
  linear: LinearWorkflowDefinition,
): EditableWorkflowDefinition {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const steps = Array.isArray(linear.steps) ? linear.steps : [];

  // Collision-safe trigger id: never reuse a real step id.
  const stepIds = new Set(steps.map((s) => s.id));
  let triggerId = '__trigger';
  while (stepIds.has(triggerId)) triggerId = `_${triggerId}`;

  nodes.push({
    id: triggerId,
    type: 'trigger',
    label: triggerLabel(linear.trigger),
    position: { x: CHAIN_X, y: 0 },
    trigger: linear.trigger,
  });

  steps.forEach((s, i) => {
    const actor: WorkflowActor | undefined = s.employee
      ? { kind: 'employee', ref: s.employee }
      : s.engine
        ? { kind: 'engine', ref: s.engine }
        : undefined;
    nodes.push({
      id: s.id,
      type: 'step',
      label: s.title,
      position: { x: CHAIN_X, y: (i + 1) * CHAIN_DY },
      ...(actor ? { actor } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.optional ? { optional: true } : {}),
      ...(s.cadence ? { cadence: s.cadence } : {}),
      // Carry ALL inline gates so migration is loss-free (e.g. verify has 2, log has 2).
      ...(s.gates && s.gates.length > 0 ? { gates: s.gates } : {}),
    });
  });

  // Unique-id edge emitter: derives a readable id from the pair, disambiguating any
  // collision (delimiter-containing node ids, or an already-taken generated id).
  const usedEdgeIds = new Set<string>();
  const pushEdge = (from: string, to: string, kind: EdgeKind) => {
    let id = `e_${from}__${to}`;
    let n = 2;
    while (usedEdgeIds.has(id)) id = `e_${from}__${to}__${n++}`;
    usedEdgeIds.add(id);
    edges.push({ id, from, to, kind });
  };

  // trigger → first step
  if (steps.length > 0) pushEdge(triggerId, steps[0].id, 'sequence');

  const handoffPairs = new Set<string>();
  steps.forEach((s) => {
    for (const target of s.handoffTo ?? []) {
      pushEdge(s.id, target, 'handoff');
      handoffPairs.add(JSON.stringify([s.id, target]));
    }
  });
  // Implicit sequence edges for connectivity, skipping any that duplicate a handoff.
  for (let i = 0; i < steps.length - 1; i++) {
    const from = steps[i].id;
    const to = steps[i + 1].id;
    if (handoffPairs.has(JSON.stringify([from, to]))) continue;
    pushEdge(from, to, 'sequence');
  }

  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: linear.id,
    title: linear.title,
    ...(linear.description ? { description: linear.description } : {}),
    version: typeof linear.version === 'number' && linear.version >= 1 ? linear.version : 1,
    status: linear.status ?? 'active',
    ...(linear.orchestrator ? { orchestrator: linear.orchestrator } : {}),
    nodes,
    edges,
    ...(linear.runGates ? { runGates: linear.runGates } : {}),
    ...(linear.loop ? { loop: linear.loop } : {}),
    ...(linear.evidenceRoot ? { evidenceRoot: linear.evidenceRoot } : {}),
  };
}

function triggerLabel(t: WorkflowTrigger | undefined): string {
  if (!t) return 'Trigger';
  if (t.kind === 'schedule') {
    const until = t.until ? ` until ${t.until.slice(0, 10)}` : '';
    return `Schedule: ${t.cron ?? '?'}${until}`;
  }
  if (t.kind === 'todo-status-change') {
    return `Todo status: ${t.toStatus ?? t.status ?? '?'}`;
  }
  return 'Manual trigger';
}
