import { initDb } from '../sessions/registry.js';
import { resolveApprovalRouteTarget, resolveRootApprovalTarget } from '../gateway/approval-authority.js';
import { appendWorkItemEvent, getWorkItem, type ApprovalTargetKind, type WorkItem } from './store.js';
import { transition } from './transitions.js';

/**
 * Todo approvals — the native write paths + the approval decision orchestrator
 * (GRS-021b, design §1.3).
 *
 * Two orthogonal facts about a Todo: its lifecycle POSITION (status) and whether
 * a routed decision is pending on it (the approval fields). This module owns the
 * approval fields; `transitions.ts` still owns status. The anti-bottleneck
 * principle is LAW: a fresh Todo NEVER carries an approval (the store's create
 * path structurally cannot attach one) — approval is attached only here, where a
 * routed decision is genuinely required for a deliberately-gated Todo.
 *
 * REQUESTING is agent-legal (`requestApproval`); DECIDING is authority-gated by
 * the gateway helper (manager/COO by default; operator/aCEO only after explicit
 * escalation). `decideWorkItemApproval` is the consequence engine after that
 * authority check succeeds.
 *
 * Consequence rules are FIXED and deterministic (not per-request config):
 *   - approve + status `in_review`  → `transition(done)`
 *   - reject  + status `in_review`  → bounce `transition(executing)` (rounds++;
 *     the bounce that reaches maxRounds `escalated`s instead — the transitions
 *     module enforces that)
 *   - any OTHER status              → the decision is recorded, status UNTOUCHED
 */

export interface RequestApprovalInput {
  /** What is being asked of the routed approver (the gate/description text). */
  request: string;
  /** Optional opaque audit/correlation reference. */
  ref?: string | null;
  /** Employee slug expected to decide this approval (manager/COO by default). */
  target?: string | null;
  /** Who requested it (audit only). */
  actor?: string | null;
}

/** Thrown when a decision lands on an item whose approval is no longer `pending`
 *  (a double-decide, or a decide-after-resolve race) — surfaced as `no-pending`.
 *  It is the in-transaction guard that makes the native decision atomic: raised
 *  inside the decision transaction, it rolls the whole thing back. */
export class ApprovalNotPendingError extends Error {
  constructor(id: string) {
    super(`work item ${id} has no pending approval to decide`);
    this.name = 'ApprovalNotPendingError';
  }
}

function classifyApprovalTarget(item: WorkItem, inputTarget: string | null | undefined): { target: string | null; kind: ApprovalTargetKind } {
  if (inputTarget === null) return { target: null, kind: 'none' };

  const target =
    inputTarget === undefined
      ? resolveApprovalRouteTarget({ ...item, approvalTarget: null, approvalTargetKind: null }).target
      : inputTarget;
  if (!target) return { target: null, kind: 'none' };

  const root = resolveRootApprovalTarget();
  return { target, kind: root?.kind === 'virtual' && target === root.name ? 'virtual' : 'employee' };
}

/**
 * Attach a PENDING approval to an item (the native "any actor may REQUEST" path,
 * design §1.3). Sets `approval_state='pending'` + the request text + optional ref,
 * clears any prior decision stamps, and appends ONE `approval_requested` event —
 * status is orthogonal and left untouched. Idempotent when the item is already
 * pending on the identical (request, ref): no write, no duplicate event (so a
 * workflow-park re-mirror on every sweep stays event-silent). Throws on an
 * unknown item.
 */
export function requestApproval(id: string, input: RequestApprovalInput): WorkItem {
  const db = initDb();
  const ref = input.ref ?? null;
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`requestApproval: work item ${id} not found`);
    const routed = classifyApprovalTarget(item, input.target);
    if (
      item.approvalState === 'pending' &&
      item.approvalRequest === input.request &&
      item.approvalRef === ref &&
      item.approvalTarget === routed.target &&
      item.approvalTargetKind === routed.kind
    ) {
      return item; // idempotent re-request (e.g. the parked-run sweep re-mirror)
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_items
         SET approval_state = 'pending', approval_request = ?, approval_ref = ?,
             approval_target = ?, approval_target_kind = ?, approval_escalated_at = NULL,
             approval_decided_by = NULL, approval_decided_at = NULL, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(input.request, ref, routed.target, routed.kind, now, id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'approval_requested',
      actor: input.actor ?? null,
      detail: { request: input.request, ...(ref ? { ref } : {}), ...(routed.target ? { target: routed.target, targetKind: routed.kind } : { targetKind: routed.kind }) },
    });
    return getWorkItem(id)!;
  });
  return txn();
}

export type ApprovalDecision = 'approve' | 'reject';

export interface ArchiveWorkItemOptions {
  human?: boolean;
  callerSessionId?: string;
  note?: string;
}

/**
 * Record a human decision on an item's pending approval (raw write): set the
 * `approved`/`rejected` state + the decided-by/at stamps and append ONE
 * `approval_decided` event. Status is NOT touched here — `decideWorkItemApproval`
 * applies the fixed consequence rules. Throws on an unknown item.
 */
function decideApproval(id: string, decision: ApprovalDecision, decidedBy: string, note?: string): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`decideApproval: work item ${id} not found`);
    if (item.approvalState !== 'pending') throw new ApprovalNotPendingError(id);
    const state = decision === 'approve' ? 'approved' : 'rejected';
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_items
         SET approval_state = ?, approval_decided_by = ?, approval_decided_at = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(state, decidedBy, now, now, id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'approval_decided',
      actor: decidedBy,
      detail: {
        decision,
        ...(note !== undefined ? { note } : {}),
        ...(item.approvalRef ? { ref: item.approvalRef } : {}),
      },
    });
    return getWorkItem(id)!;
  });
  return txn();
}

/**
 * Cancel a Todo while closing any outstanding approval record in the same SQLite
 * transaction. Callers are authority-checked by the gateway before reaching this
 * persistence primitive.
 */
export function archiveWorkItem(id: string, actor: string, opts: ArchiveWorkItemOptions = {}): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    let item = getWorkItem(id);
    if (!item) throw new Error(`archiveWorkItem: work item ${id} not found`);
    if (item.approvalState === 'pending') {
      item = decideApproval(id, 'reject', actor, opts.note ?? 'Todo archived');
    }
    if (item.status === 'cancelled') return item;
    return transition(id, 'cancelled', actor, {
      ...(opts.human ? { human: true } : {}),
      ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
      detail: { action: 'archive', ...(opts.note ? { note: opts.note } : {}) },
    }).item;
  });
  return txn();
}

/** Persist an explicit escalation to the operator/aCEO path. The routed manager
 * or COO still performs this write through the API/MCP authority helper; this
 * low-level function only records the state once authority is established. */
export function escalateApproval(id: string, actor: string, reason?: string): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`escalateApproval: work item ${id} not found`);
    if (item.approvalState !== 'pending') throw new ApprovalNotPendingError(id);
    if (item.approvalEscalatedAt) return item;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_items
         SET approval_escalated_at = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(now, now, id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'note',
      actor,
      detail: { approvalEscalated: true, ...(reason !== undefined ? { reason } : {}) },
      versionEffect: 'companion',
    });
    return getWorkItem(id)!;
  });
  return txn();
}

export interface DecideWorkItemApprovalInput {
  id: string;
  decision: ApprovalDecision;
  note?: string;
  /** Audit actor for the decision + any consequent transition. Default `operator`. */
  decidedBy?: string;
}

export type DecideWorkItemApprovalResult =
  | {
      ok: false;
      code: 'not-found' | 'no-pending';
      message: string;
    }
  | { ok: true; item: WorkItem; escalated: boolean };

/**
 * Apply a NATIVE approval decision + its fixed status consequence in ONE SQLite
 * transaction (GRS-021b QA finding 2 — no half-applied approved+in_review). The
 * decision write, the `approval_decided` event, the status transition
 * (done / bounce+rounds / escalate), and the status event either ALL commit or
 * NONE do. Guarded on `approval_state = 'pending'` re-read INSIDE the txn, so a
 * double-decide or a decide-after-resolved is a clean refusal, never a partial
 * apply. `decideApproval` and `transition` each open their own transaction; called
 * here they nest as SAVEPOINTs, so a throw from the status write (or a concurrent
 * state change) rolls back the decision too.
 */
function applyNativeDecisionAtomic(
  id: string,
  decision: ApprovalDecision,
  decidedBy: string,
  note: string | undefined,
): { item: WorkItem; escalated: boolean } {
  const db = initDb();
  const txn = db.transaction((): { item: WorkItem; escalated: boolean } => {
    const item = getWorkItem(id);
    if (!item || item.approvalState !== 'pending') throw new ApprovalNotPendingError(id);
    // 1. Record the decision (approval fields + approval_decided event).
    decideApproval(id, decision, decidedBy, note);
    // 2. The fixed consequence, in the SAME transaction — a failure here rolls the
    //    decision back with it (atomicity), never leaving approved + in_review.
    let escalated = false;
    if (item.status === 'in_review') {
      if (decision === 'approve') {
        transition(id, 'done', decidedBy, { human: true, ...(note !== undefined ? { detail: { note } } : {}) });
      } else {
        const bounced = transition(id, 'executing', decidedBy, {
          human: true,
          bounce: true,
          detail: { rejected: true, ...(note !== undefined ? { critique: note } : {}) },
        });
        escalated = bounced.escalated;
      }
    }
    return { item: getWorkItem(id)!, escalated };
  });
  return txn();
}

/**
 * Decide a Todo's pending approval and apply the fixed consequences (design §1.3).
 * The route's consequence engine — approval authority is enforced UPSTREAM by
 * the gateway helper; this function assumes the caller was already authorized.
 */
export async function decideWorkItemApproval(
  input: DecideWorkItemApprovalInput,
): Promise<DecideWorkItemApprovalResult> {
  const decidedBy = input.decidedBy ?? 'operator';
  const item = getWorkItem(input.id);
  if (!item) return { ok: false, code: 'not-found', message: `work item ${input.id} not found` };
  if (item.approvalState !== 'pending') {
    return { ok: false, code: 'no-pending', message: `work item ${input.id} has no pending approval to decide` };
  }

  // NATIVE decision → record it AND apply the fixed consequence rules ATOMICALLY
  // (QA finding 2): one transaction, guarded on `pending`, so a status-write
  // failure or a decide-after-resolve race can never leave a half-applied state.
  try {
    const { item: updated, escalated } = applyNativeDecisionAtomic(input.id, input.decision, decidedBy, input.note);
    return { ok: true, item: updated, escalated };
  } catch (err) {
    if (err instanceof ApprovalNotPendingError) return { ok: false, code: 'no-pending', message: err.message };
    throw err; // a real write failure — the whole decision rolled back; surface it
  }
}
