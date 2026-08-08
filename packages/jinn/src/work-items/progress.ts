import { listWorkItems, type WorkItem } from './store.js';
import { TERMINAL_STATUSES } from './transitions.js';

/**
 * Progress rollups over the Todo tree (Tengu step 3) — read-only aggregation
 * on top of the existing `parentId`/`rootId` tree and the guarded lifecycle in
 * transitions.ts. No new tables, no new write path.
 */

export interface RootProgress {
  rootId: string;
  total: number;
  completed: number;
  inFlight: number;
  /** 0–100, rounded to one decimal. 0 for an empty (unknown/childless-none) tree. */
  completedPct: number;
}

export interface EmployeeProgress {
  assignee: string;
  total: number;
  completed: number;
  inFlight: number;
}

function isTerminal(item: Pick<WorkItem, 'status'>): boolean {
  return TERMINAL_STATUSES.has(item.status);
}

function isInFlight(item: Pick<WorkItem, 'status'>): boolean {
  return item.status === 'executing';
}

/**
 * Completed vs total descendants of `rootId` (root included) — the whole
 * family sharing that `rootId`, exactly what `listWorkItems({ rootId })`
 * already returns. `completed` counts terminal items (`done`/`cancelled`,
 * TERMINAL_STATUSES from transitions.ts); `inFlight` counts items actively
 * `executing`. Optionally scoped to one department (step 11's stand-up).
 */
export function computeRootProgress(rootId: string, opts: { department?: string } = {}): RootProgress {
  const items = listWorkItems(opts.department ? { rootId, department: opts.department } : { rootId });
  const total = items.length;
  const completed = items.filter(isTerminal).length;
  const inFlight = items.filter(isInFlight).length;
  return {
    rootId,
    total,
    completed,
    inFlight,
    completedPct: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
  };
}

/**
 * Completed/total/in-flight per assignee, across every Todo currently
 * assigned to someone (unassigned items are excluded — there is no employee
 * row to attribute them to). One scan of the ledger, not one query per
 * employee. Optionally scoped to one department.
 */
export function computeEmployeeProgress(opts: { department?: string } = {}): EmployeeProgress[] {
  const items = listWorkItems(opts.department ? { department: opts.department } : undefined);
  const byAssignee = new Map<string, { total: number; completed: number; inFlight: number }>();
  for (const item of items) {
    if (!item.assignee) continue;
    const bucket = byAssignee.get(item.assignee) ?? { total: 0, completed: 0, inFlight: 0 };
    bucket.total += 1;
    if (isTerminal(item)) bucket.completed += 1;
    if (isInFlight(item)) bucket.inFlight += 1;
    byAssignee.set(item.assignee, bucket);
  }
  return [...byAssignee.entries()]
    .map(([assignee, counts]) => ({ assignee, ...counts }))
    .sort((a, b) => a.assignee.localeCompare(b.assignee));
}
