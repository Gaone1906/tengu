import type { EditableWorkflowDefinition } from './definition.js';

/**
 * Edge-implied execution order (GRS-014a, promoted to THE execution order in
 * GRS-014b).
 *
 * Kahn topological sort over ALL edges (`handoff` and `sequence` alike), tie-broken
 * by declaration index. This is the order the sequential v2 run engine executes —
 * every node runs after ALL its edge predecessors; among ready nodes, declaration
 * order picks next. A useful property: when declaration order is a valid linear
 * extension of the edges (every edge points declaration-forward), the sort
 * reproduces declaration order exactly, so honest graphs — including branching-
 * forward ones like the sample-autonomy fixture — execute exactly as they read.
 * `null` (a cycle) is refused at run start. GRS-014e: edges marked `kind:'loop'`
 * are EXCLUDED from the sort — a cycle is legal only when every back-edge closing
 * it is a loop edge (the run engine repeats that segment, bounded by
 * `loop.maxRoundsPerRun`); an unmarked cycle still yields `null` → refused.
 *
 * Pure module: no fs, no env, no gateway. Callers pass a definition that already
 * passed `validateDefinition` (unique node ids, no dangling edges).
 */

/**
 * LEGACY shape (GRS-014a): the interim declaration-order walk stamped this warning on
 * runs whose edges disagreed with declaration order. The v2 engine executes in edge
 * order, so nothing writes it anymore — the type stays because old run records carry
 * it and the Run view still renders it.
 */
export interface OrderWarning {
  code: 'order-warning';
  message: string;
  /** The edge-implied order (topological, declaration tiebreak). Absent for a cycle. */
  impliedOrder?: string[];
}
/**
 * Kahn topological order over the definition's edges, tie-broken by declaration
 * index. Returns `null` when the edges contain a cycle (no topological order exists).
 * Edges referencing unknown node ids are ignored (validateDefinition rejects them
 * upstream; ignoring keeps the function total).
 */
export function impliedExecutionOrder(def: EditableWorkflowDefinition): string[] | null {
  const declIndex = new Map<string, number>();
  def.nodes.forEach((n, i) => {
    if (!declIndex.has(n.id)) declIndex.set(n.id, i);
  });

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of declIndex.keys()) indegree.set(id, 0);
  for (const e of def.edges) {
    if (e.kind === 'loop') continue; // GRS-014e: loop BACK-edges never order the graph
    if (!declIndex.has(e.from) || !declIndex.has(e.to)) continue;
    adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < declIndex.size) {
    // Smallest-declaration-index node with indegree 0. Linear scan per pick is fine —
    // definitions are tens of nodes, not thousands (maxNodes caps runs at 100).
    let next: string | null = null;
    for (const [id, i] of declIndex) {
      if (done.has(id) || indegree.get(id)! > 0) continue;
      if (next === null || i < declIndex.get(next)!) next = id;
    }
    if (next === null) return null; // every remaining node has an incoming edge → cycle
    order.push(next);
    done.add(next);
    for (const to of adjacency.get(next) ?? []) {
      indegree.set(to, indegree.get(to)! - 1);
    }
  }
  return order;
}
