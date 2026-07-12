import { randomUUID } from 'node:crypto';
import { resolveExecutionPlan, type ExecutionPlan } from './execution-plan.js';
import type { EditableWorkflowDefinition } from './definition.js';
import type { WorkflowTodoEventFeed } from '../work-items/workflow-event-feed.js';
import {
  buildStepPrompt,
  edgeLabelBetween,
  referencedHandoffFieldKeys,
  type FailedPredecessor,
  type PredecessorHandoff,
} from './handoff.js';
import { impliedExecutionOrder } from './order.js';
import {
  advanceRun,
  createRunEdgeActivity,
  markDispatching,
  markFired,
  markFollowUpDeferred,
  markRunning,
  markSpawnFailure,
  requestWorkflowRunTerminal,
  mintSequentialRun,
  resolveParkedGate,
  sharedSessionKey,
  turnMarkerFor,
  turnMarkerLinePrefix,
  type PostStepFollowUp,
  type ProbeSessionTurn,
  type ProbeStepSession,
  type ResolveGateDecision,
  type SpawnResult,
  type SpawnStep,
  type StopIntent,
  type StopStepSession,
} from './advance.js';
import {
  claimWorkflowRunInvocation,
  findRunByTriggerFireRef,
  findWorkflowRunInvocationClaimByRunId,
  getRun,
  getWorkflowRunInvocationClaim,
  hasInFlightSteps,
  isWorkflowTriggerEvent,
  listActiveRunRefs,
  rebuildActiveRunIndex,
  newRunId,
  normalizeWorkflowTrigger,
  publishInitialWorkflowRun,
  workflowTriggerSource,
  saveRun,
  WORKFLOW_RUN_SCHEMA_VERSION,
  type WorkflowRun,
  type InitialWorkflowRunPublication,
  type WorkflowRunInvocation,
  type WorkflowRunParameters,
  type WorkflowStepPromptOverride,
  type RunStepStatus,
  type WorkflowTriggerEvent,
  type WorkflowRunTrigger,
} from './run-store.js';
import {
  createWorkflowRunInvocationRequest,
  fingerprintWorkflowRunInvocationRequest,
  workflowRunPrincipal,
  WorkflowRunIdempotencyConflict,
  type WorkflowRunInvocationClaim,
} from './run-idempotency.js';
import { createPendingWorkflowGateApproval, freezeWorkflowApprovalEscalation } from './approval-authority.js';
import {
  projectWorkflowRunActivity,
  stampWorkflowRunReportEpisode,
  type WorkflowReportingContext,
} from './reporting.js';

/**
 * Workflow RUN RECONCILER + driver (GRS-014b) — the impure half of the v2 engine.
 *
 * The pure planner (`advance.ts`) decides WHAT happens next; this module makes it
 * durable: it persists every transition (atomic run-file overwrites), executes
 * dispatch intents (mint-before-spawn: persist `dispatching`, spawn under the
 * deterministic sessionKey, persist `running`), and re-advances until the run is
 * in flight, quietly parked, or terminal.
 *
 * WHO ADVANCES A RUN (design D3 — no second scheduler):
 *   1. `startWorkflowRun` — the POST …/run route mints the durable record BEFORE any
 *      spawn, then drives the first advancement.
 *   2. `startWorkflowRunReconciler` — a 15s sweep (the same setInterval primitive
 *      `gateway/status-reconciler.ts` uses) plus one immediate STARTUP sweep. It reads
 *      each running run's step session by deterministic sessionKey and re-derives;
 *      native-approved parked runs with in-flight siblings are probed for truthful
 *      sibling evidence without auto-resolving or unparking them.
 *      Boot ordering matters: the gateway starts it after `recoverStaleSessions()` has
 *      stamped dead sessions `interrupted`, so the sweep sees truthful evidence —
 *      that IS the crash-recovery story (GRS-003a pattern).
 *   3. (GRS-014e) the resolve-gate route will unpark and call back into the driver.
 *   Quiet parked runs are not swept — nothing polls a human. Native-approved
 *   parked runs with in-flight siblings are swept probe-only and never auto-resolve
 *   or unpark.
 *
 * CONCURRENCY: exclusive initial publication elects one owner across processes;
 * only that owner may mint/spawn. A per-runId in-process mutex then
 * serializes route-vs-sweep advancement. One misbehaving run never kills a sweep.
 */

export interface RunDriverDeps {
  /** Evidence root the run/definition stores live under. */
  root: string;
  getDefinition: (root: string, id: string) => EditableWorkflowDefinition | null;
  /** Session lookup by sessionKey — the gateway wires registry.getSessionBySessionKey. */
  probeStepSession: ProbeStepSession;
  /** The real spawner (gateway: spawnWorkflowStepSession); tests inject a stub. */
  spawnStep: SpawnStep;
  /** Stops a live step session (GRS-016b timeouts — the gateway kills the engine
   * turn + idles the session). OPTIONAL: without it, timed-out receipts still settle
   * honestly and the abandoned session finishes naturally (logged). Best-effort:
   * executed AFTER the settle is persisted, BEFORE any dispatch. */
  stopStepSession?: StopStepSession;
  /** Deterministic loop exit-gate evaluator (GRS-014e) — the gateway wires the real
   * artifact/flag evidence check over the root; absent = gates never pass. */
  evaluateGate?: (gate: import('./execution-plan.js').GatePlan) => boolean;
  /**
   * Session-turn probe (GRS-016e) — marker-correlated evidence for follow-up-mode
   * receipts (session mode 'workflow'/'existing'). REQUIRED (with postStepFollowUp)
   * to run session-mode definitions; a driver without the pair refuses such a run
   * at START (`session-mode-unsupported`) rather than wedging it mid-flight.
   */
  probeSessionTurn?: ProbeSessionTurn;
  /** Posts a follow-up turn (user message + engine dispatch) into an existing
   * gateway session (GRS-016e). Throws when the target is gone or does not match
   * the step's declared actor — an honest spawn-failure for the policy chain. */
  postStepFollowUp?: PostStepFollowUp;
  /** Existence check for `session.mode:'existing'` targets, evaluated at run START
   * (the gateway wires the session registry). Mid-run deletion is handled by the
   * probe/post failing honestly through the step's retry/onError policy. */
  sessionExists?: (sessionId: string) => boolean;
  /** Narrow, read/claim-only Todo event boundary. Workflow runtime never receives
   * the underlying session database or Todo ledger storage. */
  todoEventFeed?: WorkflowTodoEventFeed;
  /** Injectable publication boundary for deterministic concurrency tests. */
  publishInitialRun?: (root: string, run: WorkflowRun) => InitialWorkflowRunPublication;
  /** Best-effort durable chat projection + shared Session delivery claim. */
  reporting?: WorkflowReportingContext;
  now?: () => string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function publishInitialRun(
  deps: RunDriverDeps,
  run: WorkflowRun,
): { owned: true; run: WorkflowRun } | { owned: false; run: WorkflowRun } {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const candidate = stampWorkflowRunReportEpisode(null, run, now);
  const publication = (deps.publishInitialRun ?? publishInitialWorkflowRun)(deps.root, candidate);
  projectPersistedRun(deps, publication.run);
  if (publication.outcome === 'existing') return { owned: false, run: publication.run };
  return { owned: true, run: publication.run };
}

function projectPersistedRun(deps: RunDriverDeps, run: WorkflowRun): void {
  if (!deps.reporting) return;
  try {
    projectWorkflowRunActivity(run, deps.reporting);
  } catch (error) {
    deps.log?.('warn', `[workflow-reporting] projection failed for ${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Persist one authoritative Workflow run revision. */
function persistRun(deps: RunDriverDeps, candidate: WorkflowRun): WorkflowRun {
  const previous = getRun(deps.root, candidate.workflowId, candidate.runId);
  let nativeCandidate = candidate;
  if (previous && previous.status !== 'parked'
    && candidate.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION
    && candidate.status === 'parked' && candidate.parked && !candidate.parked.approval) {
    const definition = candidate.definitionSnapshot ?? deps.getDefinition(deps.root, candidate.workflowId);
    if (definition) {
      nativeCandidate = {
        ...candidate,
        parked: {
          ...candidate.parked,
          approval: createPendingWorkflowGateApproval(
            candidate,
            definition,
            candidate.parked.at ?? (deps.now ?? (() => new Date().toISOString()))(),
          ),
        },
      };
    }
  }
  const stampedBase: WorkflowRun = {
    ...nativeCandidate,
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    revision: Math.max(previous?.revision ?? 0, candidate.revision ?? 0) + 1,
  };
  const stamped = stampWorkflowRunReportEpisode(
    previous,
    stampedBase,
    (deps.now ?? (() => new Date().toISOString()))(),
  );
  const persisted = saveRun(deps.root, stamped);
  projectPersistedRun(deps, persisted);
  return persisted;
}

export interface StartRunOptions {
  /**
   * What starts this run. New trigger emitters pass WorkflowTriggerEvent; legacy
   * callers may still pass {kind,...} for byte-compat evidence.
   * A trigger carrying fireRef is bound to the full canonical invocation intent
   * within (workflowId, stable principal, fireRef). Exact intent replays the
   * original run; changed definition/trigger/input/initial-overrides fails with a
   * typed conflict before any second run record or spawn can be minted.
   */
  trigger?: WorkflowRunTrigger;
  /** Frozen structured parameters supplied for this invocation of the workflow. */
  parameters?: WorkflowRunParameters;
  /** Verified invoking Session relation and sole report mode. */
  invocation?: WorkflowRunInvocation;
  /** Frozen-at-start run-local prompt replacements, keyed by step node id. */
  stepOverrides?: Record<string, WorkflowStepPromptOverride>;
  knownEmployees?: Iterable<string>;
  knownEngines?: Iterable<string>;
  maxNodes?: number;
  makeRunId?: () => string;
  /** Stable authorization namespace. Never use a session/capability/token value. */
  principal?: string;
  /** Allows transports to distinguish an exact replay (200) from a new run (201/422). */
  onIdempotencyReplay?: () => void;
}

/* ── Per-run advancement mutex ──────────────────────────────────────────────── */

const runLocks = new Map<string, Promise<unknown>>();

/** Serialize advancement per runId: route start, sweep ticks, and (later) gate
 * resolution never interleave their read-advance-persist cycles on one run. */
export async function withRunAdvanceLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const tail = runLocks.get(runId) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  // Keep the chain alive past rejections; clean the map when this tail settles last.
  const guard = next.then(
    () => undefined,
    () => undefined,
  );
  runLocks.set(runId, guard);
  void guard.finally(() => {
    if (runLocks.get(runId) === guard) runLocks.delete(runId);
  });
  return next;
}

/* ── Driving ────────────────────────────────────────────────────────────────── */

/** Iteration cap per drive: every receipt can pass-through/dispatch/settle plus slack.
 * A planner bug can never spin the driver — it fails the run loudly instead. */
function driveIterationCap(run: WorkflowRun): number {
  return run.steps.length * 3 + 10;
}

const MAX_CANCELLATION_STOP_FAILURES = 16;
const MAX_CANCELLATION_STOP_FAILURE_MESSAGE_CHARS = 1_000;

function cancellationStopFailure(
  run: WorkflowRun,
  stop: StopIntent,
  error: unknown,
): WorkflowRun {
  const raw = error instanceof Error ? error.message : String(error);
  const message = `could not stop run-owned session ${stop.sessionKey}: ${raw}`
    .slice(0, MAX_CANCELLATION_STOP_FAILURE_MESSAGE_CHARS);
  const evidence = { code: 'run-cancel-stop-failed', message, ref: stop.nodeId };
  const currentErrors = run.stopping?.errors ?? run.errors ?? [];
  if (currentErrors.some((item) => item.code === evidence.code && item.message === evidence.message && item.ref === evidence.ref)) {
    return run;
  }
  const other = currentErrors.filter((item) => item.code !== evidence.code);
  const boundedFailures = [
    ...currentErrors.filter((item) => item.code === evidence.code),
    evidence,
  ].slice(-MAX_CANCELLATION_STOP_FAILURES);
  if (run.stopping) {
    return { ...run, stopping: { ...run.stopping, errors: [...other, ...boundedFailures] } };
  }
  return { ...run, errors: [...other, ...boundedFailures] };
}

function recordCancellationStopOutcome(
  run: WorkflowRun,
  key: string,
  outcome: 'stopped' | 'failed',
  error?: unknown,
): WorkflowRun {
  if (!run.cancellation?.stopAttempts) return run;
  const failure = error === undefined
    ? undefined
    : (error instanceof Error ? error.message : String(error)).slice(0, MAX_CANCELLATION_STOP_FAILURE_MESSAGE_CHARS);
  let changed = false;
  const stopAttempts = run.cancellation.stopAttempts.map((attempt) => {
    if (attempt.key !== key || attempt.outcome !== 'requested') return attempt;
    changed = true;
    return { ...attempt, outcome, ...(failure ? { failure } : {}) };
  });
  return changed ? { ...run, cancellation: { ...run.cancellation, stopAttempts } } : run;
}

/**
 * Assemble a step's prompt (GRS-014c): the node's own instructions + one handoff
 * section per ACTIVE edge predecessor that produced a persisted outcome (edge
 * declaration order) + inline gate descriptions as acceptance criteria. Reads ONLY
 * the frozen definition, the compiled plan, and the run's receipts — reproducible
 * from the run record alone.
 *
 * PREDECESSOR RECEIPT SELECTION (Codex GRS-014e finding 1): in a loop run a nodeId
 * names SEVERAL receipts — one per round — and the freshly spliced PENDING receipt of
 * the round being dispatched would shadow the SETTLED one the handoff must come from.
 * Receipt lookups must carry the execution dimension, and `steps[]` IS that dimension
 * (rounds are spliced in place, so array order = execution order): for each
 * predecessor, the LAST receipt BEFORE the dispatching receipt's own position is the
 * outcome execution actually delivered to this dispatch — the previous round's source
 * for a loop-edge predecessor (b@r1 → a@r2), the current round's receipt for a
 * same-round predecessor (a@r2 → b@r2), and the FINAL round's receipt for a
 * post-loop successor. Everything at or after the dispatch position is pending by the
 * sequential invariant and must never be consulted.
 *
 * ACTIVE EDGES ONLY (GRS-016d-fix, Codex finding 1): collection walks the plan's
 * per-node in-EDGES and includes a predecessor only through an edge that is ACTIVE
 * at the dispatch position — the SAME `createRunEdgeActivity` determination the
 * planner uses for readiness, skip propagation, and routing (016c's invariant that
 * routing and handoffs agree on which edges are live, now enforced by shared code).
 * A predecessor behind a not-taken switch branch, a propagation-skipped node, or
 * the NORMAL lane of a node that failed down its error lane contributes nothing;
 * the error-lane failure notice is keyed off the actual traversed edge
 * (`edge.lane === 'error'`), not merely the predecessor's declared option. The
 * activity stamps are frozen (route / failed / skip receipts), so evaluating them
 * here — after the planner's pass — derives exactly the view the planner had when
 * it made this node ready.
 */
function stepPromptFor(def: EditableWorkflowDefinition, plan: ExecutionPlan, run: WorkflowRun, nodeId: string, round: number): string {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`definition has no node "${nodeId}"`); // driver guards before calling
  const promptOverride = run.stepOverrides?.[nodeId]?.prompt;
  const effectiveNode = promptOverride === undefined ? node : { ...node, instructions: promptOverride };
  const dispatchIndex = run.steps.findIndex((r) => r.nodeId === nodeId && (r.round ?? 1) === round);
  const scanEnd = dispatchIndex === -1 ? run.steps.length : dispatchIndex; // -1 unreachable: markDispatching already resolved this receipt
  const activity = createRunEdgeActivity(run.steps, plan);
  const predecessors: PredecessorHandoff[] = [];
  const failedPredecessors: FailedPredecessor[] = [];
  const visited = new Set<string>([nodeId]);
  /**
   * Collect predecessor material for `forNodeId`, scanning receipts strictly before
   * `before` (the position rule) through ACTIVE in-edges only. A ROUTED switch
   * predecessor (GRS-016c) carries no outcome of its own — the data that flowed
   * INTO it flows THROUGH it (the n8n router semantic): its own predecessors are
   * collected recursively at ITS receipt position (through ITS active in-edges),
   * so review→switch→branch hands review's outcome to the taken branch and only
   * the taken branch. Gate/inline/skipped predecessors deliberately stay opaque
   * (v2 behavior, design §2.3 rule 5). `visited` dedupes a node reachable both
   * through a switch and directly; recursion terminates because positions
   * strictly decrease.
   */
  const collect = (forNodeId: string, before: number, viaSwitch: boolean): void => {
    // The loop BACK-edge is deliberately absent from plan.inEdges (cross-round
    // sequencing is owned by the round splice, not readiness — GRS-014e), but the
    // cross-round HANDOFF flows along it (b@r(n-1) → a@r(n), Codex GRS-014e
    // finding 1): the loop target's collection walks it explicitly, through the
    // same activity determination as every other edge (no lane — the generic
    // settled-source rule applies).
    const inEdges = [
      ...(plan.inEdges?.[forNodeId] ?? []),
      ...(plan.loop && plan.loop.targetId === forNodeId
        ? [{ edgeId: plan.loop.edgeId, from: plan.loop.sourceId }]
        : []),
    ];
    for (const edge of inEdges) {
      const predId = edge.from;
      if (visited.has(predId)) continue;
      // The load-bearing filter: material flows only along edges the run actually
      // traversed. An inactive edge (not-taken route, dead branch, darkened normal
      // lane) contributes nothing — but does not mark the predecessor visited, so
      // a LATER active edge from the same predecessor can still deliver it.
      if (!activity.edgeActiveAt(edge, before)) continue;
      visited.add(predId);
      const receipt = activity.latestReceiptBefore(predId, before);
      if (!receipt) continue; // unreachable: an active edge implies a source receipt
      if (receipt.status === 'routed') {
        collect(predId, run.steps.indexOf(receipt), true);
        continue;
      }
      // A FAILED predecessor reached through an ACTIVE edge is by construction a
      // failure the run SURVIVED — the error lane (GRS-016d; this step IS the
      // error branch) or an onError:'continue' node's onward edge (GRS-016b).
      // Under fail-run the run would be draining and nothing would dispatch. It
      // gets an engine-generated failure NOTICE, worded per the edge actually
      // traversed; no fake outcome is fabricated (design §2.2/§2.4).
      if (receipt.status === 'failed' && !receipt.outcome) {
        failedPredecessors.push({
          nodeId: predId,
          label: receipt.label,
          actorRef: receipt.actor?.ref ?? null,
          ...(receipt.detail ? { detail: receipt.detail } : {}),
          ...(receipt.attempt !== undefined ? { attempts: receipt.attempt } : {}),
          ...(edge.lane === 'error' ? { policy: 'error-edge' as const } : {}),
        });
        continue;
      }
      if (!receipt.outcome) continue; // inline/checkpoint/skipped/fired predecessors carry no outcome
      // Edge labels describe a DIRECT edge; pass-through material has none.
      const edgeLabel = viaSwitch ? undefined : edgeLabelBetween(def, predId, forNodeId);
      predecessors.push({
        nodeId: predId,
        label: receipt.label,
        actorRef: receipt.actor?.ref ?? null,
        ...(edgeLabel ? { edgeLabel } : {}),
        outcome: receipt.outcome,
      });
    }
  };
  collect(nodeId, scanEnd, false);
  // Advertise the fields contract when (and only when) a downstream switch
  // references this node (GRS-016c) — computed from the frozen definition.
  const advertisedFieldKeys = referencedHandoffFieldKeys(def, nodeId);
  return buildStepPrompt({
    workflowId: run.workflowId,
    workflowTitle: run.title,
    runId: run.runId,
    node: effectiveNode,
    predecessors,
    ...(failedPredecessors.length > 0 ? { failedPredecessors } : {}),
    ...(advertisedFieldKeys.length > 0 ? { advertisedFieldKeys } : {}),
    ...(isWorkflowTriggerEvent(run.trigger) ? { trigger: run.trigger } : {}),
    ...(run.parameters ? { input: run.parameters.input } : {}),
  });
}

/**
 * Advance one run to quiescence: repeatedly plan (pure) → persist → execute at most
 * one dispatch → re-plan, until the planner neither changes state nor dispatches.
 * Returns the final persisted snapshot. MUST be called under the run's advance lock.
 */
async function driveRunLocked(deps: RunDriverDeps, def: EditableWorkflowDefinition, plan: ExecutionPlan, run: WorkflowRun): Promise<WorkflowRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  let current = run;
  let iterations = 0;

  for (;;) {
    if (iterations++ > driveIterationCap(current)) {
      current = {
        ...current,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(current.errors ?? []),
          { code: 'advance-loop-exceeded', message: `run advancement exceeded ${driveIterationCap(current)} iterations` },
        ],
      };
      current = persistRun(deps, current);
      deps.log?.('error', `[workflow-runs] run ${current.runId} advancement loop exceeded its cap — failed`);
      return current;
    }

    const result = advanceRun(current, plan, deps.probeStepSession, now, {
      ...(deps.evaluateGate ? { evaluateGate: deps.evaluateGate } : {}),
      ...(deps.probeSessionTurn ? { probeSessionTurn: deps.probeSessionTurn } : {}),
    });
    current = result.run;
    if (result.changed) current = persistRun(deps, current);

    // Execute STOP intents (GRS-016b timeouts) AFTER persisting the settle and
    // BEFORE any dispatch — a timeout-retry must stop the old attempt's session
    // before attempt N+1 spawns. Persist-then-stop (not stop-then-persist): a crash
    // in between leaks at most one naturally-finishing session (bounded tokens),
    // whereas a stop whose settle was lost would force-idle a session mid-turn and
    // the next sweep would mis-read the kill as an honest completion/no-output.
    // Best-effort: a stop failure is logged, never fatal, and never blocks the run.
    for (const stop of result.stops ?? []) {
      if (!deps.stopStepSession) {
        deps.log?.('warn', `[workflow-runs] run ${current.runId}: no stopStepSession injected — timed-out session ${stop.sessionKey} left to finish naturally`);
        continue;
      }
      try {
        await deps.stopStepSession({ ...stop, runId: current.runId, workflowId: current.workflowId });
        if (stop.cancellationAttemptKey) {
          current = persistRun(deps, recordCancellationStopOutcome(current, stop.cancellationAttemptKey, 'stopped'));
        }
        deps.log?.('info', `[workflow-runs] run ${current.runId}: stopped step session ${stop.sessionKey} (${stop.reason})`);
      } catch (err) {
        deps.log?.('warn', `[workflow-runs] run ${current.runId}: stopping step session ${stop.sessionKey} failed: ${(err as Error).message}`);
        if (current.cancellation && stop.reason === 'run-stopping: terminal cancelled requested') {
          const withOutcome = stop.cancellationAttemptKey
            ? recordCancellationStopOutcome(current, stop.cancellationAttemptKey, 'failed', err)
            : current;
          current = persistRun(deps, cancellationStopFailure(withOutcome, stop, err));
        }
      }
    }
    // A terminal drain request can be discovered after the planner already
    // collected this pass's dispatch batch. Re-plan under `stopping` before using
    // those stale intents; a failing run must never start new siblings.
    // Quiescent only when a pass neither changed state nor asked for a dispatch. A
    // changed-but-dispatchless pass (a settle at an undecided loop boundary, a loop
    // splice, a loopExit stamp — GRS-014e; a drain settle or a parked probe-only
    // settle — GRS-016a) must re-plan immediately, not wait a sweep.
    if (result.dispatches.length === 0) {
      if (!result.changed || current.status !== 'running') return current;
      continue;
    }

    // Execute the ready-set batch (GRS-016a) SEQUENTIALLY IN ARRAY ORDER under the
    // run lock: per intent — persist `dispatching` (mint-before-spawn), spawn, persist
    // `running`. Concurrency lives in the spawned SESSIONS, never in this loop, so no
    // new races exist inside the driver; a crash anywhere in the batch is recovered
    // per-receipt by the planner's adopt-vs-redispatch probe. With concurrency 1 the
    // batch always has one intent — the v2 driver exactly.
    let postDeferred = false;
    for (const { nodeId, attempt, round } of result.dispatches) {
      const stepPlan = plan.steps.find((s) => s.nodeId === nodeId);
      if (!stepPlan?.spawn) {
        // Planner asked to spawn a node the plan cannot spawn — a definition drifted
        // under the run. Fail loudly rather than guess (drain-aware: siblings spawned
        // earlier in this batch settle before the terminal is written).
        current = markSpawnFailure(current, plan, nodeId, 'no spawn spec in the compiled plan', now, round);
        current = persistRun(deps, current);
        if (current.status !== 'running') return current;
        break; // stopping (or optional-skip with nothing else to do) → re-plan, never spawn more on a failing run
      }

      // Session mode (GRS-016e): 'fresh' (absent) spawns per attempt — the v2 path
      // verbatim. Follow-up modes mint a deterministic turnMarker WITH the
      // dispatching persist (mint-before-post), prepend it to the prompt, then
      // either CREATE the run's shared session (the first workflow-mode dispatch,
      // under the shared key) or post a follow-up turn into the target session.
      const mode = stepPlan.sessionMode ?? 'fresh';
      const marker = mode === 'fresh' ? undefined : turnMarkerFor(current.runId, nodeId, attempt, round);
      // The durable settle anchor (GRS-016e-fix2): the inserted row's id is
      // PRE-MINTED here and persisted in the SAME write as the dispatching mark,
      // BEFORE the post — the poster/spawner inserts the row with exactly this
      // id, so recovery disambiguates purely by identity (row present → adopt,
      // absent → the id was never used → re-post), never by content.
      const anchorId = mode === 'fresh' ? undefined : randomUUID();
      const basePrompt = stepPromptFor(def, plan, current, nodeId, round);
      const prompt = marker
        ? `${turnMarkerLinePrefix(marker)} Workflow "${current.title}" (run ${current.runId}) — step "${stepPlan.label}" runs as this session's next turn. Reply to complete the step.\n\n${basePrompt}`
        : basePrompt;

      // Mint-before-spawn: persist the INTENT (dispatching + attempt + marker +
      // anchor), THEN spawn/post. A crash between the two persists is
      // disambiguated by the planner's adoption probe on the next sweep
      // (sessionKey for spawns, the anchor ROW ID for posts).
      current = markDispatching(current, nodeId, attempt, now, round, marker ? { turnMarker: marker, turnAnchor: anchorId } : {});
      current = persistRun(deps, current);
      try {
        let spawned: SpawnResult;
        let createdSharedSession = false;
        if (mode === 'fresh' || (mode === 'workflow' && !current.sharedSessionId)) {
          spawned = await deps.spawnStep({
            runId: current.runId,
            workflowId: current.workflowId,
            workflowName: def.name ?? def.id,
            triggerSource: workflowTriggerSource(current.trigger),
            nodeId,
            label: stepPlan.label,
            phaseIndex: (current.order?.indexOf(nodeId) ?? -1) + 1,
            attempt,
            round,
            spec: stepPlan.spawn,
            prompt,
            ...(mode === 'workflow' ? { sessionKey: sharedSessionKey(current.runId), anchorMessageId: anchorId! } : {}),
          });
          createdSharedSession = mode === 'workflow';
        } else {
          const target = mode === 'workflow' ? current.sharedSessionId! : stepPlan.sessionTarget ?? '';
          if (!deps.postStepFollowUp) throw new Error('run driver provides no postStepFollowUp');
          const posted = await deps.postStepFollowUp({
            runId: current.runId,
            workflowId: current.workflowId,
            nodeId,
            label: stepPlan.label,
            attempt,
            round,
            sessionId: target,
            spec: stepPlan.spawn,
            prompt,
            turnMarker: marker!,
            anchorMessageId: anchorId!,
          });
          // Typed DEFER (GRS-016e-fix, Codex finding 2): the poster's ATOMIC busy
          // check found the target busy — the marker row was never inserted. Hand
          // the attempt back (pending, un-consumed) and END THIS DRIVE after the
          // batch: re-planning now would just re-collect the same intent off the
          // possibly-stale planner probe and spin the iteration cap; the 15s sweep
          // retries once the target frees up.
          if (posted.outcome === 'deferred') {
            current = markFollowUpDeferred(current, nodeId, posted.reason, now, round);
            current = persistRun(deps, current);
            deps.log?.('info', `[workflow-runs] run ${current.runId}: step "${nodeId}" follow-up deferred — ${posted.reason}`);
            postDeferred = true;
            continue;
          }
          spawned = { sessionId: posted.sessionId, ...(posted.detail ? { detail: posted.detail } : {}) };
        }
        // output:'none' (GRS-016d): the spawn succeeding IS the settle — the
        // receipt goes straight to `fired` (sessionId + settledAt, no outcome) and
        // the session is never awaited. Only reachable on fresh mode (validation
        // refuses none + follow-up modes). Everything else runs the v2 path — the
        // follow-up settle ANCHOR was already persisted with the dispatching mark
        // (GRS-016e-fix2); fresh receipts never carry it (v2 byte-shape).
        current = stepPlan.output === 'none'
          ? markFired(current, nodeId, spawned, now, round)
          : markRunning(current, nodeId, spawned, now, round);
        if (createdSharedSession) current = { ...current, sharedSessionId: spawned.sessionId };
        current = persistRun(deps, current);
      } catch (err) {
        current = markSpawnFailure(current, plan, nodeId, (err as Error).message, now, round);
        current = persistRun(deps, current);
        if (current.status === 'failed') return current;
        if (current.stopping) break; // drain: stop spawning; the re-plan probes the in-flight batch
        // optional step skipped → keep executing the batch
      }
    }
    // A deferred follow-up ends this drive (GRS-016e-fix): everything settled or
    // dispatched above is persisted; the deferred node waits for the next sweep.
    if (postDeferred) return current;
  }
}

function compilePlan(
  def: EditableWorkflowDefinition,
  opts: Pick<StartRunOptions, 'knownEmployees' | 'knownEngines'> = {},
): ReturnType<typeof resolveExecutionPlan> {
  return resolveExecutionPlan(def, {
    ...(opts.knownEmployees ? { knownEmployees: opts.knownEmployees } : {}),
    ...(opts.knownEngines ? { knownEngines: opts.knownEngines } : {}),
  });
}

/**
 * Start a run of `def`: compile, refuse cycles, MINT the durable pending-receipts
 * record BEFORE any spawn, then drive the first advancement. Always returns a
 * persisted run (failed runs included, mirroring the v1 contract the route maps to
 * 422/201).
 */
export async function startWorkflowRun(
  deps: RunDriverDeps,
  def: EditableWorkflowDefinition,
  opts: StartRunOptions = {},
): Promise<WorkflowRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  let runId = (opts.makeRunId ?? (() => newRunId(now)))();
  const baseTrigger: WorkflowRunTrigger = opts.trigger ?? { kind: 'manual' };
  const trigger: WorkflowRunTrigger = baseTrigger;
  // Freeze caller-owned data before any persistence or async spawn. Parameters
  // comes from JSON APIs, so a JSON round-trip is both the deep copy and the durable
  // wire-format boundary; later caller mutation cannot rewrite phase context.
  const parameters: WorkflowRunParameters | undefined = opts.parameters
    ? JSON.parse(JSON.stringify(opts.parameters)) as WorkflowRunParameters
    : undefined;
  const invocation: WorkflowRunInvocation | undefined = opts.invocation
    ? JSON.parse(JSON.stringify(opts.invocation)) as WorkflowRunInvocation
    : undefined;
  const stepOverrides: Record<string, WorkflowStepPromptOverride> | undefined = opts.stepOverrides
    ? JSON.parse(JSON.stringify(opts.stepOverrides)) as Record<string, WorkflowStepPromptOverride>
    : undefined;

  const triggerEvent = normalizeWorkflowTrigger(trigger);
  if (triggerEvent.fireRef) {
    const principal = opts.principal ?? workflowRunPrincipal(undefined, triggerEvent.source);
    const request = createWorkflowRunInvocationRequest({
      definition: def,
      trigger: triggerEvent,
      input: parameters?.input,
      invocation,
      initialStepOverrides: stepOverrides,
      principal,
    });

    // A pre-claim run is legacy evidence. Never silently bind changed intent to it:
    // fail closed and let the caller explicitly choose a new key.
    const legacy = findRunByTriggerFireRef(
      deps.root,
      def.id,
      triggerEvent.source,
      triggerEvent.event,
      triggerEvent.fireRef,
    );
    if (legacy
      && !getWorkflowRunInvocationClaim(deps.root, def.id, principal, triggerEvent.fireRef)
      && !findWorkflowRunInvocationClaimByRunId(deps.root, def.id, legacy.runId)) {
      throw new WorkflowRunIdempotencyConflict(legacy.runId);
    }
    const claim: WorkflowRunInvocationClaim = {
      schemaVersion: 1,
      workflowId: def.id,
      principal,
      idempotencyKey: triggerEvent.fireRef,
      runId,
      fingerprint: fingerprintWorkflowRunInvocationRequest(request),
      request,
      createdAt: now(),
    };
    const result = claimWorkflowRunInvocation(deps.root, claim);
    if (result.outcome === 'conflict') {
      throw new WorkflowRunIdempotencyConflict(result.claim?.runId ?? legacy?.runId ?? '');
    }
    if (result.outcome === 'replay') {
      runId = result.claim.runId;
      const existing = getRun(deps.root, def.id, runId);
      if (existing) {
        opts.onIdempotencyReplay?.();
        deps.log?.('info', `[workflow-runs] exact invocation replayed as ${runId}`);
        return existing;
      }
      // The exclusive claim landed but the process died before the run record.
      // Resume using the preallocated run id rather than minting another identity.
    }
  }

  const failedRun = (errors: { code: string; message: string; ref?: string }[]): WorkflowRun => ({
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    revision: 1,
    runId,
    workflowId: def.id,
    definitionVersion: def.version,
    title: def.title,
    trigger,
    ...(parameters ? { parameters } : {}),
    ...(invocation ? { invocation } : {}),
    ...(stepOverrides ? { stepOverrides } : {}),
    status: 'failed',
    startedAt: now(),
    endedAt: now(),
    steps: [],
    parked: null,
    errors,
  });
  const publishCandidate = (candidate: WorkflowRun) => {
    const publication = publishInitialRun(deps, candidate);
    if (!publication.owned && triggerEvent.fireRef) {
      opts.onIdempotencyReplay?.();
      deps.log?.('info', `[workflow-runs] concurrent invocation replayed as ${publication.run.runId}`);
    }
    return publication;
  };

  const resolved = compilePlan(def, opts);
  if (!resolved.ok) {
    const run = failedRun(resolved.errors);
    return publishCandidate(run).run;
  }

  // Session modes (GRS-016e): refuse at START, honestly, what this driver cannot
  // drive — a session-mode run on a gateway without the follow-up deps would only
  // wedge (or fail) mid-flight. And validate 'existing' targets while the operator
  // is still watching the response: a target deleted before the run even starts is
  // an authoring-time mistake, not a mid-run hazard (those go through the step's
  // retry/onError policy when the probe/post fails).
  const followUpStep = resolved.plan.steps.find((s) => s.sessionMode === 'workflow' || s.sessionMode === 'existing');
  if (followUpStep && (!deps.postStepFollowUp || !deps.probeSessionTurn)) {
    const run = failedRun([{
      code: 'session-mode-unsupported',
      message: `step "${followUpStep.nodeId}" uses session mode "${followUpStep.sessionMode}" but this gateway's run driver provides no follow-up session support`,
      ref: followUpStep.nodeId,
    }]);
    return publishCandidate(run).run;
  }
  if (deps.sessionExists) {
    for (const s of resolved.plan.steps) {
      if (s.sessionMode !== 'existing' || !s.sessionTarget) continue;
      if (!deps.sessionExists(s.sessionTarget)) {
        const run = failedRun([{
          code: 'unknown-session-target',
          message: `step "${s.nodeId}" targets session "${s.sessionTarget}", which does not exist on this gateway`,
          ref: s.nodeId,
        }]);
        return publishCandidate(run).run;
      }
    }
  }

  const minted = mintSequentialRun(resolved.plan, impliedExecutionOrder(def), runId, now, {
    trigger,
    ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
  });
  if (!minted.ok) {
    const run = failedRun(minted.errors);
    return publishCandidate(run).run;
  }

  // Freeze the definition CONTENT into the record (GRS-014b-fix, Codex finding 2):
  // every later advance/sweep compiles from this snapshot, so a mid-run edit of the
  // store can never change what this run does.
  const run: WorkflowRun = {
    ...minted.run,
    ...(parameters ? { parameters } : {}),
    ...(invocation ? { invocation } : {}),
    ...(stepOverrides ? { stepOverrides } : {}),
    definitionSnapshot: def,
  };

  // Publish the complete durable intent before any projection or spawn.
  // The exclusive hard-link elects one owner even when several gateway processes
  // recover the same preallocated claim simultaneously.
  const publication = publishCandidate(run);
  if (!publication.owned) return publication.run;

  return withRunAdvanceLock(runId, () => driveRunLocked(deps, def, resolved.plan, publication.run));
}

export async function startWorkflowRunFromTrigger(
  deps: RunDriverDeps,
  def: EditableWorkflowDefinition,
  trigger: WorkflowTriggerEvent,
  opts: Omit<StartRunOptions, 'trigger'> = {},
): Promise<WorkflowRun> {
  return startWorkflowRun(deps, def, {
    ...opts,
    trigger: normalizeWorkflowTrigger(trigger),
  });
}

/**
 * Advance one persisted run (sweep entry point). Loads the run + its definition,
 * recompiles, and drives under the run lock. Drivable `running` records without an
 * `order` (v1 walks or 014a-era stubs) are terminally failed once with an honest
 * error so the sweep never spins on records it cannot drive.
 */
export async function advanceWorkflowRunById(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
): Promise<WorkflowRun | null> {
  const now = deps.now ?? (() => new Date().toISOString());
  const result = await withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return run;
    if (run.status === 'parked' && !run.parked?.approval) return run;
    // Drivable states (GRS-016a): `running`, plus `parked` with receipts still in
    // flight — the probe-only pass keeps a parked run's sibling evidence truthful
    // (settles clean finishes, adopts crashed spawns; never dispatches, never
    // unparks). A parked run with nothing in flight still waits untouched on the
    // human — resolve-gate remains the only unpark.
    const parkedInFlight = run.status === 'parked' && hasInFlightSteps(run);
    if (run.status !== 'running' && !parkedInFlight) return run;

    if (run.status === 'running' && !Array.isArray(run.order) && !run.cancellation) {
      const failed: WorkflowRun = {
        ...run,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(run.errors ?? []),
          {
            code: 'legacy-run-unrecoverable',
            message: 'run predates sequential execution (no order); it cannot be advanced and was closed by the reconciler',
          },
        ],
      };
      const persisted = persistRun(deps, failed);
      deps.log?.('warn', `[workflow-runs] closed pre-sequential running record ${runId} (${workflowId}) as failed`);
      return persisted;
    }

    // Compile from the run's FROZEN definition snapshot (GRS-014b-fix, Codex
    // finding 2) — the store is consulted only for pre-snapshot legacy records. A
    // running run executes what it claims (its definitionVersion), regardless of any
    // later edit/retire/delete of the definition file.
    const def = run.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
    if (!def) {
      if (run.cancellation) {
        // Native cancellation preflights and freezes a definition before writing
        // intent. A historical partial record must never be overwritten as an
        // ordinary definition failure after cancellation became authoritative.
        return run;
      }
      const failed: WorkflowRun = {
        ...run,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(run.errors ?? []),
          { code: 'definition-missing', message: `run has no definition snapshot and definition "${workflowId}" no longer exists on the evidence root` },
        ],
      };
      return persistRun(deps, failed);
    }

    // Sweep compiles WITHOUT a roster: actor existence was checked at start; at
    // advancement time the spawn itself is the authoritative check (an unknown
    // employee fails the spawn, which fails/skips the step honestly).
    const resolved = compilePlan(def);
    if (!resolved.ok) {
      if (run.cancellation) return run;
      const failed: WorkflowRun = {
        ...run,
        status: 'failed',
        endedAt: now(),
        errors: [...(run.errors ?? []), ...resolved.errors],
      };
      return persistRun(deps, failed);
    }

    return driveRunLocked(deps, def, resolved.plan, run);
  });
  return result;
}

/* ── Pending-phase prompt edits ─────────────────────────────────────────────── */

export type EditPendingWorkflowStepPromptOutcome =
  | { outcome: 'edited'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'step-not-found'; run: WorkflowRun }
  | { outcome: 'not-pending'; run: WorkflowRun; status: RunStepStatus };

/**
 * Replace one run-local phase prompt while that phase is still wholly pending.
 * The edit shares the run's advancement mutex with dispatch, closing the only race
 * that matters: either this save lands first and dispatch reads the new prompt, or
 * dispatch marks the receipt non-pending first and this edit is rejected. A node
 * that already ran in an earlier loop round is immutable even if a later receipt is
 * pending because the override is node-scoped and would otherwise rewrite behavior
 * after that phase had already started.
 */
export async function editPendingWorkflowStepPrompt(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
  nodeId: string,
  prompt: string,
  opts: { actor: string },
): Promise<EditPendingWorkflowStepPromptOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  return withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return { outcome: 'not-found' as const };

    const node = (run.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId))
      ?.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'step' && !!candidate.actor);
    const receipts = run.steps.filter((receipt) => receipt.nodeId === nodeId);
    if (!node || receipts.length === 0) return { outcome: 'step-not-found' as const, run };

    const startedReceipt = receipts.find((receipt) => receipt.status !== 'pending');
    if (startedReceipt) {
      return { outcome: 'not-pending' as const, run, status: startedReceipt.status };
    }

    const before = run.stepOverrides?.[nodeId]?.prompt
      ?? (typeof node.instructions === 'string' && node.instructions.trim() !== ''
        ? node.instructions.trim()
        : "Perform this step's work and report a concise result.");
    const revision = (run.stepPromptRevision ?? 0) + 1;
    const edited: WorkflowRun = {
      ...run,
      stepOverrides: {
        ...(run.stepOverrides ?? {}),
        [nodeId]: { prompt },
      },
      stepPromptRevision: revision,
      stepPromptEdits: [
        ...(run.stepPromptEdits ?? []),
        { revision, nodeId, actor: opts.actor, at: now(), before, after: prompt },
      ],
    };
    const persisted = persistRun(deps, edited);
    return { outcome: 'edited' as const, run: persisted };
  });
}

/* ── Gate resolution (GRS-014e) ─────────────────────────────────────────────── */

export type ResolveGateOutcome =
  | { outcome: 'resolved'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'not-parked'; run: WorkflowRun };

export type CancelWorkflowRunOutcome =
  | { outcome: 'cancelled'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'already-terminal'; run: WorkflowRun }
  | { outcome: 'conflict'; run: WorkflowRun };

/** Request a real run cancellation and drive its ordinary stop/drain path. */
export async function cancelWorkflowRun(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
  opts: { actor: string; reason?: string },
): Promise<CancelWorkflowRunOutcome> {
  return withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return { outcome: 'not-found' as const };
    const reason = opts.reason?.trim() || null;
    if (run.cancellation) {
      if (run.cancellation.requestedBy === opts.actor && run.cancellation.reason === reason) {
        return { outcome: 'cancelled' as const, run };
      }
      return { outcome: 'conflict' as const, run };
    }
    if (run.status === 'completed' || run.status === 'failed') {
      return { outcome: 'already-terminal' as const, run };
    }
    // Legacy terminal cancellation and an already-selected failure drain have no
    // canonical cancellation authority to compare against. Fail closed instead of
    // inventing ownership or replacing the earlier terminal intent.
    if (run.status === 'cancelled' || run.stopping) return { outcome: 'conflict' as const, run };

    // Cancellation may terminalize without a plan only when there is no live
    // receipt to own. Otherwise compile BEFORE persisting intent, then freeze that
    // exact definition on legacy/pre-snapshot records. A missing or invalid mutable
    // definition therefore yields a deterministic 409 with zero cancellation
    // evidence instead of successful-cancel-then-failed reconciliation.
    let definition: EditableWorkflowDefinition | null = null;
    let compiled: ReturnType<typeof compilePlan> | null = null;
    if (hasInFlightSteps(run)) {
      definition = run.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
      if (!definition) return { outcome: 'conflict' as const, run };
      compiled = compilePlan(definition);
      if (!compiled.ok) return { outcome: 'conflict' as const, run };
    }

    const at = (deps.now ?? (() => new Date().toISOString()))();
    const withIntent: WorkflowRun = {
      ...run,
      ...(definition && !run.definitionSnapshot ? {
        definitionSnapshot: JSON.parse(JSON.stringify(definition)) as EditableWorkflowDefinition,
      } : {}),
      ...(!Array.isArray(run.order) && hasInFlightSteps(run)
        ? { order: run.steps.map((receipt) => receipt.nodeId) }
        : {}),
      cancellation: { requestedAt: at, requestedBy: opts.actor, reason },
    };
    const requested = persistRun(deps, requestWorkflowRunTerminal(withIntent, 'cancelled', [{
      code: 'run-cancelled',
      message: `${opts.actor} cancelled the Workflow run${reason ? `: ${reason}` : ''}`,
    }], at));
    if (requested.status === 'cancelled') return { outcome: 'cancelled' as const, run: requested };

    definition ??= requested.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
    if (!definition) return { outcome: 'cancelled' as const, run: requested };
    compiled ??= compilePlan(definition);
    if (!compiled.ok) return { outcome: 'cancelled' as const, run: requested };
    return {
      outcome: 'cancelled' as const,
      run: await driveRunLocked(deps, definition, compiled.plan, requested),
    };
  });
}

export type EscalateGateApprovalOutcome =
  | { outcome: 'escalated'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'not-parked'; run: WorkflowRun };

export type AdoptLegacyGateApprovalOutcome =
  | { outcome: 'adopted'; run: WorkflowRun }
  | { outcome: 'already-adopted'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'not-parked'; run: WorkflowRun };

/**
 * Atomically adopt one legacy parked episode into the native approval model.
 * The transition never reads a Todo or a mutable current definition: it freezes
 * a fresh pending route from the run's own definition snapshot/invocation and
 * retains the exact pre-adoption parked evidence in an append-only record.
 */
export async function adoptLegacyParkedWorkflowApproval(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
): Promise<AdoptLegacyGateApprovalOutcome> {
  return withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return { outcome: 'not-found' as const };
    if (run.status !== 'parked' || !run.parked) return { outcome: 'not-parked' as const, run };
    if (run.parked.approval) return { outcome: 'already-adopted' as const, run };

    const at = (deps.now ?? (() => new Date().toISOString()))();
    const definitionSource = run.definitionSnapshot ? 'snapshot' as const : 'missing-fallback' as const;
    const definition = run.definitionSnapshot ?? {
      schemaVersion: 1,
      id: run.workflowId,
      title: run.title,
      version: run.definitionVersion,
      status: 'active' as const,
      nodes: [],
      edges: [],
    };
    const approval = createPendingWorkflowGateApproval(run, definition, at);
    const adoption = {
      legacySchemaVersion: run.schemaVersion ?? 1,
      definitionSource,
      adoptedAt: at,
      gateKey: run.parked.ref ?? run.parked.description,
      priorParked: { ...run.parked },
      approval,
    };
    const adopted = persistRun(deps, {
      ...run,
      parked: { ...run.parked, approval },
      approvalAdoptions: [...(run.approvalAdoptions ?? []), adoption],
    });
    return { outcome: 'adopted' as const, run: adopted };
  });
}

export async function escalateWorkflowRunGateApproval(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
): Promise<EscalateGateApprovalOutcome> {
  return withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return { outcome: 'not-found' as const };
    if (run.status !== 'parked' || !run.parked?.approval || run.parked.approval.state !== 'pending') {
      return { outcome: 'not-parked' as const, run };
    }
    if (run.parked.approval.escalation?.target === 'operator'
      && run.parked.approval.operatorEntitled) return { outcome: 'escalated' as const, run };
    const at = (deps.now ?? (() => new Date().toISOString()))();
    return {
      outcome: 'escalated' as const,
      run: persistRun(deps, {
        ...run,
        parked: {
          ...run.parked,
          approval: freezeWorkflowApprovalEscalation(run.parked.approval, at),
        },
      }),
    };
  });
}

/**
 * Resolve a PARKED run's human-approval gate (the API half of the accountability
 * doorbell — design D3: "who advances a parked run: only the resolve-gate route").
 * Runs under the run's advance lock so resolution never interleaves with a sweep.
 *
 * approve → the pure `resolveParkedGate` transition unparks the run (gateNode receipt
 * settles as operator-approved checkpoint / runGate key recorded), the record is
 * persisted, and the run is DRIVEN forward through the same driver path the sweep
 * uses (compiled from the frozen definitionSnapshot; the store is only a legacy
 * fallback). reject → the operator-rejection receipt requests a failed terminal;
 * any live siblings are cancelled/probed through the ordinary stopping drain.
 */
export async function resolveWorkflowRunGate(
  deps: RunDriverDeps,
  workflowId: string,
  runId: string,
  decision: ResolveGateDecision,
  opts: { decidedBy?: string } = {},
): Promise<ResolveGateOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const outcome = await withRunAdvanceLock(runId, async () => {
    const run = getRun(deps.root, workflowId, runId);
    if (!run) return { outcome: 'not-found' as const };
    if (run.status === 'parked' && run.parked && !run.parked.approval) {
      return { outcome: 'not-parked' as const, run };
    }
    const resolved = resolveParkedGate(run, decision, now, opts);
    if (!resolved.ok) return { outcome: 'not-parked' as const, run };

    const persistedResolution = persistRun(deps, resolved.run); // the decision/drain request is durable before any drive
    if (persistedResolution.status !== 'running') {
      return { outcome: 'resolved' as const, run: persistedResolution }; // already drained rejection — terminal
    }

    const def = persistedResolution.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
    if (!def) {
      const failed: WorkflowRun = {
        ...persistedResolution,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(persistedResolution.errors ?? []),
          { code: 'definition-missing', message: `run has no definition snapshot and definition "${workflowId}" no longer exists on the evidence root` },
        ],
      };
      return { outcome: 'resolved' as const, run: persistRun(deps, failed) };
    }
    const compiled = compilePlan(def);
    if (!compiled.ok) {
      const failed: WorkflowRun = {
        ...persistedResolution,
        status: 'failed',
        endedAt: now(),
        errors: [...(persistedResolution.errors ?? []), ...compiled.errors],
      };
      return { outcome: 'resolved' as const, run: persistRun(deps, failed) };
    }
    const driven = await driveRunLocked(deps, def, compiled.plan, persistedResolution);
    return { outcome: 'resolved' as const, run: driven };
  });
  return outcome;
}

/* ── Sweeping ───────────────────────────────────────────────────────────────── */

/** One sweep: reconcile every sweepable active run on the evidence root. Returns how many runs
 * were examined. Per-run failures are logged, never fatal to the sweep. */
export async function sweepWorkflowRuns(deps: RunDriverDeps): Promise<number> {
  let examined = 0;
  // Only active (non-terminal) runs can be sweepable — read the active-run index
  // (O(active)) instead of parsing every lifetime run file for every workflow.
  // getRun re-checks the live status, so a stale index entry is a harmless skip.
  for (const { workflowId, runId } of listActiveRunRefs(deps.root)) {
    let run;
    try {
      run = getRun(deps.root, workflowId, runId);
    } catch (err) {
      deps.log?.('warn', `[workflow-runs] getRun failed for ${workflowId}/${runId}: ${(err as Error).message}`);
      continue;
    }
    if (!run) continue; // run file gone — stale index entry, pruned on next rebuild
    if (run.status === 'parked' && !run.parked?.approval) continue;
    // Sweepable (GRS-016a): running runs, plus native-approved parked runs whose
    // sibling sessions are still in flight (probe-only settles — a park freezes
    // dispatch, not evidence). Parked-and-quiet runs wait on a human; terminals
    // are done.
    if (run.status !== 'running' && !(run.status === 'parked' && hasInFlightSteps(run))) continue;
    examined++;
    try {
      await advanceWorkflowRunById(deps, workflowId, runId);
    } catch (err) {
      deps.log?.('warn', `[workflow-runs] advancing ${runId} failed: ${(err as Error).message}`);
    }
  }
  return examined;
}

export interface RunReconcilerOptions {
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Start the periodic run sweep (+ one immediate startup sweep). Returns a stop
 * function. The gateway starts this AFTER recoverStaleSessions/reconcileWorkItems so
 * the startup sweep reads truthful session evidence; when no evidence root is
 * configured the caller simply does not start it (the workflow surface is inert).
 */
export function startWorkflowRunReconciler(deps: RunDriverDeps, opts: RunReconcilerOptions = {}): () => void {
  let stopped = false;
  let sweeping = false;
  const sweep = async (label: string): Promise<void> => {
    if (stopped || sweeping) return; // never overlap sweeps (slow spawns > interval)
    sweeping = true;
    try {
      const examined = await sweepWorkflowRuns(deps);
      if (examined > 0) deps.log?.('info', `[workflow-runs] ${label} sweep reconciled ${examined} active run(s)`);
    } catch (err) {
      deps.log?.('warn', `[workflow-runs] ${label} sweep failed: ${(err as Error).message}`);
    } finally {
      sweeping = false;
    }
  };
  // Rebuild the active-run index once at boot from a full scan, so any staleness
  // left by a crash (a run that went terminal without its pruning save landing) is
  // corrected before steady-state O(active) sweeps rely on it.
  try {
    rebuildActiveRunIndex(deps.root);
  } catch (err) {
    deps.log?.('warn', `[workflow-runs] active-run index rebuild failed at boot: ${(err as Error).message}`);
  }
  void sweep('startup');
  const timer = setInterval(() => void sweep('interval'), opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
