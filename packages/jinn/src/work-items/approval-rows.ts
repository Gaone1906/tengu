import { initDb } from '../sessions/registry.js';
import { parseTodoId } from './id.js';
import type { ApprovalState, ApprovalTargetKind } from './store.js';

/**
 * Read surface over `work_item_approvals` (Todos v2 slice 4). Approvals live in
 * their own history table; the legacy `approval_*` columns on work_items are
 * frozen (dual-read window) and every read resolves through the "current row":
 * the PENDING row when one exists (the partial unique index guarantees at most
 * one), else the most recently decided row.
 *
 * This module is deliberately free of work-item runtime imports (types only) so
 * `store.ts` can hydrate the legacy fields from it without an import cycle; the
 * WRITE orchestration (request/decide/escalate) stays in `approvals.ts`.
 */

export interface WorkItemApproval {
  id: string;
  workItemId: string;
  state: ApprovalState;
  request: string;
  /** Opaque correlation reference carried by the request contract (sources the
   *  legacy `approvalRef` payload field). */
  ref: string | null;
  target: string | null;
  targetKind: ApprovalTargetKind | null;
  requestedBy: string;
  requestedAt: string;
  escalatedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

function rowToApproval(row: Record<string, unknown>): WorkItemApproval {
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    state: row.state as ApprovalState,
    request: row.request as string,
    ref: (row.ref as string) ?? null,
    target: (row.target as string) ?? null,
    targetKind: (row.target_kind as ApprovalTargetKind) ?? null,
    requestedBy: row.requested_by as string,
    requestedAt: row.requested_at as string,
    escalatedAt: (row.escalated_at as string) ?? null,
    decidedBy: (row.decided_by as string) ?? null,
    decidedAt: (row.decided_at as string) ?? null,
    note: (row.note as string) ?? null,
  };
}

/** Pending first if present, else the latest decided row of an ORDERED history. */
function pickCurrent(history: WorkItemApproval[]): WorkItemApproval | undefined {
  const pending = history.find((row) => row.state === 'pending');
  if (pending) return pending;
  return history
    .filter((row) => row.decidedAt !== null)
    .sort((a, b) => (a.decidedAt! < b.decidedAt! ? -1 : a.decidedAt! > b.decidedAt! ? 1 : 0))
    .at(-1) ?? history.at(-1);
}

/** Full approval history for one item, oldest request first. */
export function listApprovals(workItemId: string): WorkItemApproval[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT * FROM work_item_approvals WHERE work_item_id = ? ORDER BY requested_at, rowid')
    .all(parseTodoId(workItemId)) as Record<string, unknown>[];
  return rows.map(rowToApproval);
}

/** The item's current approval: the pending row, else the most recently decided. */
export function currentApproval(workItemId: string): WorkItemApproval | undefined {
  return pickCurrent(listApprovals(workItemId));
}

/** Batched current-row lookup — ONE query per ≤500-id chunk, for list pages and
 *  trees (never per item). Items with no approval history are simply absent. */
export function currentApprovalsByItem(workItemIds: readonly string[]): Map<string, WorkItemApproval> {
  const result = new Map<string, WorkItemApproval>();
  if (workItemIds.length === 0) return result;
  const db = initDb();
  const byItem = new Map<string, WorkItemApproval[]>();
  for (let start = 0; start < workItemIds.length; start += 500) {
    const chunk = workItemIds.slice(start, start + 500).map((id) => parseTodoId(id));
    const rows = db
      .prepare(
        `SELECT * FROM work_item_approvals WHERE work_item_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY requested_at, rowid`,
      )
      .all(...chunk) as Record<string, unknown>[];
    for (const raw of rows) {
      const row = rowToApproval(raw);
      const history = byItem.get(row.workItemId) ?? [];
      history.push(row);
      byItem.set(row.workItemId, history);
    }
  }
  for (const [workItemId, history] of byItem) {
    const current = pickCurrent(history);
    if (current) result.set(workItemId, current);
  }
  return result;
}
