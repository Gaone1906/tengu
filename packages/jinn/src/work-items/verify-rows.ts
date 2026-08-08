import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';

/**
 * Read/write surface over `work_item_verify` (checkpointing,
 * docs/tengu/10-checkpointing.md). One current row per item — a verify command
 * is edited in place, not historied, so this stays a plain get/set rather than
 * mirroring `approval-rows.ts`'s pending-vs-decided resolution.
 *
 * Deliberately free of work-item runtime imports (types only) so `store.ts` can
 * hydrate `WorkItem.verifyCommand` from here without an import cycle — same
 * reasoning as `approval-rows.ts`. Depth-3-only and audit-event orchestration
 * belong to the callers (`work-items/store.ts` at create time,
 * `work-items/checkpoint.ts` for later edits), not to this table-access layer.
 */

export interface WorkItemVerify {
  workItemId: string;
  command: string;
  updatedAt: string;
}

function rowToVerify(row: Record<string, unknown>): WorkItemVerify {
  return {
    workItemId: row.work_item_id as string,
    command: row.command as string,
    updatedAt: row.updated_at as string,
  };
}

/** The item's current verify command, or undefined if none is set. */
export function currentVerify(workItemId: string): WorkItemVerify | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_item_verify WHERE work_item_id = ?')
    .get(parseTodoId(workItemId)) as Record<string, unknown> | undefined;
  return row ? rowToVerify(row) : undefined;
}

export function currentVerifyCommand(workItemId: string): string | undefined {
  return currentVerify(workItemId)?.command;
}

/** Batched current-command lookup — ONE query per ≤500-id chunk, for list pages
 *  and trees (never per item). Items with no verify command are simply absent. */
export function currentVerifyCommandsByItem(workItemIds: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (workItemIds.length === 0) return result;
  const db = initDb();
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = db
      .prepare(`SELECT work_item_id, command FROM work_item_verify WHERE work_item_id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Array<{ work_item_id: string; command: string }>;
    for (const row of rows) result.set(row.work_item_id, row.command);
  }
  return result;
}

/** Raw insert-or-replace, no validation beyond non-empty and no audit event —
 *  callers own the depth-3 invariant and the `work_item_events` trail. */
export function upsertVerifyCommand(workItemId: string, command: string): WorkItemVerify {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const trimmed = command.trim();
  if (!trimmed) throw new Error('verify command cannot be empty');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO work_item_verify (work_item_id, command, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET command = excluded.command, updated_at = excluded.updated_at`,
  ).run(id, trimmed, now);
  return { workItemId: id, command: trimmed, updatedAt: now };
}
