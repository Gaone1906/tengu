import { getDefinition, listDefinitions } from './definition-store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import { findRunByTriggerFireRef, getRun, listRuns, workflowRunTriggerTodoId, type WorkflowRun } from './run-store.js';
import { initDb } from '../sessions/registry.js';
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
  for (const summary of listRuns(deps.root, workflowId)) {
    if (!NON_TERMINAL_RUN_STATUSES.has(summary.status)) continue;
    const run = getRun(deps.root, workflowId, summary.runId);
    if (run && workflowRunTriggerTodoId(run) === todoId) return true;
  }
  return false;
}

export async function fireTodoStatusChangeWorkflows(
  deps: RunDriverDeps,
  event: TodoStatusWorkflowEvent,
): Promise<TodoStatusTriggerOutcome[]> {
  const outcomes: TodoStatusTriggerOutcome[] = [];
  const summaries = listDefinitions(deps.root);
  for (const summary of summaries) {
    let def;
    try {
      def = getDefinition(deps.root, summary.id);
    } catch {
      continue;
    }
    if (!def || def.status !== 'active') continue;
    const trigger = def.nodes.find((n) => n.type === 'trigger')?.trigger;
    if (!trigger || !triggerMatches(trigger, event)) continue;

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

export async function replayMissedTodoStatusChangeWorkflowFires(
  deps: RunDriverDeps,
  opts: TodoStatusReplayOptions = {},
): Promise<TodoStatusReplayOutcome[]> {
  const db = initDb();
  const rows = db
    .prepare(
      `SELECT
         e.id,
         e.work_item_id,
         e.from_status,
         e.to_status,
         w.source,
         w.department,
         w.assignee
       FROM work_item_events e
       JOIN work_items w ON w.id = e.work_item_id
       WHERE e.from_status IS NOT NULL
         AND e.to_status IS NOT NULL
         AND e.kind IN ('status_change', 'escalated')
       ORDER BY e.created_at DESC, e.rowid DESC
       LIMIT ?`,
    )
    .all(replayLimit(opts.limit))
    .reverse() as Array<{
    id: string;
    work_item_id: string;
    from_status: WorkItemStatus;
    to_status: WorkItemStatus;
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
  }>;

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
    });
    if (outcomes.length === 0) continue;
    replayed.push({
      eventId: row.id,
      outcomes: outcomes.map((outcome) => ({ workflowId: outcome.workflowId, outcome: outcome.outcome })),
    });
  }
  return replayed;
}
