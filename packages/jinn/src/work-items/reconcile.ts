import {
  effectiveVerifyMode,
  getWorkItem,
  isBlockDeclared,
  isReviewBounceDeclared,
  listWorkItems,
  RECONCILER_ACTOR,
  STICKY_STATUSES,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from './store.js';
import { transitionDerived } from './transitions.js';
import { currentApproval } from './approval-rows.js';
import { runVerifyForWorkItem } from './checkpoint.js';
import { notifyTodoChanged } from './live-events.js';
import { listSessionsByWorkItem } from '../sessions/registry.js';
import { logger } from '../shared/logger.js';
import type { SessionAttemptOutcome } from '../shared/types.js';

/**
 * Work-item status reconciler (GRS-003a, elevated to the Todos vocabulary by
 * GRS-021a design §1.1).
 *
 * A work item's status is DERIVED from the terminal/recovery states of its
 * linked execution attempts (sessions), not from scattered ad-hoc writes. The
 * elevated rules:
 *
 *   - `done`/`cancelled`/`escalated` are STICKY. Closes are decisions; escalated
 *     is a deliberate routing to the operator — session churn never silently
 *     pulls an item off his queue.
 *   - ZERO linked sessions → untouched (`backlog`/`assigned` are never clobbered).
 *   - Any session in flight (`running`/`waiting`) → `executing`.
 *   - Newest attempt with an explicit `succeeded` receipt → `in_review` (the vision's "session completes →
 *     in_review, NOT done" made structural) — then the TRUST policy hook runs in
 *     the same pass: an item whose effective verify mode is `trust` auto-closes
 *     to `done` (actor `policy:trust`, event-audited), so cron/fire-and-forget
 *     items never pile into a fake review queue.
 *   - Newest attempt with an explicit `failed`/`interrupted` receipt → `blocked`.
 *
 * All writes go through the guarded `transitions.ts` (event-audited, optimistic,
 * sticky-safe) — the reconciler is a consumer of the state machine, not a second
 * write path.
 */

/** Session lifecycle states, mirrored from `Session.status` in shared/types.ts. */
type SessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'interrupted';

export interface WorkItemAttemptEvidence {
  status: SessionStatus;
  outcome: SessionAttemptOutcome | null;
}

/** A session is "in flight" (work is actively happening) in these states. */
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['running', 'waiting']);

/** Declaration provenance that cannot be derived from attempt receipts alone. */
export interface DeriveWorkItemOptions {
  blockDeclared?: boolean;
  reviewBounceDeclared?: boolean;
}

/**
 * Pure derivation: given an item's current status, its provenance, and the
 * terminal receipts of its linked sessions **ordered newest-first** (as
 * `listSessionsByWorkItem` returns them, by `last_activity DESC`), return the
 * status the item SHOULD have. Never yields a sticky terminal — `done` is a
 * policy/human decision layered on top by the TRUST hook.
 */
export function deriveWorkItemStatus(
  current: WorkItemStatus,
  attempts: readonly WorkItemAttemptEvidence[],
  source?: WorkItemSource,
  opts?: DeriveWorkItemOptions,
): WorkItemStatus {
  if (STICKY_STATUSES.has(current)) return current;
  if (attempts.length === 0) return current;
  // Review is a governance phase, not a reflection of session transport state.
  // Parent callbacks and review conversations may run on linked sessions after
  // submission; only an explicit review bounce may reopen execution.
  if (current === 'in_review') return current;
  // Explicit declarations are governance state, not session transport state.
  // They remain authoritative until another declared transition moves the Todo.
  if (current === 'blocked' && opts?.blockDeclared) return current;
  if (current === 'executing' && opts?.reviewBounceDeclared) return current;
  if (attempts.some((attempt) => IN_FLIGHT.has(attempt.status))) return 'executing';
  // Nothing in flight — the most recent attempt (index 0, newest-first) is the
  // authority (an old clean settle must not mask a newer failure, and a newer
  // clean retry must clear an older failure).
  const newest = attempts[0].outcome;
  if (newest === 'succeeded') return 'in_review';
  if (newest === 'failed' || newest === 'interrupted') return 'blocked';
  return current;
}

export interface ReconcileResult {
  item: WorkItem;
  changed: boolean;
}

/**
 * Reconcile a single work item from its linked sessions, then apply the TRUST
 * auto-close hook. Returns the (possibly updated) item and whether anything
 * changed, or undefined if the id is unknown. A no-op when the derived status
 * already matches — no write, no `updated_at` churn, no events.
 */
export function reconcileWorkItem(id: string): ReconcileResult | undefined {
  const item = getWorkItem(id);
  if (!item) return undefined;
  // Workflow-created Todos predate native Workflow run authority. They are
  // frozen audit records: automatic session reconciliation must never derive,
  // TRUST-close, or otherwise rewrite them. Explicit guarded Todo actions remain
  // available through the normal operator surfaces.
  if (item.source === 'workflow') return { item, changed: false };
  // A Workflow phase session is linked to the run's bound Todo so the run's
  // spend rolls up there, but the RUN owns its own lifecycle: it retries,
  // parks on gates, and decides when the pipeline is finished. Deriving the
  // Todo from phase receipts would settle it on the first phase that finished —
  // `in_review` (and TRUST-closed to `done`) with four phases still to run, and
  // `in_review` is not re-derivable, so it would stay wrong for the rest of the
  // run. Same rule the `source === 'workflow'` guard above states for items.
  const attempts = listSessionsByWorkItem(id)
    .filter((s) => s.workflowProvenance?.kind !== 'phase')
    .map((s) => ({
      status: s.status as SessionStatus,
      outcome: s.attemptOutcome ?? null,
    }));
  let derived = deriveWorkItemStatus(item.status, attempts, item.source);
  // Provenance is only needed when receipt derivation would overwrite the
  // current state. Since a Todo cannot be blocked and executing simultaneously,
  // this performs at most one indexed event-row lookup per reconcile.
  if (derived !== item.status) {
    if (item.status === 'blocked') {
      derived = deriveWorkItemStatus(item.status, attempts, item.source, {
        blockDeclared: isBlockDeclared(id),
      });
    } else if (item.status === 'executing') {
      derived = deriveWorkItemStatus(item.status, attempts, item.source, {
        reviewBounceDeclared: isReviewBounceDeclared(id),
      });
    }
  }

  let current = item;
  let changed = false;
  if (derived !== item.status) {
    // transitionDerived returns undefined on a sticky/concurrent race — report
    // the fresh truth as unchanged rather than clobbering a deliberate decision.
    const updated = transitionDerived(id, derived, RECONCILER_ACTOR, { declared: false });
    if (updated) {
      current = updated;
      changed = true;
    } else {
      const latest = getWorkItem(id);
      return latest ? { item: latest, changed: false } : undefined;
    }
  }

  // TRUST policy hook (design §1.5): an item landing (or sitting) in `in_review`
  // whose effective verify mode is `trust` auto-closes in the SAME pass —
  // settle → in_review → done reads as one truthful story in the event log.
  //
  // A PENDING approval withholds it: an open routed gate IS the review, so
  // closing over one asserts a decision nobody made. This matters most for a
  // Todo-bound Workflow run, which parks its gates here — a trust-tier item would
  // otherwise reach `done` inside one sweep with the merge still unapproved.
  if (current.status === 'in_review' && effectiveVerifyMode(current) === 'trust'
    && currentApproval(current.id)?.state !== 'pending') {
    const closed = transitionDerived(id, 'done', 'policy:trust', { policy: 'trust', auto: true });
    if (closed) {
      current = closed;
      changed = true;
    }
  }

  // ICI-570: reconciles run from session lifecycle and cron — in-process lanes
  // with no route-level event. One live signal per actual change.
  if (changed) notifyTodoChanged(current, 'reconciled');

  return { item: current, changed };
}

export interface ReconcileSweepResult {
  checked: number;
  changed: number;
}

/** The non-sticky statuses a sweep re-derives. `in_review` is included so a
 *  pre-existing trust-tier item settles on the next pass even if its landing
 *  pass predates this code. */
const SWEEP_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'blocked'];

/**
 * Reconcile every non-sticky item. Invoked at gateway startup right after
 * `recoverStaleSessions()` (the exact moment `running` sessions became
 * `interrupted`, so their items must move to `blocked`) and periodically by
 * `startWorkItemReconciler` (so settles reach `in_review`/`done` while the
 * gateway runs, not just at the next boot). One indexed session query per
 * candidate — negligible at this table's scale (see GRS-003a's note).
 */
export function reconcileActiveWorkItems(): ReconcileSweepResult {
  const candidates = SWEEP_STATUSES.flatMap((status) => listWorkItems({ status }));
  let changed = 0;
  for (const item of candidates) {
    const result = reconcileWorkItem(item.id);
    if (result?.changed) changed++;
  }
  return { checked: candidates.length, changed };
}

/**
 * Startup hook: reconcile work items and log a one-line summary. Best-effort — a
 * reconcile failure must never block gateway boot (mirrors the cron consumer's
 * guard). Returns the count of items whose status changed (0 on any error).
 */
export function reconcileWorkItemsOnStartup(): number {
  try {
    const { checked, changed } = reconcileActiveWorkItems();
    if (changed > 0) {
      logger.info(`Reconciled ${changed} work item(s) from linked session state (of ${checked} non-sticky)`);
    }
    return changed;
  } catch (err) {
    logger.warn(`Work-item startup reconcile skipped: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

const DEFAULT_RECONCILE_INTERVAL_MS = 20_000;

/**
 * Periodic work-item reconcile (GRS-021a): without it, a session that settles
 * mid-process would only reach `in_review`/`done` at the NEXT boot or the next
 * mint-time reconcile — a stale ledger, the exact failure Todos exist to kill.
 * Same primitive as the gateway's status reconciler (unref'd interval, one
 * guarded sweep per tick, ticks never overlap because the sweep is synchronous).
 * Returns a stop function.
 */
export function startWorkItemReconciler(intervalMs: number = DEFAULT_RECONCILE_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try {
      reconcileActiveWorkItems();
    } catch (err) {
      logger.warn(`Work-item reconcile sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface CheckpointReconcileResult {
  checked: number;
  recovered: number;
}

/** The non-sticky statuses eligible for checkpoint recovery — same reasoning
 *  as `deriveWorkItemStatus`'s STICKY_STATUSES guard: `escalated` is a
 *  deliberate routing to the operator, so a passing `verify` must not silently
 *  close over it. */
function checkpointEligible(item: WorkItem): boolean {
  return item.depth === 3 && !!item.verifyCommand && !STICKY_STATUSES.has(item.status);
}

/**
 * Checkpointing on resume (docs/tengu/10-checkpointing.md, D12): before any
 * model tokens are spent, re-run `verify` for every not-done depth-3
 * sub-sub-task that carries one. A PASS means the crash landed in the window
 * between the commit (`work-items/checkpoint.ts#landCheckpoint`) and the
 * ledger write — the work is durably committed, so mark it done WITHOUT
 * redoing it. A fail (or an item with no `verify`) is untouched — that unit is
 * where the resumed session actually restarts.
 *
 * Scoped by `rootId` when given (the sub-task family the crashed session
 * owned) — an unscoped resume sweep would re-run `verify` for the whole
 * ledger, most of which has nothing to do with the session that halted.
 * Resume order per the design doc: reconcile → ledger → handoff → work — this
 * function IS the reconcile step, and it costs zero model tokens by
 * construction (shell commands only).
 */
export function reconcileCheckpointsOnResume(cwd: string, opts?: { rootId?: string }): CheckpointReconcileResult {
  const candidates = (opts?.rootId ? listWorkItems({ rootId: opts.rootId }) : listWorkItems())
    .filter(checkpointEligible);
  let recovered = 0;
  for (const item of candidates) {
    const result = runVerifyForWorkItem(item, cwd);
    if (result?.outcome !== 'passed') continue;
    const updated = transitionDerived(item.id, 'done', RECONCILER_ACTOR, {
      reason: 'verify-recovered',
      note: 'verify passed on resume — work was already committed, only the ledger status was missing',
    });
    if (updated) {
      recovered++;
      notifyTodoChanged(updated, 'reconciled');
    }
  }
  return { checked: candidates.length, recovered };
}
