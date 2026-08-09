import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Per-project phase registry (docs/tengu/18-council-specialists.md, D21):
 * `phase` is a column on `work_items`, exactly parallel to `department` (D6's
 * "labels, not agents" applied again) — this module is its vocabulary,
 * scoped by `rootId` instead of the company-wide scope `departments.ts` uses.
 * Modeled on the same lazy-registration pattern, minus the ID-prefix
 * derivation departments need and a phase never does.
 */

export interface WorkItemPhaseRecord {
  rootId: string;
  slug: string;
  sequenceOrder: number;
  createdAt: string;
}

function rowToPhase(row: Record<string, unknown>): WorkItemPhaseRecord {
  return {
    rootId: row.root_id as string,
    slug: row.slug as string,
    sequenceOrder: row.sequence_order as number,
    createdAt: row.created_at as string,
  };
}

export function listPhases(db: DatabaseType, rootId: string): WorkItemPhaseRecord[] {
  return (
    db
      .prepare("SELECT * FROM work_item_phases WHERE root_id = ? ORDER BY sequence_order, slug")
      .all(rootId) as Record<string, unknown>[]
  ).map(rowToPhase);
}

/** Resolve (lazily registering) a phase for a project. An existing row wins
 *  over `sequenceOrder` — that applies only to a first-time registration.
 *  Omitted, it defaults to one past the project's current highest order (0
 *  for the first phase). Registration races resolve via the
 *  `(root_id, slug)` primary key, same recovery shape as
 *  `resolveDepartmentPrefix`. */
export function resolvePhase(db: DatabaseType, rootId: string, slug: string, sequenceOrder?: number): WorkItemPhaseRecord {
  const existing = db.prepare("SELECT * FROM work_item_phases WHERE root_id = ? AND slug = ?").get(rootId, slug) as
    | Record<string, unknown>
    | undefined;
  if (existing) return rowToPhase(existing);
  const order =
    sequenceOrder ??
    ((db.prepare("SELECT MAX(sequence_order) AS max_order FROM work_item_phases WHERE root_id = ?").get(rootId) as {
      max_order: number | null;
    }).max_order ?? -1) + 1;
  const record: WorkItemPhaseRecord = { rootId, slug, sequenceOrder: order, createdAt: new Date().toISOString() };
  try {
    db.prepare("INSERT INTO work_item_phases (root_id, slug, sequence_order, created_at) VALUES (?, ?, ?, ?)")
      .run(record.rootId, record.slug, record.sequenceOrder, record.createdAt);
    return record;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw err;
    const winner = db.prepare("SELECT * FROM work_item_phases WHERE root_id = ? AND slug = ?").get(rootId, slug) as
      | Record<string, unknown>
      | undefined;
    if (winner) return rowToPhase(winner);
    return resolvePhase(db, rootId, slug, sequenceOrder);
  }
}

/** Reorder an already-registered phase. Throws if the project has no such
 *  phase — callers register with `resolvePhase` first. */
export function reorderPhase(db: DatabaseType, rootId: string, slug: string, sequenceOrder: number): WorkItemPhaseRecord {
  const result = db
    .prepare("UPDATE work_item_phases SET sequence_order = ? WHERE root_id = ? AND slug = ?")
    .run(sequenceOrder, rootId, slug);
  if (result.changes === 0) throw new Error(`phase "${slug}" is not registered for root ${rootId}`);
  return rowToPhase(
    db.prepare("SELECT * FROM work_item_phases WHERE root_id = ? AND slug = ?").get(rootId, slug) as Record<string, unknown>,
  );
}

/** Remove a phase from a project's registry. The write path never deletes a
 *  phase that Todos still carry — callers own that check, same as
 *  `departments.ts` having no delete path at all. */
export function deletePhase(db: DatabaseType, rootId: string, slug: string): void {
  db.prepare("DELETE FROM work_item_phases WHERE root_id = ? AND slug = ?").run(rootId, slug);
}
