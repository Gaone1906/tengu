import type {
  ExecutionPlan,
  FailNodePlan,
  GatePlan,
  GateNodePlan,
  InEdgePlan,
  LoopPlan,
  SpawnSpec,
  StepPlan,
  SwitchNodePlan,
  WaitNodePlan,
} from './execution-plan.js';
import { MAX_STEP_RETRY_ATTEMPTS, MAX_WAIT_MINUTES, type StepRetryCause, type StepRetryPolicy } from './definition.js';
import { evaluateConditions, type ConditionEvidence } from './condition.js';
import { extractHandoff, fullMessageOutcome, type StepOutcome } from './handoff.js';
import {
  IN_FLIGHT_STEP_STATUSES,
  SETTLED_STEP_STATUSES,
  WORKFLOW_RUN_SCHEMA_VERSION,
  normalizeWorkflowTrigger,
  type ParkedGate,
  type RunStepReceipt,
  type WorkflowRun,
  type WorkflowRunTrigger,
} from './run-store.js';

/**
 * Sequential-advancement PLANNER (GRS-014b) — the pure core of the v2 run engine.
 *
 * This module replaces the retired v1 fire-and-forget walk (`run-executor.ts`, deleted
 * this slice) with a durable step machine. A run's `steps[]` is materialized ONCE at
 * start, in edge-implied TOPOLOGICAL order (declaration tiebreak — `order.ts`), every
 * receipt `pending`. The run then advances by READY SET (GRS-016a): a step is ready
 * when every edge predecessor's latest receipt is settled (the implicit wait-all
 * join), and up to `plan.concurrency` receipts are in flight at once. Concurrency 1
 * (the default — `concurrency` absent on the definition) is the sequential v2 engine,
 * byte-identical: the sequential-front rule stops the walk at the first unsettled
 * receipt, so dispatches, pass-throughs, and parks happen exactly where GRS-014b put
 * them. steps[] ARRAY ORDER is the deterministic dispatch/identity frame — intents
 * are collected and executed strictly in array order; only settle timestamps record
 * that sessions overlapped. Mid-graph approval gates park the run with everything
 * downstream still `pending`; `completed` is written only when the LAST step's session
 * settled and no blocking runGate holds the run (design D5 — the status is earned).
 * A required-step failure with sibling sessions in flight DRAINS (`stopping`): no new
 * dispatches, in-flight receipts settle truthfully, terminal written when the last
 * one lands (§3.4) — a terminal record never freezes live receipts.
 *
 * PURE CORE, injected side effects: `advanceRun` reads a run + compiled plan + a
 * session PROBE and returns the next state plus at most one dispatch intent. It spawns
 * nothing and touches no fs — the impure driver (`run-reconciler.ts`) executes the
 * dispatch (mint-before-spawn), persists, and re-advances. Advancement is a pure
 * re-derivation of (run record, session statuses), so re-running it is idempotent —
 * the whole crash-recovery story is "sweep re-derives" (design D1, the GRS-003a
 * reconciler pattern).
 *
 * CRASH SAFETY per step (the GRS-003b mint-before-spawn lesson): a dispatch first
 * persists the receipt as `dispatching` with its attempt (the durable record of
 * INTENT), then spawns under the deterministic sessionKey
 * `workflow-run:<runId>:<nodeId>:<attempt>`. On recovery a `dispatching` receipt is
 * disambiguated by probing that key: session exists → ADOPT it (crash was after the
 * spawn); missing → re-dispatch the SAME attempt (crash was before — the key was never
 * used, no duplicate possible).
 *
 * RESPAWN POLICY (operator decision 2026-07-04): a step whose session was interrupted
 * (gateway restart) — or vanished — is respawned ONCE (attempt 2), then fails the run.
 * A session that settled `error` is NOT respawned (the engine ran and failed; retrying
 * the same prompt is 014e-lifecycle territory). `optional:true` steps degrade to
 * `skipped` instead of failing the run, on both spawn failure and terminal failure.
 */

/* ── Spawn contract (moved here from the deleted run-executor.ts) ───────────── */

/** What a step spawn produced. The gateway returns the real linked session; a stub returns a fake id. */
export interface SpawnResult {
  sessionId: string;
  detail?: string;
}

export interface SpawnContext {
  runId: string;
  workflowId: string;
  nodeId: string;
  label: string;
  /** Dispatch attempt (1 or 2) — part of the deterministic sessionKey. */
  attempt: number;
  /** Loop round (GRS-014e); 1 outside loops — part of the sessionKey for rounds ≥ 2. */
  round: number;
  spec: SpawnSpec;
  /**
   * The full step prompt (GRS-014c): instructions + predecessor handoffs + acceptance
   * criteria, built by the driver from the run's frozen definition snapshot and the
   * persisted predecessor outcomes (`handoff.buildStepPrompt`).
   */
  prompt: string;
  /**
   * SessionKey override (GRS-016e): the shared-session creation spawn uses
   * `workflow-run:<runId>:shared` instead of the per-attempt key. Absent = the
   * spawner derives the ordinary attempt key (v2 verbatim).
   */
  sessionKey?: string;
  /**
   * Pre-minted id for the inserted prompt ROW (GRS-016e-fix2) — persisted as the
   * receipt's `turnAnchor` in the same write as the dispatching mark; the spawner
   * MUST insert the prompt row with exactly this id (the durable settle anchor).
   * Present only on the shared-session creation spawn; fresh spawns never carry it.
   */
  anchorMessageId?: string;
}

export type SpawnStep = (ctx: SpawnContext) => Promise<SpawnResult>;

/* ── Follow-up turns into an existing session (GRS-016e session modes) ────────── */

/** The deterministic per-dispatch turn marker (GRS-016e): embedded in the posted
 * follow-up message AND persisted on the receipt at mint. Deterministic from the
 * receipt identity `(runId, nodeId, round, attempt)`, so recovery can re-derive it
 * from the record alone. */
export function turnMarkerFor(runId: string, nodeId: string, attempt: number, round = 1): string {
  return `wf-turn:${runId}:${nodeId}:r${round}:a${attempt}`;
}

/** The run's ONE shared engine session's key (GRS-016e session mode 'workflow') —
 * created lazily by the first workflow-mode node to dispatch. */
export function sharedSessionKey(runId: string): string {
  return `workflow-run:${runId}:shared`;
}

/** The marker LINE PREFIX the driver prepends to every follow-up/shared prompt —
 * shared with the correlator's anchor-relocation fallback so the two can never
 * drift (GRS-016e-fix). */
export function turnMarkerLinePrefix(marker: string): string {
  return `[workflow-turn ${marker}]`;
}

/** Minimal structural view of a session message row for turn correlation. */
export interface TurnLogRow {
  id: string;
  role: string;
  content: string;
  partial?: boolean;
}

/**
 * ROW-POSITIONAL turn correlation (GRS-016e-fix, Codex finding 1) — the ONE
 * implementation both the gateway probe and the test harnesses consume.
 *
 * IDENTITY ONLY, NEVER CONTENT (fix2, Codex round-2 finding 3): the anchor is
 * the USER row the workflow inserted, located EXCLUSIVELY by its durable id —
 * `turnAnchor` is pre-minted by the driver, persisted in the SAME write as the
 * dispatching mark, and used verbatim as the inserted row's id, so a recovered
 * receipt always carries it. There is NO content-based fallback: marker text is
 * model- and operator-reproducible, so a stale/duplicate marker-prefix row must
 * never pick the anchor. No anchor — or an anchor id absent from the log — is
 * simply "not posted": the planner re-posts (the id was never used, no duplicate
 * turn possible); it never guesses.
 *
 * The step's reply is the FIRST non-partial ASSISTANT row strictly AFTER the
 * anchor row — pure position. `replyText` is null when the anchor exists but no
 * reply row follows (the honest settled-with-no-output evidence; the caller
 * gates on idle).
 */
export function correlateSessionTurn(
  rows: TurnLogRow[],
  q: { marker: string; anchor?: string },
): { markerPosted: boolean; replyText: string | null; superseded?: boolean } {
  const anchorPos = q.anchor ? rows.findIndex((r) => r.id === q.anchor) : -1;
  if (anchorPos === -1) return { markerPosted: false, replyText: null };
  // INTERRUPT SUPERSEDE (GRS-016e-fix round 2, live-QA-found): the reply scan is
  // BOUNDED by the first intervening non-partial USER row. The message route
  // interrupts a running turn on any genuine user message (interruptOnNewMessage
  // default), so a user row landing before any assistant row means OUR turn was
  // killed — the assistant row that follows belongs to the INTERRUPTING turn and
  // is NEVER adopted (`superseded: true`; the planner routes the 'interrupted'
  // cause and the retry policy re-posts). Under a non-default no-interrupt config
  // a queued-behind turn that actually completed is also classified superseded —
  // that costs one clean re-post, never a mis-adoption (the fail-safe direction).
  // Notification rows (parent callbacks) never interrupt and never supersede.
  for (let i = anchorPos + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.partial) continue;
    if (r.role === 'assistant') {
      return { markerPosted: true, replyText: r.content };
    }
    if (r.role === 'user') {
      return { markerPosted: true, replyText: null, superseded: true };
    }
  }
  return { markerPosted: true, replyText: null };
}

/** What the driver hands the injected follow-up poster: the target session, the
 * marker-embedded prompt, and the step's declared spec (the gateway asserts the
 * target session matches the declared actor before posting). */
export interface FollowUpContext {
  runId: string;
  workflowId: string;
  nodeId: string;
  label: string;
  attempt: number;
  round: number;
  /** The gateway session the turn is posted into (shared or operator-picked). */
  sessionId: string;
  spec: SpawnSpec;
  /** The full step prompt with the turn-marker line prepended. */
  prompt: string;
  turnMarker: string;
  /** Pre-minted id for the inserted user ROW (GRS-016e-fix2) — already persisted
   * on the receipt as `turnAnchor`; the poster MUST insert the row with exactly
   * this id. Recovery then disambiguates purely by id: row present → adopt, row
   * absent → the id was never used → re-post, no duplicate turn possible. */
  anchorMessageId: string;
}

/**
 * What a follow-up post produced (GRS-016e-fix, Codex finding 2). `posted` carries
 * the inserted user row's durable message id — the settle anchor. `deferred` is the
 * TYPED busy verdict from the poster's own ATOMIC check (the target was — or
 * became — busy between the planner's probe and the insert): the driver reverts
 * the receipt to pending WITHOUT consuming an attempt and the next sweep retries.
 * A missing/mismatched target still THROWS — that is a spawn failure for the
 * policy chain, not a defer.
 */
export type FollowUpPostResult =
  | { outcome: 'posted'; sessionId: string; detail?: string }
  | { outcome: 'deferred'; reason: string };

/** Injected side effect that posts a follow-up turn (a user message + engine
 * dispatch) into an EXISTING gateway session — atomically: the busy check and the
 * insert happen with no interleave point between them (single-process gateway,
 * no await inside the segment). Busy → typed defer; gone/mismatched target →
 * throw (honest spawn-failure). */
export type PostStepFollowUp = (ctx: FollowUpContext) => Promise<FollowUpPostResult>;

/** What the injected session-turn probe reports for a follow-up-mode receipt.
 *
 * CORRELATION IS ROW-ID POSITIONAL (GRS-016e-fix/fix2): the anchor is the
 * durable id of the USER row the workflow inserted — pre-minted by the driver,
 * persisted with the dispatching mark, and passed back in the query as
 * `anchor`. `markerPosted` = that exact row exists (identity only; there is no
 * content-based location). `replyText` is the FIRST non-partial ASSISTANT row
 * strictly AFTER the anchor row, supplied when the session is idle (null =
 * settled with no reply). `superseded` = a user row intervened before any
 * reply — the turn was interrupted by an outside actor and its successor reply
 * is never adopted.
 */
export interface SessionTurnProbe {
  found: boolean;
  status?: StepSessionStatus;
  markerPosted?: boolean;
  replyText?: string | null;
  /** A user row intervened between the anchor and any assistant row — OUR turn
   * was interrupted/superseded; the next reply belongs to the interloper and is
   * never adopted. The planner routes the 'interrupted' cause (retryable). */
  superseded?: boolean;
}

export type ProbeSessionTurn = (q: { sessionId: string; marker: string; anchor?: string }) => SessionTurnProbe;

/** What the driver hands the injected session-stopper (GRS-016b timeouts): the
 * planner's StopIntent plus run identity, for logging/audit on the gateway side. */
export interface StopStepContext extends StopIntent {
  runId: string;
  workflowId: string;
}

/** Injected side effect that stops a live step session (the gateway kills the
 * engine turn + idles the session). Best-effort: a failure is logged, never fatal —
 * the receipt's settle was persisted BEFORE the stop, so the worst case is one
 * session finishing naturally (bounded token leak), never a lying receipt. */
export type StopStepSession = (ctx: StopStepContext) => Promise<void> | void;

/** The deterministic per-attempt session identity. Also the mint-before-spawn probe key.
 * Round 1 keeps the GRS-014b shape exactly (old records and mid-flight runs unaffected);
 * loop rounds ≥ 2 (GRS-014e) extend it with an `r<round>` segment so every iteration of a
 * repeated node gets its own session identity. */
export function stepSessionKey(runId: string, nodeId: string, attempt: number, round = 1): string {
  return round <= 1
    ? `workflow-run:${runId}:${nodeId}:${attempt}`
    : `workflow-run:${runId}:${nodeId}:r${round}:${attempt}`;
}

/* ── Session probe (injected; the gateway wires getSessionBySessionKey) ─────── */

/** Mirror of the gateway session statuses the planner reacts to. */
export type StepSessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'interrupted';

export interface StepSessionProbe {
  found: boolean;
  sessionId?: string;
  status?: StepSessionStatus;
  /**
   * The session's final assistant message (GRS-014c) — the gateway probe supplies it
   * for `idle` sessions (that is when the outcome is extracted). `null`/absent on an
   * idle session means the step SETTLED WITH NO OUTPUT — an honest step failure, not
   * a completion (closes the 014b forced-idle false-completion limit).
   */
  finalAssistantText?: string | null;
}

export type ProbeStepSession = (sessionKey: string) => StepSessionProbe;

/* ── Run-record minting ─────────────────────────────────────────────────────── */

export interface MintRunOptions {
  /** What started this run (GRS-014d): schedule fires carry cronJobId + fireIso. */
  trigger?: WorkflowRunTrigger;
  /** Safety cap on how many nodes a single run may hold. Default 100. */
  maxNodes?: number;
}

export type MintRunResult =
  | { ok: true; run: WorkflowRun }
  | { ok: false; errors: { code: string; message: string; ref?: string }[] };

function pendingReceiptFor(nodeId: string, plan: ExecutionPlan): RunStepReceipt | null {
  const step = plan.steps.find((s) => s.nodeId === nodeId);
  if (step) {
    return {
      nodeId,
      label: step.label,
      actor: step.spawn ? { kind: step.spawn.actorKind, ref: step.spawn.actorRef } : null,
      status: 'pending',
      attempt: 0,
      at: '',
    };
  }
  const gate = plan.gateNodes.find((g) => g.nodeId === nodeId);
  if (gate) {
    return { nodeId, label: gate.label, actor: null, status: 'pending', attempt: 0, at: '' };
  }
  // Switch/fail nodes (GRS-016c) — actorless receipts, like gate nodes. `?? []`
  // keeps the lookup total against a hand-built pre-016c plan object.
  const sw = (plan.switchNodes ?? []).find((s) => s.nodeId === nodeId);
  if (sw) {
    return { nodeId, label: sw.label, actor: null, status: 'pending', attempt: 0, at: '' };
  }
  const fail = (plan.failNodes ?? []).find((f) => f.nodeId === nodeId);
  if (fail) {
    return { nodeId, label: fail.label, actor: null, status: 'pending', attempt: 0, at: '' };
  }
  const wait = (plan.waitNodes ?? []).find((w) => w.nodeId === nodeId);
  if (wait) {
    return { nodeId, label: wait.label, actor: null, status: 'pending', attempt: 0, at: '' };
  }
  return null; // trigger (excluded by the caller) or unknown
}

/**
 * Mint the durable v2 run record: status `running`, `order` = the edge-implied topo
 * order of non-trigger nodes, one `pending` receipt per ordered node. Persisting this
 * BEFORE any spawn is the run-level mint-before-spawn — a crash after the mint leaves
 * a recoverable pending run the reconciler picks up, never an orphaned session with no
 * durable intent. Cycles are refused (`unsupported-cycle`) until GRS-014e's bounded
 * loops; the caller passes the topo order it computed (order.ts).
 */
export function mintSequentialRun(
  plan: ExecutionPlan,
  topoOrder: string[] | null,
  runId: string,
  now: () => string,
  opts: MintRunOptions = {},
): MintRunResult {
  if (topoOrder === null) {
    return {
      ok: false,
      errors: [{
        code: 'unsupported-cycle',
        message: 'workflow edges form a cycle; cyclic graphs cannot run until bounded loops land (GRS-014e)',
      }],
    };
  }
  const maxNodes = opts.maxNodes ?? 100;
  if (topoOrder.length > maxNodes) {
    return {
      ok: false,
      errors: [{ code: 'max-nodes-exceeded', message: `workflow has more than ${maxNodes} nodes` }],
    };
  }
  const at = now();
  const stepIds: string[] = [];
  const steps: RunStepReceipt[] = [];
  for (const nodeId of topoOrder) {
    const receipt = pendingReceiptFor(nodeId, plan);
    if (!receipt) continue; // the trigger node — carries no receipt
    receipt.at = at;
    stepIds.push(nodeId);
    steps.push(receipt);
  }
  return {
    ok: true,
    run: {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      runId,
      workflowId: plan.workflowId,
      definitionVersion: plan.version,
      title: plan.title,
      trigger: opts.trigger ?? { kind: 'manual' },
      status: 'running',
      startedAt: at,
      endedAt: null,
      steps,
      parked: null,
      order: stepIds,
      // Loop runs carry the round counter from birth (GRS-014e); loop-less records
      // stay byte-shape-identical to 014b.
      ...(plan.loop ? { rounds: 1 } : {}),
    },
  };
}

/* ── Advancement (one pure pass) ────────────────────────────────────────────── */

export interface DispatchIntent {
  nodeId: string;
  attempt: number;
  round: number;
}

/**
 * A live session the driver must STOP (GRS-016b timeouts, operator ruling #2 —
 * tokens stop burning). Emitted alongside the settle/redispatch the timeout caused;
 * the driver persists FIRST, then executes stops (best-effort), then dispatches —
 * so a crash between persist and stop leaks at most one naturally-finishing session
 * (bounded), never a mis-settled receipt.
 */
export interface StopIntent {
  nodeId: string;
  /** The attempt whose session is being stopped (the timed-out one). */
  attempt: number;
  round: number;
  sessionId?: string;
  /** The deterministic sessionKey of the timed-out attempt — the stop lookup key. */
  sessionKey: string;
  reason: string;
}

export interface AdvanceResult {
  /** The (possibly) updated run — a fresh object when `changed` is true. */
  run: WorkflowRun;
  /** True when any receipt/run field transitioned — the driver must persist. */
  changed: boolean;
  /**
   * Dispatch intents (GRS-016a): the READY SET — every edge-ready pending actor step,
   * in steps[] ARRAY order, bounded by `plan.concurrency` (plus any adopt-miss
   * re-dispatch / respawn intents, which occupy in-flight slots already). The driver
   * executes them sequentially in this order: mark `dispatching` (persist —
   * mint-before-spawn), spawn under the deterministic sessionKey, mark `running`
   * (persist), then re-advance. With concurrency 1 (the default) this list never
   * holds more than one intent — the sequential v2 engine.
   */
  dispatches: DispatchIntent[];
  /** The first intent — the sequential v2 shape, kept so existing consumers read unchanged. */
  dispatch?: DispatchIntent;
  /** Sessions to stop (GRS-016b timeouts). Present only when non-empty; executed by
   * the driver AFTER persisting this pass's transitions and BEFORE any dispatch (a
   * timeout-retry must stop the old attempt before spawning the next). */
  stops?: StopIntent[];
}

/**
 * Cancel every `waiting` receipt on a run that is ending (GRS-016d): a wait holds
 * NO session, so nothing ever drains it — left alone it would sit non-terminal
 * inside a terminal record (the frozen-live-receipt lie the drain machinery
 * exists to kill), or hold a drain open for up to a week. Cancelling starts no
 * work and needs no probe; the receipt settles `skipped` honestly.
 */
function cancelWaitingReceipts(steps: RunStepReceipt[], at: string): boolean {
  let cancelled = false;
  for (const s of steps) {
    if (s.status !== 'waiting') continue;
    s.status = 'skipped';
    s.detail = 'wait cancelled: run stopping';
    s.settledAt = at;
    s.at = at;
    cancelled = true;
  }
  return cancelled;
}

/* ── Shared edge-activity frame (GRS-016d-fix, Codex finding 1) ─────────────────
 * ONE implementation of "which edges did this run actually traverse", consumed by
 * BOTH the planner (readiness, skip propagation, routing) and the prompt builder
 * (predecessor collection in run-reconciler.stepPromptFor). 016c's invariant —
 * routing and handoffs must agree on which edges are live — is enforced
 * structurally by sharing the code, not by keeping two derivations in sync.
 * Everything derives from FROZEN receipt stamps (route / failed-under-error-edge /
 * propagation skips) at a given steps[] position; the factory closes over the
 * caller's steps array (the planner passes its mutable working copy — receipts
 * before any queried position are stable, so the per-instance memo stays valid;
 * the prompt builder passes the persisted record). */

export interface RunEdgeActivity {
  /** Settled for control-flow purposes: any terminal, INCLUDING a failed receipt
   * on a failure-surviving node (onError continue / error-edge). */
  isResolved(r: RunStepReceipt): boolean;
  /** Latest receipt of a node strictly before a steps[] position (GRS-014e-fix —
   * the ONE position rule readiness, routing, and handoffs all share). */
  latestReceiptBefore(nodeId: string, beforeIndex: number): RunStepReceipt | null;
  /** ≥1 in-edge active at the position ("control actually flows here"). */
  nodeActiveAt(nodeId: string, atIndex: number): boolean;
  /** Whether ONE in-edge is live at the position (route stamps, error lanes,
   * skip propagation — design §2.3 rule 1 + §2.4). */
  edgeActiveAt(edge: InEdgePlan, atIndex: number): boolean;
}

export function createRunEdgeActivity(steps: RunStepReceipt[], plan: ExecutionPlan): RunEdgeActivity {
  /** Nodes whose terminal failure the run SURVIVES: onError:'continue' (GRS-016b)
   * and onError:'error-edge' (GRS-016d — the failure ROUTES instead of killing).
   * Their `failed` receipts count as RESOLVED — successors' readiness, the loop
   * boundary, and run completion all treat them as settled evidence. */
  const errorEdgeNodes = new Set((plan.steps ?? []).filter((s) => s.onError === 'error-edge').map((s) => s.nodeId));
  const failSurvivorNodes = new Set([
    ...(plan.steps ?? []).filter((s) => s.onError === 'continue').map((s) => s.nodeId),
    ...errorEdgeNodes,
  ]);

  const isResolved = (r: RunStepReceipt): boolean =>
    SETTLED_STEP_STATUSES.has(r.status) || (r.status === 'failed' && failSurvivorNodes.has(r.nodeId));

  const latestReceiptBefore = (nodeId: string, beforeIndex: number): RunStepReceipt | null => {
    for (let i = beforeIndex - 1; i >= 0; i--) {
      if (steps[i].nodeId === nodeId) return steps[i];
    }
    return null;
  };

  /* Edge activity (GRS-016c, design §2.3): DERIVED per receipt position from
   * frozen stamps — a switch's `route` selects its out-edges; a branch-not-taken
   * skip propagates inactivity downstream — never re-evaluated from mutable
   * evidence. The distinction that keeps v2 byte-compat: an OPTIONAL-absorption
   * skip keeps its out-edges ACTIVE (v2's chain continues past it) while a
   * propagation skip is "branch not taken" — distinguished by derivation (a skip
   * was propagation iff the node was itself inactive at its own position;
   * recursion over strictly earlier positions, memoized per instance). */
  const activityMemo = new Map<string, boolean>();
  const nodeActiveAt = (nodeId: string, atIndex: number): boolean => {
    const inEdges: InEdgePlan[] | undefined = plan.inEdges?.[nodeId];
    // No in-edges (trigger-fed) → unconditionally live. A plan shape without
    // `inEdges` at all (pre-016c object in a hand-built test) degrades to
    // everything-active — exactly the pre-016c semantics.
    if (!inEdges || inEdges.length === 0) return true;
    const memoKey = `${nodeId}@${atIndex}`;
    const memo = activityMemo.get(memoKey);
    if (memo !== undefined) return memo;
    const active = inEdges.some((ed) => edgeActiveAt(ed, atIndex));
    activityMemo.set(memoKey, active);
    return active;
  };
  const edgeActiveAt = (edge: InEdgePlan, atIndex: number): boolean => {
    const src = latestReceiptBefore(edge.from, atIndex);
    if (!src) return false;
    // Error-output lanes (GRS-016d §2.4): an error-lane edge is live EXACTLY when
    // its source terminally failed under onError:'error-edge' (validation pins the
    // pairing, so the node check is belt-and-braces against hand-built records).
    // Any other source terminal — done, fired, routed-elsewhere, skipped — leaves
    // the lane dark, and a failed error-edge source darkens its NORMAL out-edges
    // (the failure took the lane; success-path successors settle "branch not taken").
    if (edge.lane === 'error') {
      return src.status === 'failed' && errorEdgeNodes.has(edge.from);
    }
    if (src.status === 'failed' && errorEdgeNodes.has(edge.from)) return false;
    if (src.status === 'routed') return Array.isArray(src.route) && src.route.includes(edge.edgeId);
    if (src.status === 'skipped') return nodeActiveAt(edge.from, steps.indexOf(src));
    // done | inline | checkpoint | fired | failed (continue / drain residue) →
    // control flows. An unresolved source is never active (callers check readiness
    // first; the recursion only meets settled receipts by the topo invariant —
    // guard anyway).
    return isResolved(src) || src.status === 'failed';
  };

  return { isResolved, latestReceiptBefore, nodeActiveAt, edgeActiveAt };
}

function parkedFromGate(scope: ParkedGate['scope'], nodeId: string | null, g: GatePlan, at: string): ParkedGate {
  return {
    scope,
    nodeId,
    kind: 'approval',
    evaluator: 'human-approval',
    ...(g.ref ? { ref: g.ref } : {}),
    description: g.description,
    at,
  };
}

interface PlanIndex {
  stepById: Map<string, StepPlan>;
  gateById: Map<string, GateNodePlan>;
  switchById: Map<string, SwitchNodePlan>;
  failById: Map<string, FailNodePlan>;
  waitById: Map<string, WaitNodePlan>;
}

function indexPlan(plan: ExecutionPlan): PlanIndex {
  return {
    stepById: new Map(plan.steps.map((s) => [s.nodeId, s])),
    gateById: new Map(plan.gateNodes.map((g) => [g.nodeId, g])),
    switchById: new Map((plan.switchNodes ?? []).map((s) => [s.nodeId, s])),
    failById: new Map((plan.failNodes ?? []).map((f) => [f.nodeId, f])),
    waitById: new Map((plan.waitNodes ?? []).map((w) => [w.nodeId, w])),
  };
}

/**
 * Take a switch's routing decision (GRS-016c, design §2.3) over the frozen run
 * evidence. Pure and deterministic; the caller stamps the result on the receipt
 * (`routed` + `route`) so the decision is frozen — later evidence drift never
 * re-routes.
 *
 * `firstMatch` (default): conditioned out-edges are evaluated in declaration order,
 * the first passing one wins; an edge with NO `when` is the default/fallback — taken
 * only when no conditioned edge passed, regardless of where it is declared (a
 * position-dependent default would silently shadow every rule declared after it).
 * `allMatches`: every passing conditioned edge activates; default edges activate
 * only if nothing else did. No match and no default → empty route: every out-branch
 * (and its exclusive descendants) settles `skipped`.
 */
function routeSwitch(sw: SwitchNodePlan, ev: ConditionEvidence): { route: string[]; detail: string } {
  const conditioned = sw.outEdges.filter((e) => Array.isArray(e.when) && e.when.length > 0);
  const defaults = sw.outEdges.filter((e) => !Array.isArray(e.when) || e.when.length === 0);
  const describe = (edges: { edgeId: string }[]) => edges.map((e) => `"${e.edgeId}"`).join(', ');
  if (sw.mode === 'allMatches') {
    const matched = conditioned.filter((e) => evaluateConditions(e.when, ev));
    if (matched.length > 0) {
      return { route: matched.map((e) => e.edgeId), detail: `routed via ${matched.length} matching edge(s): ${describe(matched)}` };
    }
    if (defaults.length > 0) {
      return { route: defaults.map((e) => e.edgeId), detail: `no rule matched — routed via default edge(s): ${describe(defaults)}` };
    }
    return { route: [], detail: 'no rule matched and no default edge — every branch skipped' };
  }
  for (const e of conditioned) {
    if (evaluateConditions(e.when, ev)) {
      return { route: [e.edgeId], detail: `routed via edge "${e.edgeId}" (rule ${sw.outEdges.indexOf(e) + 1} matched)` };
    }
  }
  if (defaults.length > 0) {
    return { route: [defaults[0].edgeId], detail: `no rule matched — routed via default edge "${defaults[0].edgeId}"` };
  }
  return { route: [], detail: 'no rule matched and no default edge — every branch skipped' };
}

/**
 * The DEFAULT retry policy = v2's respawn-once verbatim (operator decision
 * 2026-07-04): interruptions (and vanished sessions — indistinguishable, always the
 * same path) are respawned once; error / no-output / timeout are not retried. A
 * node-declared `options.retry` REPLACES this wholesale — the declared policy IS the
 * policy (an author who writes `on: ['error']` has said interruptions fail fast;
 * the inspector pre-checks 'interrupted' so dropping it is a deliberate act).
 */
const DEFAULT_STEP_RETRY: StepRetryPolicy = { maxAttempts: 2, on: ['interrupted'] };

/** Resolve a step's retry policy, total against corrupt/hand-built plans: a malformed
 * declaration falls back to the default; maxAttempts is clamped to the hard ceiling
 * (validation already refuses > MAX_STEP_RETRY_ATTEMPTS — this is defense in depth,
 * attempts are engine sessions). */
function retryFor(step: StepPlan | undefined): StepRetryPolicy {
  const r = step?.retry;
  if (!r || !Number.isInteger(r.maxAttempts) || !Array.isArray(r.on)) return DEFAULT_STEP_RETRY;
  return { maxAttempts: Math.min(Math.max(r.maxAttempts, 1), MAX_STEP_RETRY_ATTEMPTS), on: r.on };
}

/** Extract a settled session's outcome under the step's output mode (GRS-016b):
 * 'full' skips declared-block extraction — the tail-capped final message IS the
 * outcome; default ('handoff') is the v2 extraction. */
function outcomeFor(step: StepPlan | undefined, sessionId: string, text: string): StepOutcome {
  return {
    sessionId,
    ...(step?.output === 'full' ? fullMessageOutcome(text) : extractHandoff(text)),
  };
}

/**
 * One pure advancement pass over a `running` sequential run. Walks the receipts in
 * their frozen order and returns the next state:
 *   - settles pass-through nodes (actorless → inline, non-blocking gate → checkpoint),
 *   - parks on the first blocking gate NODE (downstream stays pending),
 *   - adopts / re-dispatches a `dispatching` receipt via the mint-before-spawn probe,
 *   - resolves a `running` receipt from its session status (idle→done, error→failed or
 *     skipped-if-optional, interrupted/missing→respawn once then failed),
 *   - dispatches the next pending actor step (at most one),
 *   - and when every receipt is settled: parks on a blocking runGate or completes.
 *
 * Idempotent: same inputs → same outputs; a re-run after any crash re-derives.
 */
export interface AdvanceOptions {
  /**
   * Deterministic loop exit-gate evaluator (GRS-014e) — the driver injects the real
   * artifact/flag evidence check over the evidence root; the planner stays pure.
   * Absent (or returning false) = the gate has not passed.
   */
  evaluateGate?: (gate: GatePlan) => boolean;
  /**
   * Session-turn probe (GRS-016e) for follow-up-mode receipts (session mode
   * workflow/existing) — the marker-correlated counterpart of `probe`. The driver
   * refuses to START a session-mode run without it; a mid-flight record met by a
   * planner without it fails honestly (`session-mode-unsupported`), never wedges.
   */
  probeSessionTurn?: ProbeSessionTurn;
}

export function advanceRun(
  run: WorkflowRun,
  plan: ExecutionPlan,
  probe: ProbeStepSession,
  now: () => string,
  opts: AdvanceOptions = {},
): AdvanceResult {
  if (run.status === 'parked') return probeOnlyPass(run, plan, probe, now, opts);
  if (run.status !== 'running') return { run, changed: false, dispatches: [] };

  const { stepById, gateById, switchById, failById, waitById } = indexPlan(plan);
  const steps = run.steps.map((r) => ({ ...r }));
  const next: WorkflowRun = { ...run, steps };
  let changed = false;
  /** Max receipts in flight at once. `?? 1` keeps the planner total against a plan
   * shape from before GRS-016a (compat: absent = sequential). */
  const budget = Math.max(1, plan.concurrency ?? 1);
  const dispatches: DispatchIntent[] = [];
  const stops: StopIntent[] = [];
  /** Intents for receipts that are still `pending` — the only intents that ADD
   * in-flight load (adopt-miss/respawn intents re-drive already-counted receipts). */
  let newDispatchCount = 0;

  const mkResult = (): AdvanceResult => ({
    run: next,
    changed,
    dispatches,
    ...(dispatches.length > 0 ? { dispatch: dispatches[0] } : {}),
    ...(stops.length > 0 ? { stops } : {}),
  });

  const inFlightCount = (): number => steps.filter((s) => IN_FLIGHT_STEP_STATUSES.has(s.status)).length;

  /** The shared activity frame (GRS-016d-fix): isResolved / position rule / edge
   * activity all come from the ONE implementation the prompt builder also uses —
   * routing and handoffs can never disagree about which edges are live. Closes
   * over this pass's mutable `steps` copy; receipts before any queried position
   * are stable for the rest of the pass, so the per-instance memo holds. */
  const activity = createRunEdgeActivity(steps, plan);
  const { isResolved, latestReceiptBefore, nodeActiveAt } = activity;

  /** Follow-up serialization identity (GRS-016e): every session-mode 'workflow'
   * node shares the run's ONE session; 'existing' nodes share per target id. At
   * most ONE turn may be outstanding per target — message insertion order at post
   * time is the correlation frame, so two outstanding markers on one session could
   * mis-assign replies. Null = fresh mode (no shared target, v2). */
  const followUpKeyOf = (step: StepPlan | undefined): string | null => {
    if (step?.sessionMode === 'workflow') return 'workflow:shared';
    if (step?.sessionMode === 'existing') return `existing:${step.sessionTarget ?? ''}`;
    return null;
  };
  /** Targets claimed by intents collected THIS pass — the same-pass half of the
   * one-outstanding-turn rule (in-flight receipts cover the cross-pass half). */
  const claimedFollowUpTargets = new Set<string>();

  /**
   * Record a failure honestly (GRS-016a drain). Settles `receipt` as failed (when
   * given), then: with OTHER receipts still in flight the run enters `stopping`
   * (status stays `running`, dispatch suppressed, the error parked on
   * `stopping.errors` until the drain terminal folds it in) — a terminal record must
   * never freeze live receipts at `running`. With nothing in flight this is the v2
   * immediate terminal, byte-identical (no `stopping` key is ever written on that
   * path). Either way this pass dispatches nothing — failing runs start no new work.
   */
  const recordFailure = (
    receipt: RunStepReceipt | null,
    code: string,
    message: string,
    ref?: string,
  ): AdvanceResult => {
    const at = now();
    if (receipt) {
      receipt.status = 'failed';
      receipt.detail = message;
      receipt.settledAt = at;
      receipt.at = at;
    }
    // A failing run never honors a pause: waits are cancelled here (session-less,
    // probe-free) so neither the immediate terminal below nor the drain ever
    // carries a live-looking `waiting` receipt (GRS-016d).
    cancelWaitingReceipts(steps, at);
    changed = true;
    const pendingErrors = [...(next.stopping?.errors ?? []), { code, message, ...(ref ? { ref } : {}) }];
    if (inFlightCount() > 0) {
      next.stopping = {
        to: next.stopping?.to ?? 'failed',
        at: next.stopping?.at ?? at,
        errors: pendingErrors,
      };
      return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
    }
    next.status = 'failed';
    next.endedAt = at;
    next.errors = [...(next.errors ?? []), ...pendingErrors];
    if (next.stopping) next.stopping = { ...next.stopping, errors: [] }; // folded above; keep the field as drain evidence
    return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
  };

  /**
   * Route a failure-looking settle through the GRS-016b policy chain, in the fixed
   * order the design argues (§2.1/§3.4): RETRY first (the failure may be transient —
   * cause ∈ retry.on and attempts remain → re-dispatch under the next attempt key,
   * the receipt is NOT settled between attempts, exactly the v2 respawn mechanics),
   * then OPTIONAL absorbs (skipped — the branch was declared expendable), then
   * onError:'continue' settles the receipt FAILED but lets the run proceed, and only
   * then 'fail-run' (the default) escalates — the caller invokes recordFailure with
   * the same message. A DRAINING run never retries (no new work while failing).
   */
  const routeFailure = (
    receipt: RunStepReceipt,
    step: StepPlan | undefined,
    attempt: number,
    cause: StepRetryCause,
    message: string,
    skipDetail: string,
  ): 'redispatched' | 'settled' | 'terminal' => {
    const retry = retryFor(step);
    if (!next.stopping && retry.on.includes(cause) && attempt < retry.maxAttempts) {
      if (cause === 'timeout') {
        // MINT-BEFORE-STOP (GRS-016b-fix, Codex finding 1): a timeout retry is the
        // one redispatch whose trigger evidence the engine itself DESTROYS — the
        // stop turns the session into idle-with-no-output, so a crash between the
        // stop and the next-attempt persist would leave a running@N receipt the
        // next sweep misroutes as step-no-output (losing the configured retry).
        // The retry decision therefore becomes a durable receipt transition IN
        // THIS PASS: dispatching @ attempt+1, persisted by the driver BEFORE the
        // stop executes. Recovery is then the ordinary mint-before-spawn probe
        // (key attempt+1 missing → re-dispatch the SAME attempt — exactly one
        // next attempt, no double-spawn, no lost retry). The other causes stay
        // driver-transitioned (v2 verbatim): their evidence (error / idle /
        // interrupted / vanished) is stable, so a crashed pass simply re-derives
        // the same decision — durability adds nothing there.
        const at = now();
        receipt.status = 'dispatching';
        receipt.attempt = attempt + 1;
        receipt.dispatchedAt = at;
        receipt.at = at;
        receipt.detail = `respawn after timeout (attempt ${attempt + 1})`;
        changed = true;
      }
      dispatches.push({ nodeId: receipt.nodeId, attempt: attempt + 1, round: receipt.round ?? 1 });
      sequentialFrontBlocked = true;
      return 'redispatched';
    }
    const at = now();
    if (step?.optional) {
      receipt.status = 'skipped';
      receipt.detail = skipDetail;
      receipt.settledAt = at;
      receipt.at = at;
      changed = true;
      return 'settled';
    }
    if (step?.onError === 'continue') {
      receipt.status = 'failed';
      receipt.detail = `${message} — run continues (onError: continue)`;
      receipt.settledAt = at;
      receipt.at = at;
      changed = true;
      return 'settled';
    }
    // onError:'error-edge' (GRS-016d §2.4): the receipt stays honest `failed`
    // evidence but the run continues — the edge-activity rule flips control to the
    // error-lane out-edge(s) and skip propagation darkens the normal lane. During
    // a drain this settles exactly like continue (the failure would not have
    // failed the run even normally, so it never extends stopping.errors).
    if (step?.onError === 'error-edge') {
      receipt.status = 'failed';
      receipt.detail = `${message} — routed to the error lane (onError: error-edge)`;
      receipt.settledAt = at;
      receipt.at = at;
      changed = true;
      return 'settled';
    }
    return 'terminal';
  };

  /** The exhaustion suffix for a failure message: names the declared-retry budget
   * when the cause was covered; the v2 strings stay byte-identical when no retry is
   * declared (the compat cornerstone — goldens assert raw bytes). */
  const exhaustionSuffix = (step: StepPlan | undefined, attempt: number, cause: StepRetryCause): string => {
    if (!step?.retry || !retryFor(step).on.includes(cause)) return '';
    return ` on attempt ${attempt} (retry exhausted: ${retryFor(step).maxAttempts} attempt(s))`;
  };

  /**
   * True when every CURRENT-round receipt of the loop BODY is settled (GRS-016a):
   * the round-boundary trigger. The body is `loop.segmentNodeIds` — GRAPH membership
   * (nodes on a target→source path), never an array-index window (GRS-016a-fix,
   * Codex finding 2). Because every body node is an ancestor of the source and
   * readiness is edge-checked, the source settling actually implies the body has —
   * this check stays as a cheap guard against corrupted records rather than a
   * scheduling wait.
   */
  const segmentSettled = (loop: LoopPlan): boolean => {
    for (const nodeId of loop.segmentNodeIds) {
      let last: RunStepReceipt | null = null;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].nodeId === nodeId) { last = steps[i]; break; }
      }
      if (!last || !isResolved(last)) return false;
    }
    return true;
  };

  // ── Bounded loop continuation (GRS-014e, design D4; GRS-016a: segment-settled) ──
  // Decided at the ROUND BOUNDARY: when every receipt of the current round's segment
  // has settled, either exit (gate passed / gate-less count reached — stamped durably
  // in `loopExit` so a later disappearance of the evidence can never re-open the
  // loop), splice the next round's pending receipts IN PLACE after the segment (array
  // order stays execution order), or — a gated loop that ran out of rounds — fail
  // honestly. A DRAINING run (`stopping`, GRS-016a) never takes loop decisions: no
  // new rounds while the run is failing.
  if (plan.loop && !next.loopExit && !next.stopping) {
    const loop: LoopPlan = plan.loop;
    const rounds = next.rounds ?? 1;
    let sIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].nodeId === loop.sourceId) { sIndex = i; break; }
    }
    if (sIndex >= 0 && segmentSettled(loop)) {
      const gatePassed = loop.exitGate ? opts.evaluateGate?.(loop.exitGate) === true : false;
      if (gatePassed) {
        next.loopExit = { round: rounds, at: now(), reason: 'gate-passed' };
        changed = true;
        // fall through — the walk proceeds past the segment
      } else if (rounds < loop.maxRoundsPerRun) {
        const tIdx = (next.order ?? []).indexOf(loop.targetId);
        const sIdx = (next.order ?? []).indexOf(loop.sourceId);
        if (tIdx === -1 || sIdx === -1 || tIdx > sIdx) {
          return recordFailure(null, 'invalid-loop-edge', `loop segment [${loop.targetId}..${loop.sourceId}] is not in the run's frozen order`);
        }
        const at = now();
        const segment: RunStepReceipt[] = [];
        // Re-splice the loop BODY only — graph membership (`segmentNodeIds`, nodes on
        // a target→source path, topo-ordered), never an array window: an unrelated
        // node that merely sits between the endpoints must not be re-executed
        // (GRS-016a-fix, Codex finding 2).
        for (const nodeId of loop.segmentNodeIds) {
          const fresh = pendingReceiptFor(nodeId, plan);
          if (!fresh) return recordFailure(null, 'unknown-node', `loop segment references node "${nodeId}" the plan does not know`, nodeId);
          fresh.at = at;
          fresh.round = rounds + 1;
          segment.push(fresh);
        }
        steps.splice(sIndex + 1, 0, ...segment);
        next.rounds = rounds + 1;
        changed = true;
        // fall through — the walk dispatches the new round's first step
      } else if (loop.exitGate) {
        // Gated loop exhausted: the declared success criterion never passed within
        // the budget — completing would be the old `passed` lie. rounds stays ===
        // maxRoundsPerRun as the honest evidence.
        return recordFailure(
          null,
          'loop-exhausted',
          `loop exit gate "${loop.exitGate.description}" never passed within ${loop.maxRoundsPerRun} round(s)`,
          loop.edgeId,
        );
      } else {
        // Gate-less loop: maxRoundsPerRun IS the declared iteration count — finishing
        // it is normal termination, not exhaustion. Stamp the exit and proceed.
        next.loopExit = { round: rounds, at: now(), reason: 'max-rounds' };
        changed = true;
      }
    }
  }

  // Loop-boundary guard (GRS-014e; GRS-016a: segment-settled): true when the CURRENT
  // round's whole segment is SETTLED but the loop decision has not been taken — i.e.
  // the segment finished mid-pass (the pre-pass above only decides boundaries settled
  // at pass START; a taken decision manifests as either a spliced later round — whose
  // receipts are then pending — or a stamped loopExit, or a failed run). The walk must
  // not process anything past an undecided boundary; it stops and the next pass's
  // pre-pass decides. `changed` is true by construction at the stop (this pass settled
  // the segment's last receipt). A draining run never decides loops (see pre-pass).
  const undecidedLoopBoundary = (): boolean => {
    if (!plan.loop || next.loopExit || next.status !== 'running' || next.stopping) return false;
    return segmentSettled(plan.loop);
  };

  // Post-loop blocking (GRS-016a, design §3.5; GRS-016a-fix, Codex finding 1): while
  // the loop may still re-enter (no stamped loopExit), only TRUE post-loop successors
  // — nodes with a graph path FROM the source (`postLoopNodeIds`) — are held back:
  // their handoff must come from the FINAL round, which does not exist yet.
  // Membership, never array position: an independent branch that merely sits after
  // the source in the array dispatches concurrently with loop rounds.
  const postLoopBlocked: Set<string> | null =
    plan.loop && !next.loopExit ? new Set(plan.loop.postLoopNodeIds) : null;
  const blockedByLoop = (nodeId: string): boolean => postLoopBlocked !== null && postLoopBlocked.has(nodeId);

  /** Edge-checked readiness (GRS-016a): every edge predecessor's latest receipt
   * before this position is settled. Topo order guarantees those receipts exist for
   * a well-formed run; a missing one means the record is corrupt — treated as
   * not-ready (the walk defers; nothing dispatches on a graph it cannot verify). */
  const edgeReady = (receipt: RunStepReceipt, index: number): boolean => {
    for (const predId of plan.predecessors?.[receipt.nodeId] ?? []) {
      const pred = latestReceiptBefore(predId, index);
      if (!pred || !isResolved(pred)) return false;
    }
    return true;
  };

  /** Latest SETTLED receipt of a node strictly before a position — the condition
   * language's resolution rule (design §2.5): conditions and the prompt builder use
   * the same position frame, so routing and handoffs always see the same
   * predecessor state. Unlike readiness, an unsettled latest receipt is SKIPPED
   * (a condition may reference a non-ancestor that is legitimately still running —
   * then the settled receipt of an earlier round, or nothing, is the evidence).
   * `failed` receipts are readable — routing around a continue-node failure via
   * `steps.<id>.status` is the honest use of the status path. */
  const latestSettledBefore = (nodeId: string, beforeIndex: number): RunStepReceipt | null => {
    for (let i = beforeIndex - 1; i >= 0; i--) {
      const r = steps[i];
      if (r.nodeId !== nodeId) continue;
      if (SETTLED_STEP_STATUSES.has(r.status) || r.status === 'failed') return r;
    }
    return null;
  };
  const conditionEvidenceAt = (atIndex: number): ConditionEvidence => ({
    receiptFor: (nodeId) => latestSettledBefore(nodeId, atIndex),
    ...(next.rounds !== undefined ? { rounds: next.rounds } : {}),
    runStatus: next.status,
    triggerKind: 'kind' in next.trigger ? next.trigger.kind : next.trigger.source,
    trigger: normalizeWorkflowTrigger(next.trigger, next.triggerTodoId),
  });

  /** Loop guard for skips (GRS-016c × §3.5): a node OUTSIDE the loop body fed by a
   * body node must not settle "branch not taken" while the loop may still re-enter
   * — a later round's switch may route to it (the side branch executes at most
   * once, off whichever round activates it; after loopExit the FINAL round's route
   * decides). Body-internal nodes are exempt: they get a fresh receipt every round,
   * so a per-round skip is correct — and the boundary decision waits on it. */
  const segmentSet = plan.loop ? new Set(plan.loop.segmentNodeIds) : null;
  const skipDeferredByLoop = (nodeId: string): boolean => {
    if (!segmentSet || next.loopExit || segmentSet.has(nodeId)) return false;
    return (plan.inEdges?.[nodeId] ?? []).some((ed) => segmentSet.has(ed.from));
  };

  /** Sequential-front rule: with concurrency 1 the walk processes nothing past the
   * first receipt it left unsettled — exactly the v2 walk (byte-compat: pass-throughs,
   * parks, and dispatches happen at the same points in the run's life as before).
   * With concurrency > 1 the front is ignored and readiness is purely edge-checked. */
  let sequentialFrontBlocked = false;

  for (let walkIndex = 0; walkIndex < steps.length; walkIndex++) {
    const receipt = steps[walkIndex];
    // Resolved receipts need no driving — including a FAILED receipt on a continue
    // node (GRS-016b): that is legitimate settled evidence, not corruption.
    if (isResolved(receipt)) continue;
    if (undecidedLoopBoundary()) {
      return mkResult(); // decide the loop first (next pass's pre-pass)
    }

    // A failed receipt on a DRAINING run is legitimate residue (the failure that
    // started the drain, or a sibling that failed during it) — walk past it.
    if (receipt.status === 'failed' && next.stopping) continue;

    if (receipt.status === 'failed' || receipt.status === 'spawned' || receipt.status === 'error') {
      // 'failed' on a running (non-draining) run means a previous driver pass died
      // between receipt and run-status persists — settle honestly. 'spawned'/'error'
      // are v1-only and never appear in a sequential run; refuse to guess.
      return recordFailure(null, 'inconsistent-run-record', `step "${receipt.nodeId}" is ${receipt.status} while the run is running`, receipt.nodeId);
    }

    // Wait node mid-pause (GRS-016d §2.6): the 15s sweep IS the clock — settle
    // `checkpoint` on the first pass at/after the persisted readyAt (granularity =
    // the sweep interval, documented). A DRAINING run cancels the pause instead:
    // `waiting` holds no session, so the drain terminal must never wait on it (a
    // week-long wait inside a failing run would freeze the terminal — the same
    // evidence-lie class the drain exists to kill). A corrupt readyAt fails
    // honestly rather than waiting forever.
    if (receipt.status === 'waiting') {
      if (next.stopping) {
        receipt.status = 'skipped';
        receipt.detail = 'wait cancelled: run stopping';
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      const readyAtMs = Date.parse(receipt.readyAt ?? '');
      if (!Number.isFinite(readyAtMs)) {
        return recordFailure(receipt, 'invalid-wait-deadline', `wait node "${receipt.nodeId}" has no parseable readyAt on its waiting receipt`, receipt.nodeId);
      }
      const nowIso = now();
      if (Date.parse(nowIso) >= readyAtMs) {
        receipt.status = 'checkpoint';
        receipt.detail = `wait elapsed (ready at ${receipt.readyAt})`;
        receipt.settledAt = nowIso;
        receipt.at = nowIso;
        changed = true;
        continue;
      }
      sequentialFrontBlocked = true;
      continue; // still pausing — the next sweep re-checks the persisted deadline
    }

    if (receipt.status === 'pending') {
      // Pending work is DEFERRED (never processed) while: the run is draining
      // (stopping — no new work of any kind), the loop boundary blocks it (§3.5),
      // or an edge predecessor is unsettled (the implicit wait-all join).
      if (next.stopping || blockedByLoop(receipt.nodeId) || !edgeReady(receipt, walkIndex)) {
        sequentialFrontBlocked = true;
        continue;
      }
      // Skip propagation (GRS-016c, design §2.3 rule 4): every in-edge resolved but
      // NONE active — no control path reaches this node. It settles `skipped`
      // ("branch not taken") without dispatching, and its own out-edges become
      // inactive downstream (derivation). Receipts stay total: not-taken branches
      // are skipped, never absent. Checked BEFORE any node-type handling, so a
      // blocking gate on a dead branch skips instead of parking, and a fail node on
      // a dead branch skips instead of failing the run. Deliberately checked BEFORE
      // the sequential front too: settling a dead branch starts no work, so budget 1
      // may do it mid-pass — and no v2 definition can ever reach here (inactivity
      // requires a routed/propagation-skipped source, which requires a switch).
      if (!nodeActiveAt(receipt.nodeId, walkIndex)) {
        if (skipDeferredByLoop(receipt.nodeId)) {
          sequentialFrontBlocked = true;
          continue; // a later round may still route here — not final until loopExit
        }
        receipt.status = 'skipped';
        receipt.detail = 'branch not taken';
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      // The sequential front (concurrency 1 = the v2 walk): nothing past the first
      // unsettled receipt is processed.
      if (budget === 1 && sequentialFrontBlocked) {
        continue;
      }
      const gate = gateById.get(receipt.nodeId);
      if (gate) {
        if (gate.blocking) {
          // Mid-graph park: the accountability beat. Downstream receipts stay
          // pending; the park is GLOBAL — this pass's collected dispatch intents are
          // discarded (no new work while a human decision is awaited). In-flight
          // siblings keep running; the probe-only sweep keeps their receipts honest.
          next.status = 'parked';
          next.parked = parkedFromGate('gateNode', receipt.nodeId, gate, now());
          return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
        }
        receipt.status = 'checkpoint';
        receipt.detail = `${gate.kind} checkpoint (auto-evaluated)`;
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      // Switch node (GRS-016c): actorless, evaluated inline over the frozen run
      // record, settled `routed` with the taken edge ids stamped durably — the
      // decision is frozen the moment it is taken; later passes derive activity
      // from the stamp and never re-evaluate.
      const sw = switchById.get(receipt.nodeId);
      if (sw) {
        const decision = routeSwitch(sw, conditionEvidenceAt(walkIndex));
        receipt.status = 'routed';
        receipt.route = decision.route;
        receipt.detail = decision.detail;
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      // Fail node (GRS-016c): reached on an active path it settles `failed` with
      // the authored message and fails the run (`authored-fail`) — recordFailure
      // owns the drain semantics (in-flight siblings settle before the terminal).
      const failPlan = failById.get(receipt.nodeId);
      if (failPlan) {
        return recordFailure(receipt, 'authored-fail', failPlan.message, receipt.nodeId);
      }
      // Wait node activation (GRS-016d §2.6): stamp the durable deadline —
      // now + minutes, or the authored waitUntil verbatim — and enter `waiting`.
      // The deadline is persisted on the receipt, so a restart re-derives it from
      // the record alone (no timer state exists). A waitUntil already in the past
      // settles immediately; one beyond MAX_WAIT_MINUTES at activation fails the
      // run honestly (an absolute time cannot be bounded at authoring — the clock
      // moves under the definition — so the bound is enforced here).
      const waitPlan = waitById.get(receipt.nodeId);
      if (waitPlan) {
        const nowIso = now();
        const nowMs = Date.parse(nowIso);
        let readyAtMs: number;
        if (waitPlan.untilIso !== undefined) {
          readyAtMs = Date.parse(waitPlan.untilIso);
          if (!Number.isFinite(readyAtMs)) {
            return recordFailure(receipt, 'invalid-wait-deadline', `wait node "${receipt.nodeId}" waitUntil "${waitPlan.untilIso}" is not a parseable time`, receipt.nodeId);
          }
          if (readyAtMs - nowMs > MAX_WAIT_MINUTES * 60_000) {
            return recordFailure(receipt, 'wait-too-long', `wait node "${receipt.nodeId}" deadline ${waitPlan.untilIso} is more than ${MAX_WAIT_MINUTES} minutes away`, receipt.nodeId);
          }
        } else {
          readyAtMs = nowMs + (waitPlan.minutes ?? 0) * 60_000;
        }
        receipt.readyAt = new Date(readyAtMs).toISOString();
        if (nowMs >= readyAtMs) {
          receipt.status = 'checkpoint';
          receipt.detail = `wait elapsed (ready at ${receipt.readyAt})`;
          receipt.settledAt = nowIso;
          receipt.at = nowIso;
          changed = true;
          continue;
        }
        receipt.status = 'waiting';
        receipt.detail = waitPlan.untilIso !== undefined
          ? `waiting until ${receipt.readyAt}`
          : `waiting ${waitPlan.minutes} minute(s) (until ${receipt.readyAt})`;
        receipt.at = nowIso;
        changed = true;
        sequentialFrontBlocked = true;
        continue;
      }
      const step = stepById.get(receipt.nodeId);
      if (!step) {
        return recordFailure(receipt, 'unknown-node', `run order references node "${receipt.nodeId}" the plan does not know`, receipt.nodeId);
      }
      if (!step.spawn) {
        receipt.status = 'inline';
        receipt.detail = 'inline step (no actor)';
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      // Follow-up session modes (GRS-016e): before a workflow/existing-mode step
      // may dispatch, its target session must be free — ONE outstanding turn per
      // target (serialization), and never a post into a session that is mid-turn
      // (an operator may be using an 'existing' target right now; posting would
      // queue our message BEFORE the live turn's reply lands and break the
      // marker-order correlation). A held-back node simply stays ready; no
      // deadlock is possible because the outstanding turn settles first.
      const fuKey = followUpKeyOf(step);
      if (fuKey) {
        if (!opts.probeSessionTurn) {
          return recordFailure(receipt, 'session-mode-unsupported', `step "${receipt.nodeId}" uses session mode "${step.sessionMode}" but the driver provides no session-turn probe`, receipt.nodeId);
        }
        const targetClaimed =
          claimedFollowUpTargets.has(fuKey) ||
          steps.some((s) => IN_FLIGHT_STEP_STATUSES.has(s.status) && followUpKeyOf(stepById.get(s.nodeId)) === fuKey);
        if (targetClaimed) {
          sequentialFrontBlocked = true;
          continue;
        }
        const target = step.sessionMode === 'workflow' ? next.sharedSessionId : step.sessionTarget;
        if (target) {
          const q = opts.probeSessionTurn({
            sessionId: target,
            marker: turnMarkerFor(run.runId, receipt.nodeId, (receipt.attempt ?? 0) + 1, receipt.round ?? 1),
          });
          if (q.found && (q.status === 'running' || q.status === 'waiting')) {
            sequentialFrontBlocked = true;
            continue;
          }
        }
      }
      // A ready actor step — collect a dispatch intent while the budget admits it
      // (in-flight receipts + intents collected this pass). The receipt stays
      // unsettled either way, so the sequential front closes behind it.
      if (inFlightCount() + newDispatchCount < budget) {
        dispatches.push({ nodeId: receipt.nodeId, attempt: (receipt.attempt ?? 0) + 1, round: receipt.round ?? 1 });
        newDispatchCount++;
        if (fuKey) claimedFollowUpTargets.add(fuKey);
      }
      sequentialFrontBlocked = true;
      continue;
    }

    if (receipt.status === 'dispatching') {
      // Mint-before-spawn recovery probe: intent was persisted; did the spawn happen?
      const attempt = receipt.attempt ?? 1;
      // Follow-up modes (GRS-016e): the mint persisted the turnMarker; whether the
      // POST happened is read from the target session's message log — a marker
      // message present means the post landed (adopt the outstanding turn), absent
      // means the crash preceded it (re-post the SAME attempt; the marker was never
      // used, no duplicate turn possible). The workflow mode's CREATION window
      // (no sharedSessionId yet) disambiguates on the shared sessionKey instead —
      // the ordinary adopt-vs-redispatch probe against the key the spawn would use.
      const fuMode = stepById.get(receipt.nodeId)?.sessionMode;
      if (fuMode === 'workflow' || fuMode === 'existing') {
        if (!opts.probeSessionTurn) {
          return recordFailure(receipt, 'session-mode-unsupported', `step "${receipt.nodeId}" uses session mode "${fuMode}" but the driver provides no session-turn probe`, receipt.nodeId);
        }
        if (fuMode === 'workflow' && !next.sharedSessionId) {
          const p = probe(sharedSessionKey(run.runId));
          if (p.found) {
            receipt.status = 'running';
            if (p.sessionId) {
              receipt.sessionId = p.sessionId;
              next.sharedSessionId = p.sessionId;
            }
            receipt.detail = 'session adopted after recovery';
            receipt.at = now();
            changed = true;
            // fall through to the 'running' handling below in this same pass
          } else if (next.stopping) {
            receipt.status = 'failed';
            receipt.detail = 'dispatch abandoned: run stopping';
            receipt.settledAt = now();
            receipt.at = now();
            changed = true;
            continue;
          } else {
            dispatches.push({ nodeId: receipt.nodeId, attempt, round: receipt.round ?? 1 });
            sequentialFrontBlocked = true;
            continue;
          }
        } else {
          const target = fuMode === 'workflow' ? next.sharedSessionId! : stepById.get(receipt.nodeId)?.sessionTarget ?? '';
          const marker = receipt.turnMarker ?? turnMarkerFor(run.runId, receipt.nodeId, attempt, receipt.round ?? 1);
          // ID-ONLY disambiguation (GRS-016e-fix2): the anchor was persisted WITH
          // the dispatching mark, so a recovered receipt always carries it — row
          // present → the post happened (adopt); absent → the id was never used
          // (re-post, no duplicate possible). An anchor-LESS record (a legacy
          // pre-fix2 crash window) is AMBIGUOUS: content matching could pick a
          // stale duplicate marker row (the round-2 finding), so ambiguity is
          // retryable — re-post the attempt under a fresh durable anchor, never
          // adopt any pre-crash reply by content.
          const q = receipt.turnAnchor
            ? opts.probeSessionTurn({ sessionId: target, marker, anchor: receipt.turnAnchor })
            : { found: false } as SessionTurnProbe;
          if (q.found && q.markerPosted) {
            receipt.status = 'running';
            receipt.sessionId = target;
            receipt.detail = 'follow-up turn adopted after recovery';
            receipt.at = now();
            changed = true;
            // fall through to the 'running' handling below in this same pass
          } else if (next.stopping) {
            receipt.status = 'failed';
            receipt.detail = 'dispatch abandoned: run stopping';
            receipt.settledAt = now();
            receipt.at = now();
            changed = true;
            continue;
          } else {
            // Post never happened — or the target vanished (then the re-post fails
            // honestly through markSpawnFailure and the step's policy chain).
            dispatches.push({ nodeId: receipt.nodeId, attempt, round: receipt.round ?? 1 });
            sequentialFrontBlocked = true;
            continue;
          }
        }
      } else {
        const p = probe(stepSessionKey(run.runId, receipt.nodeId, attempt, receipt.round ?? 1));
        if (p.found) {
          // output:'none' (GRS-016d): the session EXISTING is the whole contract —
          // "spawned, never awaited". A crash between spawn and the fired persist
          // recovers straight to `fired`; the session is never adopted as running
          // (nothing would ever probe it again).
          if (stepById.get(receipt.nodeId)?.output === 'none') {
            receipt.status = 'fired';
            if (p.sessionId) receipt.sessionId = p.sessionId;
            receipt.detail = 'session fired (output: none — not awaited)';
            receipt.settledAt = now();
            receipt.at = now();
            changed = true;
            continue;
          }
          // Crash landed AFTER the spawn — adopt the session, never duplicate it.
          receipt.status = 'running';
          if (p.sessionId) receipt.sessionId = p.sessionId;
          receipt.detail = 'session adopted after recovery';
          receipt.at = now();
          changed = true;
          // fall through to the 'running' handling below in this same pass
        } else if (next.stopping) {
          // Draining: the intent was persisted but the spawn never happened — abandon
          // it rather than starting new work on a failing run.
          receipt.status = 'failed';
          receipt.detail = 'dispatch abandoned: run stopping';
          receipt.settledAt = now();
          receipt.at = now();
          changed = true;
          continue;
        } else {
          // Crash landed BEFORE the spawn — the key was never used; same attempt again.
          // (Re-drives an already-counted in-flight receipt: no newDispatchCount.)
          dispatches.push({ nodeId: receipt.nodeId, attempt, round: receipt.round ?? 1 });
          sequentialFrontBlocked = true;
          continue;
        }
      }
    }

    if (receipt.status === 'running') {
      const attempt = receipt.attempt ?? 1;
      const step = stepById.get(receipt.nodeId);
      const sessionKey = stepSessionKey(run.runId, receipt.nodeId, attempt, receipt.round ?? 1);
      // Follow-up modes (GRS-016e): the turn's evidence lives in the TARGET session,
      // correlated by the persisted marker — mapped into the same probe shape so the
      // whole resolution below (idle extraction, error, interrupted/missing, the
      // retry/optional/onError chain) runs verbatim. An idle session with no
      // assistant message AFTER the marker is an honest no-output — a reply that
      // belongs to an EARLIER turn is never adopted (message order is the frame).
      // Timeout never applies here: validation refuses timeoutMinutes on follow-up
      // modes (the stop would kill a session the workflow does not own).
      const fuRunMode = step?.sessionMode;
      let p: StepSessionProbe;
      if (fuRunMode === 'workflow' || fuRunMode === 'existing') {
        if (!opts.probeSessionTurn) {
          return recordFailure(receipt, 'session-mode-unsupported', `step "${receipt.nodeId}" uses session mode "${fuRunMode}" but the driver provides no session-turn probe`, receipt.nodeId);
        }
        const target = fuRunMode === 'workflow' ? next.sharedSessionId : step?.sessionTarget;
        if (!target) {
          p = { found: false };
        } else if (!receipt.turnAnchor) {
          // An anchor-less RUNNING follow-up receipt (legacy pre-fix2 record):
          // correlation cannot be established by identity and content matching is
          // banned (round-2 finding) — ambiguity is retryable, mapped to
          // 'interrupted' so the retry policy re-posts under a durable anchor.
          p = { found: true, sessionId: target, status: 'interrupted' };
        } else {
          const marker = receipt.turnMarker ?? turnMarkerFor(run.runId, receipt.nodeId, attempt, receipt.round ?? 1);
          const q = opts.probeSessionTurn({ sessionId: target, marker, anchor: receipt.turnAnchor });
          // SUPERSEDED (GRS-016e-fix round 2): a user row cut in before our reply —
          // our turn was interrupted by an outside actor. Mapped to 'interrupted' so
          // the shared arm below routes the retry policy (default respawn-once
          // RE-POSTS); the interloper's reply is never adopted. An idle session
          // whose ANCHOR ROW is gone (never landed / deleted) is the same class:
          // our turn never materialized — retryable, never a content guess.
          if (q.found && q.status === 'idle' && q.markerPosted && q.superseded) {
            p = { found: true, sessionId: target, status: 'interrupted' };
          } else if (q.found && q.status === 'idle' && !q.markerPosted) {
            p = { found: true, sessionId: target, status: 'interrupted' };
          } else {
            p = {
              found: q.found,
              sessionId: target,
              ...(q.status ? { status: q.status } : {}),
              ...(q.found && q.status === 'idle'
                ? { finalAssistantText: q.replyText ?? null }
                : {}),
            };
          }
        }
      } else {
        p = probe(sessionKey);
      }
      const status: StepSessionStatus | 'missing' = p.found && p.status ? p.status : 'missing';

      if (status === 'running' || status === 'waiting') {
        // Per-attempt wall-clock budget (GRS-016b `timeoutMinutes`): sweep-enforced —
        // the 15s reconciler IS the clock, no second timeout system. A breach emits a
        // STOP intent (the session is live and burning tokens — operator ruling #2)
        // and routes through retry/optional/onError like any other failure. A session
        // that FINISHED before a sweep noticed is settled normally by the idle branch
        // — timeout applies only "while its session is still running" (design §2.1).
        const timeoutMin = step?.timeoutMinutes;
        if (timeoutMin !== undefined && receipt.dispatchedAt) {
          const startMs = Date.parse(receipt.dispatchedAt);
          const nowMs = Date.parse(now());
          if (Number.isFinite(startMs) && Number.isFinite(nowMs) && nowMs - startMs > timeoutMin * 60_000) {
            stops.push({
              nodeId: receipt.nodeId,
              attempt,
              round: receipt.round ?? 1,
              ...(receipt.sessionId ?? p.sessionId ? { sessionId: receipt.sessionId ?? p.sessionId } : {}),
              sessionKey,
              reason: `step-timeout: exceeded ${timeoutMin} minute(s) on attempt ${attempt}`,
            });
            const message = `step "${receipt.nodeId}" session exceeded its ${timeoutMin}-minute budget on attempt ${attempt} (stopped)`;
            const routed = routeFailure(receipt, step, attempt, 'timeout', message,
              `optional step skipped: session exceeded its ${timeoutMin}-minute budget`);
            if (routed === 'terminal') return recordFailure(receipt, 'step-timeout', message, receipt.nodeId);
            continue;
          }
        }
        sequentialFrontBlocked = true;
        continue; // in flight — later receipts may still settle/dispatch (budget > 1)
      }
      if (status === 'idle') {
        // Outcome extraction (GRS-014c). A session that settled without ANY assistant
        // output did not do the work — the status reconciler force-idles hung sessions,
        // and treating that as `done` would be the forced-idle false completion. Honest
        // failure (or skip, for optional steps) instead — retryable as 'no-output'.
        const text = p.finalAssistantText;
        if (typeof text !== 'string' || text.trim() === '') {
          const message = `step "${receipt.nodeId}" session settled with no output${exhaustionSuffix(step, attempt, 'no-output')}`;
          const routed = routeFailure(receipt, step, attempt, 'no-output', message,
            'optional step skipped: session settled with no output');
          if (routed === 'terminal') return recordFailure(receipt, 'step-no-output', message, receipt.nodeId);
          continue;
        }
        receipt.status = 'done';
        receipt.detail = 'session settled';
        receipt.outcome = outcomeFor(step, receipt.sessionId ?? p.sessionId ?? '', text);
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      if (status === 'error') {
        // The engine RAN and reported failure. Not retried by default (v2 — retrying
        // the same prompt re-rolls the dice, so it costs a deliberate `retry.on:
        // ['error']`), unlike interruptions, where the work never finished at all.
        const message = `step "${receipt.nodeId}" session ended in error${exhaustionSuffix(step, attempt, 'error')}`;
        const routed = routeFailure(receipt, step, attempt, 'error', message,
          'optional step skipped: session errored');
        if (routed === 'terminal') return recordFailure(receipt, 'step-errored', message, receipt.nodeId);
        continue;
      }
      // interrupted (gateway restart killed the engine) or missing (registry lost
      // it): the attempt never ran to completion — retried under the 'interrupted'
      // cause (the default policy's respawn-once; a declared policy replaces it).
      {
        const message = `step "${receipt.nodeId}" session was ${status} on attempt ${attempt} (${
          !step?.retry
            ? 'respawn-once exhausted'
            : retryFor(step).on.includes('interrupted')
              ? `retry exhausted: ${retryFor(step).maxAttempts} attempt(s)`
              : 'retry does not cover interruptions'
        })`;
        const routed = routeFailure(receipt, step, attempt, 'interrupted', message,
          `optional step skipped: session ${status} after ${attempt} attempts`);
        if (routed === 'terminal') return recordFailure(receipt, 'step-interrupted', message, receipt.nodeId);
        continue;
      }
    }
  }

  if (undecidedLoopBoundary()) {
    return mkResult(); // the segment settled this pass — decide before any terminal
  }

  // Honest drain terminal (GRS-016a): a stopping run reaches its terminal only when
  // the last in-flight receipt has settled — never while sessions are live.
  //
  // LIVENESS CONTRACT (GRS-016a-fix, Codex finding 3): the drain deliberately has no
  // timeout system of its own — it waits on the SAME completion signals as any step,
  // and those already have backstops that this walk converts into drain terminals:
  //   - gateway restart → recoverStaleSessions stamps running sessions `interrupted`
  //     → settled `failed` above (no respawn while stopping);
  //   - lost completion / dead heartbeat → the status reconciler two-strikes the
  //     session to `idle` → probed idle-with-no-output → `step-no-output` above.
  // A session with a genuinely LIVE engine turn is honestly in flight, not wedged —
  // the drain waits exactly as long as a real turn runs. Per-step wall-clock caps
  // (`timeoutMinutes` + stopStepSession) are GRS-016b and bound that too.
  if (next.stopping) {
    if (inFlightCount() > 0) return mkResult(); // dispatches is empty by construction while stopping
    const at = now();
    next.status = next.stopping.to;
    next.endedAt = at;
    next.errors = [...(next.errors ?? []), ...next.stopping.errors];
    next.stopping = { ...next.stopping, errors: [] }; // folded; the field stays as drain evidence
    return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
  }

  // Still working: receipts in flight, intents to execute, or pending work whose
  // predecessors haven't settled yet (budget-starved or waiting on a sibling branch).
  // Failed-continue receipts count as resolved (the run completes AROUND them).
  if (steps.some((s) => !isResolved(s))) {
    return mkResult();
  }

  // Every receipt settled → workflow-level run gates, then the earned terminal.
  // Operator-approved run gates (resolve-gate API, GRS-014e) are skipped — without
  // that record an approved run would re-park on the same gate forever.
  const resolved = new Set(next.resolvedRunGates ?? []);
  const blockingRunGate = plan.runGates.find((g) => g.blocking && !resolved.has(runGateKey(g)));
  if (blockingRunGate) {
    next.status = 'parked';
    next.parked = parkedFromGate('runGate', null, blockingRunGate, now());
    return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
  }
  next.status = 'completed';
  next.endedAt = now();
  return { run: next, changed: true, dispatches: [], ...(stops.length > 0 ? { stops } : {}) };
}

/**
 * Probe-only pass over a PARKED run (GRS-016a, design §3.4): a park is a global
 * dispatch freeze, but sibling sessions already in flight keep running — their
 * receipts must stay truthful while the run awaits the human. This pass ADOPTS
 * `dispatching` receipts whose spawn actually happened and settles receipts whose
 * sessions finished CLEANLY (idle with output → done + outcome). Everything
 * problematic — error, interrupted, vanished, idle-with-no-output — is deliberately
 * LEFT IN PLACE: those resolutions can fail the run or respawn a step, and both are
 * decisions for the resume path (resolve-gate), where the full policy applies. Never
 * parks, never dispatches, never touches run status.
 */
function probeOnlyPass(
  run: WorkflowRun,
  plan: ExecutionPlan,
  probe: ProbeStepSession,
  now: () => string,
  opts: AdvanceOptions = {},
): AdvanceResult {
  const steps = run.steps.map((r) => ({ ...r }));
  const next: WorkflowRun = { ...run, steps };
  const { stepById } = indexPlan(plan);
  let changed = false;

  for (const receipt of steps) {
    if (!IN_FLIGHT_STEP_STATUSES.has(receipt.status)) continue;
    const attempt = receipt.attempt ?? 1;

    // Follow-up modes (GRS-016e): the same adopt/settle rules as the running walk,
    // read from the target session's marker-correlated log. Every FAILURE decision
    // (vanished target, error, no-output) stays deferred to resume — probe-only
    // makes no control-flow decisions (016a's rule).
    const fuStep = stepById.get(receipt.nodeId);
    if (fuStep?.sessionMode === 'workflow' || fuStep?.sessionMode === 'existing') {
      const probeTurn = opts.probeSessionTurn;
      if (!probeTurn) continue; // an older driver — resolution waits for resume
      if (receipt.status === 'dispatching' && fuStep.sessionMode === 'workflow' && !next.sharedSessionId) {
        const shared = probe(sharedSessionKey(run.runId));
        if (!shared.found) continue; // unspawned intent stays until resume
        receipt.status = 'running';
        if (shared.sessionId) {
          receipt.sessionId = shared.sessionId;
          next.sharedSessionId = shared.sessionId;
        }
        receipt.detail = 'session adopted after recovery';
        receipt.at = now();
        changed = true;
      }
      const target = fuStep.sessionMode === 'workflow' ? next.sharedSessionId : fuStep.sessionTarget;
      if (!target) continue;
      // ID-ONLY under a park too (GRS-016e-fix2): an anchor-less legacy receipt is
      // ambiguous — its retryable resolution is a failure-class decision that
      // belongs to the resume path, so it stays in place here.
      if (!receipt.turnAnchor) continue;
      const marker = receipt.turnMarker ?? turnMarkerFor(run.runId, receipt.nodeId, attempt, receipt.round ?? 1);
      const q = probeTurn({ sessionId: target, marker, anchor: receipt.turnAnchor });
      if (!q.found) continue;
      if (receipt.status === 'dispatching') {
        if (!q.markerPosted) continue; // unposted intent stays until resume
        receipt.status = 'running';
        receipt.sessionId = target;
        receipt.detail = 'follow-up turn adopted after recovery';
        receipt.at = now();
        changed = true;
      }
      if (q.status === 'idle' && q.markerPosted && typeof q.replyText === 'string' && q.replyText.trim() !== '') {
        receipt.status = 'done';
        receipt.detail = 'session settled';
        receipt.outcome = outcomeFor(fuStep, target, q.replyText);
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
      }
      continue;
    }

    const p = probe(stepSessionKey(run.runId, receipt.nodeId, attempt, receipt.round ?? 1));
    if (!p.found) continue;

    if (receipt.status === 'dispatching') {
      // Adopt-after-crash, same rules as the running walk (incl. GRS-016d: a
      // none-output node's found session recovers straight to `fired` — the spawn
      // happening IS its settle); an unspawned intent stays dispatching until
      // resume (re-dispatching would be new work under a park).
      if (stepById.get(receipt.nodeId)?.output === 'none') {
        receipt.status = 'fired';
        if (p.sessionId) receipt.sessionId = p.sessionId;
        receipt.detail = 'session fired (output: none — not awaited)';
        receipt.settledAt = now();
        receipt.at = now();
        changed = true;
        continue;
      }
      receipt.status = 'running';
      if (p.sessionId) receipt.sessionId = p.sessionId;
      receipt.detail = 'session adopted after recovery';
      receipt.at = now();
      changed = true;
    }

    const text = p.finalAssistantText;
    if (p.status === 'idle' && typeof text === 'string' && text.trim() !== '') {
      receipt.status = 'done';
      receipt.detail = 'session settled';
      // Same output-mode rule as the running walk (GRS-016b): a parked settle must
      // not extract differently from a running one. Timeouts are deliberately NOT
      // enforced here — probe-only defers every FAILURE decision to resume (016a
      // argued deviation 1), and a timeout is a failure decision.
      receipt.outcome = outcomeFor(stepById.get(receipt.nodeId), receipt.sessionId ?? p.sessionId ?? '', text);
      receipt.settledAt = now();
      receipt.at = now();
      changed = true;
    }
  }

  return { run: next, changed, dispatches: [] };
}

/** Identity of a workflow-level run gate for the resolve record: ref wins, else description. */
export function runGateKey(g: Pick<GatePlan, 'ref' | 'description'>): string {
  return g.ref ?? g.description;
}

/* ── Driver-side transition helpers (kept here so every state write is pure + tested) ── */

/** The receipt for (nodeId, round). Rounds duplicate nodeIds (GRS-014e), so lookups are
 * round-qualified; absent round on a receipt means round 1. */
function mustReceipt(run: WorkflowRun, nodeId: string, round = 1): RunStepReceipt {
  const r = run.steps.find((s) => s.nodeId === nodeId && (s.round ?? 1) === round);
  if (!r) throw new Error(`run ${run.runId} has no receipt for node "${nodeId}" round ${round}`);
  return r;
}

/** LAST receipt for a nodeId (the current round) — used by gate resolution, where the
 * parked gate node's newest receipt is the one being resolved. */
function lastReceiptFor(run: WorkflowRun, nodeId: string): RunStepReceipt | null {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    if (run.steps[i].nodeId === nodeId) return run.steps[i];
  }
  return null;
}

/** Persistable copy with the receipt marked `dispatching` — the record of INTENT,
 * written BEFORE the spawn/post. Follow-up dispatches (GRS-016e) mint their
 * `turnMarker` AND their pre-minted `turnAnchor` here (GRS-016e-fix2) — the
 * anchor row id is durable BEFORE the row it names can exist, so a recovered
 * receipt always disambiguates by id, never by content. */
export function markDispatching(
  run: WorkflowRun,
  nodeId: string,
  attempt: number,
  now: () => string,
  round = 1,
  opts: { turnMarker?: string; turnAnchor?: string } = {},
): WorkflowRun {
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const receipt = mustReceipt(next, nodeId, round);
  const at = now();
  receipt.status = 'dispatching';
  receipt.attempt = attempt;
  receipt.dispatchedAt = at;
  receipt.at = at;
  receipt.detail = attempt > 1 ? `respawn (attempt ${attempt})` : 'dispatching';
  if (opts.turnMarker) receipt.turnMarker = opts.turnMarker;
  if (opts.turnAnchor) receipt.turnAnchor = opts.turnAnchor;
  return next;
}

/** Persistable copy with the receipt marked `running` under its spawned session.
 * (The follow-up settle anchor is NOT stamped here — GRS-016e-fix2 persists it
 * with the dispatching mark, before the post, so no crash window can lose it.) */
export function markRunning(run: WorkflowRun, nodeId: string, spawn: SpawnResult, now: () => string, round = 1): WorkflowRun {
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const receipt = mustReceipt(next, nodeId, round);
  receipt.status = 'running';
  receipt.sessionId = spawn.sessionId;
  if (spawn.detail) receipt.detail = spawn.detail;
  receipt.at = now();
  return next;
}

/**
 * Persistable copy with a DEFERRED follow-up dispatch reverted to `pending`
 * (GRS-016e-fix, Codex finding 2): the poster's atomic busy check found the
 * target busy, so the marker row was NEVER inserted — the attempt is handed back
 * (un-consumed), the minted marker dropped (the same attempt re-mints the same
 * deterministic marker later), and the next sweep retries once the target is
 * free. A crash between the dispatching persist and this revert recovers through
 * the ordinary marker probe: no anchor row exists, so the same attempt re-posts.
 */
export function markFollowUpDeferred(run: WorkflowRun, nodeId: string, reason: string, now: () => string, round = 1): WorkflowRun {
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const receipt = mustReceipt(next, nodeId, round);
  receipt.status = 'pending';
  receipt.attempt = Math.max((receipt.attempt ?? 1) - 1, 0);
  delete receipt.turnMarker;
  delete receipt.dispatchedAt;
  receipt.detail = `follow-up deferred: ${reason}`;
  receipt.at = now();
  return next;
}

/**
 * Persistable copy with the receipt SETTLED `fired` at spawn success (GRS-016d,
 * output:'none'): sessionId recorded, settledAt stamped, NO outcome — the session
 * is never probed and the run never blocks on it. The driver calls this instead of
 * markRunning for fire-and-forget steps; successors treat the receipt exactly like
 * an outcome-less settled predecessor (inline/checkpoint — no handoff section).
 */
export function markFired(run: WorkflowRun, nodeId: string, spawn: SpawnResult, now: () => string, round = 1): WorkflowRun {
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const receipt = mustReceipt(next, nodeId, round);
  const at = now();
  receipt.status = 'fired';
  receipt.sessionId = spawn.sessionId;
  receipt.detail = 'session fired (output: none — not awaited)';
  receipt.settledAt = at;
  receipt.at = at;
  return next;
}

/**
 * Persistable copy after a spawn FAILURE: optional steps degrade to `skipped` (the run
 * keeps advancing); required steps fail the run.
 */
export function markSpawnFailure(
  run: WorkflowRun,
  plan: ExecutionPlan,
  nodeId: string,
  error: string,
  now: () => string,
  round = 1,
): WorkflowRun {
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const receipt = mustReceipt(next, nodeId, round);
  const at = now();
  const optional = plan.steps.find((s) => s.nodeId === nodeId)?.optional === true;
  if (optional) {
    receipt.status = 'skipped';
    receipt.detail = `optional step skipped: spawn failed: ${error}`;
    receipt.settledAt = at;
    receipt.at = at;
    return next;
  }
  receipt.status = 'failed';
  receipt.detail = `spawn failed: ${error}`;
  receipt.settledAt = at;
  receipt.at = at;
  // onError:'continue' (GRS-016b) survives a spawn failure too: the receipt is
  // honest `failed` evidence, the run proceeds. Spawn failures are never retried
  // (the spawner is the authority — an unknown model/employee stays unknown).
  const onError = plan.steps.find((s) => s.nodeId === nodeId)?.onError;
  if (onError === 'continue') {
    receipt.detail = `spawn failed: ${error} — run continues (onError: continue)`;
    return next;
  }
  // onError:'error-edge' (GRS-016d): a spawn failure IS a terminal step failure —
  // it routes down the error lane like any other (the next advance pass flips the
  // edge activity off this settled `failed` receipt).
  if (onError === 'error-edge') {
    receipt.detail = `spawn failed: ${error} — routed to the error lane (onError: error-edge)`;
    return next;
  }
  const failure = { code: 'spawn-failed', message: `step "${nodeId}" spawn failed: ${error}`, ref: nodeId };
  // A failing run never honors a pause (GRS-016d) — same rule as recordFailure.
  cancelWaitingReceipts(next.steps, at);
  // Honest drain (GRS-016a): with OTHER receipts still in flight the run enters
  // `stopping` instead of freezing them inside a terminal record; the drain terminal
  // folds the error in once the last in-flight receipt settles.
  if (next.steps.some((s) => IN_FLIGHT_STEP_STATUSES.has(s.status))) {
    next.stopping = {
      to: next.stopping?.to ?? 'failed',
      at: next.stopping?.at ?? at,
      errors: [...(next.stopping?.errors ?? []), failure],
    };
    return next;
  }
  next.status = 'failed';
  next.endedAt = at;
  next.errors = [...(next.errors ?? []), ...(next.stopping?.errors ?? []), failure];
  if (next.stopping) next.stopping = { ...next.stopping, errors: [] };
  return next;
}

/* ── Gate resolution (GRS-014e) — the pure half of the resolve-gate API ────────── */

export type ResolveGateDecision = 'approve' | 'reject';

export type ResolveGateResult =
  | { ok: true; run: WorkflowRun }
  | { ok: false; code: 'not-parked'; message: string };

export interface ResolveParkedGateOptions {
  decidedBy?: string;
}

/**
 * Resolve a parked run's human-approval gate (pure; the driver persists + re-drives).
 *
 *   approve + gateNode scope → the gate node's CURRENT receipt settles as `checkpoint`
 *     ("approved by operator") and the run returns to `running` — the next advance
 *     pass proceeds past it naturally (the settled receipt IS the durable approval).
 *   approve + runGate scope  → the gate's key is recorded in `resolvedRunGates` (the
 *     durable approval — the terminal check skips it) and the run returns to `running`;
 *     the next advance pass either completes the run or parks on the NEXT unresolved
 *     blocking run gate (multi-gate definitions resolve one at a time, honestly).
 *   reject (either scope)    → the run FAILS with `gate-rejected`; a gateNode's
 *     receipt records "rejected by operator". Rejection is terminal — re-running the
 *     workflow is a new run.
 *
 * Parked runs are excluded from sweeps (nothing polls a human) — this transition is
 * the ONLY way a parked run moves again.
 */
export function resolveParkedGate(
  run: WorkflowRun,
  decision: ResolveGateDecision,
  now: () => string,
  opts: ResolveParkedGateOptions = {},
): ResolveGateResult {
  if (run.status !== 'parked' || !run.parked) {
    return { ok: false, code: 'not-parked', message: `run ${run.runId} is ${run.status}, not parked` };
  }
  const parked = run.parked;
  const next: WorkflowRun = { ...run, steps: run.steps.map((r) => ({ ...r })) };
  const at = now();
  const decidedBy = opts.decidedBy ?? 'operator';

  if (decision === 'reject') {
    if (parked.scope === 'gateNode' && parked.nodeId) {
      const receipt = lastReceiptFor(next, parked.nodeId);
      if (receipt) {
        receipt.status = 'failed';
        receipt.detail = `rejected by ${decidedBy}`;
        receipt.settledAt = at;
        receipt.at = at;
      }
    }
    // A rejected run never honors a pause (GRS-016d): a `waiting` sibling would
    // otherwise sit non-terminal inside this terminal record.
    cancelWaitingReceipts(next.steps, at);
    next.status = 'failed';
    next.endedAt = at;
    next.parked = null;
    next.errors = [
      ...(next.errors ?? []),
      {
        code: 'gate-rejected',
        message: `${decidedBy} rejected the ${parked.scope === 'runGate' ? 'workflow run gate' : `gate "${parked.nodeId}"`}: ${parked.description}`,
        ...(parked.nodeId ? { ref: parked.nodeId } : {}),
      },
    ];
    return { ok: true, run: next };
  }

  // approve
  if (parked.scope === 'gateNode' && parked.nodeId) {
    const receipt = lastReceiptFor(next, parked.nodeId);
    if (receipt) {
      receipt.status = 'checkpoint';
      receipt.detail = `approved by ${decidedBy}`;
      receipt.settledAt = at;
      receipt.at = at;
    }
  } else {
    const key = parked.ref ?? parked.description;
    next.resolvedRunGates = [...new Set([...(next.resolvedRunGates ?? []), key])];
  }
  next.status = 'running';
  next.parked = null;
  return { ok: true, run: next };
}
