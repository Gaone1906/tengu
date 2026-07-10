import { validateDefinition } from './definition.js';
import { impliedExecutionOrder } from './order.js';
import type {
  EditableWorkflowDefinition,
  StepOutputMode,
  StepRetryPolicy,
  StepSessionMode,
  SwitchMode,
  WorkflowNode,
} from './definition.js';
import type { WorkflowCondition } from './condition.js';
import type { WorkflowGate } from './derive.js';

/**
 * Execution-plan compiler (GRS-011d-1).
 *
 * This is the DRY-RUN / COMPILE step of the workflow execution contract. It takes an
 * editable workflow definition (the Edit-view artifact from GRS-011a/b/c) and resolves
 * it into a concrete plan expressed ENTIRELY in terms of primitives Jinn already has —
 * a schedule trigger becomes a cron-job shape, a step node becomes a session spawn spec,
 * a gate becomes one of the evaluator kinds the run already understands. If the
 * definition cannot execute, it returns structured "cannot execute because…" errors the
 * editor can surface exactly like validation errors, BEFORE anything fires.
 *
 * It is deliberately PURE (no fs, no env, no gateway, no session spawning). It computes
 * WHAT WOULD RUN, not a run. Actually driving a sandbox run from a plan is GRS-011d-2.
 *
 * Why this exists (Fable memo 2026-07-03 19:19 §2.1/§3): Jinn now has a durable, versioned,
 * validated, editable definition that NOTHING executes — editing it changes a JSON file and
 * no run. That is the exact half-baked failure mode the product thesis exists to kill. This
 * compiler is the first honest step from "definition" toward "definition that drives a run":
 * it proves a saved definition maps onto existing cron/work-item/session/gate primitives, and
 * it makes the human-approval gate a first-class RUN-PARKING concept (Fable §2.2) so the
 * dogfood's own biggest real-world state — "waiting on the operator to merge" — becomes representable.
 *
 * KISS: no new runtime engine, no scheduler, no queue. The plan compiles to primitives that
 * already exist and already have receipts, or it reports why it can't.
 */

/* ── Error codes ────────────────────────────────────────────────────────────── */

/**
 * A reason a definition cannot be executed. These are execution-mapping failures —
 * distinct from `ValidationCode` structural errors. A definition can be perfectly valid
 * (well-formed graph) yet unexecutable (references an employee that no longer exists, or
 * has no steps to spawn). `definition-invalid` is the bridge: a structurally invalid
 * definition is by definition unexecutable, and its validation errors are surfaced flat
 * so the editor renders execution + validation errors uniformly.
 */
export type ExecutionErrorCode =
  | 'definition-invalid'
  | 'no-executable-steps'
  | 'unknown-actor'
  | 'unknown-engine'
  | 'unmapped-gate-kind'
  | 'unsupported-multiple-loops'
  | 'loop-unbounded'
  | 'invalid-loop-edge';

export interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  /** Node/gate id this error anchors to, when applicable. */
  ref?: string;
}

/* ── Plan shapes (expressed in existing-primitive terms) ────────────────────── */

export interface TriggerPlan {
  kind: 'schedule' | 'manual' | 'todo-status-change';
  /** Present for schedule triggers: the cron expression a Jinn cron job would carry. */
  cron?: string;
  timezone?: string;
  until?: string;
  /** The Jinn cron job this schedule names, when the definition declares one. */
  cronJobId?: string;
  /**
   * True when the definition DECLARES a non-empty cronJobId. NOTE: the compiler is pure and
   * receives no cron registry, so this reports "the definition names a cron job", NOT "that
   * cron job exists". Verifying the job exists (and emitting an unknown-cron-job error) is the
   * execution layer's job (GRS-011d-2, which injects the real registry). Named honestly so a
   * consumer never reads it as a proven binding. (Codex GRS-011d-1 Major 2.)
   */
  declaresCronJobId: boolean;
  /** Present for todo-status-change triggers. */
  toStatus?: string;
  fromStatus?: string;
}

/** How a gate is checked at run time, in the vocabulary the run already evaluates. */
export type GateEvaluator = 'artifact-glob' | 'state-flag' | 'human-approval';

export interface GatePlan {
  id?: string;
  kind: WorkflowGate['kind'];
  evaluator: GateEvaluator;
  /**
   * True if this gate can HOLD a run rather than being auto-evaluated. Only `approval`
   * gates park (they wait on a human); `artifact`/`flag` gates are computed from evidence
   * and never block indefinitely. This is what lets the Run view show a run parked on an
   * approval, awaiting a person (Fable §2.2).
   */
  blocking: boolean;
  /** glob (artifact) | flag name (flag) | approvalRef (approval) — for UI + evaluation. */
  ref?: string;
  description: string;
}

/** How a step node becomes a session, in existing SessionManager.route() terms. */
export interface SpawnSpec {
  actorKind: 'employee' | 'engine';
  /** Employee name (e.g. "jimbo", "fable-guide") or engine id (e.g. "codex", "claude"). */
  actorRef: string;
  /** Model override (GRS-016b options.model) — wins over an employee's default model.
   * Engine-interpreted; an unknown model fails the spawn honestly. */
  model?: string;
  /** Effort override (GRS-016b options.effort) — the session's effortLevel. */
  effort?: string;
}

export interface StepPlan {
  nodeId: string;
  label: string;
  role?: string;
  optional: boolean;
  /**
   * The session this step would spawn, or `null` for an orchestrator-inline step — a step
   * with no actor (e.g. the sample-autonomy "Isolated QA" node) runs inside the orchestrator
   * turn itself, spawning no separate session. `null` is a valid, intentional plan, not an error.
   */
  spawn: SpawnSpec | null;
  gates: GatePlan[];
  /**
   * True if any of this step's inline gates is a blocking (human-approval) gate. This describes
   * the DEFINITION ("this step declares a human hold point"). NOTE: the run EXECUTOR (GRS-011d-2c)
   * does NOT park on a step's inline gate — inline step gates are post-hoc receipts, so runtime
   * parking happens only at a standalone gate NODE or a workflow runGate. This flag stays as a
   * compiler-level signal; it is not "the run parks here". (Codex GRS-011d-2c Major 1.)
   */
  parksOnApproval: boolean;
  /**
   * GRS-016b/d execution options, copied ONLY when the node declares them — an
   * option-less step's plan keeps the exact v2 shape (and the planner resolves the
   * defaults: retry = respawn-once on interrupted, onError = fail-run, output =
   * handoff, no timeout). `onError:'error-edge'` (GRS-016d) routes a terminal
   * failure down the node's error-lane out-edges; `output:'none'` (GRS-016d)
   * settles `fired` at spawn and is never awaited.
   */
  retry?: StepRetryPolicy;
  onError?: 'fail-run' | 'continue' | 'error-edge';
  output?: StepOutputMode;
  timeoutMinutes?: number;
  /**
   * SESSION MODE (GRS-016e), copied only when declared (absent = 'fresh' = the v2
   * spawn-per-invocation). 'workflow' = one shared session per run, follow-up
   * turns serialized + marker-correlated; 'existing' = follow-up turns into the
   * operator-picked `sessionTarget` gateway session.
   */
  sessionMode?: StepSessionMode;
  /** The target gateway session id for sessionMode 'existing'. */
  sessionTarget?: string;
}

/** A standalone `gate` node (a checkpoint node in the graph, distinct from a step's inline gates). */
export interface GateNodePlan extends GatePlan {
  nodeId: string;
  label: string;
}

/** One routable out-edge of a switch node (GRS-016c), in edge declaration order. */
export interface SwitchEdgePlan {
  edgeId: string;
  to: string;
  /** AND-combined conditions; absent = the default/fallback edge. */
  when?: WorkflowCondition[];
}

/** A `switch` node compiled for routing (GRS-016c): actorless, evaluated inline by
 * the planner over the frozen run record, settling `routed` with the taken edge ids. */
export interface SwitchNodePlan {
  nodeId: string;
  label: string;
  mode: SwitchMode;
  /** Non-loop out-edges in declaration order — the routing table. */
  outEdges: SwitchEdgePlan[];
}

/** A `fail` node compiled (GRS-016c): reached active, it settles `failed` with the
 * authored message and fails the run (`authored-fail`) through the drain semantics. */
export interface FailNodePlan {
  nodeId: string;
  label: string;
  message: string;
}

/** One in-edge for edge-checked readiness + activity (GRS-016c). `lane:'error'`
 * (GRS-016d) marks the failure route of an onError:'error-edge' source: the edge
 * activates exactly when the source settled `failed` terminally, and the source's
 * normal out-edges then deactivate. */
export interface InEdgePlan {
  edgeId: string;
  from: string;
  lane?: 'error';
}

/** A `wait` node compiled (GRS-016d, design §2.6): actorless, no session. On
 * activation the receipt enters `waiting` with a persisted `readyAt` (now +
 * `minutes`, or `untilIso` verbatim — validation guarantees exactly one is set);
 * the 15s sweep IS the clock and settles it `checkpoint` at/after the deadline. */
export interface WaitNodePlan {
  nodeId: string;
  label: string;
  minutes?: number;
  untilIso?: string;
}

/**
 * The bounded loop a definition declares (GRS-014e, design D4): ONE back-edge marked
 * `kind:'loop'` whose segment `[targetId..sourceId]` (in the non-loop topological
 * order) the run repeats while `rounds < maxRoundsPerRun` AND the optional exit gate
 * has not passed. Continuation is DETERMINISTIC — either a legacy artifact/flag gate
 * or conditions over frozen run/handoff evidence, never a model or a human.
 */
export interface LoopPlan {
  edgeId: string;
  /** The segment's LAST node (the loop edge's `from`) — the round-boundary. */
  sourceId: string;
  /** The segment's FIRST node (the loop edge's `to`) — where each round restarts. */
  targetId: string;
  maxRoundsPerRun: number;
  /** Early-exit gate; null = pure count-bounded loop (runs exactly maxRoundsPerRun rounds). */
  exitGate: GatePlan | null;
  /** Early-exit conditions over frozen run evidence; mutually exclusive with
   * `exitGate`. In particular this can read verifier-declared handoff fields. */
  exitWhen?: WorkflowCondition[];
  /**
   * The loop BODY, by GRAPH REACHABILITY (GRS-016a-fix, Codex findings 1+2): every
   * node on a non-loop-edge path target→…→source (= descendants of the target ∩
   * ancestors of the source, both inclusive), in topological order. THIS is what a
   * round re-executes and what the boundary decision waits on — never an array-index
   * window, which would conscript unrelated nodes that merely sit between the
   * endpoints in declaration/topo order. A target-fed side branch that does not lead
   * back to the source is NOT part of the body: it executes once.
   */
  segmentNodeIds: string[];
  /**
   * True post-loop successors (GRS-016a-fix, Codex finding 1): nodes with a non-loop
   * path FROM the source (source excluded), in topological order. Only these wait for
   * `loopExit` — their handoff must come from the final round. Independent branches
   * (no path through the loop) dispatch concurrently with rounds regardless of where
   * they sit in the array.
   */
  postLoopNodeIds: string[];
}

export interface ExecutionPlan {
  workflowId: string;
  title: string;
  version: number;
  trigger: TriggerPlan;
  /**
   * Step nodes. ORDER is DECLARATION order (the order they appear in `nodes`), matching the
   * editor's orderDefinitionNodes. This is deliberately NOT the edge-following execution
   * sequence: the sample graph branches (adversary→decide handoff declared before adversary→
   * steer sequence), so edge-following mis-orders it (the wave-27 precedent). The true run-time
   * ordering follows edges and is resolved by the execution layer (011d-2). `stepOrder` below
   * marks this explicitly so a consumer never mistakes `steps` for a strict execution sequence.
   * (Codex GRS-011d-1 Major 3.)
   */
  steps: StepPlan[];
  /** Always 'declaration' in v1 — see `steps`. A discriminator for consumers, not a strict run order. */
  stepOrder: 'declaration';
  /**
   * Standalone `gate` nodes (type:"gate") compiled to their evaluator + blocking semantics.
   * These are checkpoint NODES in the graph, distinct from a step's inline `gates` and from
   * workflow-level `runGates`. Compiling them (rather than dropping them) is what keeps
   * `hasApprovalGate` honest for a `…→approval-gate-node→…` graph. (Codex GRS-011d-1 Major 1.)
   */
  gateNodes: GateNodePlan[];
  /** Workflow-level gates every run must satisfy (mirrors runGates). */
  runGates: GatePlan[];
  /** True if ANY step gate, gate node, OR run gate parks on a human approval — the run has a human hold point. */
  hasApprovalGate: boolean;
  /** The definition's bounded loop, or null (GRS-014e). */
  loop: LoopPlan | null;
  /**
   * Max receipts in flight at once (GRS-016a): `def.concurrency ?? 1`. 1 = the
   * sequential v2 engine (the compat default); >1 enables ready-set multi-dispatch.
   */
  concurrency: number;
  /** Switch nodes compiled for routing (GRS-016c). Declaration order. */
  switchNodes: SwitchNodePlan[];
  /** Fail nodes (GRS-016c). Declaration order. */
  failNodes: FailNodePlan[];
  /** Wait nodes (GRS-016d). Declaration order. */
  waitNodes: WaitNodePlan[];
  /**
   * In-edges per non-trigger node (GRS-016c): every NON-loop edge between
   * non-trigger nodes pointing at the node, in edge declaration order — the
   * edge-level view `predecessors` collapses. Readiness (all in-edges resolved) and
   * ACTIVITY (≥1 in-edge active — a switch's route selects edges, not nodes) both
   * read this. A node fed only by the trigger has `[]` — ready at run start, always
   * active (the trigger fired; its out-edges are unconditionally live).
   */
  inEdges: Record<string, InEdgePlan[]>;
  /**
   * Edge predecessors per non-trigger node (GRS-016a), for edge-checked readiness:
   * every non-trigger `from` of a NON-loop edge pointing at the node, deduplicated,
   * in edge declaration order. A node fed only by the trigger has `[]` — ready at
   * run start. Loop back-edges never appear here: cross-round sequencing is owned by
   * the round-splice mechanism (a new round's receipts exist only after the previous
   * round's boundary decision), not by readiness.
   */
  predecessors: Record<string, string[]>;
}

export type ResolveResult =
  | { ok: true; plan: ExecutionPlan }
  | { ok: false; errors: ExecutionError[] };

export interface ResolveOptions {
  /**
   * When provided, a step whose actor is an employee not in this set yields an
   * `unknown-actor` execution error. Omit to skip the roster check (pure structural resolve).
   * Injected (not read from a registry) so the compiler stays pure and testable.
   */
  knownEmployees?: Iterable<string>;
  /** Same, for engine actors → `unknown-engine`. */
  knownEngines?: Iterable<string>;
}

/* ── Compiler ───────────────────────────────────────────────────────────────── */

/**
 * Map a gate to its run-time evaluator + blocking semantics. Total for the closed gate-kind
 * set; returns `null` for an unknown kind so the caller can emit an `unmapped-gate-kind`
 * error instead of throwing. (A valid definition never hits the null branch — validateDefinition
 * closes the kind set — but the compiler stays total regardless.)
 */
function planGate(gate: WorkflowGate): GatePlan | null {
  const base = { id: gate.id, kind: gate.kind, description: gate.description };
  switch (gate.kind) {
    case 'artifact':
      return { ...base, evaluator: 'artifact-glob', blocking: false, ref: gate.glob };
    case 'flag':
      return { ...base, evaluator: 'state-flag', blocking: false, ref: gate.flag };
    case 'approval':
      return { ...base, evaluator: 'human-approval', blocking: true, ref: gate.approvalRef };
    default:
      return null;
  }
}

/**
 * Compile an editable definition into an execution plan, or return the reasons it can't run.
 *
 * Two phases:
 *   1. Structural: run validateDefinition. An invalid graph is unexecutable — every validation
 *      error is surfaced flat as a `definition-invalid` execution error (so the editor renders
 *      structural + execution problems in one list) and we stop (a broken graph can't be mapped).
 *   2. Mapping: resolve trigger, steps, and gates onto existing primitives, collecting
 *      execution-mapping errors that validation does NOT catch (unknown roster refs, no steps).
 *      Only if zero mapping errors accumulate is a plan returned.
 */
export function resolveExecutionPlan(
  def: EditableWorkflowDefinition,
  opts: ResolveOptions = {},
): ResolveResult {
  // Phase 1 — structural. Cannot compile a graph that isn't well-formed.
  const validation = validateDefinition(def);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors.map((v) => ({
        code: 'definition-invalid' as const,
        message: `${v.code}: ${v.message}`,
        ref: v.ref,
      })),
    };
  }

  // From here the graph is valid: exactly one trigger node with a good spec, closed gate
  // kinds, reachable nodes, no dangling edges, etc.
  const errors: ExecutionError[] = [];
  const knownEmployees = opts.knownEmployees ? new Set(opts.knownEmployees) : null;
  const knownEngines = opts.knownEngines ? new Set(opts.knownEngines) : null;

  const nodes: WorkflowNode[] = def.nodes;

  // Trigger — validated to exist exactly once with a spec. Copy only STRING-typed optional
  // fields: the validator only enforces `cron` for schedule triggers, so a hand-crafted def
  // with `timezone: 123` would otherwise be copied verbatim into the plan (Codex Minor).
  const triggerNode = nodes.find((n) => n.type === 'trigger')!;
  const t = triggerNode.trigger!;
  const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
  // Schedule-only fields (cron/timezone/until/cronJobId) are copied ONLY for schedule triggers.
  // A manual trigger with a stray cronJobId must not surface as `{kind:'manual', cronJobId,
  // declaresCronJobId:false}` — that's self-contradictory (Codex round-2 Minor). Manual → bare.
  const isSchedule = t.kind === 'schedule';
  const trigger: TriggerPlan = {
    kind: t.kind,
    ...(isSchedule && str(t.cron) ? { cron: t.cron } : {}),
    ...(isSchedule && str(t.timezone) ? { timezone: t.timezone } : {}),
    ...(isSchedule && str(t.until) ? { until: t.until } : {}),
    ...(isSchedule && str(t.cronJobId) ? { cronJobId: t.cronJobId } : {}),
    ...(t.kind === 'todo-status-change' && str(t.toStatus ?? t.status) ? { toStatus: (t.toStatus ?? t.status) as string } : {}),
    ...(t.kind === 'todo-status-change' && str(t.fromStatus) ? { fromStatus: t.fromStatus } : {}),
    declaresCronJobId: isSchedule && str(t.cronJobId),
  };

  // Steps — declaration order, mapped to spawn specs + gate evaluators.
  const stepNodes = nodes.filter((n) => n.type === 'step');
  if (stepNodes.length === 0) {
    errors.push({
      code: 'no-executable-steps',
      message: 'workflow has a trigger but no step nodes, so a run would spawn nothing',
    });
  }

  const steps: StepPlan[] = [];
  let hasApprovalGate = false;

  for (const n of stepNodes) {
    let spawn: SpawnSpec | null = null;
    if (n.actor) {
      // Model/effort overrides (GRS-016b) ride the spawn spec — the validator has
      // already guaranteed options only exist on actor-bearing steps.
      spawn = {
        actorKind: n.actor.kind,
        actorRef: n.actor.ref,
        ...(n.options?.model ? { model: n.options.model } : {}),
        ...(n.options?.effort ? { effort: n.options.effort } : {}),
      };
      if (n.actor.kind === 'employee' && knownEmployees && !knownEmployees.has(n.actor.ref)) {
        errors.push({
          code: 'unknown-actor',
          message: `step "${n.id}" is assigned to employee "${n.actor.ref}", which does not exist`,
          ref: n.id,
        });
      }
      if (n.actor.kind === 'engine' && knownEngines && !knownEngines.has(n.actor.ref)) {
        errors.push({
          code: 'unknown-engine',
          message: `step "${n.id}" is assigned to engine "${n.actor.ref}", which is not available`,
          ref: n.id,
        });
      }
    }

    const gates: GatePlan[] = [];
    for (const g of n.gates ?? []) {
      const gp = planGate(g);
      if (!gp) {
        errors.push({
          code: 'unmapped-gate-kind',
          message: `step "${n.id}" has a gate of unknown kind "${(g as WorkflowGate).kind}"`,
          ref: n.id,
        });
        continue;
      }
      gates.push(gp);
    }
    const parksOnApproval = gates.some((g) => g.blocking);
    if (parksOnApproval) hasApprovalGate = true;

    steps.push({
      nodeId: n.id,
      label: n.label,
      ...(n.role ? { role: n.role } : {}),
      optional: n.optional === true,
      spawn,
      gates,
      parksOnApproval,
      // GRS-016b/d policies — copied only when declared (absent = v2 plan shape).
      ...(n.options?.retry ? { retry: { maxAttempts: n.options.retry.maxAttempts, on: [...n.options.retry.on] } } : {}),
      ...(n.options?.onError ? { onError: n.options.onError } : {}),
      ...(n.options?.output ? { output: n.options.output } : {}),
      ...(n.options?.timeoutMinutes !== undefined ? { timeoutMinutes: n.options.timeoutMinutes } : {}),
      // Session mode (GRS-016e) — copied only when declared; validation has already
      // pinned sessionId presence to mode 'existing'.
      ...(n.options?.session ? { sessionMode: n.options.session.mode } : {}),
      ...(n.options?.session?.sessionId ? { sessionTarget: n.options.session.sessionId } : {}),
    });
  }

  // Standalone `gate` nodes (checkpoint nodes). validateDefinition guarantees a gate node has
  // a `node.gate`, so these are never dropped from the plan — that is what keeps hasApprovalGate
  // honest for a `…→approval-gate-node→…` graph (Codex Major 1). Declaration order, like steps.
  const gateNodes: GateNodePlan[] = [];
  for (const n of nodes) {
    if (n.type !== 'gate') continue;
    const gp = n.gate ? planGate(n.gate) : null;
    if (!gp) {
      errors.push({
        code: 'unmapped-gate-kind',
        message: `gate node "${n.id}" has a gate of unknown kind "${(n.gate as WorkflowGate | undefined)?.kind}"`,
        ref: n.id,
      });
      continue;
    }
    gateNodes.push({ ...gp, nodeId: n.id, label: n.label });
    if (gp.blocking) hasApprovalGate = true;
  }

  // Switch + fail + wait nodes (GRS-016c/d). Validation has already pinned the
  // shapes (switch-only mode, fail message present + capped, `when` only on
  // non-loop switch out-edges, exactly one wait duration/deadline), so
  // compilation is a straight copy in declaration order.
  const switchNodes: SwitchNodePlan[] = [];
  const failNodes: FailNodePlan[] = [];
  const waitNodes: WaitNodePlan[] = [];
  for (const n of nodes) {
    if (n.type === 'wait') {
      waitNodes.push({
        nodeId: n.id,
        label: n.label,
        ...(n.waitMinutes !== undefined ? { minutes: n.waitMinutes } : {}),
        ...(n.waitUntil !== undefined ? { untilIso: n.waitUntil } : {}),
      });
    }
    if (n.type === 'switch') {
      switchNodes.push({
        nodeId: n.id,
        label: n.label,
        mode: n.switchMode ?? 'firstMatch',
        outEdges: def.edges
          .filter((e) => e && e.from === n.id && e.kind !== 'loop')
          .map((e) => ({
            edgeId: e.id,
            to: e.to,
            ...(e.when ? { when: e.when.map((c) => ({ ...c })) } : {}),
          })),
      });
    }
    if (n.type === 'fail') {
      failNodes.push({ nodeId: n.id, label: n.label, message: n.failMessage ?? '' });
    }
  }

  // Workflow-level run gates.
  const runGates: GatePlan[] = [];
  for (const g of def.runGates ?? []) {
    const gp = planGate(g);
    if (!gp) {
      errors.push({
        code: 'unmapped-gate-kind',
        message: `runGate has an unknown kind "${(g as WorkflowGate).kind}"`,
      });
      continue;
    }
    runGates.push(gp);
    if (gp.blocking) hasApprovalGate = true;
  }

  // Bounded loop (GRS-014e). Exactly one `kind:'loop'` back-edge is supported —
  // nested/overlapping loop segments would need per-loop round counters and have no
  // consumer; refuse rather than half-support. A loop edge requires the definition to
  // bound it (`def.loop.maxRoundsPerRun`, a positive integer — design D4's "default
  // refuse"), and must point BACKWARD in the non-loop topological order (its segment
  // [target..source] must be non-empty and forward-contiguous).
  let loop: LoopPlan | null = null;
  const loopEdges = def.edges.filter((e) => e && e.kind === 'loop');
  if (loopEdges.length > 1) {
    errors.push({
      code: 'unsupported-multiple-loops',
      message: `workflow declares ${loopEdges.length} loop edges; only one bounded loop is supported`,
    });
  } else if (loopEdges.length === 1) {
    const e = loopEdges[0];
    const maxRounds = def.loop?.maxRoundsPerRun;
    if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) {
      errors.push({
        code: 'loop-unbounded',
        message: `loop edge "${e.id}" needs a positive integer loop.maxRoundsPerRun on the definition`,
        ref: e.id,
      });
    }
    // Backwardness: in the non-loop topo order the target must not come after the
    // source (self-loops are already refused by the validator). Topo is non-null here:
    // loop edges are excluded from the sort and the graph validated acyclic otherwise —
    // but stay total and skip the check if it ever is.
    const topo = impliedExecutionOrder(def);
    if (topo) {
      const ti = topo.indexOf(e.to);
      const si = topo.indexOf(e.from);
      if (ti === -1 || si === -1 || ti > si) {
        errors.push({
          code: 'invalid-loop-edge',
          message: `loop edge "${e.id}" must point BACKWARD: its target "${e.to}" must precede its source "${e.from}" in execution order`,
          ref: e.id,
        });
      }
      if (ti !== -1 && topo[0] === e.to && nodes.find((n) => n.id === e.to)?.type === 'trigger') {
        errors.push({
          code: 'invalid-loop-edge',
          message: `loop edge "${e.id}" targets the trigger node; a trigger cannot be re-run`,
          ref: e.id,
        });
      }
    }
    // Loop BODY by reachability over non-loop edges (GRS-016a-fix, Codex findings
    // 1+2): body = descendants(target) ∩ ancestors(source), inclusive; post-loop =
    // strict descendants(source). Array position never decides membership.
    const forwardAdj = new Map<string, string[]>();
    const reverseAdj = new Map<string, string[]>();
    for (const ed of def.edges) {
      if (!ed || ed.kind === 'loop') continue;
      forwardAdj.set(ed.from, [...(forwardAdj.get(ed.from) ?? []), ed.to]);
      reverseAdj.set(ed.to, [...(reverseAdj.get(ed.to) ?? []), ed.from]);
    }
    const reachFrom = (start: string, adj: Map<string, string[]>): Set<string> => {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const nxt of adj.get(cur) ?? []) {
          if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
        }
      }
      return seen;
    };
    const fromTarget = reachFrom(e.to, forwardAdj);       // target + its descendants
    const intoSource = reachFrom(e.from, reverseAdj);     // source + its ancestors
    const fromSource = reachFrom(e.from, forwardAdj);     // source + its descendants
    // A loop edge whose target cannot reach its source over non-loop edges has no
    // body to repeat — refuse (with the positional model this silently conscripted
    // whatever sat between the endpoints).
    if (!intoSource.has(e.to)) {
      errors.push({
        code: 'invalid-loop-edge',
        message: `loop edge "${e.id}" has no non-loop path from its target "${e.to}" to its source "${e.from}" — there is no loop body to repeat`,
        ref: e.id,
      });
    }
    const topoForLoop = impliedExecutionOrder(def) ?? [];
    const segmentNodeIds = topoForLoop.filter((id) => fromTarget.has(id) && intoSource.has(id));
    const postLoopNodeIds = topoForLoop.filter((id) => id !== e.from && fromSource.has(id));

    const exitGate = e.gate ? planGate(e.gate) : null;
    const exitWhen = Array.isArray(e.when) && e.when.length > 0 ? e.when.map((condition) => ({ ...condition })) : null;
    if (errors.length === 0) {
      loop = {
        edgeId: e.id,
        sourceId: e.from,
        targetId: e.to,
        maxRoundsPerRun: maxRounds as number,
        exitGate,
        ...(exitWhen ? { exitWhen } : {}),
        segmentNodeIds,
        postLoopNodeIds,
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Edge-predecessor map (GRS-016a): for every non-trigger node, its non-trigger
  // predecessors over NON-loop edges, deduped, in edge declaration order. The
  // validator already guarantees no dangling edges and unique node ids.
  const triggerId = triggerNode.id;
  // NULL-PROTOTYPE records (GRS-016c-fix, Codex finding 2): these are keyed by
  // AUTHORED node ids. Prototype-shaped ids (__proto__/constructor/prototype) are
  // refused at validation, but legal-charset ids can still collide with
  // Object.prototype keys ('toString', 'hasOwnProperty') — a plain {} would then
  // read the inherited function where the engine expects an array. Object.create(null)
  // keeps the Record shape (JSON-serializable for the dry-run surface, `?.[]` reads
  // unchanged) with zero inherited keys.
  const predecessors: Record<string, string[]> = Object.create(null);
  const inEdges: Record<string, InEdgePlan[]> = Object.create(null);
  for (const n of nodes) {
    if (n.type === 'trigger') continue;
    predecessors[n.id] = [];
    inEdges[n.id] = [];
  }
  for (const e of def.edges) {
    if (e.kind === 'loop') continue;
    if (e.from === triggerId || e.to === triggerId) continue;
    const list = predecessors[e.to];
    if (list && !list.includes(e.from)) list.push(e.from);
    // Edge-level (GRS-016c): every edge kept — two switch out-edges can point at
    // the same node under different conditions, and activity is per-edge. The
    // error lane (GRS-016d) rides along: activity needs to know failure routes.
    inEdges[e.to]?.push({ edgeId: e.id, from: e.from, ...(e.lane === 'error' ? { lane: 'error' as const } : {}) });
  }

  return {
    ok: true,
    plan: {
      workflowId: def.id,
      title: def.title,
      version: def.version,
      trigger,
      steps,
      stepOrder: 'declaration',
      gateNodes,
      runGates,
      hasApprovalGate,
      loop,
      concurrency: def.concurrency ?? 1,
      switchNodes,
      failNodes,
      waitNodes,
      inEdges,
      predecessors,
    },
  };
}
