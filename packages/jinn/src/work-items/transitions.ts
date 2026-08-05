import { listSessionsByWorkItem } from '../sessions/registry.js';
import { initDb } from '../shared/db.js';
import {
  appendWorkItemEvent,
  effectiveMaxRounds,
  ensureDepartmentRegistered,
  getWorkItem,
  STICKY_STATUSES,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemStatus,
} from './store.js';

/**
 * Guarded Todo transitions (GRS-021a design §1.2) — THE status write path.
 *
 * With 8 statuses + approvals + rounds, scattered `updateStatus` calls would be
 * the split-brain seed all over again. Every status change flows through
 * `transition()`: only declared edges are allowed (illegal edges THROW, never
 * silently write), every change appends a `work_item_events` audit row in the
 * SAME transaction, sticky terminals (`done`/`cancelled`/`escalated`) are left
 * only under explicit human authority, the self-review ban is structural, and
 * the bounce rule (`in_review → executing` with `rounds++`) auto-escalates at
 * the policy's max rounds instead of looping. The GRS-003a reconciler and the
 * (phase-2) dispatcher are consumers of this module, not competitors to it.
 */

/** Declared edges: from → the set of legal targets (design §1.1's diagram).
 *  Governs the human and derived lanes; the agent lane (`opts.agent`) and the
 *  workflow re-arm lane (`opts.requeue`) are bounded by their caller's target
 *  allowlist instead. */
const EDGES: Readonly<Record<WorkItemStatus, ReadonlySet<WorkItemStatus>>> = {
  // `done` from backlog/assigned covers trivially-completed work (e.g. a
  // gate-only workflow run that finishes without ever spawning a session) —
  // rare, but refusing it would strand a truthful terminal.
  backlog: new Set(['assigned', 'executing', 'in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  assigned: new Set(['backlog', 'executing', 'in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  executing: new Set(['in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  in_review: new Set(['executing', 'done', 'blocked', 'cancelled', 'escalated']),
  blocked: new Set(['backlog', 'assigned', 'executing', 'in_review', 'done', 'cancelled', 'escalated']),
  // Sticky terminals: leaving them is HUMAN-ONLY (enforced below, not by edge absence —
  // the operator can route an escalated/closed item anywhere sensible).
  escalated: new Set(['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'cancelled']),
  done: new Set(['backlog']),
  cancelled: new Set(['backlog']),
};

export type TransitionErrorCode =
  | 'not-found'
  | 'illegal-edge'
  | 'human-required'
  | 'self-review-banned'
  | 'children-open'
  | 'conflict';

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

export interface TransitionOptions {
  /** Caller is a human surface (operator web/API). Required to LEAVE a sticky
   *  terminal (`done`/`cancelled`/`escalated`). Agent/system callers never set it. */
  human?: boolean;
  /** Explicit status update from a human/tool surface. A manual move INTO
   *  `executing` is a start action and is legal only from backlog/assigned;
   *  reconciler derivation and review bounces deliberately leave this unset. */
  manual?: boolean;
  /**
   * The calling session's id (the GRS-017 identity seam), when the transition
   * comes from an agent. Enforces the SELF-REVIEW BAN (design §1.5): a session
   * that is one of the item's linked non-phase execution attempts cannot move
   * the item to `done` — its reviewer does. Workflow phases are linked for run
   * attribution and do not become producers merely because of that link.
   */
  callerSessionId?: string;
  /**
   * The agent lane. The calling surface has already restricted `to` to the
   * agent-settable targets, and inside that set the edge map only got in the
   * way: a Todo parked in `blocked` could not be put back to work by the agent
   * that unblocked it. Skips the edge map and the manual-start rule; nothing
   * else moves. Sticky terminals still need `human`, the self-review ban still
   * withholds `done`, and open children still block a close.
   */
  agent?: boolean;
  /**
   * Marks an `in_review → executing` transition as a review BOUNCE (rejection
   * with critique): `rounds` increments, and when the incremented count reaches
   * the policy's max rounds the item goes to `escalated` INSTEAD (design §1.3 —
   * bounded loops end in front of the operator, never spin).
   */
  bounce?: boolean;
  /**
   * The re-arm lane: `to` is dictated by a Workflow's own `todo-status` trigger,
   * not chosen by the caller, so the edge map does not apply. The board withholds
   * `in_review → assigned` from a human drag on purpose (a send-back there is a
   * review verdict, not a drag) — but work sent back for revision has to restart
   * exactly where its trigger fires, whatever status that is. Sticky terminals
   * still need `human`, and the self-review ban still withholds `done`.
   */
  requeue?: boolean;
  /** Free-form audit payload (critique text, verdict, reason) stored on the event. */
  detail?: Record<string, unknown>;
}

export interface TransitionResult {
  item: WorkItem;
  /** True when the bounce rule redirected the target to `escalated`. */
  escalated: boolean;
  /** The committed audit event for an actual status write. Undefined for no-ops. */
  event?: WorkItemEvent;
}

export interface TodoStatusChangeEvent extends WorkItemEvent {
  fromStatus: WorkItemStatus;
  toStatus: WorkItemStatus;
  item: WorkItem;
}

export type TodoStatusChangeListener = (event: TodoStatusChangeEvent) => void | Promise<void>;

let todoStatusChangeListener: TodoStatusChangeListener | null = null;

export function setTodoStatusChangeListener(listener: TodoStatusChangeListener | null): void {
  todoStatusChangeListener = listener;
}

function notifyTodoStatusChange(event: WorkItemEvent | undefined, item: WorkItem): void {
  if (!event || !event.fromStatus || !event.toStatus || !todoStatusChangeListener) return;
  try {
    const maybe = todoStatusChangeListener({
      ...event,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      item,
    });
    if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
      void (maybe as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Best-effort bridge: a workflow-fire failure must never roll back or throw
    // from the guarded lifecycle transition that already committed.
  }
}

function todoProvenanceSnapshot(
  item: Pick<WorkItem, 'source' | 'department' | 'assignee'>,
): Pick<WorkItem, 'source' | 'department' | 'assignee'> {
  return {
    source: item.source,
    department: item.department,
    assignee: item.assignee,
  };
}

/**
 * Move a work item to `to` under the edge map. Throws `TransitionError` on an
 * unknown item, an undeclared edge, a sticky-terminal exit without human
 * authority, or a self-review `done`. Returns the updated item. The status
 * write, rounds bump, and audit event(s) commit in ONE transaction; the write
 * is optimistic (`WHERE status = <from>`) so a concurrent writer surfaces as a
 * `conflict` error instead of a silent clobber.
 */
export function transition(id: string, to: WorkItemStatus, actor: string, opts: TransitionOptions = {}): TransitionResult {
  const db = initDb();
  const txn = db.transaction((): TransitionResult => {
    const item = getWorkItem(id);
    if (!item) throw new TransitionError('not-found', `work item ${id} not found`);
    const from = item.status;
    if (from === to) return { item, escalated: false }; // no-op: no write, no event

    if (STICKY_STATUSES.has(from) && !opts.human) {
      throw new TransitionError(
        'human-required',
        `work item ${id} is ${from} — leaving a sticky terminal is a human decision (operator surface only)`,
      );
    }
    if (!opts.agent && !opts.requeue) {
      if (opts.manual && to === 'executing' && from !== 'backlog' && from !== 'assigned') {
        throw new TransitionError('illegal-edge', `illegal manual transition ${from} → ${to} for work item ${id}`);
      }
      if (!EDGES[from].has(to)) {
        throw new TransitionError('illegal-edge', `illegal transition ${from} → ${to} for work item ${id}`);
      }
    }
    if (to === 'done' && opts.callerSessionId) {
      const linked = listSessionsByWorkItem(id);
      if (linked.some((s) => s.id === opts.callerSessionId && s.workflowProvenance?.kind !== 'phase')) {
        throw new TransitionError(
          'self-review-banned',
          `session ${opts.callerSessionId} executed work item ${id} and cannot mark it done — a reviewer does (self-review ban)`,
        );
      }
    }

    // Roll-up gate (Todos v2): a container cannot be closed over open children.
    // Deliberately stricter than spec §3.4's "non-terminal" wording: an
    // `escalated` child also blocks the close — an escalation awaiting the
    // operator must not be buried by closing its parent. (Human-authorized
    // cascade-cancel still cancels escalated children via the declared
    // escalated→cancelled edge.)
    if (to === 'done' || to === 'cancelled') {
      const openChild = db
        .prepare("SELECT id FROM work_items WHERE parent_id = ? AND status NOT IN ('done', 'cancelled') LIMIT 1")
        .get(id) as { id: string } | undefined;
      if (openChild) {
        throw new TransitionError(
          'children-open',
          `work item ${id} still has open children (e.g. ${openChild.id}) — close or cancel them first`,
        );
      }
    }

    // The bounce rule: a rejected review returns to executing — unless this
    // rejection exhausts the policy's rounds, in which case the loop terminates
    // at the operator (escalated), never spins.
    let target = to;
    let escalatedByRounds = false;
    let rounds = item.rounds;
    if (opts.bounce && from === 'in_review' && to === 'executing') {
      rounds += 1;
      if (rounds >= effectiveMaxRounds(item)) {
        target = 'escalated';
        escalatedByRounds = true;
      }
    }

    // Optimistic write: 0 rows changed = someone moved it between our read and
    // this write (cross-process only — better-sqlite3 calls are synchronous).
    const now = new Date().toISOString();
    const closing = target === 'done' || target === 'cancelled';
    const result = db
      .prepare(`UPDATE work_items SET status = ?, rounds = ?, updated_at = ?, version = version + 1${
        closing ? ', closed_at = COALESCE(closed_at, ?)' : ', closed_at = NULL'
      } WHERE id = ? AND status = ?`)
      .run(...(closing ? [target, rounds, now, now, id, from] : [target, rounds, now, id, from]));
    if (result.changes === 0) {
      throw new TransitionError('conflict', `work item ${id} changed concurrently (expected status ${from})`);
    }

    const event = appendWorkItemEvent({
      workItemId: id,
      kind: escalatedByRounds ? 'escalated' : 'status_change',
      fromStatus: from,
      toStatus: target,
      actor,
      detail: {
        ...(opts.detail ?? {}),
        ...(opts.bounce ? { bounce: true, rounds } : {}),
        ...(escalatedByRounds ? { reason: 'max-rounds-exhausted', maxRounds: effectiveMaxRounds(item) } : {}),
        todoProvenance: todoProvenanceSnapshot(item),
      },
    });

    return { item: getWorkItem(id)!, escalated: escalatedByRounds, event };
  });
  const result = txn();
  notifyTodoStatusChange(result.event, result.item);
  return result;
}

/** Assign a Todo to an employee. Roster validation lives at the route layer; this
 * transition-owned write is the only assignment path so backlog→assigned emits
 * the same committed status event and live todo-status listener notification as
 * any other lifecycle move. */
export function assignWorkItem(
  id: string,
  assignee: string,
  department: string | null,
  actor?: string | null,
): WorkItem | undefined {
  const db = initDb();
  const txn = db.transaction((): TransitionResult | undefined => {
    const item = getWorkItem(id);
    if (!item) return undefined;
    if (STICKY_STATUSES.has(item.status)) {
      throw new TransitionError('illegal-edge', `cannot assign work item ${id} while it is in terminal state ${item.status}`);
    }
    const target = item.status === 'backlog' ? 'assigned' : item.status;
    if (item.assignee === assignee && item.department === department && item.status === target) {
      return { item, escalated: false };
    }
    if (department !== null) ensureDepartmentRegistered(department); // review F2: same-transaction registry mint
    const now = new Date().toISOString();
    const result = db
      .prepare('UPDATE work_items SET assignee = ?, department = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ?')
      .run(assignee, department, target, now, id, item.status);
    if (result.changes === 0) {
      throw new TransitionError('conflict', `work item ${id} changed concurrently (expected status ${item.status})`);
    }
    const event = appendWorkItemEvent({
      workItemId: id,
      kind: item.status === target ? 'note' : 'status_change',
      fromStatus: item.status === target ? null : item.status,
      toStatus: item.status === target ? null : target,
      actor: actor ?? null,
      detail: {
        assignee,
        department,
        todoProvenance: todoProvenanceSnapshot({
          source: item.source,
          department,
          assignee,
        }),
      },
      versionEffect: 'companion',
    });
    return { item: getWorkItem(id)!, escalated: false, event };
  });
  const result = txn();
  if (!result) return undefined;
  notifyTodoStatusChange(result.event, result.item);
  return result.item;
}

/** Convenience: the reconciler's derived writes (agent-free, event-audited).
 *  Returns undefined instead of throwing on conflict/sticky races — derivation
 *  is best-effort truth-keeping, not authority. */
export function transitionDerived(id: string, to: WorkItemStatus, actor: string, detail?: Record<string, unknown>): WorkItem | undefined {
  try {
    return transition(id, to, actor, detail ? { detail } : {}).item;
  } catch (err) {
    if (err instanceof TransitionError) return undefined;
    throw err;
  }
}
