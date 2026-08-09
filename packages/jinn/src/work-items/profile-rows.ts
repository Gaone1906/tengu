import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';

/**
 * Read/write surface over `work_item_profile` — which profile a root work
 * item belongs to (docs/tengu/18-council-specialists.md, D22): a user-defined
 * namespace inside one running instance, root-only, mirroring
 * `workspace-rows.ts`'s `work_item_workspace` surface byte-for-byte. One
 * current row per item, edited in place, and free of work-item runtime
 * imports for the same reason: `store.ts` hydrates `WorkItem.profileId` from
 * here without an import cycle.
 */

export interface WorkItemProfile {
  workItemId: string;
  profileId: string;
  updatedAt: string;
}

function rowToProfile(row: Record<string, unknown>): WorkItemProfile {
  return {
    workItemId: row.work_item_id as string,
    profileId: row.profile_id as string,
    updatedAt: row.updated_at as string,
  };
}

/** The item's current profile, or undefined if none is set. */
export function currentProfile(workItemId: string): WorkItemProfile | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_item_profile WHERE work_item_id = ?')
    .get(parseTodoId(workItemId)) as Record<string, unknown> | undefined;
  return row ? rowToProfile(row) : undefined;
}

export function currentProfileId(workItemId: string): string | undefined {
  return currentProfile(workItemId)?.profileId;
}

/** Batched current-annotation lookup — ONE query per ≤500-id chunk, for list
 *  pages and trees (never per item). Items with no profile are absent. */
export function currentProfilesByItem(workItemIds: readonly string[]): Map<string, WorkItemProfile> {
  const result = new Map<string, WorkItemProfile>();
  if (workItemIds.length === 0) return result;
  const db = initDb();
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = db
      .prepare(`SELECT * FROM work_item_profile WHERE work_item_id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const profile = rowToProfile(row);
      result.set(profile.workItemId, profile);
    }
  }
  return result;
}

/** Raw insert-or-replace, no validation beyond non-empty and no audit event —
 *  callers own the root-only invariant and the `work_item_events` trail. */
export function upsertProfileId(workItemId: string, profileId: string): WorkItemProfile {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const trimmed = profileId.trim();
  if (!trimmed) throw new Error('profile id cannot be empty');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO work_item_profile (work_item_id, profile_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
  ).run(id, trimmed, now);
  return { workItemId: id, profileId: trimmed, updatedAt: now };
}
