import { getDefinition, listDefinitions } from './definition-store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import { findRunByTriggerFireRef, getRun, listActiveRunRefs, workflowRunTriggerTodoId, type WorkflowRun } from './run-store.js';
import type { EditableWorkflowDefinition } from './definition.js';
import { initDb, getMetaValue, setMetaValue } from '../sessions/registry.js';
import type { WorkflowTrigger } from './derive.js';
import type { WorkItemSource, WorkItemStatus } from '../work-items/store.js';

export interface TodoStatusWorkflowEvent {
  id: string;
  workItemId: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  item: {
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
  };
}

export type TodoStatusTriggerOutcome =
  | { workflowId: string; outcome: 'started'; run: WorkflowRun; detail: string }
  | { workflowId: string; outcome: 'duplicate'; runId: string; detail: string }
  | { workflowId: string; outcome: 'suppressed'; detail: string }
  | { workflowId: string; outcome: 'failed'; run: WorkflowRun; detail: string };

export interface TodoStatusReplayOptions {
  limit?: number;
}

export interface TodoStatusReplayOutcome {
  eventId: string;
  outcomes: Array<Pick<TodoStatusTriggerOutcome, 'workflowId' | 'outcome'>>;
}

const NON_TERMINAL_RUN_STATUSES = new Set(['running', 'parked', 'dispatched']);

/** meta key for the last-replayed todo-status event cursor (created_at + rowid).
 * Lets a boot replay only events newer than everything already processed (live or
 * by a prior replay) instead of re-scanning the last N every time. */
const REPLAY_WATERMARK_KEY = 'todo_status_replay_watermark';

interface ReplayCursor {
  createdAt: string;
  rowid: number;
}

/** An active workflow definition whose trigger is a todo-status-change, resolved
 * once so a replay batch does not re-read every definition per event. */
interface TodoStatusDef {
  def: EditableWorkflowDefinition;
  trigger: WorkflowTrigger;
}

function triggerTarget(trigger: WorkflowTrigger): string | undefined {
  return trigger.toStatus ?? trigger.status;
}

function triggerMatches(trigger: WorkflowTrigger, event: TodoStatusWorkflowEvent): boolean {
  if (trigger.kind !== 'todo-status-change') return false;
  if (triggerTarget(trigger) !== event.toStatus) return false;
  if (trigger.fromStatus && trigger.fromStatus !== event.fromStatus) return false;
  const filter = trigger.filter;
  if (!filter) return true;
  if (filter.source && filter.source !== event.item.source) return false;
  if (filter.department && filter.department !== event.item.department) return false;
  if (filter.assignee && filter.assignee !== event.item.assignee) return false;
  return true;
}

function hasNonTerminalRunForTodo(deps: RunDriverDeps, workflowId: string, todoId: string): boolean {
  // Only active (non-terminal) runs can match — read the active-run index instead
  // of parsing every lifetime run file for this workflow. The status re-check
  // guards against a stale index entry.
  for (const ref of listActiveRunRefs(deps.root)) {
    if (ref.workflowId !== workflowId) continue;
    const run = getRun(deps.root, workflowId, ref.runId);
    if (!run || !NON_TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (workflowRunTriggerTodoId(run) === todoId) return true;
  }
  return false;
}

/** Resolve every active workflow whose trigger is a todo-status-change, once — so
 * a replay batch reads definitions a single time, not once per event. */
function loadActiveTodoStatusDefs(deps: RunDriverDeps): TodoStatusDef[] {
  const out: TodoStatusDef[] = [];
  for (const summary of listDefinitions(deps.root)) {
    let def;
    try {
      def = getDefinition(deps.root, summary.id);
    } catch {
      continue;
    }
    if (!def || def.status !== 'active') continue;
    const trigger = def.nodes.find((n) => n.type === 'trigger')?.trigger;
    if (!trigger || trigger.kind !== 'todo-status-change') continue;
    out.push({ def, trigger });
  }
  return out;
}

function parseReplayCursor(raw: string | null): ReplayCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.createdAt === 'string' && Number.isFinite(parsed.rowid)) {
      return { createdAt: parsed.createdAt, rowid: Number(parsed.rowid) };
    }
  } catch {
    /* corrupt watermark → treat as unset (rebuild-on-miss) */
  }
  return null;
}

function isNewerCursor(a: ReplayCursor, b: ReplayCursor): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.rowid > b.rowid;
}

/** Advance the replay watermark monotonically to `next` — so the next boot only
 * replays events created after everything this boot already processed. */
function advanceReplayWatermark(next: ReplayCursor): void {
  const current = parseReplayCursor(getMetaValue(REPLAY_WATERMARK_KEY));
  if (current && !isNewerCursor(next, current)) return;
  setMetaValue(REPLAY_WATERMARK_KEY, JSON.stringify(next));
}

export async function fireTodoStatusChangeWorkflows(
  deps: RunDriverDeps,
  event: TodoStatusWorkflowEvent,
  preloadedDefs?: TodoStatusDef[],
): Promise<TodoStatusTriggerOutcome[]> {
  const outcomes: TodoStatusTriggerOutcome[] = [];
  const defs = preloadedDefs ?? loadActiveTodoStatusDefs(deps);
  for (const { def, trigger } of defs) {
    if (!triggerMatches(trigger, event)) continue;

    const existing = findRunByTriggerFireRef(deps.root, def.id, 'todo-status-change', 'todo.status_changed', event.id);
    if (existing) {
      outcomes.push({
        workflowId: def.id,
        outcome: 'duplicate',
        runId: existing.runId,
        detail: `todo event ${event.id} already ran as ${existing.runId}`,
      });
      continue;
    }
    if (hasNonTerminalRunForTodo(deps, def.id, event.workItemId)) {
      outcomes.push({
        workflowId: def.id,
        outcome: 'suppressed',
        detail: `workflow "${def.id}" already has a non-terminal run linked to Todo ${event.workItemId}`,
      });
      continue;
    }

    const run = await startWorkflowRunFromTrigger(deps, def, {
      source: 'todo-status-change',
      event: 'todo.status_changed',
      payload: {
        todoId: event.workItemId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        source: event.item.source,
        department: event.item.department,
        assignee: event.item.assignee,
      },
      fireRef: event.id,
    }, {
      maxNodes: 100,
    });
    outcomes.push({
      workflowId: def.id,
      outcome: run.status === 'failed' ? 'failed' : 'started',
      run,
      detail: `workflow run ${run.runId} started from Todo ${event.workItemId} (status: ${run.status})`,
    });
  }
  return outcomes;
}

function replayLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(5000, Math.floor(limit as number)));
}

interface TodoEventRow {
  id: string;
  work_item_id: string;
  from_status: WorkItemStatus;
  to_status: WorkItemStatus;
  source: WorkItemSource;
  department: string | null;
  assignee: string | null;
  rowid: number;
  created_at: string;
}

export async function replayMissedTodoStatusChangeWorkflowFires(
  deps: RunDriverDeps,
  opts: TodoStatusReplayOptions = {},
): Promise<TodoStatusReplayOutcome[]> {
  const db = initDb();
  const limit = replayLimit(opts.limit);
  const watermark = parseReplayCursor(getMetaValue(REPLAY_WATERMARK_KEY));

  // With a watermark, replay only events created AFTER everything already handled
  // (the boot gap) — oldest first. Without one (first boot), fall back to the last
  // `limit` events, newest-first-then-reversed, matching the prior behaviour.
  const baseSelect = `SELECT
         e.id,
         e.work_item_id,
         e.from_status,
         e.to_status,
         w.source,
         w.department,
         w.assignee,
         e.rowid AS rowid,
         e.created_at AS created_at
       FROM work_item_events e
       JOIN work_items w ON w.id = e.work_item_id
       WHERE e.from_status IS NOT NULL
         AND e.to_status IS NOT NULL
         AND e.kind IN ('status_change', 'escalated')`;

  const rows = (watermark
    ? db
        .prepare(
          `${baseSelect}
             AND (e.created_at > ? OR (e.created_at = ? AND e.rowid > ?))
           ORDER BY e.created_at ASC, e.rowid ASC
           LIMIT ?`,
        )
        .all(watermark.createdAt, watermark.createdAt, watermark.rowid, limit)
    : db
        .prepare(`${baseSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`)
        .all(limit)
        .reverse()) as TodoEventRow[];

  // Read every active todo-status definition ONCE for the whole batch rather than
  // re-reading all definitions per event.
  const defs = loadActiveTodoStatusDefs(deps);

  const replayed: TodoStatusReplayOutcome[] = [];
  for (const row of rows) {
    const outcomes = await fireTodoStatusChangeWorkflows(deps, {
      id: row.id,
      workItemId: row.work_item_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      item: {
        source: row.source,
        department: row.department,
        assignee: row.assignee,
      },
    }, defs);
    // This event has now been considered (matched or not) — advance the watermark
    // past it so a later boot never re-scans it, whether or not a workflow fired.
    advanceReplayWatermark({ createdAt: row.created_at, rowid: Number(row.rowid) });
    if (outcomes.length === 0) continue;
    replayed.push({
      eventId: row.id,
      outcomes: outcomes.map((outcome) => ({ workflowId: outcome.workflowId, outcome: outcome.outcome })),
    });
  }
  return replayed;
}
