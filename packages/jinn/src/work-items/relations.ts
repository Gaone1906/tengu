import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';
import { appendWorkItemEvent, type WorkItemStatus } from './store.js';

/**
 * Work-item relations — typed item-to-item links (Todos v2 slice 3).
 *
 * Semantics (design decisions, locked):
 * - `blocks` and `duplicates` are directional (src blocks dst; src duplicates
 *   dst). `relates` is symmetric and stored ONCE in canonical order — the
 *   lexicographically smaller Todo id as src_id; writers normalize, readers
 *   query one way.
 * - The `blocks` graph is a DAG: inserting an edge runs a BFS from dst over
 *   outgoing blocks edges inside the insert transaction; reaching src refuses
 *   with `relation-cycle` and the cycle path.
 * - `duplicates` is a pure marker — no lifecycle coupling.
 * - Any identified caller adds; removal is the relation's creator or the
 *   operator. Self-relations are refused (belt: the table CHECK).
 * - `relation_added`/`relation_removed` events land on BOTH endpoints' audit
 *   trails in the same transaction with `versionEffect: 'state'` (both resort).
 */

export type RelationKind = 'blocks' | 'relates' | 'duplicates';

export interface WorkItemRelation {
  srcId: string;
  dstId: string;
  kind: RelationKind;
  createdBy: string;
  createdAt: string;
}

export interface RelatedItemRef {
  id: string;
  title: string;
  status: WorkItemStatus;
}

export interface WorkItemRelationView {
  kind: RelationKind;
  direction: 'out' | 'in';
  other: RelatedItemRef;
  createdBy: string;
  createdAt: string;
}

export type WorkItemRelationErrorCode = 'relation-cycle' | 'relation-forbidden';

export class WorkItemRelationError extends Error {
  readonly code: WorkItemRelationErrorCode;

  constructor(code: WorkItemRelationErrorCode, message: string) {
    super(message);
    this.name = 'WorkItemRelationError';
    this.code = code;
  }
}

/** Non-terminal blocker statuses: everything except done/cancelled blocks —
 *  including `escalated`, which is sticky but decidedly not finished. */
const TERMINAL_SQL = "('done', 'cancelled')";

function rowToRelation(row: Record<string, unknown>): WorkItemRelation {
  return {
    srcId: row.src_id as string,
    dstId: row.dst_id as string,
    kind: row.kind as RelationKind,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
  };
}

/** Canonical stored endpoint order for a kind: `relates` sorts the pair,
 *  directional kinds keep it. */
function canonicalEndpoints(srcId: string, dstId: string, kind: RelationKind): [string, string] {
  if (kind === 'relates' && dstId < srcId) return [dstId, srcId];
  return [srcId, dstId];
}

function getRelationRow(
  db: ReturnType<typeof initDb>,
  srcId: string,
  dstId: string,
  kind: RelationKind,
): WorkItemRelation | undefined {
  const row = db
    .prepare('SELECT * FROM work_item_relations WHERE src_id = ? AND dst_id = ? AND kind = ?')
    .get(srcId, dstId, kind) as Record<string, unknown> | undefined;
  return row ? rowToRelation(row) : undefined;
}

/** BFS from `from` over outgoing blocks edges; returns the path from → … → to
 *  when reachable, else undefined. Runs inside the caller's transaction. */
function blocksPath(db: ReturnType<typeof initDb>, from: string, to: string): string[] | undefined {
  const outgoing = db.prepare("SELECT dst_id FROM work_item_relations WHERE src_id = ? AND kind = 'blocks'");
  const predecessor = new Map<string, string | null>([[from, null]]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === to) {
      const path: string[] = [];
      for (let step: string | null = node; step !== null; step = predecessor.get(step) ?? null) path.unshift(step);
      return path;
    }
    for (const next of outgoing.pluck().all(node) as string[]) {
      if (predecessor.has(next)) continue;
      predecessor.set(next, node);
      queue.push(next);
    }
  }
  return undefined;
}

/**
 * Add a relation between two Todos. `relates` is normalized to canonical order;
 * a re-add of an existing relation (either order for `relates`) is idempotent —
 * it returns the existing row and appends no events. A `blocks` edge that would
 * close a cycle refuses with `relation-cycle` and the offending path.
 */
export function addRelation(srcId: string, dstId: string, kind: RelationKind, createdBy: string): WorkItemRelation {
  const db = initDb();
  const rawSrc = parseTodoId(srcId);
  const rawDst = parseTodoId(dstId);
  if (rawSrc === rawDst) throw new Error(`a Todo cannot ${kind === 'relates' ? 'relate to' : kind === 'blocks' ? 'block' : 'duplicate'} itself`);
  const [src, dst] = canonicalEndpoints(rawSrc, rawDst, kind);
  const now = new Date().toISOString();
  const txn = db.transaction((): WorkItemRelation => {
    for (const endpoint of [src, dst]) {
      if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(endpoint)) {
        throw new Error(`Todo ${endpoint} not found`);
      }
    }
    const existing = getRelationRow(db, src, dst, kind);
    if (existing) return existing;
    if (kind === 'blocks') {
      // src → dst must not close a loop: refuse when dst already reaches src.
      // The path reads src → dst → … → src (the new edge + the existing chain).
      const path = blocksPath(db, dst, src);
      if (path) {
        throw new WorkItemRelationError(
          'relation-cycle',
          `${src} blocks ${dst} would create a cycle: ${[src, ...path].join(' → ')}`,
        );
      }
    }
    db.prepare(
      'INSERT INTO work_item_relations (src_id, dst_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(src, dst, kind, createdBy, now);
    for (const endpoint of [src, dst]) {
      appendWorkItemEvent({
        workItemId: endpoint,
        kind: 'relation_added',
        actor: createdBy,
        detail: { srcId: src, dstId: dst, kind },
        versionEffect: 'state', // both endpoints resort in activity-ordered lists
      });
    }
    return { srcId: src, dstId: dst, kind, createdBy, createdAt: now };
  });
  return txn();
}

/**
 * Remove a relation (creator-or-operator). `relates` accepts either endpoint
 * order. Returns false when the relation does not exist.
 */
export function removeRelation(
  srcId: string,
  dstId: string,
  kind: RelationKind,
  remover: { actor: string; operator: boolean },
): boolean {
  const db = initDb();
  const [src, dst] = canonicalEndpoints(parseTodoId(srcId), parseTodoId(dstId), kind);
  const txn = db.transaction((): boolean => {
    const existing = getRelationRow(db, src, dst, kind);
    if (!existing) return false;
    if (!remover.operator && remover.actor !== existing.createdBy) {
      throw new WorkItemRelationError('relation-forbidden', 'only the relation creator (or the operator) may remove it');
    }
    db.prepare('DELETE FROM work_item_relations WHERE src_id = ? AND dst_id = ? AND kind = ?').run(src, dst, kind);
    for (const endpoint of [src, dst]) {
      appendWorkItemEvent({
        workItemId: endpoint,
        kind: 'relation_removed',
        actor: remover.operator ? 'operator' : remover.actor,
        detail: { srcId: src, dstId: dst, kind },
        versionEffect: 'state',
      });
    }
    return true;
  });
  return txn();
}

/** List a Todo's relations in both directions, each resolved with the other
 *  endpoint's compact ref. `relates` is symmetric, so it always reads as
 *  direction 'out' regardless of stored order. An unknown Todo reads as empty —
 *  existence 404s belong to the route layer. */
export function listRelations(workItemId: string): WorkItemRelationView[] {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const rows = db
    .prepare(
      `SELECT r.kind, r.created_by, r.created_at,
              CASE WHEN r.src_id = @id THEN 'out' ELSE 'in' END AS direction,
              w.id AS other_id, w.title AS other_title, w.status AS other_status
       FROM work_item_relations r
       JOIN work_items w ON w.id = CASE WHEN r.src_id = @id THEN r.dst_id ELSE r.src_id END
       WHERE r.src_id = @id OR r.dst_id = @id
       ORDER BY r.created_at, r.rowid`,
    )
    .all({ id }) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    kind: row.kind as RelationKind,
    direction: row.kind === 'relates' ? 'out' : (row.direction as 'out' | 'in'),
    other: { id: row.other_id as string, title: row.other_title as string, status: row.other_status as WorkItemStatus },
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
  }));
}

/** True while ANY incoming blocks edge originates from a non-terminal (not
 *  done/cancelled) item. */
export function isBlocked(workItemId: string): boolean {
  const db = initDb();
  const id = parseTodoId(workItemId);
  return !!db
    .prepare(
      `SELECT 1 FROM work_item_relations r
       JOIN work_items w ON w.id = r.src_id
       WHERE r.dst_id = ? AND r.kind = 'blocks' AND w.status NOT IN ${TERMINAL_SQL}
       LIMIT 1`,
    )
    .get(id);
}

/** Batch form of `isBlocked` for list payloads: ONE query for the whole page,
 *  never per-item. Returns the subset of the given ids that are blocked. */
export function blockedSet(workItemIds: string[]): Set<string> {
  if (workItemIds.length === 0) return new Set();
  const db = initDb();
  const ids = workItemIds.map((id) => parseTodoId(id));
  const placeholders = ids.map(() => '?').join(', ');
  const blocked = db
    .prepare(
      `SELECT DISTINCT r.dst_id FROM work_item_relations r
       JOIN work_items w ON w.id = r.src_id
       WHERE r.kind = 'blocks' AND w.status NOT IN ${TERMINAL_SQL} AND r.dst_id IN (${placeholders})`,
    )
    .pluck()
    .all(...ids) as string[];
  return new Set(blocked);
}
