import { randomUUID } from 'node:crypto';
import { resolveExecutionPlan, type ExecutionPlan } from './execution-plan.js';
import type { EditableWorkflowDefinition } from './definition.js';
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
  type StopStepSession,
} from './advance.js';
import {
  findRunByTriggerFireRef,
  getRun,
  hasInFlightSteps,
  isWorkflowTriggerEvent,
  listActiveRunRefs,
  rebuildActiveRunIndex,
  newRunId,
  normalizeWorkflowTrigger,
  saveRun,
  workflowRunTriggerTodoId,
  type WorkflowRun,
  type WorkflowTriggerEvent,
  type WorkflowRunTrigger,
} from './run-store.js';
import type { WorkflowTodoBridge } from '../work-items/workflow-bridge.js';
import { transition as transitionWorkItem } from '../work-items/transitions.js';
import type { WorkItemStatus } from '../work-items/store.js';

/**
 * Workflow RUN RECONCILER + driver (GRS-014b) — the impure half of the v2 engine.
 *
 * The pure planner (`advance.ts`) decides WHAT happens next; this module makes it
 * durable: it persists every transition (atomic run-file overwrites), executes
 * dispatch intents (mint-before-spawn: persist `dispatching`, spawn under the
 * deterministic sessionKey, persist `running`), and re-advances until the run is
 * in flight, parked, or terminal.
 *
 * WHO ADVANCES A RUN (design D3 — no second scheduler):
 *   1. `startWorkflowRun` — the POST …/run route mints the durable record BEFORE any
 *      spawn, then drives the first advancement.
 *   2. `startWorkflowRunReconciler` — a 15s sweep (the same setInterval primitive
 *      `gateway/status-reconciler.ts` uses) plus one immediate STARTUP sweep. It reads
 *      each running run's step session by deterministic sessionKey and re-derives.
 *      Boot ordering matters: the gateway starts it after `recoverStaleSessions()` has
 *      stamped dead sessions `interrupted`, so the sweep sees truthful evidence —
 *      that IS the crash-recovery story (GRS-003a pattern).
 *   3. (GRS-014e) the resolve-gate route will unpark and call back into the driver.
 *   Parked runs are deliberately NOT swept — nothing polls a human.
 *
 * CONCURRENCY: a per-runId in-process mutex serializes route-vs-sweep advancement
 * (single gateway process is the run store's stated contract). One misbehaving run
 * never kills a sweep — every run is driven under its own try/catch.
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
  /**
   * Todos-ledger bridge (GRS-021a): mints the run-level work item at start,
   * links the step sessions the driver SPAWNS, and reflects run terminals
   * (`completed → done`, `failed → blocked`). OPTIONAL and best-effort by
   * contract — absent in unit tests and on drivers that don't wire it; a ledger
   * failure must never affect the run (every call site is guarded).
   */
  workItems?: WorkflowTodoBridge;
  now?: () => string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Clear a mirrored Todo approval to match a gate the RUN AUTHORITY resolved
 *  (GRS-021b QA finding 1) — best-effort, idempotent in the bridge (a no-op when
 *  there is no pending mirror). The ledger REACTS to the run; this never touches
 *  the run/resolve path, so park/resolve semantics and their goldens are unchanged. */
function clearParkMirrorOnTodo(deps: RunDriverDeps, run: WorkflowRun | null, decision: 'approve' | 'reject', decidedBy = 'operator'): void {
  if (!run) return;
  try {
    deps.workItems?.clearParkMirror(run, decision, decidedBy);
  } catch (err) {
    deps.log?.('warn', `[workflow-runs] run ${run.runId}: Todo park-mirror clear failed: ${(err as Error).message}`);
  }
}

/** Reflect a terminal run onto its Todo (best-effort, idempotent in the bridge). */
function reflectRunTerminalOnTodo(deps: RunDriverDeps, run: WorkflowRun | null): void {
  if (!run || (run.status !== 'completed' && run.status !== 'failed')) return;
  try {
    deps.workItems?.onRunTerminal(run);
  } catch (err) {
    deps.log?.('warn', `[workflow-runs] run ${run.runId}: Todo terminal reflect failed: ${(err as Error).message}`);
  }
  // Terminal-repair: a terminal run must NEVER keep a pending mirror. Idempotent —
  // when resolve already cleared it, this is a no-op (QA finding 1).
  clearParkMirrorOnTodo(deps, run, run.status === 'failed' ? 'reject' : 'approve');
}

/**
 * Mirror a PARKED run's approval gate onto its Todo (GRS-021b, design §1.3): the
 * run surfaces in the ONE operator queue as a pending approval whose ref
 * (`workflow-gate:…`) routes any decision back to the shipped resolve-gate. Best-
 * effort like every ledger bridge — a throwing ledger NEVER changes park
 * semantics — and idempotent in the store (a sweep re-mirror of the same park is
 * event-silent). The run store stays the single authority; this only enqueues.
 */
function mirrorParkOnTodo(deps: RunDriverDeps, run: WorkflowRun | null): void {
  if (!run || run.status !== 'parked' || !run.parked) return;
  try {
    deps.workItems?.mirrorParkedGate(run, {
      description: run.parked.description,
      ...(run.parked.ref ? { ref: run.parked.ref } : {}),
    });
  } catch (err) {
    deps.log?.('warn', `[workflow-runs] run ${run.runId}: Todo park mirror failed: ${(err as Error).message}`);
  }
}

function settledStepKeys(run: WorkflowRun): Set<string> {
  return new Set(
    run.steps
      .filter((s) => ['done', 'skipped', 'inline', 'checkpoint', 'routed', 'fired', 'failed'].includes(s.status))
      .map((s) => `${s.nodeId}:${s.round ?? 1}:${s.status}`),
  );
}

function applyTodoTransitions(
  deps: RunDriverDeps,
  def: EditableWorkflowDefinition,
  before: WorkflowRun,
  after: WorkflowRun,
): WorkflowRun {
  const triggerTodoId = workflowRunTriggerTodoId(after);
  if (!triggerTodoId || after.status === 'failed' || after.status === 'cancelled') return after;
  const beforeSettled = settledStepKeys(before);
  let current = after;
  for (const receipt of after.steps) {
    const key = `${receipt.nodeId}:${receipt.round ?? 1}:${receipt.status}`;
    if (beforeSettled.has(key)) continue;
    if (!['done', 'skipped', 'inline', 'checkpoint', 'routed', 'fired'].includes(receipt.status)) continue;
    const node = def.nodes.find((n) => n.id === receipt.nodeId && n.type === 'step');
    const toStatus = node?.todoTransition as WorkItemStatus | undefined;
    if (!toStatus) continue;
    try {
      transitionWorkItem(triggerTodoId, toStatus, 'workflow-run', {
        bounce: toStatus === 'executing',
        detail: { workflowId: after.workflowId, runId: after.runId, nodeId: receipt.nodeId },
      });
    } catch (err) {
      const now = deps.now ?? (() => new Date().toISOString());
      current = {
        ...current,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(current.errors ?? []),
          {
            code: 'todo-transition-failed',
            message: `step "${receipt.nodeId}" could not transition Todo ${triggerTodoId} to ${toStatus}: ${(err as Error).message}`,
            ref: receipt.nodeId,
          },
        ],
      };
      saveRun(deps.root, current);
      return current;
    }
  }
  return current;
}

export interface StartRunOptions {
  /**
   * What starts this run. New trigger emitters pass WorkflowTriggerEvent; legacy
   * callers may still pass {kind,...} for byte-compat evidence.
   * Any trigger carrying fireRef is IDEMPOTENT per (workflowId, source, event, fireRef):
   * if a run already claims that fire,
   * `startWorkflowRun` refuses to mint a second one and returns the existing run
   * (file-enforced — the run store scans the run dir; the run store is the registry).
   */
  trigger?: WorkflowRunTrigger;
  knownEmployees?: Iterable<string>;
  knownEngines?: Iterable<string>;
  maxNodes?: number;
  makeRunId?: () => string;
  /** Legacy input seam: new todo-status starts carry this as trigger.payload.todoId. */
  triggerTodoId?: string;
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
    node,
    predecessors,
    ...(failedPredecessors.length > 0 ? { failedPredecessors } : {}),
    ...(advertisedFieldKeys.length > 0 ? { advertisedFieldKeys } : {}),
    ...(isWorkflowTriggerEvent(run.trigger) ? { trigger: run.trigger } : {}),
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
      saveRun(deps.root, current);
      deps.log?.('error', `[workflow-runs] run ${current.runId} advancement loop exceeded its cap — failed`);
      return current;
    }

    const beforeAdvance = current;
    const result = advanceRun(current, plan, deps.probeStepSession, now, {
      ...(deps.evaluateGate ? { evaluateGate: deps.evaluateGate } : {}),
      ...(deps.probeSessionTurn ? { probeSessionTurn: deps.probeSessionTurn } : {}),
    });
    current = result.run;
    if (result.changed) saveRun(deps.root, current);
    if (result.changed) {
      const progressed = applyTodoTransitions(deps, def, beforeAdvance, current);
      if (progressed !== current) {
        current = progressed;
        if (current.status !== 'running') return current;
      }
    }

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
        deps.log?.('info', `[workflow-runs] run ${current.runId}: stopped step session ${stop.sessionKey} (${stop.reason})`);
      } catch (err) {
        deps.log?.('warn', `[workflow-runs] run ${current.runId}: stopping step session ${stop.sessionKey} failed: ${(err as Error).message}`);
      }
    }
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
        saveRun(deps.root, current);
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
      saveRun(deps.root, current);
      try {
        let spawned: SpawnResult;
        let createdSharedSession = false;
        if (mode === 'fresh' || (mode === 'workflow' && !current.sharedSessionId)) {
          spawned = await deps.spawnStep({
            runId: current.runId,
            workflowId: current.workflowId,
            nodeId,
            label: stepPlan.label,
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
            saveRun(deps.root, current);
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
        saveRun(deps.root, current);
        // Todos ledger (GRS-021a): link the attempt the driver just SPAWNED to
        // the run's work item — fresh spawns + the shared session at creation.
        // Follow-up posts are skipped: a 'workflow'-mode reuse is already linked
        // and an 'existing'-mode target is a session the workflow does not own.
        // Best-effort: a ledger failure never affects the run.
        if (mode === 'fresh' || createdSharedSession) {
          try {
            deps.workItems?.linkRunSession(current, spawned.sessionId);
          } catch (linkErr) {
            deps.log?.('warn', `[workflow-runs] run ${current.runId}: Todo step-link failed: ${(linkErr as Error).message}`);
          }
        }
      } catch (err) {
        current = markSpawnFailure(current, plan, nodeId, (err as Error).message, now, round);
        saveRun(deps.root, current);
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
  const runId = (opts.makeRunId ?? (() => newRunId(now)))();
  const baseTrigger: WorkflowRunTrigger = opts.trigger ?? { kind: 'manual' };
  const trigger: WorkflowRunTrigger = opts.triggerTodoId
    ? normalizeWorkflowTrigger(baseTrigger, opts.triggerTodoId)
    : baseTrigger;

  // ONE RUN PER (workflowId, source, event, fireRef). A re-invocation of the same
  // logical fire (scheduler retry, replay, double tick) finds the run that already
  // claims the fireRef and no-ops. The scan and the first save below are synchronous
  // (no await between them), so a same-tick duplicate call cannot interleave past the
  // guard in this single-process store. Fail-open: a corrupt run file is invisible to
  // the scan (listRuns skips it) — double-running is the lesser harm vs permanently
  // skipping a fire, mirroring the cron run-log guard's stance.
  const triggerEvent = normalizeWorkflowTrigger(trigger, opts.triggerTodoId);
  if (triggerEvent.fireRef) {
    const existing = findRunByTriggerFireRef(deps.root, def.id, triggerEvent.source, triggerEvent.event, triggerEvent.fireRef);
    if (existing) {
      deps.log?.('info', `[workflow-runs] fire ${triggerEvent.fireRef} of ${def.id} already ran as ${existing.runId} — refusing a duplicate run`);
      const claimed = getRun(deps.root, def.id, existing.runId);
      // getRun re-reads the file the scan just parsed (both synchronous); null means
      // it vanished in between — then the fire is genuinely unclaimed, so mint.
      if (claimed) return claimed;
    }
  }

  const failedRun = (errors: { code: string; message: string; ref?: string }[]): WorkflowRun => ({
    schemaVersion: 2,
    runId,
    workflowId: def.id,
    definitionVersion: def.version,
    title: def.title,
    trigger,
    status: 'failed',
    startedAt: now(),
    endedAt: now(),
    steps: [],
    parked: null,
    errors,
  });

  const resolved = compilePlan(def, opts);
  if (!resolved.ok) {
    const run = failedRun(resolved.errors);
    saveRun(deps.root, run);
    return run;
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
    saveRun(deps.root, run);
    return run;
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
        saveRun(deps.root, run);
        return run;
      }
    }
  }

  const minted = mintSequentialRun(resolved.plan, impliedExecutionOrder(def), runId, now, {
    trigger,
    ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
  });
  if (!minted.ok) {
    const run = failedRun(minted.errors);
    saveRun(deps.root, run);
    return run;
  }

  // Freeze the definition CONTENT into the record (GRS-014b-fix, Codex finding 2):
  // every later advance/sweep compiles from this snapshot, so a mid-run edit of the
  // store can never change what this run does.
  const run: WorkflowRun = {
    ...minted.run,
    definitionSnapshot: def,
  };

  // Durable intent (incl. the frozen definition) BEFORE any spawn — and saved
  // synchronously with the fireIso dedupe scan above (GRS-014d), so a same-tick
  // duplicate schedule fire sees this file before it can mint a second run.
  saveRun(deps.root, run);

  // Todos ledger (GRS-021a, design §2 — the one missing structural mint point):
  // a workflow run is company work, so it lands in the ledger right after its
  // durable record exists and BEFORE any spawn (mint-with-intent). Idempotent on
  // the `workflow:<workflowId>:<runId>` sourceRef; best-effort by contract.
  const triggerTodoId = workflowRunTriggerTodoId(run);
  try {
    if (triggerTodoId) deps.workItems?.linkTriggeredRunItem(run, triggerTodoId);
    else deps.workItems?.mintRunItem(run);
  } catch (err) {
    deps.log?.('warn', `[workflow-runs] run ${runId}: Todo ${triggerTodoId ? 'trigger-link' : 'mint'} failed: ${(err as Error).message}`);
  }

  const driven = await withRunAdvanceLock(runId, () => driveRunLocked(deps, def, resolved.plan, run));
  reflectRunTerminalOnTodo(deps, driven);
  mirrorParkOnTodo(deps, driven); // a run that parked at start surfaces to the operator (GRS-021b)
  return driven;
}

export async function startWorkflowRunFromTrigger(
  deps: RunDriverDeps,
  def: EditableWorkflowDefinition,
  trigger: WorkflowTriggerEvent,
  opts: Omit<StartRunOptions, 'trigger' | 'triggerTodoId'> = {},
): Promise<WorkflowRun> {
  return startWorkflowRun(deps, def, {
    ...opts,
    trigger: normalizeWorkflowTrigger(trigger),
  });
}

/**
 * Advance one persisted run (sweep entry point). Loads the run + its definition,
 * recompiles, and drives under the run lock. Non-sequential records (no `order` —
 * v1 walks or 014a-era stubs) are terminally failed once with an honest error so the
 * sweep never spins on records it cannot drive.
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
    // Drivable states (GRS-016a): `running`, plus `parked` with receipts still in
    // flight — the probe-only pass keeps a parked run's sibling evidence truthful
    // (settles clean finishes, adopts crashed spawns; never dispatches, never
    // unparks). A parked run with nothing in flight still waits untouched on the
    // human — resolve-gate remains the only unpark.
    const parkedInFlight = run.status === 'parked' && hasInFlightSteps(run);
    if (run.status !== 'running' && !parkedInFlight) return run;

    if (run.status === 'running' && !Array.isArray(run.order)) {
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
      saveRun(deps.root, failed);
      deps.log?.('warn', `[workflow-runs] closed pre-sequential running record ${runId} (${workflowId}) as failed`);
      return failed;
    }

    // Compile from the run's FROZEN definition snapshot (GRS-014b-fix, Codex
    // finding 2) — the store is consulted only for pre-snapshot legacy records. A
    // running run executes what it claims (its definitionVersion), regardless of any
    // later edit/retire/delete of the definition file.
    const def = run.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
    if (!def) {
      const failed: WorkflowRun = {
        ...run,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(run.errors ?? []),
          { code: 'definition-missing', message: `run has no definition snapshot and definition "${workflowId}" no longer exists on the evidence root` },
        ],
      };
      saveRun(deps.root, failed);
      return failed;
    }

    // Sweep compiles WITHOUT a roster: actor existence was checked at start; at
    // advancement time the spawn itself is the authoritative check (an unknown
    // employee fails the spawn, which fails/skips the step honestly).
    const resolved = compilePlan(def);
    if (!resolved.ok) {
      const failed: WorkflowRun = {
        ...run,
        status: 'failed',
        endedAt: now(),
        errors: [...(run.errors ?? []), ...resolved.errors],
      };
      saveRun(deps.root, failed);
      return failed;
    }

    return driveRunLocked(deps, def, resolved.plan, run);
  });
  // Todos ledger (GRS-021a): a sweep drive that lands the run terminal reflects
  // it onto the run's work item. Idempotent in the bridge — re-reflecting an
  // already-mapped terminal is a no-op.
  reflectRunTerminalOnTodo(deps, result);
  // GRS-021b: a sweep that leaves the run parked (a fresh park, or a still-parked
  // probe-only pass) keeps the operator queue truthful — idempotent re-mirror.
  mirrorParkOnTodo(deps, result);
  return result;
}

/* ── Gate resolution (GRS-014e) ─────────────────────────────────────────────── */

export type ResolveGateOutcome =
  | { outcome: 'resolved'; run: WorkflowRun }
  | { outcome: 'not-found' }
  | { outcome: 'not-parked'; run: WorkflowRun };

/**
 * Resolve a PARKED run's human-approval gate (the API half of the accountability
 * doorbell — design D3: "who advances a parked run: only the resolve-gate route").
 * Runs under the run's advance lock so resolution never interleaves with a sweep.
 *
 * approve → the pure `resolveParkedGate` transition unparks the run (gateNode receipt
 * settles as operator-approved checkpoint / runGate key recorded), the record is
 * persisted, and the run is DRIVEN forward through the same driver path the sweep
 * uses (compiled from the frozen definitionSnapshot; the store is only a legacy
 * fallback). reject → the run persists as `failed` with the operator-rejection
 * receipt; nothing is driven (rejection is terminal).
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
    const resolved = resolveParkedGate(run, decision, now, opts);
    if (!resolved.ok) return { outcome: 'not-parked' as const, run };

    saveRun(deps.root, resolved.run); // the decision is durable before any drive
    if (resolved.run.status !== 'running') {
      return { outcome: 'resolved' as const, run: resolved.run }; // rejection — terminal
    }

    const def = resolved.run.definitionSnapshot ?? deps.getDefinition(deps.root, workflowId);
    if (!def) {
      const failed: WorkflowRun = {
        ...resolved.run,
        status: 'failed',
        endedAt: now(),
        errors: [
          ...(resolved.run.errors ?? []),
          { code: 'definition-missing', message: `run has no definition snapshot and definition "${workflowId}" no longer exists on the evidence root` },
        ],
      };
      saveRun(deps.root, failed);
      return { outcome: 'resolved' as const, run: failed };
    }
    const compiled = compilePlan(def);
    if (!compiled.ok) {
      const failed: WorkflowRun = {
        ...resolved.run,
        status: 'failed',
        endedAt: now(),
        errors: [...(resolved.run.errors ?? []), ...compiled.errors],
      };
      saveRun(deps.root, failed);
      return { outcome: 'resolved' as const, run: failed };
    }
    const driven = await driveRunLocked(deps, def, compiled.plan, resolved.run);
    return { outcome: 'resolved' as const, run: driven };
  });
  // Todos ledger: the gate was resolved by the RUN AUTHORITY through THIS route —
  // clear any mirrored Todo approval to match, no matter which surface called it
  // (the Todo route or the workflow UI's own resolve-gate), so a pending mirror
  // never ghosts in the operator's queue (GRS-021b QA finding 1). Then reflect any
  // terminal (an operator rejection → failed, or a post-approval drive → completed).
  // Both best-effort; a throwing ledger never changes resolve semantics.
  if (outcome.outcome === 'resolved') {
    clearParkMirrorOnTodo(deps, outcome.run, decision, opts.decidedBy ?? 'operator');
    reflectRunTerminalOnTodo(deps, outcome.run);
  }
  return outcome;
}

/* ── Sweeping ───────────────────────────────────────────────────────────────── */

/** One sweep: advance every `running` run on the evidence root. Returns how many runs
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
    // Sweepable (GRS-016a): running runs, plus parked runs whose sibling sessions
    // are still in flight (probe-only settles — a park freezes dispatch, not
    // evidence). Parked-and-quiet runs wait on a human; terminals are done.
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
      if (examined > 0) deps.log?.('info', `[workflow-runs] ${label} sweep advanced ${examined} running run(s)`);
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
