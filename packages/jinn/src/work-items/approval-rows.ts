import { initDb } from '../shared/db.js';
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
  /** Offered variants for a CHOICE approval (null = plain approve/reject). */
  options: string[] | null;
  /** The picked option, once an approve decision carried one. */
  choice: string | null;
  /** Reserved for the human operator: no employee may decide it, not the COO
   *  and not through escalation. */
  operatorOnly: boolean;
  target: string | null;
  targetKind: ApprovalTargetKind | null;
  requestedBy: string;
  requestedAt: string;
  escalatedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

/** Options are stored as a JSON array of labels; an unreadable blob reads as a
 *  plain approval rather than poisoning the whole row. */
function parseOptions(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) return null;
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function rowToApproval(row: Record<string, unknown>): WorkItemApproval {
  const options = parseOptions(row.choice_options);
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    state: row.state as ApprovalState,
    request: row.request as string,
    ref: (row.ref as string) ?? null,
    options,
    choice: options ? ((row.choice_value as string) ?? null) : null,
    operatorOnly: row.operator_only_id != null,
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

/** Every read joins the optional extensions, so `options`/`choice` and the
 *  operator reservation are present on an approval regardless of which read path
 *  produced it. */
const SELECT_APPROVALS = `SELECT a.*, c.options AS choice_options, c.choice AS choice_value,
     o.approval_id AS operator_only_id
   FROM work_item_approvals a
   LEFT JOIN work_item_approval_choices c ON c.approval_id = a.id
   LEFT JOIN work_item_approval_operator_only o ON o.approval_id = a.id`;

/** Full approval history for one item, oldest request first. */
export function listApprovals(workItemId: string): WorkItemApproval[] {
  const db = initDb();
  const rows = db
    .prepare(`${SELECT_APPROVALS} WHERE a.work_item_id = ? ORDER BY a.requested_at, a.rowid`)
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
        `${SELECT_APPROVALS} WHERE a.work_item_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY a.requested_at, a.rowid`,
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
