import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';

/**
 * Read/write surface over `work_item_fanout` — the planner's fan-out
 * annotation (docs/tengu/07-fanout-policy.md Gate 1, D8): `parallelSafe`
 * (defaults false) and `parallelGroup`, set once at planning time and
 * justified in the todo body. One current row per item, edited in place —
 * same shape as `verify-rows.ts`'s `work_item_verify` surface, and free of
 * work-item runtime imports for the same reason: `store.ts` hydrates
 * `WorkItem.parallelSafe`/`parallelGroup` from here without an import cycle.
 */

export interface WorkItemFanout {
  workItemId: string;
  parallelSafe: boolean;
  parallelGroup: string | null;
  updatedAt: string;
}

function rowToFanout(row: Record<string, unknown>): WorkItemFanout {
  return {
    workItemId: row.work_item_id as string,
    parallelSafe: Number(row.parallel_safe) === 1,
    parallelGroup: (row.parallel_group as string) ?? null,
    updatedAt: row.updated_at as string,
  };
}

/** The item's current fan-out annotation, or undefined if the planner never
 *  set one — callers treat "no row" as `{ parallelSafe: false, parallelGroup: null }`. */
export function currentFanout(workItemId: string): WorkItemFanout | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_item_fanout WHERE work_item_id = ?')
    .get(parseTodoId(workItemId)) as Record<string, unknown> | undefined;
  return row ? rowToFanout(row) : undefined;
}

/** Batched current-annotation lookup — ONE query per ≤500-id chunk, for list
 *  pages and trees (never per item). Items with no annotation are absent. */
export function currentFanoutsByItem(workItemIds: readonly string[]): Map<string, WorkItemFanout> {
  const result = new Map<string, WorkItemFanout>();
  if (workItemIds.length === 0) return result;
  const db = initDb();
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = db
      .prepare(`SELECT * FROM work_item_fanout WHERE work_item_id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const fanout = rowToFanout(row);
      result.set(fanout.workItemId, fanout);
    }
  }
  return result;
}

export interface SetFanoutInput {
  parallelSafe: boolean;
  parallelGroup?: string | null;
}

/** Raw insert-or-replace, no validation and no audit event — callers
 *  (`work-items/store.ts` at create time, the planner's update path) own the
 *  justification and the `work_item_events` trail. */
export function upsertFanout(workItemId: string, input: SetFanoutInput): WorkItemFanout {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const now = new Date().toISOString();
  const parallelGroup = input.parallelGroup ?? null;
  db.prepare(
    `INSERT INTO work_item_fanout (work_item_id, parallel_safe, parallel_group, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET parallel_safe = excluded.parallel_safe, parallel_group = excluded.parallel_group, updated_at = excluded.updated_at`,
  ).run(id, input.parallelSafe ? 1 : 0, parallelGroup, now);
  return { workItemId: id, parallelSafe: input.parallelSafe, parallelGroup, updatedAt: now };
}
