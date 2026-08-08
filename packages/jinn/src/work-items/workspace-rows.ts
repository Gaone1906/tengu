import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';

/**
 * Read/write surface over `work_item_workspace` — project identity for a root
 * work item (docs/tengu/03-implementation-plan.md step 11, stand-up): root =
 * project, matching the existing one-root-per-outcome convention. One current
 * row per item, edited in place — same shape as `verify-rows.ts`'s
 * `work_item_verify` surface, and free of work-item runtime imports for the
 * same reason: `store.ts` hydrates `WorkItem.workspacePath` from here without
 * an import cycle.
 */

export interface WorkItemWorkspace {
  workItemId: string;
  workspacePath: string;
  updatedAt: string;
}

function rowToWorkspace(row: Record<string, unknown>): WorkItemWorkspace {
  return {
    workItemId: row.work_item_id as string,
    workspacePath: row.workspace_path as string,
    updatedAt: row.updated_at as string,
  };
}

/** The item's current workspace path, or undefined if none is set. */
export function currentWorkspace(workItemId: string): WorkItemWorkspace | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_item_workspace WHERE work_item_id = ?')
    .get(parseTodoId(workItemId)) as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : undefined;
}

export function currentWorkspacePath(workItemId: string): string | undefined {
  return currentWorkspace(workItemId)?.workspacePath;
}

/** Batched current-annotation lookup — ONE query per ≤500-id chunk, for list
 *  pages and trees (never per item). Items with no workspace path are absent. */
export function currentWorkspacesByItem(workItemIds: readonly string[]): Map<string, WorkItemWorkspace> {
  const result = new Map<string, WorkItemWorkspace>();
  if (workItemIds.length === 0) return result;
  const db = initDb();
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = db
      .prepare(`SELECT * FROM work_item_workspace WHERE work_item_id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const workspace = rowToWorkspace(row);
      result.set(workspace.workItemId, workspace);
    }
  }
  return result;
}

/** Raw insert-or-replace, no validation beyond non-empty and no audit event —
 *  callers own the root-only invariant and the `work_item_events` trail. */
export function upsertWorkspacePath(workItemId: string, workspacePath: string): WorkItemWorkspace {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const trimmed = workspacePath.trim();
  if (!trimmed) throw new Error('workspace path cannot be empty');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO work_item_workspace (work_item_id, workspace_path, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`,
  ).run(id, trimmed, now);
  return { workItemId: id, workspacePath: trimmed, updatedAt: now };
}
